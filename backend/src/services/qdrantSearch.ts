/**
 * Qdrant vector search service.
 *
 * Mirrors the interface of searchProductsSemantic() in search.ts so it can
 * be swapped in or run in parallel for A/B comparison.
 *
 * Env vars:
 *   QDRANT_URL     — Qdrant base URL (default: http://localhost:6333)
 *   QDRANT_API_KEY — API key for Qdrant Cloud (optional for local)
 */

import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { SemanticResult, StockFilterOptions } from "./search.js";

export const COLLECTION_NAME = "products_v2_large";

// Large model for Qdrant (must match what was used during migration)
const QDRANT_EMBEDDING_MODEL = "text-embedding-3-large";
const QDRANT_EMBEDDING_DIMS = 512;

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * Generate a query embedding using text-embedding-3-large (512d).
 * Used exclusively for Qdrant searches against products_v2_large.
 */
export async function generateQueryEmbeddingLarge(query: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: QDRANT_EMBEDDING_MODEL,
    dimensions: QDRANT_EMBEDDING_DIMS,
    input: query,
  });
  return response.data[0]!.embedding;
}

let _client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!_client) {
    const url = process.env.QDRANT_URL ?? "http://localhost:6333";
    const apiKey = process.env.QDRANT_API_KEY;
    _client = new QdrantClient({ url, ...(apiKey ? { apiKey } : {}), checkCompatibility: false });
  }
  return _client;
}

// ── Filter builder ───────────────────────────────────────────

type QdrantMustCondition =
  | { key: string; match: { text: string } }
  | { key: string; match: { value: boolean | string } }
  | { key: string; match: { any: string[] } };

type QdrantFilter =
  | { must: QdrantMustCondition[]; must_not?: Array<{ is_empty: { key: string } }> }
  | { must: QdrantMustCondition[]; must_not: Array<{ is_empty: { key: string } }> };

function buildFilter(
  manufacturer?: string,
  category?: string,
  stockOpts?: StockFilterOptions,
): QdrantFilter | undefined {
  const must: QdrantMustCondition[] = [];
  const must_not: Array<{ is_empty: { key: string } }> = [];

  // Never return removed products
  must.push({ key: "removed", match: { value: false } });

  if (manufacturer) {
    // Text index on supplier_name → case-insensitive word-based matching
    must.push({ key: "supplier_name", match: { text: manufacturer } });
  }

  if (category) {
    // category_prefixes is an array of all ancestor + own codes stored at migration time.
    // e.g. product with category_code "4050205" has category_prefixes ["4050205","40502","405"]
    // Falls back to exact match on category_code if category_prefixes is not present.
    must.push({ key: "category_prefixes", match: { any: [category] } });
  }

  if (stockOpts?.stockItemOnly) {
    must.push({ key: "is_stock_item", match: { value: true } });
  }

  if (stockOpts?.inStockOnly) {
    // must_not is_empty means branch_codes array must have at least one element
    must_not.push({ is_empty: { key: "branch_codes" } });
  }

  if (stockOpts?.branchCodeFilter) {
    must.push({
      key: "branch_codes",
      match: { any: [stockOpts.branchCodeFilter] },
    });
  }

  if (must.length === 0 && must_not.length === 0) return undefined;
  return must_not.length > 0 ? { must, must_not } : { must };
}

// ── Search ───────────────────────────────────────────────────

interface QdrantPayload {
  sku?: string;
  name?: string;
  unit?: string | null;
  current_price?: number | null;
  supplier_name?: string | null;
  category_main?: string | null;
  category_sub?: string | null;
  category_line?: string | null;
  is_stock_item?: boolean;
  branch_codes?: string[];
  removed?: boolean;
}

/**
 * Search products in Qdrant by embedding vector.
 *
 * Same signature as searchProductsSemantic() — drop-in replacement.
 */
export async function searchProductsQdrant(
  embedding: number[],
  maxResults = 10,
  threshold = 0.15,
  _client?: undefined,
  manufacturer?: string,
  category?: string,
  stockOpts?: StockFilterOptions,
): Promise<SemanticResult[]> {
  const qdrant = getQdrantClient();

  const filter = buildFilter(manufacturer, category, stockOpts);

  const results = await qdrant.search(COLLECTION_NAME, {
    vector: embedding,
    limit: maxResults,
    score_threshold: threshold,
    with_payload: true,
    ...(filter ? { filter } : {}),
  });

  return results.map((hit) => {
    const p = (hit.payload ?? {}) as QdrantPayload;
    return {
      id: typeof hit.id === "number" ? hit.id : parseInt(String(hit.id), 10),
      sku: p.sku ?? "",
      name: p.name ?? "",
      unit: p.unit ?? null,
      current_price: p.current_price ?? null,
      supplier_name: p.supplier_name ?? null,
      category_main: p.category_main ?? null,
      category_sub: p.category_sub ?? null,
      category_line: p.category_line ?? null,
      is_stock_item: p.is_stock_item ?? false,
      has_stock: (p.branch_codes?.length ?? 0) > 0,
      removed_at: p.removed ? "removed" : null,
      description: null,
      status_purchase_code: null,
      status_purchase_text: null,
      status_sales_code: null,
      status_sales_text: null,
      dispo: null,
      cosine_similarity: hit.score,
    };
  });
}

// ── Health check ─────────────────────────────────────────────

export async function qdrantHealthCheck(): Promise<{
  ok: boolean;
  pointsCount?: number;
  error?: string;
}> {
  try {
    const qdrant = getQdrantClient();
    const info = await qdrant.getCollection(COLLECTION_NAME);
    return {
      ok: true,
      pointsCount: info.points_count ?? undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
