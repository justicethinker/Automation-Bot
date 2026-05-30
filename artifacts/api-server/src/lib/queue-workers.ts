import { incomingQueue, outboundQueue, broadcastQueue, IncomingMessageJob, OutboundMessageJob, BroadcastMessageJob } from "./queue";
import { handleIncomingMessage } from "./bot";
import { sendWhatsAppMessage } from "./whatsapp";
import { db } from "@workspace/db";
import { vendorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const INCOMING_CONCURRENCY = 5;    // Process up to 5 incoming messages concurrently
const OUTBOUND_CONCURRENCY = 10;   // Send up to 10 messages concurrently
const BROADCAST_CONCURRENCY = 3;   // Process 3 broadcast batches concurrently

/**
 * Setup queue workers for processing messages
 * Call this once during application startup
 */
export async function setupQueueWorkers(): Promise<void> {
  logger.info("Setting up queue workers...");

  // ──────────────────────────────────────────────────────────────────────
  // Incoming Message Processing
  // ──────────────────────────────────────────────────────────────────────
  incomingQueue.process(INCOMING_CONCURRENCY, async (job) => {
    const data = job.data as IncomingMessageJob;

    try {
      logger.debug({ jobId: job.id, phone: data.fromPhone }, "Processing incoming message");

      // Fetch vendor
      const [vendor] = await db
        .select()
        .from(vendorsTable)
        .where(eq(vendorsTable.id, data.vendorId))
        .limit(1);

      if (!vendor) {
        logger.error({ vendorId: data.vendorId }, "Vendor not found");
        throw new Error("Vendor not found");
      }

      // Process the message
      await handleIncomingMessage({
        vendor,
        fromPhone: data.fromPhone,
        fromName: data.fromName,
        body: data.body,
      });

      logger.debug({ jobId: job.id, phone: data.fromPhone }, "Incoming message processed successfully");
    } catch (err) {
      logger.error(
        { jobId: job.id, err, attemptsMade: job.attemptsMade, data },
        "Error processing incoming message",
      );
      throw err;  // Re-throw to trigger retry
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Outbound Message Sending
  // ──────────────────────────────────────────────────────────────────────
  outboundQueue.process(OUTBOUND_CONCURRENCY, async (job) => {
    const data = job.data as OutboundMessageJob;

    try {
      logger.debug({ jobId: job.id, to: data.to }, "Sending outbound message");

      const result = await sendWhatsAppMessage({
        phoneNumberId: data.phoneNumberId,
        to: data.to,
        text: data.text,
        idempotencyKey: data.idempotencyKey,
      });

      if (!result.ok) {
        logger.warn(
          { jobId: job.id, to: data.to, reason: result.reason },
          "Message send failed",
        );
        throw new Error(`Send failed: ${result.reason}`);
      }

      logger.debug({ jobId: job.id, to: data.to, messageId: result.messageId }, "Message sent successfully");
    } catch (err) {
      logger.error(
        { jobId: job.id, err, attemptsMade: job.attemptsMade, to: data.to },
        "Error sending outbound message",
      );
      throw err;  // Re-throw to trigger retry
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Broadcast Message Processing
  // ──────────────────────────────────────────────────────────────────────
  broadcastQueue.process(BROADCAST_CONCURRENCY, async (job) => {
    const data = job.data as any;  // BroadcastMessageJob

    try {
      logger.debug(
        { jobId: job.id, batchIndex: data.batchIndex, recipientCount: data.recipients.length },
        "Processing broadcast batch",
      );

      // Send with rate limiting
      for (const recipient of data.recipients) {
        await sendWhatsAppMessage({
          phoneNumberId: data.phoneNumberId,
          to: recipient.phone,
          text: data.message,
        });

        // Small delay between messages to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      logger.debug(
        { jobId: job.id, batchIndex: data.batchIndex },
        "Broadcast batch processed successfully",
      );
    } catch (err) {
      logger.error(
        { jobId: job.id, err, batchIndex: data.batchIndex },
        "Error processing broadcast batch",
      );
      throw err;
    }
  });

  logger.info({
    incoming: INCOMING_CONCURRENCY,
    outbound: OUTBOUND_CONCURRENCY,
    broadcast: BROADCAST_CONCURRENCY,
  }, "Queue workers started");
}

/**
 * Gracefully close all queue workers
 * Call this during application shutdown
 */
export async function closeQueueWorkers(): Promise<void> {
  logger.info("Closing queue workers...");
  await Promise.all([
    incomingQueue.close(),
    outboundQueue.close(),
    broadcastQueue.close(),
  ]);
  logger.info("Queue workers closed");
}
