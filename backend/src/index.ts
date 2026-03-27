import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { env } from "./config/env.js";
import { health } from "./routes/health.js";
import { agentRoutes } from "./routes/agent.js";
import { exportRouter } from "./routes/export.js";
import { pricelistRouter } from "./routes/pricelist.js";
import { profileRouter } from "./routes/profile.js";
import { offersRouter } from "./routes/offers.js";
import { customersRouter } from "./routes/customers.js";
import { startSyncCron, triggerSyncManually, isSyncRunning } from "./cron/daily-sync.js";

const app = new Hono();

app.use("*", logger());
app.use("/agent/offer-chat", bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = [env.FRONTEND_URL, "http://localhost:3000"];
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

app.get("/", (c) =>
  c.json({ name: "KV Offer Manager API", version: "0.1.0" }),
);

app.post("/admin/sync/trigger", (c) => {
  const started = triggerSyncManually();
  if (!started) return c.json({ error: "Sync already running" }, 409);
  return c.json({ message: "Sync started" });
});

app.get("/admin/sync/status", (c) => {
  return c.json({ running: isSyncRunning() });
});

serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    console.log(`Backend running on http://localhost:${info.port}`);
    startSyncCron();
  },
);
