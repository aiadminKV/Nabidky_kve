import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { getAdminClient } from "../services/supabase.js";

type Env = {
  Variables: {
    user: { id: string; app_metadata?: { role?: string } };
    accessToken: string;
  };
};

const customersRouter = new Hono<Env>();

/**
 * GET /customers/search?q=...&limit=8
 * Fulltext + trigram search in customers_v2.
 * Returns source_kunnr (customer ID), ico, name, address.
 */
customersRouter.get("/customers/search", authMiddleware, async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Number(c.req.query("limit")) || 8, 20);

  if (q.length < 2) {
    return c.json({ customers: [] });
  }

  // Escape ILIKE special chars
  const safeQ = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

  const supabase = getAdminClient();

  // Search by name (trigram), source_kunnr prefix, or ICO exact/prefix
  // Uses trigram GIN index on name and B-tree index on ico
  const { data, error } = await supabase
    .from("customers_v2")
    .select("source_kunnr, ico, name, address")
    .or(
      `name.ilike.%${safeQ}%,source_kunnr.ilike.${safeQ}%,ico.ilike.${safeQ}%`,
    )
    .limit(limit);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ customers: data ?? [] });
});

export { customersRouter };
