import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { logger } from "../lib/logger";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] ?? req.headers["authorization"]?.replace("Bearer ", "");
  const validKey = process.env.API_SECRET_KEY;

  if (!validKey) {
    logger.error("API_SECRET_KEY environment variable is not set");
    return res.status(500).json({ error: "server_configuration_error" });
  }

  if (!apiKey || typeof apiKey !== "string") {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Constant-time comparison to prevent timing attacks
  try {
    const keyBuffer = Buffer.from(apiKey);
    const validBuffer = Buffer.from(validKey);
    if (keyBuffer.length !== validBuffer.length || !timingSafeEqual(keyBuffer, validBuffer)) {
      return res.status(401).json({ error: "unauthorized" });
    }
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
}
