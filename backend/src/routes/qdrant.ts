/**
 * Qdrant search routes — for A/B testing against Supabase semantic search.
 *
 * POST /qdrant/search     — single-query vector search
 * POST /qdrant/compare    — run same query against both SB and Qdrant, return side-by-side
 * GET  /qdrant/health     — check Qdrant connection and collection stats
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { generateQueryEmbedding } from "../services/embedding.js";
import { searchProductsSemantic, type StockFilterOptions } from "../services/search.js";
import { searchProductsQdrant, qdrantHealthCheck } from "../services/qdrantSearch.js";

export const qdrantRouter = new Hono();

// ── POST /qdrant/search ──────────────────────────────────────

interface SearchBody {
  query: string;
  maxResults?: number;
  threshold?: number;
  manufacturer?: string;
  category?: string;
  stockItemOnly?: boolean;
  inStockOnly?: boolean;
  branchCode?: string;
}

qdrantRouter.post("/qdrant/search", authMiddleware, async (c) => {
  const body = await c.req.json<SearchBody>();

  if (!body.query?.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

  const stockOpts: StockFilterOptions = {
    stockItemOnly: body.stockItemOnly,
    inStockOnly: body.inStockOnly,
    branchCodeFilter: body.branchCode,
  };

  const t0 = Date.now();
  const embedding = await generateQueryEmbedding(body.query.trim());
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const results = await searchProductsQdrant(
    embedding,
    body.maxResults ?? 20,
    body.threshold ?? 0.15,
    undefined,
    body.manufacturer,
    body.category,
    stockOpts,
  );
  const searchMs = Date.now() - t1;

  return c.json({
    results,
    meta: {
      query: body.query,
      count: results.length,
      embedMs,
      searchMs,
      totalMs: Date.now() - t0,
    },
  });
});

// ── POST /qdrant/compare ─────────────────────────────────────

qdrantRouter.post("/qdrant/compare", authMiddleware, async (c) => {
  const body = await c.req.json<SearchBody>();

  if (!body.query?.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

  const stockOpts: StockFilterOptions = {
    stockItemOnly: body.stockItemOnly,
    inStockOnly: body.inStockOnly,
    branchCodeFilter: body.branchCode,
  };

  const t0 = Date.now();
  const embedding = await generateQueryEmbedding(body.query.trim());
  const embedMs = Date.now() - t0;

  const limit = body.maxResults ?? 20;
  const threshold = body.threshold ?? 0.15;

  const [sbRaw, qdRaw] = await Promise.all([
    searchProductsSemantic(
      embedding,
      limit,
      threshold,
      undefined,
      body.manufacturer,
      body.category,
      stockOpts,
    ).then((r) => ({ results: r, ms: Date.now() - t0 - embedMs })),
    searchProductsQdrant(
      embedding,
      limit,
      threshold,
      undefined,
      body.manufacturer,
      body.category,
      stockOpts,
    ).then((r) => ({ results: r, ms: Date.now() - t0 - embedMs })),
  ]);

  const sbSkus = new Set(sbRaw.results.map((r) => r.sku));
  const qdSkus = new Set(qdRaw.results.map((r) => r.sku));
  const overlap = [...sbSkus].filter((s) => qdSkus.has(s));

  return c.json({
    query: body.query,
    supabase: {
      results: sbRaw.results,
      count: sbRaw.results.length,
      ms: sbRaw.ms,
    },
    qdrant: {
      results: qdRaw.results,
      count: qdRaw.results.length,
      ms: qdRaw.ms,
    },
    overlap: {
      count: overlap.length,
      skus: overlap,
    },
    embedMs,
    totalMs: Date.now() - t0,
  });
});

// ── GET /qdrant/health ───────────────────────────────────────

qdrantRouter.get("/qdrant/health", authMiddleware, async (c) => {
  const health = await qdrantHealthCheck();
  return c.json(health, health.ok ? 200 : 503);
});
