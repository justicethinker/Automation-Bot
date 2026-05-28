import app from "./app";
import { logger } from "./lib/logger";
import { setupQueueWorkers, closeQueueWorkers } from "./lib/queue-workers";
import { closeQueues } from "./lib/queue";
import { closeDatabase, checkDatabaseHealth } from "@workspace/db";
import { scheduleIdempotencyKeyCleanup } from "./lib/idempotency";
import { scheduleExpiredPendingOrdersCleanup } from "./lib/pending-orders";

/**
 * Validate all required environment variables at startup
 * This prevents runtime failures due to missing configuration
 */
function validateEnvironment() {
  const required = [
    "PORT",
    "NODE_ENV",
    "DATABASE_URL",
    "REDIS_URL",
    "FRONTEND_URL",
    "VERIFY_TOKEN",
    "ACCESS_TOKEN",
  ];

  const missing: string[] = [];
  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(", ")}. 
Please check your .env file and ensure all required variables are set.
Reference .env.example for a complete list of required variables.`;
    logger.error({ missing }, message);
    throw new Error(message);
  }

  logger.info("✅ All required environment variables are set");
}

// Validate environment before anything else
try {
  validateEnvironment();
} catch (err) {
  logger.error({ err }, "Environment validation failed - cannot start server");
  process.exit(1);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Start server
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, nodeEnv: process.env.NODE_ENV }, "Server listening");
});

/**
 * Initialize production-critical systems
 */
async function initializeProduction() {
  try {
    logger.info("Initializing production systems...");

    // Check database connectivity
    const dbHealth = await checkDatabaseHealth();
    if (!dbHealth.ok) {
      if (process.env.NODE_ENV === "development") {
        logger.warn(dbHealth, "Database health check failed (development mode - continuing anyway)");
      } else {
        logger.error(dbHealth, "Database health check failed");
        process.exit(1);
      }
    } else {
      logger.info(dbHealth, "Database health check passed");
    }

    // Start queue workers (process background jobs)
    try {
      await setupQueueWorkers();
      logger.info("Queue workers initialized");
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        logger.warn({ err }, "Queue workers setup failed (development mode - continuing anyway)");
      } else {
        throw err;
      }
    }

    // Schedule periodic cleanups
    scheduleIdempotencyKeyCleanup(3600000); // Every hour
    scheduleExpiredPendingOrdersCleanup(3600000); // Every hour
    logger.info("Periodic cleanup tasks scheduled");

    logger.info("✅ All production systems initialized");
  } catch (err) {
    logger.error({ err }, "Failed to initialize production systems");
    if (process.env.NODE_ENV !== "development") {
      process.exit(1);
    }
  }
}

// Initialize on startup
initializeProduction().catch((err) => {
  logger.error({ err }, "Fatal error during initialization");
  process.exit(1);
});

/**
 * Graceful shutdown handler
 * Closes connections cleanly to prevent data loss
 */
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Graceful shutdown initiated");

  try {
    // Stop accepting new connections
    server.close(async () => {
      logger.info("HTTP server closed, closing resources...");

      // Close queue workers
      try {
        await closeQueueWorkers();
      } catch (err) {
        logger.error({ err }, "Error closing queue workers");
      }

      // Close queues
      try {
        await closeQueues();
      } catch (err) {
        logger.error({ err }, "Error closing queues");
      }

      // Close database connection pool
      try {
        await closeDatabase();
      } catch (err) {
        logger.error({ err }, "Error closing database");
      }

      logger.info("✅ Graceful shutdown complete");
      process.exit(0);
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error("Forced shutdown: timeout exceeded");
      process.exit(1);
    }, 30000);
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}

// Listen for shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled rejection");
  process.exit(1);
});
