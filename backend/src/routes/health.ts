import { Hono } from "hono";
import { getAdminClient } from "../services/supabase.js";
import { qdrantHealthCheck } from "../services/qdrantSearch.js";

const health = new Hono();

health.get("/health", async (c) => {
  const checks: Record<string, string> = { server: "ok" };

  await Promise.all([
    (async () => {
      try {
        const supabase = getAdminClient();
        const { error } = await supabase.from("products").select("id").limit(1);
        checks.database = error ? "error" : "ok";
      } catch {
        checks.database = "unreachable";
      }
    })(),
    (async () => {
      const result = await qdrantHealthCheck();
      checks.qdrant = result.ok ? `ok (${result.pointsCount?.toLocaleString() ?? "?"} points)` : `error: ${result.error}`;
    })(),
  ]);

  const healthy = checks.database === "ok" && checks.qdrant.startsWith("ok");

  return c.json(
    { status: healthy ? "healthy" : "degraded", checks, timestamp: new Date().toISOString() },
    healthy ? 200 : 503,
  );
});

export { health };
