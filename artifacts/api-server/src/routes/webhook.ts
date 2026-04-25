import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { vendorsTable } from "@workspace/db";
import { eq, or } from "drizzle-orm";
import {
  WhatsappWebhookBody,
  SimulateIncomingMessageBody,
} from "@workspace/api-zod";
import { handleIncomingMessage } from "../lib/bot";

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
  // Always 200 immediately so Meta doesn't retry; do work in the background.
  res.sendStatus(200);

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
          req.log.warn(
            { phoneNumberId },
            "Inbound webhook: no vendor for phone_number_id",
          );
          continue;
        }

        for (const msg of messages) {
          if (msg.type !== "text" || !msg.text?.body || !msg.from) continue;
          const profileName =
            v.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ??
            msg.from;
          await handleIncomingMessage({
            vendor,
            fromPhone: msg.from,
            fromName: profileName,
            body: msg.text.body,
          });
        }
      }
    }
  } catch (err) {
    req.log.error({ err }, "Webhook processing failed");
  }
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

  res.json({
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

  res.json({
    ok: true,
    botReply: result.botReply,
    conversationId: result.conversation?.id ?? null,
    isAdmin: result.isAdmin,
    adminNotification: result.adminNotification,
  });
});

export default router;
