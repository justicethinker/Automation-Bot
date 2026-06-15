import { logger } from "./logger";
import { v4 as uuidv4 } from "uuid";

export type OutboundMessage = {
  phoneNumberId: string | null;
  to: string;
  text: string;
  idempotencyKey?: string;  // For retries
};

export type SendMessageResult = {
  ok: boolean;
  messageId: string;
  delivered: boolean;
  reason?: string;
};

const META_GRAPH_URL = "https://graph.facebook.com/v20.0";

/**
 * Send a WhatsApp message with timeout protection.
 * 
 * IMPORTANT: This function has a 10-second timeout to prevent hanging.
 * For production resilience, this should be called from a message queue
 * with retry logic (see queue.ts).
 * 
 * @returns SendMessageResult - always returns a result, never throws
 */
export async function sendWhatsAppMessage(
  msg: OutboundMessage,
): Promise<SendMessageResult> {
  const accessToken = process.env.ACCESS_TOKEN;
  const messageId = msg.idempotencyKey || `msg-${uuidv4().slice(0, 8)}`;

  if (!accessToken || !msg.phoneNumberId) {
    logger.info(
      {
        to: msg.to,
        phoneNumberId: msg.phoneNumberId,
        messageId,
        textPreview: msg.text.slice(0, 80),
      },
      "WhatsApp send (stub: no ACCESS_TOKEN or phone_number_id)",
    );
    return {
      ok: true,
      messageId: `stub-${messageId}`,
      delivered: false,
      reason: accessToken ? "no_phone_number_id" : "no_access_token",
    };
  }

  const startTime = Date.now();

  try {
    // Add timeout to fetch request: 10 seconds max
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

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
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };

    if (!res.ok || data.error) {
      logger.warn(
        {
          err: data.error,
          status: res.status,
          to: msg.to,
          messageId,
          duration: Date.now() - startTime,
        },
        "WhatsApp send failed",
      );
      return {
        ok: false,
        messageId,
        delivered: false,
        reason: data.error?.message ?? `http_${res.status}`,
      };
    }

    logger.debug(
      {
        to: msg.to,
        messageId: data.messages?.[0]?.id || messageId,
        duration: Date.now() - startTime,
      },
      "WhatsApp message sent successfully",
    );

    return {
      ok: true,
      messageId: data.messages?.[0]?.id ?? messageId,
      delivered: true,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        to: msg.to,
        messageId,
        isTimeout,
        duration: Date.now() - startTime,
      },
      isTimeout ? "WhatsApp send timed out" : "WhatsApp send threw",
    );

    return {
      ok: false,
      messageId,
      delivered: false,
      reason: isTimeout ? "timeout" : err instanceof Error ? err.message : "unknown",
    };
  }
}

/**
 * Batch send messages with rate limiting
 * Used for broadcasts to avoid overwhelming the API
 */
export async function sendBatchWhatsAppMessages(
  phoneNumberId: string,
  messages: Array<{ to: string; text: string }>,
  batchDelayMs: number = 100,
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const result = await sendWhatsAppMessage({
      phoneNumberId,
      to: msg.to,
      text: msg.text,
    });
    results.push(result);

    // Rate limiting: wait between messages
    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  return results;
}
