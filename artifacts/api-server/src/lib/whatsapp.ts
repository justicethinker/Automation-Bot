import { logger } from "./logger";

export type OutboundMessage = {
  phoneNumberId: string | null;
  to: string;
  text: string;
};

export type SendMessageResult = {
  ok: boolean;
  messageId: string;
  delivered: boolean;
  reason?: string;
};

const META_GRAPH_URL = "https://graph.facebook.com/v20.0";

export async function sendWhatsAppMessage(
  msg: OutboundMessage,
): Promise<SendMessageResult> {
  const accessToken = process.env.ACCESS_TOKEN;

  if (!accessToken || !msg.phoneNumberId) {
    logger.info(
      {
        to: msg.to,
        phoneNumberId: msg.phoneNumberId,
        textPreview: msg.text.slice(0, 80),
      },
      "WhatsApp send (stub: no ACCESS_TOKEN or phone_number_id)",
    );
    return {
      ok: true,
      messageId: `stub-${Date.now()}`,
      delivered: false,
      reason: accessToken ? "no_phone_number_id" : "no_access_token",
    };
  }

  try {
    const res = await fetch(
      `${META_GRAPH_URL}/${msg.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: msg.to,
          type: "text",
          text: { body: msg.text },
        }),
      },
    );
    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };
    if (!res.ok || data.error) {
      logger.warn({ err: data.error, status: res.status }, "WhatsApp send failed");
      return {
        ok: false,
        messageId: `err-${Date.now()}`,
        delivered: false,
        reason: data.error?.message ?? `http_${res.status}`,
      };
    }
    return {
      ok: true,
      messageId: data.messages?.[0]?.id ?? `unk-${Date.now()}`,
      delivered: true,
    };
  } catch (err) {
    logger.error({ err }, "WhatsApp send threw");
    return {
      ok: false,
      messageId: `err-${Date.now()}`,
      delivered: false,
      reason: err instanceof Error ? err.message : "unknown",
    };
  }
}
