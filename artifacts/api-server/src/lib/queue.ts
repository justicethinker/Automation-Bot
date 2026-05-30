import Queue from "bull";
import { logger } from "./logger";

/**
 * queue.ts
 * Handles message processing with retry logic and backpressure protection.
 * 
 * Benefits:
 * - Prevents request pile-up during traffic spikes
 * - Automatic retry with exponential backoff
 * - Survives process restarts (Redis persistence)
 * - Concurrency control (prevents overwhelming the database)
 */

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export interface IncomingMessageJob {
  vendorId: string;
  fromPhone: string;
  fromName: string;
  body: string;
  timestamp: number;
  attempt: number;
}

export interface OutboundMessageJob {
  phoneNumberId: string;
  to: string;
  text: string;
  timestamp: number;
  attempt: number;
  idempotencyKey?: string;
}

export interface BroadcastMessageJob {
  vendorId: string;
  phoneNumberId: string;
  recipients: Array<{ phone: string }>;
  message: string;
  batchSize: number;
  batchIndex: number;
}

// Incoming webhook message processing queue
export const incomingQueue = new Queue("incoming-messages", REDIS_URL, {
  settings: {
    maxStalledCount: 3,        // Max times a job can be stalled before failed
    stalledInterval: 30000,    // Check for stalled jobs every 30 seconds
    lockRenewTime: 15000,      // Renew lock every 15 seconds
    lockDuration: 60000,       // Lock expires after 60 seconds
    retryProcessDelay: 1000,   // Delay between processing retries
  },
  defaultJobOptions: {
    attempts: 3,               // Retry up to 3 times
    backoff: {
      type: "exponential",
      delay: 2000,             // Start with 2 second delay, doubles each retry
    },
    removeOnComplete: {
      age: 3600,               // Remove completed jobs after 1 hour
    },
    removeOnFail: false,       // Keep failed jobs for debugging
  },
});

// Outbound WhatsApp message queue (with higher retry count)
export const outboundQueue = new Queue("outbound-messages", REDIS_URL, {
  settings: {
    maxStalledCount: 5,
    stalledInterval: 30000,
    lockRenewTime: 15000,
    lockDuration: 60000,
    retryProcessDelay: 2000,
  },
  defaultJobOptions: {
    attempts: 5,               // More retries for outbound (important!)
    backoff: {
      type: "exponential",
      delay: 3000,             // Start with 3 second delay
    },
    removeOnComplete: {
      age: 86400,              // Keep for 24 hours
    },
    removeOnFail: false,
  },
});

// Broadcast message queue (separate to avoid blocking priority messages)
export const broadcastQueue = new Queue("broadcast-messages", REDIS_URL, {
  settings: {
    maxStalledCount: 2,
    stalledInterval: 60000,
    lockRenewTime: 30000,
    lockDuration: 120000,
  },
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
    priority: 10,              // Lower priority than normal messages
  },
});

// Event handlers for monitoring
incomingQueue.on("completed", (job) => {
  logger.debug({ jobId: job.id, data: job.data }, "Incoming message processed");
});

incomingQueue.on("failed", (job, err) => {
  logger.error(
    { jobId: job.id, attempt: job.attemptsMade, err, data: job.data },
    "Incoming message processing failed after retries",
  );
});

incomingQueue.on("stalled", (job) => {
  logger.warn({ jobId: job.id, data: job.data }, "Incoming message job stalled");
});

outboundQueue.on("completed", (job) => {
  logger.debug({ jobId: job.id, to: job.data.to }, "Outbound message sent");
});

outboundQueue.on("failed", (job, err) => {
  logger.error(
    { jobId: job.id, attempt: job.attemptsMade, to: job.data.to, err },
    "Outbound message failed to send after retries",
  );
});

outboundQueue.on("stalled", (job) => {
  logger.warn({ jobId: job.id, to: job.data.to }, "Outbound message job stalled");
});

broadcastQueue.on("failed", (job, err) => {
  logger.warn(
    { jobId: job.id, batchIndex: job.data.batchIndex, err },
    "Broadcast batch failed",
  );
});

/**
 * Add incoming message to processing queue
 * Returns immediately; processing happens asynchronously
 */
export async function queueIncomingMessage(
  vendorId: string,
  fromPhone: string,
  fromName: string,
  body: string,
): Promise<void> {
  await incomingQueue.add(
    {
      vendorId,
      fromPhone,
      fromName,
      body,
      timestamp: Date.now(),
      attempt: 1,
    } as IncomingMessageJob,
    {
      priority: 5,  // Normal priority
    },
  );
}

/**
 * Add outbound message to send queue
 * Ensures delivery with retries
 */
export async function queueOutboundMessage(
  phoneNumberId: string,
  to: string,
  text: string,
  idempotencyKey?: string,
): Promise<void> {
  await outboundQueue.add(
    {
      phoneNumberId,
      to,
      text,
      timestamp: Date.now(),
      attempt: 1,
      idempotencyKey,
    } as OutboundMessageJob,
    {
      priority: 1,  // High priority for customer-facing messages
      jobId: idempotencyKey ? `msg:${idempotencyKey}` : undefined,
    },
  );
}

/**
 * Add broadcast message job to broadcast queue
 * Sends message to multiple recipients in batches
 */
export async function queueBroadcastMessage(job: BroadcastMessageJob): Promise<void> {
  await broadcastQueue.add(job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

/**
 * Health check for queue infrastructure
 */
export async function checkQueueHealth(): Promise<{
  incomingQueueOk: boolean;
  outboundQueueOk: boolean;
  redisConnected: boolean;
  pendingIncoming: number;
  pendingOutbound: number;
}> {
  try {
    const [incomingCount, outboundCount] = await Promise.all([
      incomingQueue.count(),
      outboundQueue.count(),
    ]);

    return {
      incomingQueueOk: true,
      outboundQueueOk: true,
      redisConnected: true,
      pendingIncoming: incomingCount,
      pendingOutbound: outboundCount,
    };
  } catch (err) {
    logger.error({ err }, "Queue health check failed");
    return {
      incomingQueueOk: false,
      outboundQueueOk: false,
      redisConnected: false,
      pendingIncoming: 0,
      pendingOutbound: 0,
    };
  }
}

/**
 * Close queue connections (call on graceful shutdown)
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    incomingQueue.close(),
    outboundQueue.close(),
    broadcastQueue.close(),
  ]);
  logger.info("All queues closed");
}
