import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { env } from "./config/env.js";
import { logger } from "./services/logger.js";
import { health } from "./routes/health.js";
import { agentRoutes } from "./routes/agent.js";
import { exportRouter } from "./routes/export.js";
import { pricelistRouter } from "./routes/pricelist.js";
import { profileRouter } from "./routes/profile.js";
import { offersRouter } from "./routes/offers.js";
import { customersRouter } from "./routes/customers.js";
import { qdrantRouter } from "./routes/qdrant.js";
import { startSyncCron, triggerSyncManually, isSyncRunning } from "./cron/daily-sync.js";
import { invalidateKBCache } from "./services/kitKnowledgeBase.js";
import { authMiddleware, adminMiddleware } from "./middleware/auth.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { userQueueMiddleware } from "./middleware/userQueue.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { notify, registerChannel, createGoogleChatChannel } from "./services/notifier.js";
import { qdrantHealthCheck } from "./services/qdrantSearch.js";

const app = new Hono();

app.use("*", requestLogger);
app.use("*", bodyLimit({ maxSize: 5 * 1024 * 1024 }));
app.use("/agent/offer-chat", bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// Per-user concurrency queue for review modal re-searches (neomezuje rychlost, jen souběžnost)
app.use("/agent/search-item", userQueueMiddleware({ maxConcurrent: 3, maxWaiting: 20, timeoutMs: 90_000 }));

// Rate limity pro drahe endpointy
app.use("/agent/offer-chat", rateLimiter({ windowMs: 60_000, max: 20 }));    // AI chat, nejdrazsi
app.use("/agent/search", rateLimiter({ windowMs: 60_000, max: 10 }));         // batch search, 1 call = cela nabidka
app.use("/agent/search-plan", rateLimiter({ windowMs: 60_000, max: 15 }));    // planovani
app.use("/agent/*", rateLimiter({ windowMs: 60_000, max: 60 }));              // fallback pro ostatni /agent/ endpointy
app.use("/qdrant/*", rateLimiter({ windowMs: 60_000, max: 60 }));
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = [env.FRONTEND_URL, "http://localhost:3000"];
      // In dev, allow any localhost port (multiple Next.js instances may run on different ports).
      const isLocalhost = origin?.match(/^http:\/\/localhost:\d+$/);
      if (isLocalhost) return origin;
      return allowed.includes(origin) ? origin : env.FRONTEND_URL;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.route("/", health);
app.route("/", agentRoutes);
app.route("/", exportRouter);
app.route("/", pricelistRouter);
app.route("/", profileRouter);
app.route("/", offersRouter);
app.route("/", customersRouter);
app.route("/", qdrantRouter);

app.get("/", (c) =>
  c.json({ name: "KV Offer Manager API", version: "0.1.0" }),
);

app.post("/admin/sync/trigger", authMiddleware, adminMiddleware, (c) => {
  const started = triggerSyncManually();
  if (!started) return c.json({ error: "Sync already running" }, 409);
  return c.json({ message: "Sync started" });
});

app.get("/admin/sync/status", authMiddleware, adminMiddleware, (c) => {
  return c.json({ running: isSyncRunning() });
});

app.post("/admin/kit/cache/invalidate", authMiddleware, adminMiddleware, (c) => {
  invalidateKBCache();
  return c.json({ ok: true });
});

app.onError((err, c) => {
  const requestId = c.res.headers.get("x-request-id") ?? c.req.header("x-request-id");
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message, requestId, path: c.req.path, method: c.req.method }, "unhandled route error");
  if (isProduction) {
    notify({ level: "error", title: "Unhandled API error", details: `${c.req.method} ${c.req.path}: ${message}`, source: "api" });
  }
  return c.json({ error: "Internal server error" }, 500);
});

const isProduction = env.NODE_ENV === "production";

if (isProduction && env.SYNC_WEBHOOK_URL) {
  registerChannel(createGoogleChatChannel(env.SYNC_WEBHOOK_URL));
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception");
  if (isProduction) {
    notify({ level: "critical", title: "Uncaught exception", details: err.message, source: "process" })
      .finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error({ err: message }, "unhandled rejection");
  if (isProduction) {
    notify({ level: "error", title: "Unhandled rejection", details: message, source: "process" });
  }
});

serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    logger.info({ port: info.port }, "backend started");
    if (isProduction) {
      notify({ level: "info", title: "Backend started", details: `Port ${info.port}`, source: "startup" });
    }
    startSyncCron();

    // Qdrant connectivity check on startup
    qdrantHealthCheck().then((result) => {
      if (result.ok) {
        logger.info({ pointsCount: result.pointsCount }, "Qdrant connected");
      } else {
        logger.error({ err: result.error }, "Qdrant unreachable on startup");
        if (isProduction) {
          notify({
            level: "critical",
            title: "Qdrant nedostupný",
            details: `Qdrant search nebude fungovat: ${result.error}`,
            source: "startup",
          });
        }
      }
    }).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Qdrant health check failed on startup");
    });
  },
);
