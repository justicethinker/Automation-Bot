import { createClient } from "redis";
import { logger } from "./logger";

// Shared Redis client for rate limiting
let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on("error", (err) => logger.error({ err }, "Redis client error"));
    await redisClient.connect();
  }
  return redisClient;
}

export class RedisRateLimiter {
  constructor(
    private readonly prefix: string,
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly blockDurationMs: number,
  ) {}

  async isLimited(identifier: string): Promise<boolean> {
    try {
      // Use a simple counter with TTL for sliding window
      // Each request increments the counter, which automatically expires after windowMs
      const redis = await getRedisClient();
      const key = `${this.prefix}:${identifier}`;
      const blockKey = `${this.prefix}:blocked:${identifier}`;

      // Check if currently blocked
      const isBlocked = await redis.exists(blockKey);
      if (isBlocked) {
        logger.debug(
          { identifier, prefix: this.prefix },
          "Rate limit: blocked (temporary ban)",
        );
        return true;
      }

      // Get current request count in this window
      const count = await redis.incr(key);

      // Set expiration on first request
      if (count === 1) {
        await redis.expire(key, Math.ceil(this.windowMs / 1000));
      }

      // Check if exceeded
      if (count >= this.maxRequests) {
        // Set block key
        await redis.setEx(
          blockKey,
          Math.ceil(this.blockDurationMs / 1000),
          "1",
        );
        logger.warn(
          {
            identifier,
            prefix: this.prefix,
            count,
            limit: this.maxRequests,
            blockDurationMs: this.blockDurationMs,
          },
          "Rate limit: exceeded, blocking requests",
        );
        return true;
      }

      return false;
    } catch (err) {
      // Fail open: on Redis error, don't rate limit
      // Better to allow the request than to reject valid ones
      logger.warn(
        { err, identifier, prefix: this.prefix },
        "Rate limit check failed, allowing request",
      );
      return false;
    }
  }

  async reset(identifier: string): Promise<void> {
    try {
      const redis = await getRedisClient();
      const key = `${this.prefix}:${identifier}`;
      const blockKey = `${this.prefix}:blocked:${identifier}`;
      await Promise.all([redis.del(key), redis.del(blockKey)]);
      logger.debug({ identifier, prefix: this.prefix }, "Rate limit reset");
    } catch (err) {
      logger.warn(
        { err, identifier, prefix: this.prefix },
        "Failed to reset rate limit",
      );
    }
  }
}

export const customerRateLimiter = new RedisRateLimiter("customer", 10, 60000, 5000);
export const adminCommandLimiter = new RedisRateLimiter("admin", 20, 60000, 10000);

export async function shouldRateLimitCustomer(phone: string): Promise<boolean> {
  return customerRateLimiter.isLimited(phone);
}

export async function shouldRateLimitAdminCommand(vendorId: string): Promise<boolean> {
  return adminCommandLimiter.isLimited(vendorId);
}
