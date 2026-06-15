## Execution Progress

### Security (1.x)
- `[x]` 1.1 — `webhook-signature.ts` timing-safe comparison
- `[x]` 1.2 — `webhook.ts` missing `queueOutboundMessage` import
- `[x]` 1.3 — `auth.ts` timing-safe API key comparison
- `[x]` 1.4 — `index.ts` add `GEMINI_API_KEY` to optional env warnings

### Bugs (2.x)
- `[x]` 2.1 — `bot.ts` fix `findBestMenuMatch` 3-arg call in `looksLikeOrder`
- `[x]` 2.2 — `bot.ts` switch `notifyCustomer` to use `queueOutboundMessage`
- `[x]` 2.3 — `broadcasts.ts` route: use queue for broadcast sends
- `[x]` 2.4 — `broadcasts.ts` route: use queue for follow-up sends
- `[x]` 2.5 — `serializers.ts` add `cancelled` to `toOrder` status union
- `[x]` 2.6 — `whatsapp.ts` fix O(n²) indexOf in batch send
- `[x]` 2.7 — `orders.ts` route: use queue for notifications

### Tier Management (3.x)
- `[x]` 3.1 — `dashboard.ts` gate analytics behind Pro
- `[x]` 3.2 — `dashboard.ts` scope summary to vendor context
- `[x]` 3.3 — `promotions.ts` gate READ behind Pro

### Architecture (4.x)
- `[x]` 4.1 — `bot.ts` tighten agent trigger matching
- `[x]` 4.2 — `bot.ts` reorder cancel/status before order detection
- `[x]` 4.3 — `bot.ts` deduplicate admin confirm/reject/paid logic
- `[x]` 4.4 — `bot.ts` merge menu queries in `handleOrderClarification`

### Conversational Logic (5.x)
- `[x]` 5.1 — `ai-extractor.ts` inject menu context into order prompt
- `[x]` 5.2 — `ai-extractor.ts` pass message history for admin intent
- `[x]` 5.3 — `bot.ts` inject conversation history into computeBotReply
- `[x]` 5.4 — `ai-extractor.ts` add `detectCustomerIntent` for ambiguous messages
- `[x]` 5.5 — `ai-extractor.ts` increase timeout to 10s (verified already set)
- `[x]` 5.6 — `bot.ts` add warmth/personality to fallback responses

### Dead Code (6.x)
- `[x]` 6.1 — Delete `middlewares/` duplicate directory
- `[x]` 6.2 — Remove unused schema exports (admin-contexts, conversation-states, message-delivery)
- `[x]` 6.3 — Delete unused `circuit-breaker.ts`
