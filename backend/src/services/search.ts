import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "./supabase.js";

// ── V2 Result Types ─────────────────────────────────────────

export interface ProductResult {
  id: number;
  sku: string;
  name: string;
  unit: string | null;
  current_price: number | null;
  supplier_name: string | null;
  category_main: string | null;
  category_sub: string | null;
  category_line: string | null;
  is_stock_item: boolean;
  has_stock: boolean;
  removed_at: string | null;
  description: string | null;
  status_purchase_code: string | null;
  status_purchase_text: string | null;
  status_sales_code: string | null;
  status_sales_text: string | null;
  dispo: string | null;
}

export interface FulltextResult extends ProductResult {
  rank: number;
  similarity_score: number;
}

export interface AgentFulltextResult extends ProductResult {
  rank: number;
}

export interface SemanticResult extends ProductResult {
  cosine_similarity: number;
}

export interface ExactResult extends ProductResult {
  match_type: string;
  matched_value: string;
}

export interface CategoryTreeEntry {
  category_code: string;
  category_name: string;
  level: number;
  parent_code: string | null;
  product_count: number | null;
}

// ── Stock / Branch filter options ────────────────────────────

export interface StockFilterOptions {
  stockItemOnly?: boolean;
  inStockOnly?: boolean;
  branchCodeFilter?: string | null;
}

// ── Fulltext Search ─────────────────────────────────────────

export async function searchProductsFulltext(
  query: string,
  maxResults = 20,
  client?: SupabaseClient,
  manufacturer?: string,
  category?: string,
  stockOpts?: StockFilterOptions,
): Promise<FulltextResult[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {
    search_query: query,
    max_results: maxResults,
  };
  if (manufacturer) rpcParams.manufacturer_filter = manufacturer;
  if (category) rpcParams.category_filter = category;
  if (stockOpts?.stockItemOnly) rpcParams.stock_item_only = true;
  if (stockOpts?.inStockOnly) rpcParams.in_stock_only = true;
  if (stockOpts?.branchCodeFilter) rpcParams.branch_code_filter = stockOpts.branchCodeFilter;

  const { data, error } = await supabase.rpc("search_products_v2_fulltext", rpcParams);

  if (error) {
    throw new Error(`Fulltext search failed: ${error.message}`);
  }

  return (data ?? []) as FulltextResult[];
}

// ── Agent Fulltext Search (name-only, lightweight) ───────────

export async function searchProductsAgentFulltext(
  query: string,
  maxResults = 40,
  client?: SupabaseClient,
  manufacturer?: string,
  category?: string,
  stockOpts?: StockFilterOptions,
): Promise<AgentFulltextResult[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {
    search_query: query,
    max_results: maxResults,
  };
  if (manufacturer) rpcParams.manufacturer_filter = manufacturer;
  if (category) rpcParams.category_filter = category;
  if (stockOpts?.stockItemOnly) rpcParams.stock_item_only = true;
  if (stockOpts?.inStockOnly) rpcParams.in_stock_only = true;

  const { data, error } = await supabase.rpc("search_products_agent_fulltext", rpcParams);

  if (error) {
    throw new Error(`Agent fulltext search failed: ${error.message}`);
  }

  return (data ?? []) as AgentFulltextResult[];
}

// ── Semantic Search ─────────────────────────────────────────

export async function searchProductsSemantic(
  embedding: number[],
  maxResults = 10,
  threshold = 0.5,
  client?: SupabaseClient,
  manufacturer?: string,
  category?: string,
  stockOpts?: StockFilterOptions,
): Promise<SemanticResult[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {
    query_embedding: JSON.stringify(embedding),
    max_results: maxResults,
    similarity_threshold: threshold,
  };
  if (manufacturer) rpcParams.manufacturer_filter = manufacturer;
  if (category) rpcParams.category_filter = category;
  if (stockOpts?.stockItemOnly) rpcParams.stock_item_only = true;
  if (stockOpts?.inStockOnly) rpcParams.in_stock_only = true;
  if (stockOpts?.branchCodeFilter) rpcParams.branch_code_filter = stockOpts.branchCodeFilter;

  const { data, error } = await supabase.rpc("search_products_v2_semantic", rpcParams);

  if (error) {
    throw new Error(`Semantic search failed: ${error.message}`);
  }

  return (data ?? []) as SemanticResult[];
}

// ── Exact Lookup (SKU / EAN / IDNLF) ───────────────────────

export async function lookupProductsExact(
  query: string,
  maxResults = 10,
  client?: SupabaseClient,
): Promise<ExactResult[]> {
  const supabase = client ?? getAdminClient();

  const { data, error } = await supabase.rpc("lookup_products_v2_exact", {
    lookup_query: query,
    max_results: maxResults,
  });

  if (error) {
    throw new Error(`Exact lookup failed: ${error.message}`);
  }

  return (data ?? []) as ExactResult[];
}

// ── Category Tree ───────────────────────────────────────────

export async function getCategoryTree(
  client?: SupabaseClient,
): Promise<CategoryTreeEntry[]> {
  const supabase = client ?? getAdminClient();

  const { data, error } = await supabase.rpc("get_category_tree_v2");

  if (error) {
    throw new Error(`Category tree failed: ${error.message}`);
  }

  return (data ?? []) as CategoryTreeEntry[];
}

// ── Fetch by SKU ────────────────────────────────────────────

export async function fetchProductsBySkus(
  skus: string[],
  client?: SupabaseClient,
): Promise<ProductResult[]> {
  if (skus.length === 0) return [];
  const supabase = client ?? getAdminClient();

  const { data, error } = await supabase
    .from("products_v2")
    .select(`
      id, sku, name, unit, supplier_name,
      category_main, category_sub, category_line,
      is_stock_item, removed_at, description,
      status_purchase_code, status_purchase_text,
      status_sales_code, status_sales_text, dispo
    `)
    .in("sku", skus);

  if (error) {
    throw new Error(`Fetch by SKU failed: ${error.message}`);
  }

  const products = data ?? [];
  const productIds = products.map((p: any) => p.id as number);

  const [{ data: prices }, { data: stockData }] = await Promise.all([
    supabase
      .from("product_price_v2")
      .select("product_id, current_price")
      .in("product_id", productIds),
    supabase
      .from("product_branch_stock_v2")
      .select("product_id")
      .in("product_id", productIds),
  ]);

  const priceMap = new Map<number, number>(
    (prices ?? []).map((p: any) => [p.product_id as number, Number(p.current_price)]),
  );

  const hasStockSet = new Set<number>(
    (stockData ?? []).map((s: any) => s.product_id as number),
  );

  return products.map((p: any) => ({
    ...p,
    current_price: priceMap.get(p.id) ?? null,
    has_stock: hasStockSet.has(p.id),
  })) as ProductResult[];
}

export async function getProductBySku(
  sku: string,
  client?: SupabaseClient,
): Promise<ProductResult | null> {
  const results = await fetchProductsBySkus([sku], client);
  return results[0] ?? null;
}

// ── Fetch by IDs ────────────────────────────────────────────

export async function fetchProductsByIds(
  ids: number[],
  client?: SupabaseClient,
): Promise<ProductResult[]> {
  if (ids.length === 0) return [];
  const supabase = client ?? getAdminClient();

  const { data, error } = await supabase.rpc("get_products_v2_by_ids", {
    product_ids: ids,
  });

  if (error) {
    throw new Error(`Fetch by IDs failed: ${error.message}`);
  }

  return (data ?? []) as ProductResult[];
}
