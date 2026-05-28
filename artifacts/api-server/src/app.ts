import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  }),
);

// ────────────────────────────────────────────────────────────────────────
// SECURITY: Capture raw body before JSON parsing (needed for webhook signature verification)
// ────────────────────────────────────────────────────────────────────────
app.use(
  express.json({
    verify: (req: any, res, buf) => {
      // Store the raw body for webhook signature verification
      req.rawBody = buf.toString("utf-8");
    },
  }),
);

app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ────────────────────────────────────────────────────────────────────────
// Serve frontend static files
// ────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../../control-panel/dist")));

// Catch-all: serve index.html for any unmatched route (SPA support)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../../control-panel/dist/index.html"));
});

export default app;
