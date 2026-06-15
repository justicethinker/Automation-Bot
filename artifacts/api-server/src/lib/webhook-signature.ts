import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "./logger";

/**
 * Verify webhook signature from Meta
 * 
 * Meta sends the X-Hub-Signature-256 header with every webhook request.
 * Format: sha256=<signature>
 * Signature is HMAC-SHA256 of request body using app secret
 * 
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/verify-messages
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) {
    logger.warn("Webhook request missing X-Hub-Signature-256 header");
    return false;
  }

  // Signature format: "sha256=<hex>"
  const expectedPrefix = "sha256=";
  if (!signature.startsWith(expectedPrefix)) {
    logger.warn({ signature }, "Webhook signature has invalid format");
    return false;
  }

  const signatureHex = signature.slice(expectedPrefix.length);

  // Calculate expected signature
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf-8");
  const expectedSignature = hmac.digest("hex");

  // Constant-time comparison to prevent timing attacks
  let isValid = false;
  try {
    const sigBuffer = Buffer.from(signatureHex, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    isValid = sigBuffer.length === expectedBuffer.length &&
      timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    isValid = false;
  }

  if (!isValid) {
    logger.warn(
      { 
        received: signatureHex.slice(0, 8) + "...", 
        expected: expectedSignature.slice(0, 8) + "..." 
      },
      "Webhook signature verification failed",
    );
  }

  return isValid;
}
