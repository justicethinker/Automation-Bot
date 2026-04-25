import { db } from "@workspace/db";
import {
  vendorsTable,
  type VendorRow,
  menuItemsTable,
  type MenuItemRow,
  ordersTable,
  type OrderItemJson,
  type OrderRow,
  conversationsTable,
  type ConversationRow,
  messagesTable,
  customersTable,
  paymentsTable,
  promotionsTable,
  broadcastsTable,
} from "@workspace/db";
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { sendWhatsAppMessage } from "./whatsapp";
import { hasFeature } from "./plans";

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
//   "order margherita x2"  -> by name (legacy)
//   "2 margherita"    -> 2× margherita (qty-first)
type ParsedItem =
  | { kind: "number"; index: number; quantity: number }
  | { kind: "name"; name: string; quantity: number };

function parseOrderLine(body: string): ParsedItem[] {
  const text = body.replace(/^order\s+/i, "").trim();
  if (!text) return [];
  const parts = text
    .split(/[,;\n]| and /i)
    .map((s) => s.trim())
    .filter(Boolean);
  const result: ParsedItem[] = [];
  for (const part of parts) {
    // Pure number forms: "3", "3x2", "3 x 2", "3*2"
    const numMatch = part.match(/^(\d+)\s*(?:[x×*]\s*(\d+))?$/i);
    if (numMatch) {
      const index = parseInt(numMatch[1]!, 10);
      const qty = numMatch[2] ? parseInt(numMatch[2]!, 10) : 1;
      if (index > 0 && qty > 0) {
        result.push({ kind: "number", index, quantity: qty });
        continue;
      }
    }
    // "<qty> <name>" e.g. "2 margherita"
    const qtyFirst = part.match(/^(\d+)\s+(.+)$/);
    if (qtyFirst) {
      const qty = parseInt(qtyFirst[1]!, 10);
      const name = qtyFirst[2]!.trim();
      if (qty > 0 && name) {
        result.push({ kind: "name", name, quantity: qty });
        continue;
      }
    }
    // "<name> x<qty>" or just "<name>"
    const nameMatch = part.match(/^(.*?)(?:\s*[x×*]\s*(\d+))?$/i);
    if (nameMatch) {
      const name = nameMatch[1]!.trim();
      const qty = nameMatch[2] ? parseInt(nameMatch[2]!, 10) : 1;
      if (name && qty > 0) result.push({ kind: "name", name, quantity: qty });
    }
  }
  return result;
}

// Detects "order intent" without false positives on chit-chat.
// Triggers on: explicit "order" prefix, anything that looks like a number-pick
// ("1", "1x2", "1,2,3"), or qty markers ("x2").
function looksLikeOrder(body: string): boolean {
  const trimmed = body.trim();
  if (startsWithAny(trimmed, orderTriggers)) return true;
  if (/^[\d, x×*]+$/i.test(trimmed)) return true;
  if (/\b[x×]\s?\d+\b/i.test(trimmed)) return true;
  return false;
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
  const existing = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.vendorId, vendor.id),
        eq(conversationsTable.customerPhone, customerPhone),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(conversationsTable)
    .values({
      vendorId: vendor.id,
      customerPhone,
      customerName,
    })
    .returning();
  return created!;
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

function isAdminSender(vendor: VendorRow, fromPhone: string): boolean {
  if (!vendor.adminNumber) return false;
  // Normalize: strip spaces and a single leading '+' for comparison.
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/^\+/, "");
  return norm(vendor.adminNumber) === norm(fromPhone);
}

export async function handleIncomingMessage(args: {
  vendor: VendorRow;
  fromPhone: string;
  fromName: string;
  body: string;
}): Promise<IncomingResult> {
  const { vendor, fromPhone, fromName, body } = args;

  // Admin (vendor's personal number) -> admin command flow.
  if (isAdminSender(vendor, fromPhone)) {
    const reply = await handleAdminCommand(vendor, body);
    if (reply.text) {
      await sendWhatsAppMessage({
        phoneNumberId: vendor.phoneNumberId,
        to: fromPhone,
        text: reply.text,
      });
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

  if (reply.text) {
    await recordMessage(conversation.id, "out", "bot", reply.text);
    await sendWhatsAppMessage({
      phoneNumberId: vendor.phoneNumberId,
      to: fromPhone,
      text: reply.text,
    });
  }

  // Notify the vendor's admin number when a new order was just placed,
  // or when handover was requested.
  let adminNotification: string | null = null;
  if (reply.adminAlert && vendor.adminNumber) {
    adminNotification = reply.adminAlert;
    await sendWhatsAppMessage({
      phoneNumberId: vendor.phoneNumberId,
      to: vendor.adminNumber,
      text: reply.adminAlert,
    });
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
  // Human handover request
  if (includesAny(body, agentTriggers)) {
    return {
      text: `Connecting you to a human agent now. Someone will reply here shortly.`,
      handover: true,
      adminAlert: `Handover requested by ${conversation.customerName} (${conversation.customerPhone}). Reply in WhatsApp to take over.`,
    };
  }

  // Help / commands
  if (startsWithAny(body, helpTriggers)) {
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
      adminAlert: `Customer ${conversation.customerName} (${conversation.customerPhone}) reports payment for order #${target.id.slice(0, 8)} (${formatMoney(Number(target.total), vendor.currency)}). Reply *paid ${target.id.slice(0, 8)}* once verified.`,
    };
  }

  // Order detection (number picks, "order <name>", "<qty> <name>", etc.)
  if (looksLikeOrder(body)) {
    const requested = parseOrderLine(body);
    if (requested.length === 0) {
      return {
        text: `I didn't catch that. Reply *menu* to see the list, then send the number(s) you want — e.g. "1" or "1, 3x2, 5".`,
        handover: false,
      };
    }
    const allItems = await listActiveMenuItems(vendor);
    if (allItems.length === 0) {
      return {
        text: `Our menu is being updated. Please check back soon.`,
        handover: false,
      };
    }
    const matched: OrderItemJson[] = [];
    const missing: string[] = [];
    for (const r of requested) {
      let found: MenuItemRow | undefined;
      if (r.kind === "number") {
        found = allItems[r.index - 1];
        if (!found) {
          missing.push(`#${r.index}`);
          continue;
        }
      } else {
        found =
          allItems.find(
            (m) => m.name.toLowerCase() === r.name.toLowerCase(),
          ) ??
          allItems.find((m) =>
            m.name.toLowerCase().includes(r.name.toLowerCase()),
          );
        if (!found) {
          missing.push(r.name);
          continue;
        }
      }
      // Combine duplicates (e.g. "1, 1x2" -> 3× item #1)
      const existing = matched.find((m) => m.name === found!.name);
      if (existing) {
        existing.quantity += r.quantity;
      } else {
        matched.push({
          name: found.name,
          quantity: r.quantity,
          unitPrice: Number(found.price),
        });
      }
    }
    if (matched.length === 0) {
      return {
        text: `I couldn't find ${missing.join(", ")} on the menu. Reply *menu* to see what's available.`,
        handover: false,
      };
    }
    const total = matched.reduce(
      (sum, i) => sum + i.unitPrice * i.quantity,
      0,
    );
    const [order] = await db
      .insert(ordersTable)
      .values({
        vendorId: vendor.id,
        customerPhone: conversation.customerPhone,
        customerName: conversation.customerName,
        status: "pending",
        paymentStatus: "pending",
        total: total.toFixed(2),
        currency: vendor.currency,
        items: matched,
        notes: missing.length > 0 ? `Not on menu: ${missing.join(", ")}` : null,
      })
      .returning();
    const lines: string[] = [`*Order received*`, ``];
    for (const item of matched) {
      lines.push(
        `- ${item.quantity}× ${item.name} — ${formatMoney(item.unitPrice * item.quantity, vendor.currency)}`,
      );
    }
    lines.push(``, `Total: *${formatMoney(total, vendor.currency)}*`);
    if (missing.length > 0) {
      lines.push(``, `Not on menu: ${missing.join(", ")}`);
    }
    lines.push(
      ``,
      `The vendor will confirm shortly. Order #${order!.id.slice(0, 8)}.`,
    );
    const adminLines: string[] = [
      `*New order from ${conversation.customerName}* (${conversation.customerPhone})`,
      ``,
    ];
    for (const item of matched) {
      adminLines.push(
        `- ${item.quantity}× ${item.name} — ${formatMoney(item.unitPrice * item.quantity, vendor.currency)}`,
      );
    }
    adminLines.push(
      ``,
      `Total: ${formatMoney(total, vendor.currency)}`,
      ``,
      `Reply *confirm ${order!.id.slice(0, 8)}* or *reject ${order!.id.slice(0, 8)}*.`,
    );
    return {
      text: lines.join("\n"),
      handover: false,
      adminAlert: adminLines.join("\n"),
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

async function findOrderByShortId(
  vendorId: string,
  shortId: string,
): Promise<OrderRow | null> {
  const all = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.vendorId, vendorId))
    .orderBy(desc(ordersTable.createdAt));
  return all.find((o) => o.id.startsWith(shortId.toLowerCase())) ?? null;
}

async function findLatestPendingOrder(vendorId: string): Promise<OrderRow | null> {
  const rows = await db
    .select()
    .from(ordersTable)
    .where(
      and(eq(ordersTable.vendorId, vendorId), eq(ordersTable.status, "pending")),
    )
    .orderBy(desc(ordersTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function findLatestConfirmedOrder(
  vendorId: string,
): Promise<OrderRow | null> {
  const rows = await db
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
  return rows[0] ?? null;
}

async function notifyCustomer(
  vendor: VendorRow,
  customerPhone: string,
  text: string,
): Promise<void> {
  // Record in their conversation if one exists, plus push to WhatsApp.
  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.vendorId, vendor.id),
        eq(conversationsTable.customerPhone, customerPhone),
      ),
    )
    .limit(1);
  if (conv) {
    await recordMessage(conv.id, "out", "vendor", text);
  }
  await sendWhatsAppMessage({
    phoneNumberId: vendor.phoneNumberId,
    to: customerPhone,
    text,
  });
}

export async function handleAdminCommand(
  vendor: VendorRow,
  raw: string,
): Promise<AdminReply> {
  const body = raw.trim();
  const lower = body.toLowerCase();

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
    for (const r of recipients) {
      await sendWhatsAppMessage({
        phoneNumberId: vendor.phoneNumberId,
        to: r.phone,
        text: message,
      });
    }
    await db.insert(broadcastsTable).values({
      vendorId: vendor.id,
      message,
      recipientCount: recipients.length,
    });
    return {
      text: `Broadcast sent to ${recipients.length} customer${recipients.length === 1 ? "" : "s"} (active in the last 30 days).`,
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
        await sendWhatsAppMessage({
          phoneNumberId: vendor.phoneNumberId,
          to: t.phone,
          text,
        });
      }
      return {
        text: `Sent reminders to ${targets.length} customer${targets.length === 1 ? "" : "s"} with stalled orders.`,
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
    const items = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.vendorId, vendor.id));
    if (items.length === 0) return { text: `Your menu is empty. Use *add <name> <price>* to add items.` };
    const lines = [`*Your menu*`, ``];
    for (const item of items) {
      const tag = item.available ? "" : " (unavailable)";
      lines.push(
        `- ${item.name} — ${formatMoney(Number(item.price), vendor.currency)}${tag}`,
      );
    }
    return { text: lines.join("\n") };
  }

  // add <name> <price>
  if (lower.startsWith("add ") || /^[a-z].* \d+(\.\d+)?$/i.test(body)) {
    const text = lower.startsWith("add ") ? body.slice(4).trim() : body;
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
        `#${o.id.slice(0, 8)} — ${o.customerName} — ${formatMoney(Number(o.total), vendor.currency)}`,
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
      return { text: `Order #${order.id.slice(0, 8)} is already ${order.status}.` };
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
      text: `Confirmed #${order.id.slice(0, 8)} for ${order.customerName}. Payment instructions were sent to the customer.`,
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
      return { text: `Order #${order.id.slice(0, 8)} is already ${order.status}.` };
    }
    await db
      .update(ordersTable)
      .set({ status: "rejected" })
      .where(eq(ordersTable.id, order.id));
    await notifyCustomer(
      vendor,
      order.customerPhone,
      `Sorry, your order #${order.id.slice(0, 8)} couldn't be accepted right now. Reply *menu* to try again.`,
    );
    return {
      text: `Rejected #${order.id.slice(0, 8)}. The customer was notified.`,
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
      return { text: `Order #${order.id.slice(0, 8)} is already marked paid.` };
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
      `Payment received for order #${order.id.slice(0, 8)}. Thank you!`,
    );
    return {
      text: `Payment confirmed on #${order.id.slice(0, 8)}. The customer was notified.`,
    };
  }

  // Fallback
  return {
    text: [
      `Command not recognized. Reply */help* for the full list.`,
    ].join("\n"),
  };
}

export { isAdminSender };
