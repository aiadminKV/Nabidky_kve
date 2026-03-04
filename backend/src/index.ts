import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env.js";
import { health } from "./routes/health.js";
import { agentRoutes } from "./routes/agent.js";
import { exportRouter } from "./routes/export.js";
import { pricelistRouter } from "./routes/pricelist.js";
import { profileRouter } from "./routes/profile.js";
import { offersRouter } from "./routes/offers.js";

const app = new Hono();

app.use("*", logger());
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

app.get("/", (c) =>
  c.json({ name: "KV Offer Manager API", version: "0.1.0" }),
);

serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    console.log(`Backend running on http://localhost:${info.port}`);
  },
);
