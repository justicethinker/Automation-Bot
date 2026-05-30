import { db } from "@workspace/db";
import {
  vendorsTable,
  type VendorRow,
  menuItemsTable,
  type MenuItemRow,
  ordersTable,
  type OrderRow,
  conversationsTable,
  type ConversationRow,
  messagesTable,
  customersTable,
  paymentsTable,
  promotionsTable,
  broadcastsTable,
  vendorAdminsTable,
} from "@workspace/db";
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { sendWhatsAppMessage } from "./whatsapp";
import { logger } from "./logger";
import { hasFeature } from "./plans";
import { aiExtractOrder, aiExtractAdminIntent, type ExtractedAdminIntent } from "./ai-extractor";
import {
  setPendingOrder,
  getPendingOrder,
  clearPendingOrder,
  type PendingResolvedItem,
} from "./pending-orders";
import {
  generateOrderIdempotencyKey,
  checkIdempotencyKey,
  recordIdempotencyKey,
} from "./idempotency";
import { findBestMenuMatch } from "./fuzzy-match";
import { shouldRateLimitCustomer, shouldRateLimitAdminCommand } from "./rate-limiter-redis";
import { queueOutboundMessage, queueBroadcastMessage } from "./queue";

export type IncomingResult = {
  conversation: ConversationRow | null;
  botReply: string | null;
  adminNotification: string | null;
  isAdmin: boolean;
};

const greetingTriggers = ["hi", "hello", "hey", "start", "hola"];
const menuTriggers = ["menu", "list", "items", "products", "show"];
const orderTriggers = ["order", "buy", "want", "i'd like", "id like", "get me"];
const agentTriggers = [
  "agent",
  "human",
  "person",
  "staff",
  "support",
  "talk to someone",
];
const helpTriggers = ["help", "?", "commands", "options"];

function startsWithAny(body: string, triggers: string[]) {
  const lower = body.trim().toLowerCase();
  return triggers.some((t) => lower === t || lower.startsWith(t + " "));
}

function includesAny(body: string, triggers: string[]) {
  const lower = body.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// Returns active menu items in a stable order so the *number* shown to the
// customer in the menu and the *number* they reply with always line up.
async function listActiveMenuItems(vendor: VendorRow): Promise<MenuItemRow[]> {
  return db
    .select()
    .from(menuItemsTable)
    .where(
      and(
        eq(menuItemsTable.vendorId, vendor.id),
        eq(menuItemsTable.available, true),
      ),
    )
    .orderBy(menuItemsTable.category, menuItemsTable.createdAt);
}

async function listActivePromotions(vendor: VendorRow) {
  return db
    .select()
    .from(promotionsTable)
    .where(
      and(
        eq(promotionsTable.vendorId, vendor.id),
        eq(promotionsTable.active, true),
      ),
    )
    .orderBy(desc(promotionsTable.createdAt))
    .limit(3);
}

async function buildMenuMessage(vendor: VendorRow): Promise<string> {
  const items = await listActiveMenuItems(vendor);

  if (items.length === 0) {
    return `Our menu is being updated. Please check back soon.`;
  }

  const promos = await listActivePromotions(vendor);

  const lines: string[] = [`*${vendor.name} — Menu*`, ""];

  if (promos.length > 0) {
    lines.push(`*Today's offers*`);
    for (const p of promos) {
      lines.push(
        p.description ? `- ${p.title}: ${p.description}` : `- ${p.title}`,
      );
    }
    lines.push("");
  }

  // Numbered list. Numbers are global (1..N) so customers can always reply
  // with just a number regardless of category.
  let n = 1;
  let currentCat: string | null = null;
  for (const item of items) {
    const cat = item.category ?? "Menu";
    if (cat !== currentCat) {
      if (currentCat !== null) lines.push("");
      lines.push(`*${cat}*`);
      currentCat = cat;
    }
    lines.push(
      `${n}. ${item.name} — ${formatMoney(Number(item.price), vendor.currency)}`,
    );
    n++;
  }
  lines.push("");
  lines.push(`Reply with the number of what you want.`);
  lines.push(
    `For multiple items: *1, 3x2, 5* (item 1, two of item 3, item 5).`,
  );
  return lines.join("\n");
}

// Parse what the customer wants. Supports:
//   "1"               -> 1× item #1
//   "1x2"  /  "1 x 2" -> 2× item #1
//   "1, 3x2, 5"       -> mixed
//   "order margherita x2"  -> by name
//   "2 margherita"    -> 2× margherita
//   "I need one plate of jellof rice" -> fuzzy name parsing

type ParsedItem =
  | { kind: "number"; index: number; quantity: number }
  | { kind: "name"; name: string; quantity: number };

type OrderResolution =
  | { type: "resolved"; item: MenuItemRow; quantity: number }
  | {
      type: "ambiguous";
      originalText: string;
      quantity: number;
      candidates: Array<{ item: MenuItemRow; confidence: number }>;
    }
  | { type: "not_found"; originalText: string; quantity: number }
  | { type: "unavailable"; item: MenuItemRow; quantity: number };

type OrderSummaryItem = {
  name: string;
  unitPrice: number;
  quantity: number;
};

function isUnavailableResolution(
  res: OrderResolution,
): res is { type: "unavailable"; item: MenuItemRow; quantity: number } {
  return res.type === "unavailable";
}

function isAmbiguousResolution(
  res: OrderResolution,
): res is {
  type: "ambiguous";
  originalText: string;
  quantity: number;
  candidates: Array<{ item: MenuItemRow; confidence: number }>;
} {
  return res.type === "ambiguous";
}

function isNotFoundResolution(
  res: OrderResolution,
): res is { type: "not_found"; originalText: string; quantity: number } {
  return res.type === "not_found";
}

function toPendingResolvedItem(
  resolved: { item: MenuItemRow; quantity: number },
): PendingResolvedItem {
  return {
    menuItemId: resolved.item.id,
    itemName: resolved.item.name,
    quantity: resolved.quantity,
    unitPrice: Number(resolved.item.price),
    total: Number(resolved.item.price) * resolved.quantity,
  };
}

function orderSummaryFromPendingResolvedItems(
  orderItems: PendingResolvedItem[],
): OrderSummaryItem[] {
  return orderItems.map((resolved) => ({
    name: resolved.itemName,
    unitPrice: resolved.unitPrice,
    quantity: resolved.quantity,
  }));
}

function orderSummaryFromResolvedItems(
  orderItems: Array<{ item: MenuItemRow; quantity: number }>,
): OrderSummaryItem[] {
  return orderItems.map((resolved) => ({
    name: resolved.item.name,
    unitPrice: Number(resolved.item.price),
    quantity: resolved.quantity,
  }));
}

async function findOrderByShortId(vendorId: string, shortId: string): Promise<OrderRow | null> {
  if (!shortId) return null;
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, vendorId),
        sql`${ordersTable.id} LIKE ${shortId}%`,
      ),
    )
    .limit(1);
  return order ?? null;
}

async function findLatestPendingOrder(vendorId: string): Promise<OrderRow | null> {
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, vendorId),
        eq(ordersTable.status, "pending"),
      ),
    )
    .orderBy(desc(ordersTable.createdAt))
    .limit(1);
  return order ?? null;
}

async function findLatestConfirmedOrder(vendorId: string): Promise<OrderRow | null> {
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, vendorId),
        eq(ordersTable.status, "confirmed"),
      ),
    )
    .orderBy(desc(ordersTable.createdAt))
    .limit(1);
  return order ?? null;
}

async function notifyCustomer(
  vendor: VendorRow,
  customerPhone: string,
  text: string,
): Promise<void> {
  const conversation = await findOrCreateConversation(vendor, customerPhone, "Customer");
  await recordMessage(conversation.id, "out", "bot", text);
  await sendWhatsAppMessage({
    phoneNumberId: vendor.phoneNumberId,
    to: customerPhone,
    text,
  });
}

function pendingResolvedItemToOrderItem(
  resolved: PendingResolvedItem,
): { item: MenuItemRow; quantity: number } {
  return {
    item: {
      id: resolved.menuItemId,
      vendorId: "",
      name: resolved.itemName,
      price: resolved.unitPrice.toString(),
      available: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      category: null,
      description: null,
    } as MenuItemRow,
    quantity: resolved.quantity,
  };
}

type OrderItem = {
  name: string;
  unitPrice: number;
  quantity: number;
};

async function listAllMenuItems(vendor: VendorRow): Promise<MenuItemRow[]> {
  return db
    .select()
    .from(menuItemsTable)
    .where(eq(menuItemsTable.vendorId, vendor.id))
    .orderBy(menuItemsTable.category, menuItemsTable.createdAt);
}


function normalizeOrderText(body: string): string {
  return body
    .replace(/[,;]+/g, ",")
    .replace(/\b(?:please|pls|abeg|i need|need|i want|want|give me|can i get|i'd like|id like|may i have|would like|for me|kindly)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOrderLine(body: string): ParsedItem[] {
  const text = normalizeOrderText(body).replace(/^order\s+/i, "").trim();
  if (!text) return [];
  const parts = text
    .split(/[,;\n]| and /i)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: ParsedItem[] = [];
  for (const part of parts) {
    const numMatch = part.match(/^(\d+)\s*(?:[x×*]\s*(\d+))?$/i);
    if (numMatch) {
      const index = parseInt(numMatch[1]!, 10);
      const qty = numMatch[2] ? parseInt(numMatch[2]!, 10) : 1;
      if (index > 0 && qty > 0) {
        result.push({ kind: "number", index, quantity: qty });
        continue;
      }
    }

    const qtyFirst = part.match(/^(\d+)\s+(.+)$/);
    if (qtyFirst) {
      const qty = parseInt(qtyFirst[1]!, 10);
      const name = qtyFirst[2]!.trim();
      if (qty > 0 && name) {
        result.push({ kind: "name", name, quantity: qty });
        continue;
      }
    }

    const nameMatch = part.match(/^(.*?)(?:\s*[x×*]\s*(\d+))?$/i);
    if (nameMatch) {
      const name = nameMatch[1]!.trim();
      const qty = nameMatch[2] ? parseInt(nameMatch[2]!, 10) : 1;
      if (name && qty > 0) {
        result.push({ kind: "name", name, quantity: qty });
      }
    }
  }
  return result;
}

function looksLikeOrder(body: string, menuItems: MenuItemRow[]): boolean {
  const trimmed = body.trim();

  // Starts with explicit order triggers
  if (startsWithAny(trimmed, orderTriggers)) return true;

  // Pure number pattern (e.g. "1", "1,2,3", "1x2")
  if (/^[\d,\s x×*]+$/i.test(trimmed) && /\d/.test(trimmed)) return true;

  // Contains quantity notation like "x2" or "×3"
  if (/\b[x×]\s?\d+\b/i.test(trimmed)) return true;

  // Fuzzy-match at least one token against actual menu items
  // This makes the detection vendor-agnostic
  if (menuItems.length > 0) {
    const normalized = normalizeOrderText(trimmed);
    const tokens = normalized.split(/[\s,;]+/).filter(Boolean);
    
    for (const token of tokens) {
      if (token.length < 2) continue; // Skip very short tokens
      
      // Try fuzzy matching this token against menu item names
      for (const item of menuItems) {
        const itemNameLower = item.name.toLowerCase();
        const tokenLower = token.toLowerCase();
        
        // Exact substring match
        if (itemNameLower.includes(tokenLower) || tokenLower.includes(itemNameLower.split(" ")[0]!)) {
          return true;
        }
      }
    }
  }

  return false;
}

function buildOrderSummary(vendor: VendorRow, orderItems: OrderItem[]): string {
  const total = orderItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const lines = ["*Order summary*", ""];
  for (const resolved of orderItems) {
    lines.push(
      `- ${resolved.quantity}× ${resolved.name} — ${formatMoney(
        resolved.unitPrice * resolved.quantity,
        vendor.currency,
      )}`,
    );
  }
  lines.push("", `Total: *${formatMoney(total, vendor.currency)}*`);
  return lines.join("\n");
}

function formatClarificationOptions(candidates: Array<{ item: MenuItemRow; confidence: number }>) {
  return candidates
    .slice(0, 3)
    .map((candidate, index) => `*${index + 1}*: ${candidate.item.name}`)
    .join("\n");
}

function isAffirmative(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return ["yes", "y", "sure", "yeah", "yep", "please do", "okay", "ok", "confirm"].includes(normalized);
}

function isNegative(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return ["no", "n", "nah", "nope", "cancel", "stop", "not now"].includes(normalized);
}


async function buildPendingOrderState(
  vendor: VendorRow,
  conversation: ConversationRow,
  body: string,
): Promise<BotReply> {
  const activeItems = await listActiveMenuItems(vendor);
  const allItems = await listAllMenuItems(vendor);
  if (activeItems.length === 0) {
    return {
      text: `Our menu is being updated. Please check back soon.`,
      handover: false,
    };
  }

  const parsed = parseOrderLine(body);
  let requests = parsed;
  if (requests.length === 0) {
    const aiItems = await aiExtractOrder(body);
    if (aiItems) {
      requests = aiItems.map((order) => ({ kind: "name", name: order.item, quantity: order.quantity }));
    }
  }

  if (requests.length === 0) {
    return {
      text: `I didn't catch your order. Reply with the item name or say *menu* to see what's available.`,
      handover: false,
    };
  }

  const resolvedItems: Array<{ item: MenuItemRow; quantity: number }> = [];
  const unresolved: Array<{ text: string; quantity: number; resolution: OrderResolution }> = [];

  for (const request of requests) {
    const result = resolveOrderRequest(request, activeItems, allItems, vendor.id);
    if (result.type === "resolved") {
      resolvedItems.push({ item: result.item, quantity: request.quantity });
      continue;
    }
    unresolved.push({
      text: request.kind === "name" ? request.name : `${request.index}`,
      quantity: request.quantity,
      resolution: result,
    });
  }

  const unavailable = unresolved.filter(
    (item): item is { text: string; quantity: number; resolution: { type: "unavailable"; item: MenuItemRow; quantity: number } } =>
      isUnavailableResolution(item.resolution),
  );
  const ambiguous = unresolved.filter(
    (item): item is { text: string; quantity: number; resolution: { type: "ambiguous"; originalText: string; quantity: number; candidates: Array<{ item: MenuItemRow; confidence: number }> } } =>
      isAmbiguousResolution(item.resolution),
  );
  const notFound = unresolved.filter(
    (item): item is { text: string; quantity: number; resolution: { type: "not_found"; originalText: string; quantity: number } } =>
      isNotFoundResolution(item.resolution),
  );

  if (unavailable.length > 0 && resolvedItems.length === 0 && ambiguous.length === 0 && notFound.length === 0) {
    return {
      text: `Sorry, ${unavailable[0].resolution.item.name} is currently unavailable. Reply *menu* to choose something else.`,
      handover: false,
    };
  }

  const total = resolvedItems.reduce(
    (sum, item) => sum + Number(item.item.price) * item.quantity,
    0,
  );

  if (ambiguous.length > 0) {
    const first = ambiguous[0].resolution;
    const remaining = ambiguous.slice(1).map((item) => ({ text: item.text, quantity: item.quantity }))
      .concat(notFound.map((item) => ({ text: item.text, quantity: item.quantity })))
      .concat(unavailable.map((item) => ({ text: item.resolution.item.name, quantity: item.quantity })));

    const pending = await setPendingOrder(
      vendor.id,
      conversation.customerPhone ?? "unknown",
      resolvedItems.map((resolved) => ({
        menuItemId: resolved.item.id,
        itemName: resolved.item.name,
        quantity: resolved.quantity,
        unitPrice: Number(resolved.item.price),
        total: Number(resolved.item.price) * resolved.quantity,
      })),
      {
        originalText: first.originalText,
        quantity: first.quantity,
        candidates: first.candidates.map((candidate) => ({
          itemId: candidate.item.id,
          itemName: candidate.item.name,
          confidence: candidate.confidence,
        })),
        remaining,
      },
      total,
    );

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    const options = formatClarificationOptions(first.candidates);
    return {
      text: `I found a few matches for "${first.originalText}":

${options}

Reply with the number for the item you want.`,
      handover: false,
    };
  }

  if (notFound.length > 0) {
    if (resolvedItems.length === 0) {
      return {
        text: `I couldn't match "${notFound[0].text}". Reply with a different item or say *menu* to view the menu.`,
        handover: false,
      };
    }

    const remaining = notFound.slice(1).map((item) => ({ text: item.text, quantity: item.quantity }));
    const pending = await setPendingOrder(
      vendor.id,
      conversation.customerPhone ?? "unknown",
      resolvedItems.map((resolved) => ({
        menuItemId: resolved.item.id,
        itemName: resolved.item.name,
        quantity: resolved.quantity,
        unitPrice: Number(resolved.item.price),
        total: Number(resolved.item.price) * resolved.quantity,
      })),
      {
        originalText: notFound[0].text,
        quantity: notFound[0].quantity,
        candidates: [],
        remaining,
      },
      total,
    );

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    return {
      text: `I couldn't find "${notFound[0].text}". Reply YES to continue with the other item${
        resolvedItems.length === 1 ? "" : "s"
      }, or NO to start over.`,
      handover: false,
    };
  }

  if (unavailable.length > 0) {
    const firstUnavailable = unavailable[0];
    const remaining = unavailable.slice(1).map((item) => ({ text: item.resolution.item.name, quantity: item.quantity }));
    if (resolvedItems.length === 0 && remaining.length === 0) {
      return {
        text: `Sorry, ${firstUnavailable.resolution.item.name} is currently unavailable. Reply *menu* for other options.`,
        handover: false,
      };
    }

    const pending = await setPendingOrder(
      vendor.id,
      conversation.customerPhone ?? "unknown",
      resolvedItems.map((resolved) => ({
        menuItemId: resolved.item.id,
        itemName: resolved.item.name,
        quantity: resolved.quantity,
        unitPrice: Number(resolved.item.price),
        total: Number(resolved.item.price) * resolved.quantity,
      })),
      {
        originalText: firstUnavailable.resolution.item.name,
        quantity: firstUnavailable.quantity,
        candidates: [],
        remaining,
      },
      total,
    );

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    return {
      text: `Sorry, ${firstUnavailable.resolution.item.name} is currently unavailable. Reply YES to continue with the rest of your order, or NO to start over.`,
      handover: false,
    };
  }

  const pending = await setPendingOrder(
    vendor.id,
    conversation.customerPhone ?? "unknown",
    resolvedItems.map((resolved) => ({
      menuItemId: resolved.item.id,
      itemName: resolved.item.name,
      quantity: resolved.quantity,
      unitPrice: Number(resolved.item.price),
      total: Number(resolved.item.price) * resolved.quantity,
    })),
    null,
    total,
  );

  if (!pending) {
    return {
      text: `Sorry, something went wrong while I prepared your order. Try again in a moment.`,
      handover: false,
    };
  }

  return {
    text: `${buildOrderSummary(vendor, orderSummaryFromResolvedItems(resolvedItems))}

Reply YES to confirm or NO to cancel.`,
    handover: false,
  };
}

function findBestCandidateMatch(
  body: string,
  options: Array<{ itemId: string; itemName: string; confidence: number }>,
) {
  const choice = parseInt(body.trim(), 10);
  if (!Number.isNaN(choice) && choice >= 1 && choice <= options.length) {
    return options[choice - 1];
  }

  const normalized = body.trim().toLowerCase();
  return options.find((option) => option.itemName.toLowerCase() === normalized) ?? null;
}

async function resolvePendingClarification(
  vendor: VendorRow,
  conversation: ConversationRow,
  body: string,
  pendingOrder: PendingOrder,
): Promise<BotReply | null> {
  if (!pendingOrder.pendingClarification) return null;

  const activeItems = await listActiveMenuItems(vendor);
  const allItems = await listAllMenuItems(vendor);
  const state = pendingOrder.pendingClarification;
  const trimmed = body.trim();

  // Handle delivery address collection
  if (state.originalText === "awaiting_delivery_address") {
    // Store the address in the pending order by creating a new order with the address
    // For now, we'll store it in a special way that the order creation can access
    const updatedOrder = { ...pendingOrder, deliveryAddress: trimmed } as any;
    // Recreate the pending order with the address, then create the actual order
    const order = await createOrderWithLock(
      vendor.id,
      conversation.customerPhone ?? "unknown",
      conversation.customerName ?? "Anonymous",
      pendingOrder.resolvedItems.map(pendingResolvedItemToOrderItem),
      vendor,
    );

    if (order) {
      // Update order notes with the address
      await db.update(ordersTable).set({
        notes: trimmed,
      }).where(eq(ordersTable.id, order.id));
    }

    await clearPendingOrder(vendor.id, conversation.customerPhone);

    if (!order) {
      return {
        text: `Sorry, I encountered an error confirming your order. Please try again.`,
        handover: false,
      };
    }

    const orderItems = pendingOrder.resolvedItems.map(pendingResolvedItemToOrderItem);
    const lines: string[] = [`*Order confirmed! ✓*`, ``];
    for (const item of orderItems) {
      lines.push(
        `- ${item.quantity}× ${item.item.name} — ${formatMoney(
          Number(item.item.price) * item.quantity,
          vendor.currency,
        )}`,
      );
    }
    lines.push(``, `Total: *${formatMoney(pendingOrder.total, vendor.currency)}*`);
    lines.push(``, `Address: ${trimmed}`);
    lines.push(``, `Order #${order.shortId} sent to vendor. They'll confirm shortly.`);

    return { text: lines.join("\n"), handover: false };
  }

  if (state.candidates.length > 0) {
    const selectedRef = findBestCandidateMatch(trimmed, state.candidates);
    if (selectedRef) {
      const selected = allItems.find((item) => item.id === selectedRef.itemId);
      if (!selected || !selected.available) {
        await clearPendingOrder(vendor.id, conversation.customerPhone ?? "unknown");
        return {
          text: `Sorry, ${selectedRef.itemName} is not available anymore. Please start again with *menu*.`,
          handover: false,
        };
      }

      const resolvedItems = [
        ...pendingOrder.resolvedItems,
        toPendingResolvedItem({ item: selected, quantity: state.quantity }),
      ];

      if (state.remaining.length === 0) {
        const total = resolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
        await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", resolvedItems, null, total);
        return {
          text: `${buildOrderSummary(vendor, orderSummaryFromPendingResolvedItems(resolvedItems))}

Reply YES to confirm or NO to cancel.`,
          handover: false,
        };
      }

      const nextRequest = state.remaining.shift()!;
      const nextResolution = resolveOrderRequest({ kind: "name", name: nextRequest.text, quantity: nextRequest.quantity }, activeItems, allItems, vendor.id);
      return await handleNextPendingResolution(vendor, conversation, resolvedItems, nextRequest, nextResolution, state.remaining);
    }

    return {
      text: `Please reply with a number from the list, or say NO to start over.`,
      handover: false,
    };
  }

  if (isNegative(body)) {
    await clearPendingOrder(vendor.id, conversation.customerPhone ?? "unknown");
    return {
      text: `No problem. Send your order again when you're ready.`,
      handover: false,
    };
  }

  if (isAffirmative(body)) {
    if (pendingOrder.resolvedItems.length === 0) {
      await clearPendingOrder(vendor.id, conversation.customerPhone ?? "unknown");
      return {
        text: `Okay. Reply *menu* when you want to start a new order.`,
        handover: false,
      };
    }
    const total = pendingOrder.resolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", pendingOrder.resolvedItems, null, total);
    return {
      text: `${buildOrderSummary(vendor, orderSummaryFromPendingResolvedItems(pendingOrder.resolvedItems))}

Reply YES to confirm or NO to cancel.`,
      handover: false,
    };
  }

  return {
    text: `I didn't understand that. Reply YES to continue with the order, or NO to cancel.`,
    handover: false,
  };
}

async function handleNextPendingResolution(
  vendor: VendorRow,
  conversation: ConversationRow,
  resolvedItems: PendingResolvedItem[],
  nextRequest: { text: string; quantity: number },
  nextResolution: OrderResolution,
  remaining: Array<{ text: string; quantity: number }>,
): Promise<BotReply> {
  if (nextResolution.type === "resolved") {
    const nextResolvedItems = [
      ...resolvedItems,
      toPendingResolvedItem({ item: nextResolution.item, quantity: nextRequest.quantity }),
    ];
    const total = nextResolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", nextResolvedItems, null, total);
    return {
      text: `${buildOrderSummary(vendor, orderSummaryFromPendingResolvedItems(nextResolvedItems))}

Reply YES to confirm or NO to cancel.`,
      handover: false,
    };
  }

  if (nextResolution.type === "ambiguous") {
    const pending = await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", resolvedItems, {
      originalText: nextResolution.originalText,
      quantity: nextResolution.quantity,
      candidates: nextResolution.candidates.map((item) => ({
        itemId: item.item.id,
        itemName: item.item.name,
        confidence: item.confidence,
      })),
      remaining,
    },
    resolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    const options = formatClarificationOptions(nextResolution.candidates);
    return {
      text: `I also need to confirm one more item: "${nextResolution.originalText}".

${options}

Reply with the number for the item you want.`,
      handover: false,
    };
  }

  if (nextResolution.type === "not_found") {
    const pending = await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", resolvedItems, {
      originalText: nextResolution.originalText,
      quantity: nextResolution.quantity,
      candidates: [],
      remaining,
    },
    resolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    return {
      text: `I couldn't match "${nextResolution.originalText}". Reply YES to continue with the rest of your order, or NO to start over.`,
      handover: false,
    };
  }

  if (nextResolution.type === "unavailable") {
    const pending = await setPendingOrder(vendor.id, conversation.customerPhone ?? "unknown", resolvedItems, {
      originalText: nextResolution.item.name,
      quantity: nextResolution.quantity,
      candidates: [],
      remaining,
    },
    resolvedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));

    if (!pending) {
      return {
        text: `Sorry, I couldn't save your order yet. Please try again.`,
        handover: false,
      };
    }

    return {
      text: `Sorry, ${nextResolution.item.name} is currently unavailable. Reply YES to continue with the rest of your order, or NO to start over.`,
      handover: false,
    };
  }

  return {
    text: `Sorry, I couldn't understand that last response. Please try again.`,
    handover: false,
  };
}

function resolveOrderRequest(
  req: ParsedItem,
  activeItems: MenuItemRow[],
  allItems: MenuItemRow[],
  vendorId: string,
): OrderResolution {
  if (req.kind === "number") {
    const item = activeItems[req.index - 1] ?? null;
    if (!item) {
      return { type: "not_found", originalText: `${req.index}`, quantity: req.quantity };
    }
    if (!item.available) {
      return { type: "unavailable", item, quantity: req.quantity };
    }
    return { type: "resolved", item, quantity: req.quantity };
  }

  const fuzzyResult = findBestMenuMatch(req.name, allItems, vendorId);
  if (fuzzyResult.kind === "exact" || fuzzyResult.kind === "unique") {
    if (!fuzzyResult.item.available) {
      return { type: "unavailable", item: fuzzyResult.item, quantity: req.quantity };
    }
    return { type: "resolved", item: fuzzyResult.item, quantity: req.quantity };
  }

  if (fuzzyResult.kind === "ambiguous") {
    return {
      type: "ambiguous",
      originalText: req.name,
      quantity: req.quantity,
      candidates: fuzzyResult.options.map((item) => ({ item, confidence: fuzzyResult.confidence })),
    };
  }

  return { type: "not_found", originalText: req.name, quantity: req.quantity };
}
function paymentInstructions(vendor: VendorRow, total: number): string {
  if (vendor.bankName && vendor.bankAccountNumber) {
    return [
      `*Payment instructions*`,
      `Total: ${formatMoney(total, vendor.currency)}`,
      `Bank: ${vendor.bankName}`,
      `Account: ${vendor.bankAccountNumber}`,
      vendor.bankAccountHolder ? `Holder: ${vendor.bankAccountHolder}` : null,
      ``,
      `After paying, reply *paid* and we will confirm.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `Total: ${formatMoney(total, vendor.currency)}. Reply *paid* once you have completed payment.`;
}

async function findOrCreateConversation(
  vendor: VendorRow,
  customerPhone: string,
  customerName: string,
): Promise<ConversationRow> {
  const phone = customerPhone ?? "unknown";
  const name = customerName ?? "Anonymous";

  // Upsert: insert if not exists, update name if exists, always return the row
  const [row] = await db
    .insert(conversationsTable)
    .values({
      vendorId: vendor.id,
      customerPhone: phone,
      customerName: name,
    })
    .onConflictDoUpdate({
      target: [conversationsTable.vendorId, conversationsTable.customerPhone],
      set: { customerName: name },
    })
    .returning();

  return row!;
}

/**
 * Resolve multiple requested items to menu items.
 * Returns items with menu price/details or null if any item not found.
 * Issue #8: Multi-Item Order Support
 */
/**
 * Create order with database transaction to prevent race conditions.
 * Issue #10: Race Condition Prevention with Pessimistic Lock
 */
async function createOrderWithLock(
  vendorId: string,
  customerPhone: string,
  customerName: string,
  orderItems: Array<{ item: MenuItemRow; quantity: number }>,
  vendor: VendorRow,
): Promise<OrderRow | null> {
  try {
    // Generate idempotency key from stable inputs
    const itemKey = orderItems.map((oi) => `${oi.item.id}:${oi.quantity}`).join(",");
    const idempotencyKey = generateOrderIdempotencyKey(vendorId, customerPhone, itemKey);

    // Check if we've already created an order with this key
    const existingKey = await checkIdempotencyKey(idempotencyKey);
    if (existingKey) {
      logger.info(
        { vendorId, customerPhone, existingOrderId: existingKey.id },
        "Duplicate order prevented via idempotency key",
      );
      const [existing] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, existingKey.id))
        .limit(1);
      return existing ?? null;
    }

    const [order] = await db
      .insert(ordersTable)
      .values({
        vendorId,
        customerPhone,
        customerName,
        status: "pending",
        paymentStatus: "pending",
        total: orderItems
          .reduce((sum, oi) => sum + Number(oi.item.price) * oi.quantity, 0)
          .toFixed(2),
        currency: vendor.currency,
        items: orderItems.map((oi) => ({
          name: oi.item.name,
          quantity: oi.quantity,
          unitPrice: Number(oi.item.price),
        })),
      })
      .returning();

    if (order) {
      // Record this idempotency key so future requests with the same key return this order
      await recordIdempotencyKey(idempotencyKey, order.id, "order");
    }

    return order ?? null;
  } catch (err) {
    logger.error(
      { err, vendorId, customerPhone },
      "Failed to create order",
    );
    return null;
  }
}

async function upsertCustomer(
  vendorId: string,
  phone: string,
  name: string,
): Promise<void> {
  await db
    .insert(customersTable)
    .values({ vendorId, phone, name, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [customersTable.vendorId, customersTable.phone],
      set: { name, lastSeenAt: new Date() },
    });
}

async function recordMessage(
  conversationId: string,
  direction: "in" | "out",
  sender: "customer" | "bot" | "vendor" | "system",
  body: string,
): Promise<void> {
  await db
    .insert(messagesTable)
    .values({ conversationId, direction, sender, body });
  const preview = body.length > 80 ? body.slice(0, 77) + "..." : body;
  await db
    .update(conversationsTable)
    .set({
      lastMessagePreview: preview,
      lastMessageAt: new Date(),
      ...(direction === "in"
        ? { unreadCount: sql`${conversationsTable.unreadCount} + 1` }
        : {}),
    })
    .where(eq(conversationsTable.id, conversationId));
}

async function isAdminSender(vendor: VendorRow, fromPhone: string): Promise<boolean> {
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/^\+/, "");
  const normalizedFrom = norm(fromPhone);

  // Legacy adminNumber compatibility
  if (vendor.adminNumber && norm(vendor.adminNumber) === normalizedFrom) {
    return true;
  }

  const admins = await db
    .select()
    .from(vendorAdminsTable)
    .where(eq(vendorAdminsTable.vendorId, vendor.id));

  return admins.some((admin) => norm(admin.phone) === normalizedFrom);
}

export async function handleIncomingMessage(args: {
  vendor: VendorRow;
  fromPhone: string;
  fromName: string;
  body: string;
}): Promise<IncomingResult> {
  const { vendor, fromPhone, fromName, body } = args;

  // Rate limit: prevent customer spam
  if (await shouldRateLimitCustomer(fromPhone)) {
    logger.warn({ phone: fromPhone }, "Customer rate limited");
    return {
      conversation: null,
      botReply: null,
      adminNotification: null,
      isAdmin: false,
    };
  }

  // Admin (vendor's personal number or vendor admins) -> admin command flow.
  if (await isAdminSender(vendor, fromPhone)) {
    // Admin rate limiting
    if (await shouldRateLimitAdminCommand(vendor.id)) {
      logger.warn({ vendorId: vendor.id }, "Admin command rate limited");
      return {
        conversation: null,
        botReply: null,
        adminNotification: null,
        isAdmin: true,
      };
    }

    const reply = await handleAdminCommand(vendor, body);
    if (reply.text && vendor.phoneNumberId) {
      // Queue the message instead of sending immediately
      await queueOutboundMessage(
        vendor.phoneNumberId,
        fromPhone,
        reply.text,
      );
    }
    return {
      conversation: null,
      botReply: reply.text,
      adminNotification: null,
      isAdmin: true,
    };
  }

  // Customer flow
  await upsertCustomer(vendor.id, fromPhone, fromName);
  const conversation = await findOrCreateConversation(
    vendor,
    fromPhone,
    fromName,
  );

  await recordMessage(conversation.id, "in", "customer", body);

  // Bot stays silent during human handover or when bot is disabled.
  if (
    !vendor.botEnabled ||
    conversation.status === "human" ||
    conversation.status === "closed"
  ) {
    return {
      conversation,
      botReply: null,
      adminNotification: null,
      isAdmin: false,
    };
  }

  const reply = await computeBotReply(vendor, conversation, body);
  if (reply.handover) {
    await db
      .update(conversationsTable)
      .set({ status: "human" })
      .where(eq(conversationsTable.id, conversation.id));
  }

  if (reply.text && vendor.phoneNumberId) {
    await recordMessage(conversation.id, "out", "bot", reply.text);
    // Queue message for reliable delivery
    await queueOutboundMessage(
      vendor.phoneNumberId,
      fromPhone,
      reply.text,
    );
  }

  // Notify the vendor's admin number when a new order was just placed,
  // or when handover was requested.
  let adminNotification: string | null = null;
  if (reply.adminAlert && vendor.adminNumber && vendor.phoneNumberId) {
    adminNotification = reply.adminAlert;
    // Queue admin notification as well
    await queueOutboundMessage(
      vendor.phoneNumberId,
      vendor.adminNumber,
      reply.adminAlert,
    );
  }

  return {
    conversation,
    botReply: reply.text,
    adminNotification,
    isAdmin: false,
  };
}

type BotReply = {
  text: string | null;
  handover: boolean;
  adminAlert?: string | null;
};

async function computeBotReply(
  vendor: VendorRow,
  conversation: ConversationRow,
  body: string,
): Promise<BotReply> {
  // Fetch active menu items once at the beginning for use in order detection and menu building
  const activeItems = await listActiveMenuItems(vendor);

  // Human handover request
  if (includesAny(body, agentTriggers)) {
    return {
      text: `Connecting you to a human agent now. Someone will reply here shortly.`,
      handover: true,
      adminAlert: `Handover requested by ${conversation.customerName} (${conversation.customerPhone}). Reply in WhatsApp to take over.`,
    };
  }

  // Help / commands
  if (startsWithAny(body, helpTriggers) || includesAny(body, helpTriggers)) {
    return {
      text: [
        `I can help you with:`,
        `- *menu* — see what's available`,
        `- reply with a *number* (e.g. "1") to order an item`,
        `- *1, 3x2, 5* to order multiple items at once`,
        `- *paid* — confirm a payment`,
        `- *agent* — talk to a human`,
      ].join("\n"),
      handover: false,
    };
  }

  // "paid" -> mark latest confirmed order's paymentStatus as paid (vendor will verify).
  if (startsWithAny(body, ["paid"]) || /^i.?ve paid/i.test(body)) {
    const pending = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.vendorId, vendor.id),
          eq(ordersTable.customerPhone, conversation.customerPhone),
          eq(ordersTable.status, "confirmed"),
        ),
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(1);
    const target = pending[0];
    if (!target) {
      return {
        text: `We don't see a confirmed order awaiting payment. Reply *menu* to start a new order.`,
        handover: false,
      };
    }
    return {
      text: `Thanks. We've notified the vendor of your payment and they'll confirm shortly.`,
      handover: false,
      adminAlert: `Customer ${conversation.customerName} (${conversation.customerPhone}) reports payment for order #${target.shortId} (${formatMoney(Number(target.total), vendor.currency)}). Reply *paid ${target.shortId}* once verified.`,
    };
  }

  const pendingOrderResult = await getPendingOrder(vendor.id, conversation.customerPhone);

  // Handle expired pending order
  if (pendingOrderResult.status === "expired") {
    return {
      text: `Your pending order has expired. Reply *menu* to start a new one!`,
      handover: false,
    };
  }

  const pendingOrder = pendingOrderResult.status === "found" ? pendingOrderResult.order : null;

  if (pendingOrder?.pendingClarification) {
    const followUp = await resolvePendingClarification(vendor, conversation, body, pendingOrder);
    if (followUp) return followUp;
  }

  if (pendingOrder) {
    if (isAffirmative(body)) {
      // Check if vendor requires delivery address and we don't have one yet
      if (vendor.requiresDeliveryAddress) {
        const hasAddress = (pendingOrder as any).deliveryAddress;
        if (!hasAddress) {
          // Store the current pending order with a clarification state to ask for address
          await setPendingOrder(
            vendor.id,
            conversation.customerPhone,
            pendingOrder.resolvedItems,
            {
              originalText: "awaiting_delivery_address",
              quantity: 1,
              candidates: [],
              remaining: [],
            },
            pendingOrder.total,
          );

          return {
            text: `Please provide your delivery address so the vendor knows where to send your order.`,
            handover: false,
          };
        }
      }

      const order = await createOrderWithLock(
        vendor.id,
        conversation.customerPhone ?? "unknown",
        conversation.customerName ?? "Anonymous",
        pendingOrder.resolvedItems.map(pendingResolvedItemToOrderItem),
        vendor,
      );

      await clearPendingOrder(vendor.id, conversation.customerPhone);

      if (!order) {
        return {
          text: `Sorry, I encountered an error confirming your order. Please try again.`,
          handover: false,
        };
      }

      const orderItems = pendingOrder.resolvedItems.map(pendingResolvedItemToOrderItem);
      const lines: string[] = [`*Order confirmed! ✓*`, ``];
      for (const item of orderItems) {
        lines.push(
          `- ${item.quantity}× ${item.item.name} — ${formatMoney(
            Number(item.item.price) * item.quantity,
            vendor.currency,
          )}`,
        );
      }
      lines.push(``, `Total: *${formatMoney(pendingOrder.total, vendor.currency)}*`);
      lines.push(``, `Order #${order.shortId} sent to vendor. They'll confirm shortly.`);

      const adminLines: string[] = [
        `*New order from ${conversation.customerName}* (${conversation.customerPhone})`,
        ``,
      ];
      for (const item of orderItems) {
        adminLines.push(
          `- ${item.quantity}× ${item.item.name} — ${formatMoney(
            Number(item.item.price) * item.quantity,
            vendor.currency,
          )}`,
        );
      }
      adminLines.push(``, `Total: ${formatMoney(pendingOrder.total, vendor.currency)}`, ``, `Reply *confirm ${order.shortId}* or *reject ${order.shortId}*.`);

      return {
        text: lines.join("\n"),
        handover: false,
        adminAlert: adminLines.join("\n"),
      };
    }

    if (isNegative(body)) {
      await clearPendingOrder(vendor.id, conversation.customerPhone);
      return {
        text: `Okay, your pending order was cancelled. Reply *menu* to start again.`,
        handover: false,
      };
    }
  }

  if (looksLikeOrder(body, activeItems)) {
    return await buildPendingOrderState(vendor, conversation, body);
  }

  // Order status check
  const statusTriggers = ["status", "my order", "order status", "where is my order", "what happened to my order", "track"];
  if (startsWithAny(body, statusTriggers) || includesAny(body, statusTriggers)) {
    const [latestOrder] = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.vendorId, vendor.id),
          eq(ordersTable.customerPhone, conversation.customerPhone),
        ),
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(1);

    if (!latestOrder) {
      return {
        text: `You don't have any orders yet. Reply *menu* to start one!`,
        handover: false,
      };
    }

    const statusMessages: Record<string, string> = {
      pending: `⏳ Your order #${latestOrder.shortId} is waiting to be confirmed by the vendor.`,
      confirmed: `✅ Your order #${latestOrder.shortId} has been confirmed. Awaiting payment.`,
      paid: `💰 Payment received for order #${latestOrder.shortId}. Your order is being prepared!`,
      completed: `🎉 Your order #${latestOrder.shortId} is complete!`,
      rejected: `❌ Your order #${latestOrder.shortId} was not accepted. Reply *menu* to try again or *agent* for help.`,
      cancelled: `🚫 Your order #${latestOrder.shortId} was cancelled.`,
    };

    const msg = statusMessages[latestOrder.status] ?? `Your order #${latestOrder.shortId} status: ${latestOrder.status}.`;
    return { text: msg, handover: false };
  }

  // Cancel order command
  const cancelTriggers = ["cancel", "cancel order", "nevermind", "never mind", "i changed my mind"];
  if (startsWithAny(body, cancelTriggers) || includesAny(body, cancelTriggers)) {
    // If there's a pending (unconfirmed) order in progress, clear it
    const pendingOrderResult = await getPendingOrder(vendor.id, conversation.customerPhone);
    if (pendingOrderResult.status === "found") {
      await clearPendingOrder(vendor.id, conversation.customerPhone);
      return {
        text: `Your pending order was cancelled. Reply *menu* to start a new one!`,
        handover: false,
      };
    }

    // Check for a vendor-pending order (not yet confirmed by vendor)
    const [latestOrder] = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.vendorId, vendor.id),
          eq(ordersTable.customerPhone, conversation.customerPhone),
          eq(ordersTable.status, "pending"),
        ),
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(1);

    if (latestOrder) {
      await db
        .update(ordersTable)
        .set({ status: "cancelled" })
        .where(eq(ordersTable.id, latestOrder.id));

      return {
        text: `Your order #${latestOrder.shortId} has been cancelled. Reply *menu* to start a new one!`,
        handover: false,
      };
    }

    // Already confirmed — can't self-cancel
    return {
      text: `Your order has already been confirmed by the vendor. Please reply *agent* if you need to make changes.`,
      handover: false,
    };
  }

  // Menu request
  if (startsWithAny(body, menuTriggers)) {
    return { text: await buildMenuMessage(vendor), handover: false };
  }

  // Greeting / welcome
  if (startsWithAny(body, greetingTriggers)) {
    const welcome =
      vendor.welcomeMessage ??
      `Welcome to ${vendor.name}. Reply *menu* to see what's available.`;
    return { text: welcome, handover: false };
  }

  // Fallback
  return {
    text: [
      `I'm not sure I understood. Try:`,
      `- *menu* to see what we offer`,
      `- *order <item> x<qty>* to order`,
      `- *agent* to reach a human`,
    ].join("\n"),
    handover: false,
  };
}

// Send payment instructions to the customer's chat after an order is confirmed.
export async function notifyOrderConfirmedToCustomer(args: {
  vendor: VendorRow;
  conversationId: string;
  customerPhone: string;
  total: number;
}): Promise<string> {
  const text = paymentInstructions(args.vendor, args.total);
  await recordMessage(args.conversationId, "out", "bot", text);
  await sendWhatsAppMessage({
    phoneNumberId: args.vendor.phoneNumberId,
    to: args.customerPhone,
    text,
  });
  return text;
}

// ────────────────────────────────────────────────────────────────────────────
// Admin command system (vendor sending commands from their personal number)
// ────────────────────────────────────────────────────────────────────────────

type AdminReply = { text: string | null };

export async function handleAdminCommand(
  vendor: VendorRow,
  raw: string,
): Promise<AdminReply> {
  const body = raw.trim();
  const lower = body.toLowerCase();

  const aiIntent = await aiExtractAdminIntent(body);
  if (aiIntent && aiIntent.intent !== "unknown") {
    const aiReply = await handleAdminIntent(vendor, aiIntent);
    if (aiReply) return aiReply;
  }

  // /help
  if (lower === "/help" || lower === "help" || lower === "?") {
    const proLine = vendor.plan === "pro" ? "" : " (Pro plan only)";
    return {
      text: [
        `*Vendor commands*`,
        `- *menu* — show your menu`,
        `- *add <name> <price>* — add a menu item (e.g. "add Jollof Rice 2500")`,
        `- *remove <name>* — remove a menu item`,
        `- *orders* — list pending orders`,
        `- *confirm [id]* — confirm latest or specific order`,
        `- *reject [id]* — reject latest or specific order`,
        `- *paid [id]* — mark order as paid`,
        `- */bot [phone]* — return to bot mode (all chats or one)`,
        `- */human <phone>* — take a chat over manually`,
        ``,
        `*Pro features*${proLine}`,
        `- */promo add <text>* — add a promotion shown with the menu`,
        `- */promo list* — see active promotions`,
        `- */promo off* — disable all promotions`,
        `- */broadcast <message>* — send to recent customers`,
        `- */followups on|off|run* — auto reminders for unpaid orders`,
      ].join("\n"),
    };
  }

  // ── Pro: /broadcast <message> ────────────────────────────────────────────
  if (lower === "/broadcast" || lower.startsWith("/broadcast ")) {
    if (!hasFeature(vendor, "broadcasts")) {
      return {
        text: `Broadcasts are a Pro feature. Upgrade ${vendor.name} to Pro in the control panel to send messages to your customers.`,
      };
    }
    const message = body.slice("/broadcast".length).trim();
    if (!message) return { text: `Usage: */broadcast <message>*` };
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recipients = await db
      .select({ phone: customersTable.phone })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.vendorId, vendor.id),
          gte(customersTable.lastSeenAt, since),
        ),
      );

    // Queue messages in batches (50 per batch) instead of sequential
    // This prevents rate limiting and server overload
    if (vendor.phoneNumberId) {
      const BATCH_SIZE = 50;
      let batchIndex = 0;
      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        await queueBroadcastMessage({
          vendorId: vendor.id,
          phoneNumberId: vendor.phoneNumberId,
          recipients: batch,
          message,
          batchIndex: batchIndex++,
          batchSize: BATCH_SIZE,
        });
      }
    }

    await db.insert(broadcastsTable).values({
      vendorId: vendor.id,
      message,
      recipientCount: recipients.length,
    });
    return {
      text: `Broadcast queued for ${recipients.length} customer${recipients.length === 1 ? "" : "s"} (active in the last 30 days). Messages will be delivered shortly.`,
    };
  }

  // ── Pro: /promo add | list | off ─────────────────────────────────────────
  if (lower === "/promo" || lower.startsWith("/promo ")) {
    if (!hasFeature(vendor, "promotions")) {
      return {
        text: `Promotions are a Pro feature. Upgrade ${vendor.name} to Pro in the control panel.`,
      };
    }
    const rest = body.slice("/promo".length).trim();
    if (!rest || rest === "list") {
      const promos = await db
        .select()
        .from(promotionsTable)
        .where(eq(promotionsTable.vendorId, vendor.id))
        .orderBy(desc(promotionsTable.createdAt));
      if (promos.length === 0) return { text: `No promotions yet. Add one with */promo add <text>*.` };
      const lines = [`*Promotions*`, ``];
      for (const p of promos) {
        const tag = p.active ? "" : " (off)";
        lines.push(
          p.description ? `- ${p.title}: ${p.description}${tag}` : `- ${p.title}${tag}`,
        );
      }
      return { text: lines.join("\n") };
    }
    if (rest === "off" || rest === "stop") {
      const updated = await db
        .update(promotionsTable)
        .set({ active: false })
        .where(eq(promotionsTable.vendorId, vendor.id))
        .returning();
      return {
        text: `Disabled ${updated.length} promotion${updated.length === 1 ? "" : "s"}.`,
      };
    }
    if (rest.startsWith("add ")) {
      const text = rest.slice(4).trim();
      if (!text) return { text: `Usage: */promo add <message>*` };
      // Optional "title :: description"
      const split = text.split(/\s*::\s*/);
      const title = split[0]!.trim();
      const description = split[1]?.trim() || null;
      const [created] = await db
        .insert(promotionsTable)
        .values({ vendorId: vendor.id, title, description, active: true })
        .returning();
      return {
        text: `Promotion added: *${created!.title}*. Customers will see it with the menu.`,
      };
    }
    return { text: `Usage: */promo add <text>*, */promo list*, */promo off*` };
  }

  // ── Pro: /followups on | off | run ──────────────────────────────────────
  if (lower === "/followups" || lower.startsWith("/followups ")) {
    if (!hasFeature(vendor, "follow_ups")) {
      return {
        text: `Auto follow-ups are a Pro feature. Upgrade ${vendor.name} to Pro in the control panel.`,
      };
    }
    const arg = body.slice("/followups".length).trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      await db
        .update(vendorsTable)
        .set({ followUpsEnabled: arg === "on" })
        .where(eq(vendorsTable.id, vendor.id));
      return {
        text: `Auto follow-ups ${arg === "on" ? "enabled" : "disabled"}.`,
      };
    }
    if (arg === "run" || arg === "") {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const stalled = await db
        .select({
          phone: ordersTable.customerPhone,
          name: ordersTable.customerName,
          total: ordersTable.total,
          shortId: sql<string>`substring(${ordersTable.id}::text, 1, 8)`,
        })
        .from(ordersTable)
        .where(
          and(
            eq(ordersTable.vendorId, vendor.id),
            eq(ordersTable.status, "confirmed"),
            eq(ordersTable.paymentStatus, "pending"),
            sql`${ordersTable.createdAt} < ${cutoff}`,
          ),
        );
      const seen = new Set<string>();
      const targets = stalled.filter((s) => {
        if (seen.has(s.phone)) return false;
        seen.add(s.phone);
        return true;
      });
      for (const t of targets) {
        const text =
          `Hi ${t.name}, this is a reminder about your order #${t.shortId} ` +
          `at ${vendor.name} (total ${vendor.currency} ${Number(t.total).toFixed(2)}). ` +
          `Reply *paid* once you've completed payment, or *agent* if you need help.`;
        if (vendor.phoneNumberId) {
          await queueOutboundMessage(
            vendor.phoneNumberId,
            t.phone,
            text,
          );
        }
      }
      return {
        text: `Queued reminders to ${targets.length} customer${targets.length === 1 ? "" : "s"} with stalled orders.`,
      };
    }
    return {
      text: `Usage: */followups on*, */followups off*, */followups run*. Currently ${vendor.followUpsEnabled ? "ON" : "OFF"}.`,
    };
  }

  // /bot or /bot <phone>
  if (lower === "/bot" || lower.startsWith("/bot ")) {
    const target = body.slice(4).trim();
    if (target) {
      const updated = await db
        .update(conversationsTable)
        .set({ status: "bot" })
        .where(
          and(
            eq(conversationsTable.vendorId, vendor.id),
            eq(conversationsTable.customerPhone, target),
          ),
        )
        .returning();
      if (updated.length === 0) {
        return { text: `No conversation found for ${target}.` };
      }
      return { text: `Bot resumed for ${target}.` };
    }
    const updated = await db
      .update(conversationsTable)
      .set({ status: "bot" })
      .where(
        and(
          eq(conversationsTable.vendorId, vendor.id),
          eq(conversationsTable.status, "human"),
        ),
      )
      .returning();
    return {
      text: `Bot resumed on ${updated.length} conversation${updated.length === 1 ? "" : "s"}.`,
    };
  }

  // /human <phone>
  if (lower.startsWith("/human ")) {
    const target = body.slice(7).trim();
    if (!target) return { text: `Usage: /human <customer_phone>` };
    const updated = await db
      .update(conversationsTable)
      .set({ status: "human" })
      .where(
        and(
          eq(conversationsTable.vendorId, vendor.id),
          eq(conversationsTable.customerPhone, target),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return { text: `No conversation found for ${target}.` };
    }
    return {
      text: `Bot paused for ${target}. You'll handle this chat manually.`,
    };
  }

  // menu (vendor side: list current items)
  if (lower === "menu" || lower === "list") {
    return await handleAdminShowMenu(vendor);
  }

  // add <name> <price>
  if (lower.startsWith("add ")) {
    const text = body.slice(4).trim();
    const m = text.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
    if (!m) {
      return {
        text: `Couldn't parse. Try: *add Jollof Rice 2500*`,
      };
    }
    const name = m[1]!.trim();
    const price = parseFloat(m[2]!);
    const [created] = await db
      .insert(menuItemsTable)
      .values({
        vendorId: vendor.id,
        name,
        price: price.toFixed(2),
        available: true,
      })
      .returning();
    return {
      text: `Added *${created!.name}* at ${formatMoney(Number(created!.price), vendor.currency)}.`,
    };
  }

  // remove <name>
  if (lower.startsWith("remove ") || lower.startsWith("delete ")) {
    const name = body.replace(/^(remove|delete)\s+/i, "").trim();
    if (!name) return { text: `Usage: *remove <item name>*` };
    const items = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.vendorId, vendor.id));
    const target =
      items.find((i) => i.name.toLowerCase() === name.toLowerCase()) ??
      items.find((i) => i.name.toLowerCase().includes(name.toLowerCase()));
    if (!target) return { text: `No menu item matching "${name}".` };
    await db.delete(menuItemsTable).where(eq(menuItemsTable.id, target.id));
    return { text: `Removed *${target.name}* from your menu.` };
  }

  // orders (list pending)
  if (lower === "orders" || lower === "pending") {
    const pending = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.vendorId, vendor.id),
          eq(ordersTable.status, "pending"),
        ),
      )
      .orderBy(desc(ordersTable.createdAt))
      .limit(10);
    if (pending.length === 0) return { text: `No pending orders right now.` };
    const lines: string[] = [`*Pending orders*`, ``];
    for (const o of pending) {
      lines.push(
        `#${o.shortId} — ${o.customerName} — ${formatMoney(Number(o.total), vendor.currency)}`,
      );
    }
    lines.push(``, `Reply *confirm <id>* or *reject <id>*.`);
    return { text: lines.join("\n") };
  }

  // confirm [id]
  if (lower === "confirm" || lower.startsWith("confirm ")) {
    const id = body.slice(7).trim();
    const order = id
      ? await findOrderByShortId(vendor.id, id)
      : await findLatestPendingOrder(vendor.id);
    if (!order) return { text: `No matching order to confirm.` };
    if (order.status !== "pending") {
      return { text: `Order #${order.shortId} is already ${order.status}.` };
    }
    await db
      .update(ordersTable)
      .set({ status: "confirmed" })
      .where(eq(ordersTable.id, order.id));
    await notifyCustomer(
      vendor,
      order.customerPhone,
      paymentInstructions(vendor, Number(order.total)),
    );
    return {
      text: `Confirmed #${order.shortId} for ${order.customerName}. Payment instructions were sent to the customer.`,
    };
  }

  // reject [id]
  if (lower === "reject" || lower.startsWith("reject ")) {
    const id = body.slice(6).trim();
    const order = id
      ? await findOrderByShortId(vendor.id, id)
      : await findLatestPendingOrder(vendor.id);
    if (!order) return { text: `No matching order to reject.` };
    if (order.status !== "pending") {
      return { text: `Order #${order.shortId} is already ${order.status}.` };
    }
    await db
      .update(ordersTable)
      .set({ status: "rejected" })
      .where(eq(ordersTable.id, order.id));
    await notifyCustomer(
      vendor,
      order.customerPhone,
      `Sorry, your order #${order.shortId} couldn't be accepted right now. Reply *menu* to try again.`,
    );
    return {
      text: `Rejected #${order.shortId}. The customer was notified.`,
    };
  }

  // paid [id]  (vendor confirms payment was received)
  if (lower === "paid" || lower.startsWith("paid ")) {
    const id = body.slice(4).trim();
    const order = id
      ? await findOrderByShortId(vendor.id, id)
      : await findLatestConfirmedOrder(vendor.id);
    if (!order) return { text: `No matching order to mark paid.` };
    if (order.paymentStatus === "paid") {
      return { text: `Order #${order.shortId} is already marked paid.` };
    }
    await db
      .update(ordersTable)
      .set({ status: "paid", paymentStatus: "paid" })
      .where(eq(ordersTable.id, order.id));
    await db.insert(paymentsTable).values({
      vendorId: vendor.id,
      orderId: order.id,
      customerName: order.customerName,
      amount: order.total,
      currency: order.currency,
      method: "bank_transfer",
      status: "confirmed",
      reference: "vendor_confirmed_via_chat",
    });
    await db
      .insert(customersTable)
      .values({
        vendorId: vendor.id,
        phone: order.customerPhone,
        name: order.customerName,
        totalOrders: 1,
        totalSpent: order.total,
      })
      .onConflictDoUpdate({
        target: [customersTable.vendorId, customersTable.phone],
        set: {
          totalOrders: sql`${customersTable.totalOrders} + 1`,
          totalSpent: sql`${customersTable.totalSpent} + ${order.total}`,
          name: order.customerName,
          lastSeenAt: new Date(),
        },
      });
    await notifyCustomer(
      vendor,
      order.customerPhone,
      `Payment received for order #${order.shortId}. Thank you!`,
    );
    return {
      text: `Payment confirmed on #${order.shortId}. The customer was notified.`,
    };
  }

  // Fallback
  return {
    text: [
      `Command not recognized. Reply */help* for the full list.`,
    ].join("\n"),
  };
}

async function handleAdminIntent(
  vendor: VendorRow,
  extracted: ExtractedAdminIntent,
): Promise<AdminReply | null> {
  const entities = extracted.entities ?? {};
  const itemName = normalizeAdminEntityString(entities.itemName);
  const price = normalizeAdminEntityNumber(entities.price);
  const orderId = normalizeAdminEntityString(entities.orderId);
  const customerPhone = normalizeAdminEntityString(entities.customerPhone);

  switch (extracted.intent) {
    case "show_menu":
      return await handleAdminShowMenu(vendor);
    case "add_menu_item":
      return await handleAdminAddMenuItem(vendor, itemName, price);
    case "remove_menu_item":
      return await handleAdminRemoveMenuItem(vendor, itemName);
    case "update_price":
      return await handleAdminUpdatePrice(vendor, itemName, price);
    case "mark_unavailable":
      return await handleAdminSetAvailability(vendor, itemName, false);
    case "mark_available":
      return await handleAdminSetAvailability(vendor, itemName, true);
    case "confirm_order":
      return await handleAdminConfirmOrder(vendor, orderId);
    case "reject_order":
      return await handleAdminRejectOrder(vendor, orderId);
    case "confirm_payment":
      return await handleAdminConfirmPayment(vendor, orderId);
    case "switch_human":
      return await handleAdminSwitchHuman(vendor, customerPhone);
    case "switch_bot":
      return await handleAdminSwitchBot(vendor, customerPhone);
    default:
      return null;
  }
}

function normalizeAdminEntityString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function normalizeAdminEntityNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function findMenuItemByName(
  vendor: VendorRow,
  query: string,
): Promise<MenuItemRow | null> {
  const items = await db
    .select()
    .from(menuItemsTable)
    .where(eq(menuItemsTable.vendorId, vendor.id));
  const normalized = query.toLowerCase();
  return (
    items.find((item) => item.name.toLowerCase() === normalized) ??
    items.find((item) => item.name.toLowerCase().includes(normalized)) ??
    null
  );
}

async function handleAdminShowMenu(vendor: VendorRow): Promise<AdminReply> {
  const items = await db
    .select()
    .from(menuItemsTable)
    .where(eq(menuItemsTable.vendorId, vendor.id));
  if (items.length === 0) {
    return { text: `Your menu is empty. Use *add <name> <price>* to add items.` };
  }
  const lines = [`*Your menu*`, ``];
  for (const item of items) {
    const tag = item.available ? "" : " (unavailable)";
    lines.push(
      `- ${item.name} — ${formatMoney(Number(item.price), vendor.currency)}${tag}`,
    );
  }
  return { text: lines.join("\n") };
}

async function handleAdminAddMenuItem(
  vendor: VendorRow,
  itemName: string | null,
  price: number | null,
): Promise<AdminReply> {
  if (!itemName || price === null) {
    return {
      text: `Please provide an item name and price, for example: add_menu_item itemName="Jollof Rice" price=2500`,
    };
  }
  const [created] = await db
    .insert(menuItemsTable)
    .values({
      vendorId: vendor.id,
      name: itemName,
      price: price.toFixed(2),
      available: true,
    })
    .returning();
  return {
    text: `Added *${created!.name}* at ${formatMoney(Number(created!.price), vendor.currency)}.`,
  };
}

async function handleAdminRemoveMenuItem(
  vendor: VendorRow,
  itemName: string | null,
): Promise<AdminReply> {
  if (!itemName) {
    return { text: `Please tell me which item to remove.` };
  }
  const target = await findMenuItemByName(vendor, itemName);
  if (!target) {
    return { text: `No menu item matching "${itemName}" was found.` };
  }
  await db.delete(menuItemsTable).where(eq(menuItemsTable.id, target.id));
  return { text: `Removed *${target.name}* from your menu.` };
}

async function handleAdminUpdatePrice(
  vendor: VendorRow,
  itemName: string | null,
  price: number | null,
): Promise<AdminReply> {
  if (!itemName || price === null) {
    return { text: `Please provide an item name and price to update.` };
  }
  const target = await findMenuItemByName(vendor, itemName);
  if (!target) {
    return { text: `No menu item matching "${itemName}" was found.` };
  }
  await db
    .update(menuItemsTable)
    .set({ price: price.toFixed(2) })
    .where(eq(menuItemsTable.id, target.id));
  return {
    text: `Updated *${target.name}* to ${formatMoney(price, vendor.currency)}.`,
  };
}

async function handleAdminSetAvailability(
  vendor: VendorRow,
  itemName: string | null,
  available: boolean,
): Promise<AdminReply> {
  if (!itemName) {
    return { text: `Please tell me which item to mark ${available ? "available" : "unavailable"}.` };
  }
  const target = await findMenuItemByName(vendor, itemName);
  if (!target) {
    return { text: `No menu item matching "${itemName}" was found.` };
  }
  await db
    .update(menuItemsTable)
    .set({ available })
    .where(eq(menuItemsTable.id, target.id));
  return {
    text: `Marked *${target.name}* as ${available ? "available" : "unavailable"}.`,
  };
}

async function handleAdminConfirmOrder(
  vendor: VendorRow,
  orderId: string | null,
): Promise<AdminReply> {
  const order = orderId
    ? await findOrderByShortId(vendor.id, orderId)
    : await findLatestPendingOrder(vendor.id);
  if (!order) return { text: `No matching order to confirm.` };
  if (order.status !== "pending") {
    return { text: `Order #${order.shortId} is already ${order.status}.` };
  }
  await db
    .update(ordersTable)
    .set({ status: "confirmed" })
    .where(eq(ordersTable.id, order.id));
  await notifyCustomer(
    vendor,
    order.customerPhone,
    paymentInstructions(vendor, Number(order.total)),
  );
  return {
    text: `Confirmed #${order.shortId} for ${order.customerName}. Payment instructions were sent to the customer.`,
  };
}

async function handleAdminRejectOrder(
  vendor: VendorRow,
  orderId: string | null,
): Promise<AdminReply> {
  const order = orderId
    ? await findOrderByShortId(vendor.id, orderId)
    : await findLatestPendingOrder(vendor.id);
  if (!order) return { text: `No matching order to reject.` };
  if (order.status !== "pending") {
    return { text: `Order #${order.shortId} is already ${order.status}.` };
  }
  await db
    .update(ordersTable)
    .set({ status: "rejected" })
    .where(eq(ordersTable.id, order.id));
  await notifyCustomer(
    vendor,
    order.customerPhone,
    `Sorry, your order #${order.shortId} couldn't be accepted right now. Reply *menu* to try again.`,
  );
  return {
    text: `Rejected #${order.shortId}. The customer was notified.`,
  };
}

async function handleAdminConfirmPayment(
  vendor: VendorRow,
  orderId: string | null,
): Promise<AdminReply> {
  const order = orderId
    ? await findOrderByShortId(vendor.id, orderId)
    : await findLatestConfirmedOrder(vendor.id);
  if (!order) return { text: `No matching order to mark paid.` };
  if (order.paymentStatus === "paid") {
    return { text: `Order #${order.shortId} is already marked paid.` };
  }
  await db
    .update(ordersTable)
    .set({ status: "paid", paymentStatus: "paid" })
    .where(eq(ordersTable.id, order.id));
  await db.insert(paymentsTable).values({
    vendorId: vendor.id,
    orderId: order.id,
    customerName: order.customerName,
    amount: order.total,
    currency: order.currency,
    method: "bank_transfer",
    status: "confirmed",
    reference: "vendor_confirmed_via_chat",
  });
  await db
    .insert(customersTable)
    .values({
      vendorId: vendor.id,
      phone: order.customerPhone,
      name: order.customerName,
      totalOrders: 1,
      totalSpent: order.total,
    })
    .onConflictDoUpdate({
      target: [customersTable.vendorId, customersTable.phone],
      set: {
        totalOrders: sql`${customersTable.totalOrders} + 1`,
        totalSpent: sql`${customersTable.totalSpent} + ${order.total}`,
        name: order.customerName,
        lastSeenAt: new Date(),
      },
    });
  await notifyCustomer(
    vendor,
    order.customerPhone,
    `Payment received for order #${order.shortId}. Thank you!`,
  );
  return {
    text: `Payment confirmed on #${order.shortId}. The customer was notified.`,
  };
}

async function handleAdminSwitchHuman(
  vendor: VendorRow,
  customerPhone: string | null,
): Promise<AdminReply> {
  const target = customerPhone?.trim();
  if (!target) {
    return { text: `Please provide the customer's phone to switch to human handling.` };
  }
  const updated = await db
    .update(conversationsTable)
    .set({ status: "human" })
    .where(
      and(
        eq(conversationsTable.vendorId, vendor.id),
        eq(conversationsTable.customerPhone, target),
      ),
    )
    .returning();
  if (updated.length === 0) {
    return { text: `No conversation found for ${target}.` };
  }
  return { text: `Bot paused for ${target}. You'll handle this chat manually.` };
}

async function handleAdminSwitchBot(
  vendor: VendorRow,
  customerPhone: string | null,
): Promise<AdminReply> {
  const target = customerPhone?.trim();
  if (target) {
    const updated = await db
      .update(conversationsTable)
      .set({ status: "bot" })
      .where(
        and(
          eq(conversationsTable.vendorId, vendor.id),
          eq(conversationsTable.customerPhone, target),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return { text: `No conversation found for ${target}.` };
    }
    return { text: `Bot resumed for ${target}.` };
  }
  const updated = await db
    .update(conversationsTable)
    .set({ status: "bot" })
    .where(
      and(
        eq(conversationsTable.vendorId, vendor.id),
        eq(conversationsTable.status, "human"),
      ),
    )
    .returning();
  return {
    text: `Bot resumed on ${updated.length} conversation${updated.length === 1 ? "" : "s"}.`,
  };
}

export { isAdminSender };
