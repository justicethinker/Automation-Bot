# Comprehensive Codebase Audit & Fixes

> Generated: 2026-06-15 | Lead: AI & Backend Engineer
> Scope: Full codebase — `api-server`, `lib/db`, routes, bot logic, tier enforcement, conversational AI

---

## 1. SECURITY VULNERABILITIES

- [ ] **1.1 Webhook signature uses string equality instead of `timingSafeEqual`**
  - File: [webhook-signature.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/webhook-signature.ts#L38-L40)
  - The comparison `signatureHex === expectedSignature` is vulnerable to timing attacks. Must use `crypto.timingSafeEqual` with Buffer comparison.

- [ ] **1.2 Webhook non-text fallback references undefined `queueOutboundMessage`**
  - File: [webhook.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/webhook.ts#L175)
  - `queueOutboundMessage` is called but **never imported** in `webhook.ts`. This will crash at runtime for any non-text message (image, voice note, etc.).

- [ ] **1.3 Auth middleware does not use constant-time comparison**
  - File: [auth.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/middleware/auth.ts#L13)
  - `apiKey !== validKey` is a plain string comparison. Should use `crypto.timingSafeEqual` to prevent timing attacks on the API key.

- [ ] **1.4 `GEMINI_API_KEY` not in required env validation**
  - File: [index.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/index.ts#L14-L24)
  - `GEMINI_API_KEY` is used by `ai-extractor.ts` but is not listed in required env vars, so the bot silently degrades without any startup warning.

---

## 2. BUGS & RUNTIME ERRORS

- [ ] **2.1 `findBestMenuMatch` call signature mismatch in `looksLikeOrder`**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L397)
  - `findBestMenuMatch(word, menuItems)` is called with 2 args, but the function signature requires 3: `(itemName, menuItems, vendorId)`. Missing `vendorId` means the Fuse.js cache key is `undefined`, corrupting the cache and potentially returning wrong vendor results.

- [ ] **2.2 `notifyCustomer` calls `sendWhatsAppMessage` directly, bypassing the queue**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L282-L294)
  - This function is used for order confirmations, rejections, and payment notifications but sends messages synchronously via `sendWhatsAppMessage` instead of `queueOutboundMessage`. These critical notifications have no retry logic and can silently fail.

- [ ] **2.3 Broadcast route sends messages synchronously without queue**
  - File: [broadcasts.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/broadcasts.ts#L68-L74)
  - The REST API broadcast route loops through recipients with `sendWhatsAppMessage` directly. Unlike the bot `/broadcast` command which correctly uses `queueBroadcastMessage`, the API route has zero retry logic and will timeout on large recipient lists.

- [ ] **2.4 Follow-ups route sends messages synchronously without queue**
  - File: [broadcasts.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/broadcasts.ts#L130-L139)
  - Same issue as 2.3. Follow-up reminders via the REST API bypass the queue entirely.

- [ ] **2.5 `toOrder` serializer missing `cancelled` status**
  - File: [serializers.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/serializers.ts#L75-L80)
  - The `status` type assertion is `"pending" | "confirmed" | "paid" | "rejected" | "completed"` but the `orderStatusEnum` includes `"cancelled"`. This can cause type errors or unexpected behavior when serializing cancelled orders.

- [ ] **2.6 `whatsapp.ts` batch send uses `indexOf` for loop position detection**
  - File: [whatsapp.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/whatsapp.ts#L161)
  - `messages.indexOf(msg)` is O(n) per iteration, making the batch send O(n²). Should use index from the loop directly.

- [ ] **2.7 Orders route uses `sendWhatsAppMessage` directly (no queue/retry)**
  - File: [orders.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/orders.ts#L103-L108)
  - Order rejection and payment notifications in the REST API route bypass the queue, meaning no retries on failure.

---

## 3. TIER MANAGEMENT (STARTER vs PRO)

- [ ] **3.1 Analytics route has no tier gating**
  - File: [dashboard.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/dashboard.ts#L168)
  - `/vendors/:vendorId/analytics` serves detailed analytics (daily orders, revenue, top items, repeat rate) to all vendors regardless of plan. Analytics is defined as a Pro-only feature in `plans.ts`.

- [ ] **3.2 Dashboard summary exposes all vendor data without vendor-scoped access**
  - File: [dashboard.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/dashboard.ts#L16-L83)
  - `/dashboard/summary` returns aggregate data across ALL vendors. There is no ownership check — any authenticated API key holder sees everything. This is a multi-tenant data leak if multiple vendor operators share the system.

- [ ] **3.3 Promotions READ endpoint has no tier gate**
  - File: [promotions.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/routes/promotions.ts#L18-L27)
  - `GET /vendors/:vendorId/promotions` returns promotion data for any vendor regardless of plan. Only CREATE is gated. Starter vendors shouldn't see promotion UI/data at all.

---

## 4. ARCHITECTURAL & PERFORMANCE

- [ ] **4.1 `computeBotReply` agent triggers are over-eager**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L1250)
  - `includesAny(body, agentTriggers)` at line 1250 will match any message containing "help", "person", "support" even mid-sentence (e.g., "this is for my support team"). Agent triggers should use `startsWithAny` primarily, with `includesAny` only for explicit multi-word phrases.

- [ ] **4.2 `computeBotReply` checks cancel triggers AFTER `looksLikeOrder`**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L1405)
  - If a customer says "cancel my order of rice", order detection matches first (because "order" and "rice" are triggers), preventing cancel intent. Cancel/status should be checked before order detection.

- [ ] **4.3 Duplicate admin logic between manual parsing and AI intent handlers**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L1866-L1964) vs [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L2150-L2251)
  - `handleAdminCommand` has manual parsing for `confirm`, `reject`, `paid` that duplicates identical logic in the intent handlers. The manual path should delegate to the intent handlers.

- [ ] **4.4 `listAllMenuItems` and `listActiveMenuItems` queried separately**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L446-L447)
  - Both are called for every order message. `listAllMenuItems` is a superset. Should query once and filter in-memory.

---

## 5. CONVERSATIONAL LOGIC (GEMINI BOT)

- [ ] **5.1 AI order extraction prompt has no vendor menu context**
  - File: [ai-extractor.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/ai-extractor.ts#L86)
  - The prompt says "Extract food order details" but provides no menu context. Gemini has no idea what items the vendor sells, so it can only echo back what the customer typed. Should inject the vendor's actual menu items into the prompt for accurate extraction.

- [ ] **5.2 AI admin intent extraction has no conversation memory**
  - File: [ai-extractor.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/ai-extractor.ts#L137)
  - Each admin message is processed in complete isolation. No multi-turn continuity. Should pass recent message history.

- [ ] **5.3 Customer conversation has zero memory — no multi-turn context**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L1241)
  - `computeBotReply` receives only the current message body. The bot cannot remember previous messages, handle "add another one", or follow up on partial conversations. Must retrieve and inject recent conversation history.

- [ ] **5.4 No subtext/intent detection for ambiguous customer messages**
  - File: [bot.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/bot.ts#L1503-L1512)
  - Any message that doesn't match a trigger falls through to a generic fallback. The bot should use Gemini to interpret ambiguous messages (e.g., "how much is the rice?" → menu lookup, "when will my food arrive?" → status).

- [ ] **5.5 AI extraction timeout too aggressive at 5 seconds**
  - File: [ai-extractor.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/ai-extractor.ts#L41)
  - 5 seconds is very tight for cold-start Gemini calls. Will frequently timeout and silently degrade the bot. Should be 8-10 seconds.

- [ ] **5.6 No conversational tone/personality in bot responses**
  - All bot responses are functional but robotic. The bot should have a warm, dynamic personality. The `welcomeMessage` field supports brand customization partially but all other responses are hardcoded generic text.

---

## 6. DEAD CODE & CLEANUP

- [ ] **6.1 `middlewares` directory exists alongside `middleware` (duplicate)**
  - Both `src/middleware/` and `src/middlewares/` directories exist. Only `middleware/auth.ts` is used.

- [ ] **6.2 Unused DB schema files**
  - `admin-contexts.ts`, `conversation-states.ts`, `message-delivery.ts` exist in the schema directory but are never referenced. Verify if future work or dead code.

- [ ] **6.3 `circuit-breaker.ts` is defined but never used**
  - File: [circuit-breaker.ts](file:///C:/Users/REV.%20IKECHUKWU/.gemini/antigravity/scratch/Automation-Bot/artifacts/api-server/src/lib/circuit-breaker.ts)
  - Both `createAICircuitBreaker` and `createWhatsAppCircuitBreaker` are exported but never imported anywhere. Should integrate into `ai-extractor.ts` and `whatsapp.ts`, or remove.

---

## Summary

| Category | Count |
|---|---|
| Security Vulnerabilities | 4 |
| Bugs & Runtime Errors | 7 |
| Tier Management Gaps | 3 |
| Architectural Issues | 4 |
| Conversational Logic | 6 |
| Dead Code | 3 |
| **Total** | **27** |
