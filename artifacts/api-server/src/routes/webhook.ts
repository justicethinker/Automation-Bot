import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { vendorsTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import {
  WhatsappWebhookBody,
  SimulateIncomingMessageBody,
} from "@workspace/api-zod";
import { handleIncomingMessage } from "../lib/bot";
import { queueIncomingMessage, queueOutboundMessage } from "../lib/queue";
import { logger } from "../lib/logger";
import { shouldRateLimitCustomer } from "../lib/rate-limiter-redis";
import { verifyWebhookSignature } from "../lib/webhook-signature";
import { checkIdempotencyKey, recordIdempotencyKey } from "../lib/idempotency";

const router: IRouter = Router();

// ────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Cloud API webhook
// One endpoint for ALL vendors. Meta sends messages here; we route by
// the `phone_number_id` field embedded in the payload.
// ────────────────────────────────────────────────────────────────────────

// Meta verification handshake.
router.get("/webhook/messages", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected && typeof challenge === "string") {
    return res.status(200).type("text/plain").send(challenge);
  }
  return res.sendStatus(403);
});

// Meta POSTs incoming messages here. Payload shape (relevant pieces):
// { object: "whatsapp_business_account",
//   entry: [{
//     changes: [{
//       value: {
//         metadata: { phone_number_id, display_phone_number },
//         contacts: [{ profile: { name }, wa_id }],
//         messages: [{ from, id, type, text: { body } }]
//       }
//     }]
//   }]
// }
router.post("/webhook/messages", async (req, res) => {
  // SECURITY: Validate webhook signature (X-Hub-Signature-256 header)
  // This ensures the request is genuinely from Meta
  const signature = req.get("X-Hub-Signature-256");
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    logger.error("WHATSAPP_APP_SECRET not set - cannot validate webhook signatures");
    return res.status(500).json({ error: "server_configuration_error" });
  }

  const isSignatureValid = verifyWebhookSignature(rawBody, signature, appSecret);
  if (!isSignatureValid) {
    logger.error("Webhook signature verification failed - rejecting request");
    return res.status(403).json({ error: "signature_verification_failed" });
  }

  // Always 200 immediately so Meta doesn't retry; do work in the background.
  res.sendStatus(200);

  // Process webhook asynchronously (background job)
  // This allows us to return 200 to Meta immediately before processing completes
  (async () => {
    try {
      const entries = (req.body?.entry ?? []) as unknown[];
      for (const entry of entries) {
        const changes = (entry as { changes?: unknown[] }).changes ?? [];
        for (const change of changes) {
          const value = (change as { value?: unknown }).value;
          if (!value || typeof value !== "object") continue;
          const v = value as {
            metadata?: { phone_number_id?: string; display_phone_number?: string };
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
            messages?: Array<{
              from?: string;
              id?: string;
              type?: string;
              text?: { body?: string };
            }>;
          };
          const phoneNumberId = v.metadata?.phone_number_id;
          const messages = v.messages ?? [];
          if (!phoneNumberId || messages.length === 0) continue;

          const [vendor] = await db
            .select()
            .from(vendorsTable)
            .where(eq(vendorsTable.phoneNumberId, phoneNumberId))
            .limit(1);

          if (!vendor) {
            logger.warn(
              { phoneNumberId },
              "Inbound webhook: no vendor for phone_number_id",
            );
            continue;
          }

          for (const msg of messages) {
            // Handle text messages
            if (msg.type === "text" && msg.text?.body && msg.from) {
              // Deduplicate using Meta's message ID
              // WhatsApp retries webhook delivery, so we need to skip duplicates
              if (msg.id) {
                const dedupeKey = `whatsapp_msg:${msg.id}`;
                const existing = await checkIdempotencyKey(dedupeKey);
                if (existing) {
                  logger.debug(
                    { messageId: msg.id, from: msg.from, vendorId: vendor.id },
                    "Duplicate message skipped",
                  );
                  continue;
                }
              }
              
              const profileName =
                v.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ??
                msg.from;
              
              // CRITICAL: Check rate limit BEFORE queueing
              // This prevents spam from filling up the queue
              if (await shouldRateLimitCustomer(msg.from)) {
                logger.warn(
                  { phone: msg.from, vendorId: vendor.id, messageId: msg.id },
                  "Rate limited: ignoring spam customer",
                );
                continue;
              }
              
              // PRODUCTION CHANGE: Queue the message instead of processing immediately
              // This prevents request pile-up during traffic spikes
              try {
                await queueIncomingMessage(
                  vendor.id,
                  msg.from,
                  profileName,
                  msg.text.body,
                );
                
                // Record this message ID to prevent duplicate processing
                if (msg.id) {
                  await recordIdempotencyKey(
                    `whatsapp_msg:${msg.id}`,
                    msg.id,
                    "message",
                  );
                }
              } catch (err) {
                logger.error(
                  { err, phone: msg.from, vendorId: vendor.id, messageId: msg.id },
                  "Failed to queue incoming message",
                );
              }
              continue;
            }

            // Handle non-text messages: send a polite fallback
            if (msg.from && msg.type && msg.type !== "text") {
              // Don't respond to reactions or read receipts
              if (msg.type === "reaction" || msg.type === "read") {
                continue;
              }
              
              // Send fallback for images, voice notes, documents, etc.
              try {
                await queueOutboundMessage(
                  vendor.phoneNumberId!,
                  msg.from,
                  `Sorry, I can only process text messages. Please send your message as text and I'll help you! 📝`,
                );
              } catch (err) {
                logger.warn(
                  { err, from: msg.from, msgType: msg.type },
                  "Failed to send non-text fallback message",
                );
              }
              continue;
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Webhook processing failed");
    }
  })().catch((err) => {
    logger.error({ err }, "Unhandled error in webhook background processing");
  });

  // Response already sent, don't send another
  return;
});

// ────────────────────────────────────────────────────────────────────────
// Convenience webhook for testing / non-Meta integrations.
// Routes by either bot phoneNumber or phoneNumberId.
// ────────────────────────────────────────────────────────────────────────
router.post("/webhook/whatsapp", async (req, res) => {
  const body = WhatsappWebhookBody.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", details: body.error.issues });
  }

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(
      or(
        eq(vendorsTable.phoneNumber, body.data.to),
        eq(vendorsTable.phoneNumberId, body.data.to),
      ),
    )
    .limit(1);

  if (!vendor) {
    req.log.warn({ to: body.data.to }, "No vendor matches inbound number");
    return res
      .status(404)
      .json({ ok: false, botReply: null, conversationId: null });
  }

  const result = await handleIncomingMessage({
    vendor,
    fromPhone: body.data.from,
    fromName: body.data.profileName ?? body.data.from,
    body: body.data.body,
  });

  return res.json({
    ok: true,
    botReply: result.botReply,
    conversationId: result.conversation?.id ?? null,
    isAdmin: result.isAdmin,
    adminNotification: result.adminNotification,
  });
});

router.post("/simulator/incoming", async (req, res) => {
  const body = SimulateIncomingMessageBody.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({ error: "invalid_body", details: body.error.issues });
  }

  const [vendor] = await db
    .select()
    .from(vendorsTable)
    .where(eq(vendorsTable.id, body.data.vendorId))
    .limit(1);

  if (!vendor) return res.status(404).json({ error: "vendor_not_found" });

  const result = await handleIncomingMessage({
    vendor,
    fromPhone: body.data.customerPhone,
    fromName: body.data.customerName ?? body.data.customerPhone,
    body: body.data.body,
  });

  return res.json({
    ok: true,
    botReply: result.botReply,
    conversationId: result.conversation?.id ?? null,
    isAdmin: result.isAdmin,
    adminNotification: result.adminNotification,
  });
});

export default router;
