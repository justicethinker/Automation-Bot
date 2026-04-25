# WhatsApp Commerce Control Panel

A multi-tenant WhatsApp commerce platform. One operator manages many vendors;
vendors interact with the system entirely through WhatsApp (no vendor dashboard).

## Architecture

This is a pnpm monorepo with three artifacts:

- `artifacts/control-panel` — React + Vite admin UI (mounted at `/`).
- `artifacts/api-server` — Express 5 backend (mounted at `/api`).
- `artifacts/mockup-sandbox` — design canvas (auto-generated, not used for production).

Shared libraries:

- `lib/api-spec` — OpenAPI 3 contract (`openapi.yaml`).
- `lib/api-zod` — generated Zod schemas + types from OpenAPI.
- `lib/api-client-react` — generated TanStack Query hooks.
- `lib/db` — Drizzle ORM schema, exports `db` and `pool`. Tables:
  `vendors`, `menu_items`, `orders`, `conversations`, `messages`,
  `customers`, `payments`.

## Bot

`artifacts/api-server/src/lib/bot.ts` handles every incoming WhatsApp
message and splits into two flows based on the sender's number:

**Customer flow** (sender ≠ vendor's `adminNumber`):
- greeting / `menu` → numbered list of active items, with up to 3 active
  promotions shown at the top. Items are numbered globally across categories
  in `(category, createdAt)` order so the numbers in the menu always match
  what the customer replies with.
- order by **number**: `1`, `1x2`, `1, 3x2, 5` (multi-item in one message),
  qty-first `2 margherita`, or legacy `order <name> x<qty>`. Duplicate picks
  are coalesced into one line.
- `paid` → marks the latest confirmed order paid
- `agent` / `human` → flips the conversation to `human`, alerts the admin,
  and stops auto-replies until the admin runs `/bot`
- `help` → command list

**Admin flow** (sender == vendor's `adminNumber`):
- `/help` — command list (also lists Pro commands)
- `menu` — show the menu
- `add <name> <price>` / `remove <name>` — manage menu items
- `orders` — list pending orders
- `confirm [id]` / `reject [id]` — confirm or reject (defaults to latest)
- `paid [id]` — mark an order as paid (also notifies the customer)
- `/human <phone>` — manually take over a customer chat
- `/bot [phone]` — return that chat (or every chat) to bot mode

**Admin Pro commands** (gated by `hasFeature`):
- `/promo add <title> :: <description>` / `/promo list` / `/promo off`
- `/broadcast <message>` — sends to customers active in the last 30 days,
  records a row in `broadcasts`
- `/followups on|off|run` — toggle automatic stalled-order reminders
  (`vendors.followUpsEnabled`) or run them now (24h cutoff,
  confirmed+unpaid, deduped by phone)

### Webhooks & routing

- `GET /api/webhook/messages` — Meta verification handshake using the
  `VERIFY_TOKEN` env var.
- `POST /api/webhook/messages` — Meta inbound payload. Routes to a vendor
  by the `metadata.phone_number_id` and always responds 200 immediately.
- `POST /api/webhook/whatsapp` — legacy/internal endpoint; matches vendor
  by `phoneNumber` or `phoneNumberId`.
- `POST /api/simulator/incoming` — selects vendor by id (used by the
  in-app simulator page).

Outbound WhatsApp messages go through `lib/whatsapp.ts`. If the
`WHATSAPP_ACCESS_TOKEN` env var is unset the function logs the payload
and returns `null` (stub mode for free-tier development).

### Plan gating

`lib/plans.ts → hasFeature(vendorOrPlan, feature)` accepts either a
`{plan: string}` row or a plain string. Pro-only features:
`analytics`, `customer_memory`, `broadcasts`, `promotions`, `follow_ups`.
The UI mirrors this on the analytics, customers, promotions, and
broadcasts pages.

### Vendor WhatsApp config (per vendor)

- `phoneNumber` — the business number customers see.
- `botNumber` — display number for the bot (usually the same).
- `adminNumber` — the vendor's personal WhatsApp; sender of admin
  commands and recipient of order alerts.
- `phoneNumberId` — Meta WhatsApp Cloud API id used to route webhooks.

## Plans

- **Starter**: bot, numbered menu, multi-item orders, manual bank-transfer
  payments.
- **Pro**: adds analytics (per-vendor), customer memory views, promotions
  shown with the menu, broadcast messages to recent customers, and
  automatic follow-ups for stalled (confirmed-but-unpaid) orders.

Tables added for Pro: `promotions` (id, vendorId, title, description,
active, createdAt) and `broadcasts` (id, vendorId, message,
recipientCount, sentAt). `vendors.followUpsEnabled` toggles the auto
reminder behaviour.

## Local development

- Frontend dev: workflow `artifacts/control-panel: web` (Vite, port from `PORT`).
- Backend dev: workflow `artifacts/api-server: API Server` (Express, port 8080).
- DB push: `pnpm --filter @workspace/db run push`.
- Seed: `pnpm --filter @workspace/scripts run seed` (idempotent — skips if data exists).
- API regen after spec changes: `pnpm --filter @workspace/api-spec run codegen`.

## Conventions

- Money is stored as `numeric(12,2)` strings in Postgres; serializers convert
  to numbers for the API. Display uses each vendor's `currency`.
- No emojis in UI copy.
- All routes validate with `safeParse` from `@workspace/api-zod`.
