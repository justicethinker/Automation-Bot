# Automation-Bot Full Audit Implementation Prompt

You are working on a production WhatsApp commerce automation platform called **Vendor Connect Hub** (also referenced as Automation-Bot). The codebase is a pnpm monorepo with the following structure:

```
artifacts/
  api-server/        → Express.js + TypeScript backend
  control-panel/     → React + Vite admin dashboard
  mockup-sandbox/    → Design prototypes (not relevant here)
lib/
  db/                → Drizzle ORM schema + Supabase/PostgreSQL
  api-spec/          → OpenAPI YAML spec
  api-client-react/  → Auto-generated React query hooks
  api-zod/           → Auto-generated Zod validation schemas
```

Your task is to implement **all of the following improvements in a single pass**. Read every section carefully before making any changes. Each fix is described with exact file locations, the problem, and the required implementation.

---

## SECTION 1 — CRITICAL BUGS (fix these first)

### 1.1 — Double res.json() crash in vendor detail route

**File:** `artifacts/api-server/src/routes/vendors.ts`
**Problem:** The `GET /vendors/:vendorId` handler calls `res.json()` twice with the same payload at the bottom of the function. Express throws "Cannot set headers after they are sent" on the second call, crashing the vendor overview page.
**Fix:** Find the second `return res.json({ ...toVendor(v), stats: { ... } })` call at the very end of that handler and delete it entirely. Keep only the first one.

---

### 1.2 — Idempotency check missing on order creation

**File:** `artifacts/api-server/src/lib/bot.ts`
**Problem:** `createOrderWithLock` never calls the idempotency functions from `idempotency.ts`, so a customer double-tapping "yes" creates duplicate orders.
**Fix:** Update `createOrderWithLock` as follows:

```typescript
import { generateOrderIdempotencyKey, checkIdempotencyKey, recordIdempotencyKey } from "./idempotency";

async function createOrderWithLock(
  vendorId: string,
  customerPhone: string,
  customerName: string,
  orderItems: Array<{ item: MenuItemRow; quantity: number }>,
  vendor: VendorRow,
): Promise<OrderRow | null> {
  try {
    // Generate idempotency key from stable inputs
    const itemSignature = orderItems.map(i => `${i.item.id}:${i.quantity}`).sort().join("|");
    const idempotencyKey = generateOrderIdempotencyKey(vendorId, customerPhone, itemSignature);

    // Check if this exact order was already created
    const existing = await checkIdempotencyKey(idempotencyKey);
    if (existing) {
      // Return the already-created order
      const [existingOrder] = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.id, existing.id))
        .limit(1);
      return existingOrder ?? null;
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
      await recordIdempotencyKey(idempotencyKey, order.id, "order");
    }

    return order ?? null;
  } catch (err) {
    logger.error({ err, vendorId, customerPhone }, "Failed to create order");
    return null;
  }
}
```

---

### 1.3 — Race condition in findOrCreateConversation

**File:** `artifacts/api-server/src/lib/bot.ts`
**Problem:** Two concurrent messages from the same customer both pass the SELECT check, both find no conversation, both try INSERT, second one crashes with a unique constraint violation.
**Fix:** Replace the SELECT + INSERT pattern with a single upsert using ON CONFLICT:

```typescript
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
```

This requires that a UNIQUE constraint exists on `(vendor_id, customer_phone)` in the conversations table — add it in the schema if it does not already exist (see Section 4.1 for index/constraint additions).

---

### 1.4 — broadcastQueue never populated

**File:** `artifacts/api-server/src/lib/bot.ts` (the `/broadcast` handler), `artifacts/api-server/src/lib/queue.ts`, `artifacts/api-server/src/lib/queue-workers.ts`

**Problem:** The `/broadcast` admin command uses `queueOutboundMessage` instead of the dedicated `broadcastQueue`. The broadcast queue infrastructure is dead.

**Step A:** In `queue.ts`, ensure a `queueBroadcastMessage` export exists:

```typescript
export type BroadcastMessageJob = {
  vendorId: string;
  phoneNumberId: string;
  recipients: Array<{ phone: string }>;
  message: string;
  batchIndex: number;
};

export async function queueBroadcastMessage(job: BroadcastMessageJob): Promise<void> {
  await broadcastQueue.add(job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}
```

**Step B:** In `bot.ts`, replace the `/broadcast` send loop:

```typescript
// Replace the loop that calls queueOutboundMessage for each recipient with:
const BATCH_SIZE = 50;
let batchIndex = 0;
for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
  const batch = recipients.slice(i, i + BATCH_SIZE);
  await queueBroadcastMessage({
    vendorId: vendor.id,
    phoneNumberId: vendor.phoneNumberId!,
    recipients: batch,
    message,
    batchIndex: batchIndex++,
  });
}
```

**Step C:** In `queue-workers.ts`, verify the `broadcastQueue.process` worker is sending correctly to each recipient in the batch and logging properly.

---

## SECTION 2 — SECURITY

### 2.1 — API route authentication

**File:** Create new file `artifacts/api-server/src/middleware/auth.ts`

**Problem:** All REST routes are completely open with no authentication.
**Fix:** Implement API key middleware:

```typescript
import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] ?? req.headers["authorization"]?.replace("Bearer ", "");
  const validKey = process.env.API_SECRET_KEY;

  if (!validKey) {
    logger.error("API_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "server_configuration_error" });
  }

  if (!apiKey || apiKey !== validKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
}
```

**File:** `artifacts/api-server/src/app.ts`
Apply the middleware to all non-webhook routes:

```typescript
import { requireApiKey } from "./middleware/auth";

// Apply auth to all routes EXCEPT webhook endpoints
app.use("/vendors", requireApiKey);
app.use("/orders", requireApiKey);
app.use("/conversations", requireApiKey);
app.use("/customers", requireApiKey);
app.use("/menu", requireApiKey);
app.use("/payments", requireApiKey);
app.use("/promotions", requireApiKey);
app.use("/broadcasts", requireApiKey);
app.use("/dashboard", requireApiKey);
// Do NOT protect /webhook/messages or /webhook/whatsapp
```

Add `API_SECRET_KEY` to `.env.example` with a comment explaining it should be a long random string.

Also add `API_SECRET_KEY` to the required environment variables check in `artifacts/api-server/src/index.ts`:

```typescript
const required = [
  "PORT",
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "VERIFY_TOKEN",
  "ACCESS_TOKEN",
  "API_SECRET_KEY",  // Add this
];
```

Update the control panel to send this key in all API requests. In `artifacts/control-panel`, find where the API client or axios/fetch instance is configured and add the header:

```typescript
headers: {
  "x-api-key": import.meta.env.VITE_API_SECRET_KEY,
}
```

Add `VITE_API_SECRET_KEY` to the control panel's `.env.example`.

---

### 2.2 — Webhook signature uses wrong secret

**File:** `artifacts/api-server/src/lib/webhook-signature.ts`, `artifacts/api-server/src/routes/webhook.ts`

**Problem:** The signature verification passes `ACCESS_TOKEN` as the HMAC secret. Meta uses `APP_SECRET` (a completely different credential) to sign webhooks.

**Fix:**

1. Add `WHATSAPP_APP_SECRET` to the required environment variables list in `index.ts` and to `.env.example`.

2. In `webhook.ts`, change:
```typescript
// BEFORE
const accessToken = process.env.ACCESS_TOKEN;
const isSignatureValid = verifyWebhookSignature(rawBody, signature, accessToken);

// AFTER
const appSecret = process.env.WHATSAPP_APP_SECRET;
if (!appSecret) {
  logger.error("WHATSAPP_APP_SECRET not set - cannot validate webhook signatures");
  return res.status(500).json({ error: "server_configuration_error" });
}
const isSignatureValid = verifyWebhookSignature(rawBody, signature, appSecret);
```

---

### 2.3 — Incoming message deduplication

**File:** `artifacts/api-server/src/routes/webhook.ts`

**Problem:** WhatsApp retries webhook delivery, causing the same message to be processed multiple times.

**Fix:** Before calling `queueIncomingMessage`, check if the Meta message ID has been seen:

```typescript
import { checkIdempotencyKey, recordIdempotencyKey } from "../lib/idempotency";

// Inside the message loop, before queueIncomingMessage:
for (const msg of messages) {
  if (msg.type !== "text" || !msg.text?.body || !msg.from) continue;

  // Deduplicate using Meta's message ID
  if (msg.id) {
    const dedupeKey = `whatsapp_msg:${msg.id}`;
    const alreadySeen = await checkIdempotencyKey(dedupeKey);
    if (alreadySeen) {
      logger.debug({ messageId: msg.id }, "Duplicate webhook delivery ignored");
      continue;
    }
    // Record before processing to prevent race on concurrent delivery
    await recordIdempotencyKey(dedupeKey, msg.id, "message");
  }

  if (shouldRateLimitCustomer(msg.from)) { ... }
  await queueIncomingMessage(...);
}
```

---

### 2.4 — Redis-backed rate limiter

**File:** Create new file `artifacts/api-server/src/lib/rate-limiter-redis.ts`

**Problem:** In-memory rate limiter doesn't work across multiple server instances and resets on restart.

**Fix:** Implement a Redis-backed sliding window rate limiter using the existing Redis connection. Create the new file:

```typescript
import { getRedisClient } from "./queue"; // or wherever Redis client is exported
import { logger } from "./logger";

export class RedisRateLimiter {
  constructor(
    private readonly prefix: string,
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly blockDurationMs: number,
  ) {}

  async isLimited(identifier: string): Promise<boolean> {
    const redis = getRedisClient();
    const key = `ratelimit:${this.prefix}:${identifier}`;
    const blockKey = `ratelimit:block:${this.prefix}:${identifier}`;
    const now = Date.now();

    try {
      // Check if currently blocked
      const blocked = await redis.get(blockKey);
      if (blocked) return true;

      // Sliding window: remove timestamps outside window
      const windowStart = now - this.windowMs;
      await redis.zremrangebyscore(key, 0, windowStart);

      // Count current requests in window
      const count = await redis.zcard(key);

      if (count >= this.maxRequests) {
        // Block the identifier
        await redis.set(blockKey, "1", "PX", this.blockDurationMs);
        logger.warn({ identifier, count, limit: this.maxRequests }, "Rate limit exceeded");
        return true;
      }

      // Record this request
      await redis.zadd(key, now, `${now}-${Math.random()}`);
      await redis.pexpire(key, this.windowMs);
      return false;
    } catch (err) {
      // On Redis failure, fail open (don't block legitimate users)
      logger.error({ err, identifier }, "Redis rate limiter error - failing open");
      return false;
    }
  }
}

export const customerRateLimiter = new RedisRateLimiter("customer", 10, 60000, 5000);
export const adminCommandLimiter = new RedisRateLimiter("admin", 20, 60000, 10000);

export async function shouldRateLimitCustomer(phone: string): Promise<boolean> {
  return customerRateLimiter.isLimited(phone);
}

export async function shouldRateLimitAdminCommand(vendorId: string): Promise<boolean> {
  return adminCommandLimiter.isLimited(vendorId);
}
```

**Important:** The existing `rate-limiter.ts` exports sync functions (`shouldRateLimitCustomer` returns `boolean`). The new Redis-backed versions are async. Update all call sites in `bot.ts` and `webhook.ts` to `await shouldRateLimitCustomer(...)`. Update the import paths accordingly.

If a `getRedisClient()` export doesn't exist in `queue.ts`, expose the underlying Bull Redis client or create a shared `redis.ts` singleton:

```typescript
// lib/redis.ts
import Redis from "ioredis";
let client: Redis | null = null;
export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL!);
  }
  return client;
}
```

Replace the old `rate-limiter.ts` exports with the new Redis-backed ones, or update all imports to point to the new file. Delete the old in-memory implementation.

---

## SECTION 3 — BOT CONVERSATION FLOW IMPROVEMENTS

### 3.1 — Non-text message handling

**File:** `artifacts/api-server/src/routes/webhook.ts`

**Problem:** Voice notes, images, reactions, documents are silently dropped.

**Fix:** In the webhook message loop, after handling text messages, add a handler for non-text types:

```typescript
for (const msg of messages) {
  // Existing text handler
  if (msg.type === "text" && msg.text?.body && msg.from) {
    // ... existing logic ...
    continue;
  }

  // Handle non-text messages: send a polite fallback
  if (msg.from && msg.type && msg.type !== "text") {
    // Don't respond to reactions or read receipts
    const silentTypes = ["reaction", "read", "delivery"];
    if (!silentTypes.includes(msg.type)) {
      try {
        await queueOutboundMessage(
          vendor.phoneNumberId!,
          msg.from,
          `Hi! I can only understand text messages right now. Reply *menu* to see what's available, or *agent* to speak with a human.`,
        );
      } catch (err) {
        logger.error({ err, phone: msg.from, msgType: msg.type }, "Failed to queue non-text fallback");
      }
    }
    continue;
  }
}
```

Also update the WhatsApp webhook payload type to include the `type` field if it's not already typed.

---

### 3.2 — Remove hardcoded food keywords from looksLikeOrder

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** `looksLikeOrder` contains hardcoded food vocabulary that breaks non-food vendors.

**Fix:** Replace the `looksLikeOrder` function:

```typescript
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
    const words = normalized.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const result = findBestMenuMatch(word, menuItems);
      if (result.kind === "exact" || result.kind === "unique") return true;
    }
  }

  return false;
}
```

Update every call to `looksLikeOrder` in `computeBotReply` to pass `activeItems` as the second argument. You will need to fetch `activeItems` earlier in `computeBotReply` or pass it through. Refactor `computeBotReply` to fetch `activeItems` once at the top if `looksLikeOrder` needs it.

---

### 3.3 — Fix help trigger to use includesAny

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** "I need help" falls through to `looksLikeOrder` because `startsWithAny` requires "help" at the start.

**Fix:** In `computeBotReply`, change the help check:

```typescript
// BEFORE
if (startsWithAny(body, helpTriggers)) {

// AFTER
if (startsWithAny(body, helpTriggers) || includesAny(body, helpTriggers)) {
```

Also add `"help"` to the `normalizeOrderText` strip list so it doesn't accidentally get parsed as a menu item name:

```typescript
function normalizeOrderText(body: string): string {
  return body
    .replace(/[,;]+/g, ",")
    .replace(/\b(?:please|pls|abeg|i need|need|i want|want|give me|can i get|i'd like|id like|may i have|would like|for me|kindly|help)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
```

---

### 3.4 — Add customer "order status" command

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** Customers have no way to check the status of their order.

**Fix:** Add status triggers and a handler in `computeBotReply`. Add before the menu trigger check:

```typescript
const statusTriggers = ["status", "my order", "order status", "where is my order", "what happened to my order", "track"];

// Add inside computeBotReply, before the menu check:
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
      text: `You don't have any orders with us yet. Reply *menu* to place your first order.`,
      handover: false,
    };
  }

  const statusMessages: Record<string, string> = {
    pending: `⏳ Your order #${latestOrder.id.slice(0, 8)} is waiting to be confirmed by the vendor.`,
    confirmed: `✅ Your order #${latestOrder.id.slice(0, 8)} has been confirmed. ${paymentInstructions(vendor, Number(latestOrder.total))}`,
    paid: `🎉 Your order #${latestOrder.id.slice(0, 8)} is confirmed and payment received. Thank you!`,
    rejected: `❌ Your order #${latestOrder.id.slice(0, 8)} was not accepted. Reply *menu* to try again or *agent* for help.`,
  };

  const msg = statusMessages[latestOrder.status] ?? `Your order #${latestOrder.id.slice(0, 8)} status: ${latestOrder.status}.`;
  return { text: msg, handover: false };
}
```

---

### 3.5 — Add delivery address collection

**File:** `lib/db/src/schema/vendors.ts`

Add an optional `requiresDeliveryAddress` boolean field to the vendors table:

```typescript
requiresDeliveryAddress: boolean("requires_delivery_address").notNull().default(false),
```

**File:** `artifacts/api-server/src/lib/bot.ts`

Add a new conversation state: after the customer confirms their order (says YES), if the vendor requires a delivery address and no address is stored yet, ask for it before finalizing:

Add a new pending state type. When `isAffirmative(body)` is detected on a `pendingOrder`, check:

```typescript
// Inside the pendingOrder + isAffirmative branch, before createOrderWithLock:
if (vendor.requiresDeliveryAddress) {
  // Check if we already have an address stored in the pending order notes
  const hasAddress = (pendingOrder as any).deliveryAddress;
  if (!hasAddress) {
    // Store intent to confirm — set a flag in the pending order
    await setPendingOrderWithAddress(vendor.id, conversation.customerPhone ?? "unknown", pendingOrder, "awaiting_address");
    return {
      text: `Got it! One last thing — what's your delivery address?`,
      handover: false,
    };
  }
}
```

Add `deliveryAddress` as an optional field to the `PendingOrder` type and the `pending_orders` table JSONB column or as a separate text column. On the next message after "awaiting_address" state, capture the raw text as the address and store it in the order's `notes` field.

Expose `requiresDeliveryAddress` in the vendor update route and the control panel settings page.

---

### 3.6 — Abandoned pending order expiry notification

**File:** `artifacts/api-server/src/lib/pending-orders.ts`

**Problem:** Expired pending orders are silently deleted, leaving customers confused.

**Fix:** Modify `getPendingOrder` to return an expiry signal:

```typescript
export type PendingOrderResult =
  | { status: "found"; order: PendingOrder }
  | { status: "expired" }
  | { status: "not_found" };

export async function getPendingOrder(
  vendorId: string,
  customerPhone: string,
): Promise<PendingOrderResult> {
  try {
    const [pending] = await db
      .select()
      .from(pendingOrdersTable)
      .where(
        and(
          eq(pendingOrdersTable.vendorId, vendorId),
          eq(pendingOrdersTable.customerPhone, customerPhone),
        ),
      )
      .limit(1);

    if (!pending) return { status: "not_found" };

    if (new Date() > pending.expiresAt) {
      await db.delete(pendingOrdersTable).where(eq(pendingOrdersTable.id, pending.id));
      return { status: "expired" };
    }

    return {
      status: "found",
      order: {
        id: pending.id,
        vendorId: pending.vendorId,
        customerPhone: pending.customerPhone,
        resolvedItems: pending.resolvedItems,
        pendingClarification: pending.pendingClarification,
        total: Number(pending.total),
        timestamp: pending.createdAt,
        expiresAt: pending.expiresAt,
      },
    };
  } catch (err) {
    logger.error({ err, vendorId, customerPhone }, "Failed to get pending order");
    return { status: "not_found" };
  }
}
```

**File:** `artifacts/api-server/src/lib/bot.ts`

Update all call sites of `getPendingOrder` to handle the new return type:

```typescript
const pendingResult = await getPendingOrder(vendor.id, conversation.customerPhone);

if (pendingResult.status === "expired") {
  // Notify customer their cart timed out
  // Then continue processing the current message normally (don't return early)
  await queueOutboundMessage(
    vendor.phoneNumberId!,
    conversation.customerPhone,
    `Your previous order timed out after 10 minutes of inactivity. Reply *menu* to start a new one.`,
  );
}

const pendingOrder = pendingResult.status === "found" ? pendingResult.order : null;
```

Also remove the `cleanupExpiredPendingOrders(vendorId)` call from inside `getPendingOrder`. The global scheduled cleanup in `index.ts` is sufficient and this should not run on every inbound message.

---

### 3.7 — Add "cancel order" command for customers

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** Customers can't cancel a confirmed order from their side.

**Fix:** Add cancel triggers and logic in `computeBotReply`, after the "paid" handler:

```typescript
const cancelTriggers = ["cancel", "cancel order", "nevermind", "never mind", "i changed my mind"];

if (startsWithAny(body, cancelTriggers) || includesAny(body, cancelTriggers)) {
  // If there's a pending (unconfirmed) order in progress, clear it
  if (pendingOrder) {
    await clearPendingOrder(vendor.id, conversation.customerPhone);
    return {
      text: `Your order has been cancelled. Reply *menu* whenever you're ready to order again.`,
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
      .set({ status: "rejected" })
      .where(eq(ordersTable.id, latestOrder.id));

    return {
      text: `Order #${latestOrder.id.slice(0, 8)} has been cancelled. Reply *menu* to start a new order.`,
      handover: false,
      adminAlert: `Customer ${conversation.customerName} (${conversation.customerPhone}) cancelled order #${latestOrder.id.slice(0, 8)}.`,
    };
  }

  // Already confirmed — can't self-cancel
  return {
    text: `Your order has already been confirmed by the vendor. Please reply *agent* if you need to make changes.`,
    handover: false,
  };
}
```

---

## SECTION 4 — DATABASE & PERFORMANCE

### 4.1 — Add missing indexes

**File:** `lib/db/src/schema/conversations.ts`

Add a unique composite index on `(vendorId, customerPhone)` — this is required for the ON CONFLICT fix in 1.3 and speeds up every single inbound message:

```typescript
import { pgTable, text, uuid, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const conversationsTable = pgTable("conversations", {
  // ... existing columns unchanged ...
}, (t) => ({
  vendorPhoneUnique: uniqueIndex("conversations_vendor_phone_unique").on(t.vendorId, t.customerPhone),
}));
```

**File:** `lib/db/src/schema/orders.ts`

Add composite indexes for the most common query patterns:

```typescript
import { pgTable, text, uuid, timestamp, numeric, jsonb, index } from "drizzle-orm/pg-core";

export const ordersTable = pgTable("orders", {
  // ... existing columns unchanged ...
}, (t) => ({
  vendorStatusIdx: index("orders_vendor_status_idx").on(t.vendorId, t.status),
  vendorPhoneIdx: index("orders_vendor_phone_idx").on(t.vendorId, t.customerPhone),
  vendorCreatedIdx: index("orders_vendor_created_idx").on(t.vendorId, t.createdAt),
}));
```

**File:** `lib/db/src/schema/messages.ts`

Add index on `conversationId` — every conversation history load scans without it:

```typescript
import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";

export const messagesTable = pgTable("messages", {
  // ... existing columns unchanged ...
}, (t) => ({
  conversationIdx: index("messages_conversation_idx").on(t.conversationId),
  createdAtIdx: index("messages_created_at_idx").on(t.createdAt),
}));
```

**File:** `lib/db/src/schema/pending-orders.ts` (or wherever this table is defined)

Add composite index on `(vendorId, customerPhone)` — hit on every inbound message:

```typescript
(t) => ({
  vendorPhoneIdx: index("pending_orders_vendor_phone_idx").on(t.vendorId, t.customerPhone),
  expiresAtIdx: index("pending_orders_expires_idx").on(t.expiresAt),
})
```

After adding all indexes, generate and run a new Drizzle migration:
```bash
pnpm --filter @workspace/db db:generate
pnpm --filter @workspace/db db:migrate
```

---

### 4.2 — Add short_id column to orders and fix findOrderByShortId

**File:** `lib/db/src/schema/orders.ts`

Add a `shortId` column:

```typescript
import { nanoid } from "nanoid"; // or use crypto.randomUUID().slice(0,8)

shortId: text("short_id").notNull().default(sql`substr(gen_random_uuid()::text, 1, 8)`),
```

Add an index on it:
```typescript
shortIdIdx: index("orders_short_id_idx").on(t.shortId),
```

**File:** `artifacts/api-server/src/lib/bot.ts`

Replace `findOrderByShortId`:

```typescript
async function findOrderByShortId(vendorId: string, shortId: string): Promise<OrderRow | null> {
  if (!shortId) return null;
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.vendorId, vendorId),
        eq(ordersTable.shortId, shortId),
      ),
    )
    .limit(1);
  return order ?? null;
}
```

Update all admin notification strings that currently do `order.id.slice(0, 8)` to use `order.shortId` instead.

---

### 4.3 — Cache Fuse.js instances per vendor

**File:** `artifacts/api-server/src/lib/fuzzy-match.ts`

**Problem:** A new Fuse instance is built from scratch on every menu match call.

**Fix:** Add a cache with TTL:

```typescript
interface FuseCache {
  fuse: Fuse<MenuItemRow>;
  expiresAt: number;
}

const fuseCache = new Map<string, FuseCache>();
const FUSE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getFuseInstance(vendorId: string, menuItems: MenuItemRow[]): Fuse<MenuItemRow> {
  const cached = fuseCache.get(vendorId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.fuse;
  }
  const fuse = new Fuse(menuItems, {
    keys: ["name"],
    threshold: 0.4,
    includeScore: true,
  });
  fuseCache.set(vendorId, { fuse, expiresAt: Date.now() + FUSE_CACHE_TTL_MS });
  return fuse;
}

// Add a cache invalidation export for when the menu changes
export function invalidateFuseCache(vendorId: string): void {
  fuseCache.delete(vendorId);
}
```

Update `findBestMenuMatch` signature to accept `vendorId` as a parameter and use `getFuseInstance(vendorId, menuItems)` instead of creating a new Fuse on every call. Update all call sites.

**File:** `artifacts/api-server/src/routes/menu.ts` (wherever menu items are created/updated/deleted)

Call `invalidateFuseCache(vendorId)` after any menu mutation (add, remove, update availability).

---

### 4.4 — Fix status fields to use enums

**File:** `lib/db/src/schema/orders.ts`

```typescript
import { pgEnum } from "drizzle-orm/pg-core";

export const orderStatusEnum = pgEnum("order_status", ["pending", "confirmed", "paid", "rejected", "cancelled"]);
export const paymentStatusEnum = pgEnum("payment_status", ["pending", "paid", "refunded"]);

// In the table definition:
status: orderStatusEnum("status").notNull().default("pending"),
paymentStatus: paymentStatusEnum("payment_status").notNull().default("pending"),
```

**File:** `lib/db/src/schema/conversations.ts`

```typescript
export const conversationStatusEnum = pgEnum("conversation_status", ["bot", "human", "closed"]);

status: conversationStatusEnum("status").notNull().default("bot"),
```

Update the Drizzle migration after these changes. Update all TypeScript call sites that pass string literals for status to use the enum values (TypeScript will surface all the type errors automatically).

---

### 4.5 — Fix attemptCount column type in message_delivery

**File:** `lib/db/src/schema/message-delivery.ts`

```typescript
// BEFORE
attemptCount: text("attempt_count").notNull().default("1"),

// AFTER
attemptCount: integer("attempt_count").notNull().default(1),
```

---

## SECTION 5 — ADMIN / VENDOR EXPERIENCE

### 5.1 — Fix dangerous false-positive in "add" command regex

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** The implicit regex `/^[a-z].* \d+(\.\d+)?$/i` on the `add` branch matches messages like "confirm 12345678", hijacking them before the `confirm` branch runs.

**Fix:** Remove the regex fallback entirely. Only match the explicit `"add "` prefix:

```typescript
// BEFORE
if (lower.startsWith("add ") || /^[a-z].* \d+(\.\d+)?$/i.test(body)) {
  const text = lower.startsWith("add ") ? body.slice(4).trim() : body;

// AFTER
if (lower.startsWith("add ")) {
  const text = body.slice(4).trim();
```

The AI intent extraction (`aiExtractAdminIntent`) already handles natural language like "add Jollof Rice 2500" without the explicit "add " prefix. The regex was redundant and dangerous.

---

### 5.2 — Deduplicate admin show menu implementation

**File:** `artifacts/api-server/src/lib/bot.ts`

**Problem:** Two separate implementations of "show vendor their menu" exist.

**Fix:** In the main `handleAdminCommand` function, find the inline `if (lower === "menu" || lower === "list")` block and replace it with a call to the existing `handleAdminShowMenu`:

```typescript
if (lower === "menu" || lower === "list") {
  return handleAdminShowMenu(vendor);
}
```

Delete the inline implementation entirely.

---

### 5.3 — Multi-admin support

**File:** `lib/db/src/schema/` — create new file `vendor-admins.ts`:

```typescript
import { pgTable, text, uuid, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { vendorsTable } from "./vendors";

export const adminRoleEnum = pgEnum("admin_role", ["owner", "staff"]);

export const vendorAdminsTable = pgTable("vendor_admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => vendorsTable.id, { onDelete: "cascade" }),
  phone: text("phone").notNull(),
  name: text("name"),
  role: adminRoleEnum("role").notNull().default("staff"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VendorAdminRow = typeof vendorAdminsTable.$inferSelect;
```

Export `vendorAdminsTable` from the db package's main index.

**File:** `artifacts/api-server/src/lib/bot.ts`

Replace the `isAdminSender` function:

```typescript
import { vendorAdminsTable } from "@workspace/db";

export async function isAdminSender(vendor: VendorRow, fromPhone: string): Promise<boolean> {
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/^\+/, "");
  const normalizedFrom = norm(fromPhone);

  // Check legacy adminNumber field (backwards compatibility)
  if (vendor.adminNumber && norm(vendor.adminNumber) === normalizedFrom) return true;

  // Check vendor_admins table
  const admins = await db
    .select()
    .from(vendorAdminsTable)
    .where(eq(vendorAdminsTable.vendorId, vendor.id));

  return admins.some(a => norm(a.phone) === normalizedFrom);
}
```

Since `isAdminSender` is now async, update all call sites to `await isAdminSender(vendor, fromPhone)`.

Add REST routes for managing vendor admins:
- `GET /vendors/:vendorId/admins` — list admins
- `POST /vendors/:vendorId/admins` — add admin `{ phone, name, role }`
- `DELETE /vendors/:vendorId/admins/:adminId` — remove admin

---

### 5.4 — Add conversation "close" functionality

**File:** `artifacts/api-server/src/lib/bot.ts`

Add a `/close` admin command:

```typescript
// Add inside handleAdminCommand, near the /human and /bot commands:
if (lower.startsWith("/close ") || lower === "/close") {
  const target = body.slice(6).trim();
  if (!target) return { text: `Usage: /close <customer_phone>` };
  const updated = await db
    .update(conversationsTable)
    .set({ status: "closed" })
    .where(
      and(
        eq(conversationsTable.vendorId, vendor.id),
        eq(conversationsTable.customerPhone, target),
      ),
    )
    .returning();
  if (updated.length === 0) return { text: `No conversation found for ${target}.` };
  return { text: `Conversation with ${target} closed.` };
}
```

Add `/close <phone>` to the help text in the admin help command.

**File:** `artifacts/control-panel/src/` — find the conversations list or detail page and add a "Close conversation" button that calls `PATCH /conversations/:id` with `{ status: "closed" }`. Also add a "Reopen" button (sets status back to "bot") on closed conversations.

---

### 5.5 — Include item descriptions in bot menu message

**File:** `artifacts/api-server/src/lib/bot.ts`

Update `buildMenuMessage` to include descriptions when present:

```typescript
// In the item listing loop inside buildMenuMessage:
for (const item of items) {
  const cat = item.category ?? "Menu";
  if (cat !== currentCat) {
    if (currentCat !== null) lines.push("");
    lines.push(`*${cat}*`);
    currentCat = cat;
  }
  const descLine = item.description ? `\n   _${item.description}_` : "";
  lines.push(
    `${n}. ${item.name} — ${formatMoney(Number(item.price), vendor.currency)}${descLine}`,
  );
  n++;
}
```

---

## SECTION 6 — WIRE UP DEAD INFRASTRUCTURE

### 6.1 — Populate message_delivery table from outbound queue worker

**File:** `artifacts/api-server/src/lib/queue-workers.ts`

In the outbound queue worker, after each send attempt, write a delivery record:

```typescript
import { db } from "@workspace/db";
import { messageDeliveryTable } from "@workspace/db";

// Inside outboundQueue.process, after sendWhatsAppMessage:
const result = await sendWhatsAppMessage({ ... });

// Record delivery outcome
try {
  await db.insert(messageDeliveryTable).values({
    vendorId: data.vendorId, // Add vendorId to OutboundMessageJob type
    messageId: result.messageId,
    to: data.to,
    textPreview: data.text.slice(0, 100),
    delivered: result.delivered,
    deliveredAt: result.delivered ? new Date() : null,
    failureReason: result.reason ?? null,
    attemptCount: job.attemptsMade + 1,
  });
} catch (err) {
  // Non-critical: log but don't fail the job
  logger.warn({ err }, "Failed to record message delivery");
}
```

Add `vendorId` to the `OutboundMessageJob` type in `queue.ts` and update `queueOutboundMessage` to accept and pass it through.

---

## SECTION 7 — ARCHITECTURE CLEANUP

### 7.1 — Split bot.ts into focused modules

This is the most important structural change. Split `artifacts/api-server/src/lib/bot.ts` into:

**`bot-router.ts`** — Top-level `handleIncomingMessage` and `computeBotReply`. Intent detection only. Imports from the modules below.

**`order-flow.ts`** — Everything related to order parsing and state: `buildPendingOrderState`, `resolvePendingClarification`, `handleNextPendingResolution`, `resolveOrderRequest`, `createOrderWithLock`, `buildOrderSummary`, `buildMenuMessage`, `parseOrderLine`, `looksLikeOrder`, `normalizeOrderText`, `formatClarificationOptions`.

**`admin-commands.ts`** — `handleAdminCommand`, `handleAdminIntent`, all `handleAdmin*` functions.

**`notifications.ts`** — `notifyCustomer`, `notifyOrderConfirmedToCustomer`, `paymentInstructions`.

**`conversation-helpers.ts`** — `findOrCreateConversation`, `recordMessage`, `upsertCustomer`, `isAdminSender`, `findOrCreateConversation`.

Keep `bot.ts` as a thin re-export barrel for backwards compatibility:
```typescript
export { handleIncomingMessage, isAdminSender } from "./bot-router";
export { handleAdminCommand } from "./admin-commands";
export { notifyOrderConfirmedToCustomer } from "./notifications";
```

Ensure all existing imports from `"./bot"` continue to resolve correctly.

---

## SECTION 8 — ENVIRONMENT & CONFIGURATION

### 8.1 — Update .env.example

Add the following new variables to `.env.example` with descriptive comments:

```bash
# API authentication key for the control panel and any external API consumers
# Generate with: openssl rand -hex 32
API_SECRET_KEY=your_secret_key_here

# WhatsApp App Secret (from Meta Developer Console → App Settings → Basic)
# Used for webhook signature verification. Different from ACCESS_TOKEN.
WHATSAPP_APP_SECRET=your_app_secret_here
```

### 8.2 — Update index.ts required variables list

Add `WHATSAPP_APP_SECRET` and `API_SECRET_KEY` to the `required` array in `artifacts/api-server/src/index.ts`.

---

## SECTION 9 — CONTROL PANEL UPDATES

The following changes are needed in `artifacts/control-panel`:

1. **Auth header**: Add `x-api-key: ${import.meta.env.VITE_API_SECRET_KEY}` to all API requests (axios default headers or fetch wrapper).

2. **Conversation close button**: On the conversations page, add a "Close" button per conversation row, and a "Reopen" action for closed ones. Filter should include "closed" as a status tab.

3. **Delivery address setting**: On the vendor settings page, add a toggle for "Require delivery address from customers".

4. **Vendor admins management**: Add a "Staff / Admins" section in vendor settings with a list of admin phone numbers, ability to add (with name + role) and remove them.

5. **Order short ID display**: Replace all `order.id.slice(0, 8)` in the UI with `order.shortId` from the API response.

6. **Menu item description**: On the menu management page, ensure the description field is editable and displayed in the item list.

---

## IMPLEMENTATION NOTES

- Run `pnpm install` after any dependency additions.
- After all schema changes, run `pnpm --filter @workspace/db db:generate` then `pnpm --filter @workspace/db db:migrate`.
- TypeScript strict mode is likely enabled — make sure all new async functions have proper return types and all new fields are reflected in the shared types.
- After splitting `bot.ts`, run `pnpm --filter api-server typecheck` to catch any broken imports before testing.
- Test the full order flow via the simulator endpoint (`POST /simulator/incoming`) before considering any section complete.
- Preserve all existing behaviour — this is a set of fixes and additions, not a rewrite. Do not change function signatures unless explicitly instructed above.
