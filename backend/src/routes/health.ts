import { Hono } from "hono";
import { getAdminClient } from "../services/supabase.js";

const health = new Hono();

health.get("/health", async (c) => {
  const checks: Record<string, string> = { server: "ok" };

  try {
    const supabase = getAdminClient();
    const { error } = await supabase.from("products").select("id").limit(1);
    checks.database = error ? `error: ${error.message}` : "ok";
  } catch {
    checks.database = "unreachable";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  return c.json(
    { status: healthy ? "healthy" : "degraded", checks, timestamp: new Date().toISOString() },
    healthy ? 200 : 503,
  );
});

export { health };
