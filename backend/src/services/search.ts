import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "./supabase.js";

export interface ProductResult {
  id: string;
  sku: string;
  name: string;
  name_secondary: string | null;
  unit: string | null;
  price: number | null;
  ean: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
  eshop_url: string | null;
  rank: number;
  similarity_score: number;
}

export interface SemanticResult extends Omit<ProductResult, "rank" | "similarity_score"> {
  cosine_similarity: number;
}

/**
 * Fulltext + trigram hybrid search.
 * Uses the DB-level RPC function for optimal performance.
 */
export async function searchProductsFulltext(
  query: string,
  maxResults = 20,
  client?: SupabaseClient,
  manufacturer?: string,
  category?: string,
): Promise<ProductResult[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {
    search_query: query,
    max_results: maxResults,
  };
  if (manufacturer) rpcParams.manufacturer_filter = manufacturer;
  if (category) rpcParams.category_filter = category;

  const { data, error } = await supabase.rpc("search_products_fulltext", rpcParams);

  if (error) {
    throw new Error(`Fulltext search failed: ${error.message}`);
  }

  return (data ?? []) as ProductResult[];
}

export interface CategoryInfo {
  category: string;
  subcategories: { name: string; cnt: number }[];
  manufacturers: { name: string; cnt: number }[];
}

export interface TopCategory {
  name: string;
  cnt: number;
}

/**
 * Get category info: top-level categories (no arg) or subcategories + manufacturers for a specific category.
 */
export async function getCategoryInfo(
  category?: string,
  client?: SupabaseClient,
): Promise<CategoryInfo | TopCategory[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {};
  if (category) rpcParams.target_category = category;

  const { data, error } = await supabase.rpc("get_category_info", rpcParams);

  if (error) {
    throw new Error(`Category info failed: ${error.message}`);
  }

  return data as CategoryInfo | TopCategory[];
}

/**
 * Semantic vector search (requires embeddings to be generated).
 */
export async function searchProductsSemantic(
  embedding: number[],
  maxResults = 10,
  threshold = 0.5,
  client?: SupabaseClient,
  manufacturer?: string,
): Promise<SemanticResult[]> {
  const supabase = client ?? getAdminClient();

  const rpcParams: Record<string, unknown> = {
    query_embedding: JSON.stringify(embedding),
    max_results: maxResults,
    similarity_threshold: threshold,
  };
  if (manufacturer) rpcParams.manufacturer_filter = manufacturer;

  const { data, error } = await supabase.rpc("search_products_semantic", rpcParams);

  if (error) {
    throw new Error(`Semantic search failed: ${error.message}`);
  }

  return (data ?? []) as SemanticResult[];
}

/**
 * Fetch multiple products by their SKU codes.
 */
export async function fetchProductsBySkus(
  skus: string[],
  client?: SupabaseClient,
): Promise<ProductResult[]> {
  if (skus.length === 0) return [];
  const supabase = client ?? getAdminClient();
  const { data } = await supabase
    .from("products")
    .select("id, sku, name, name_secondary, unit, price, ean, manufacturer_code, manufacturer, category, subcategory, sub_subcategory, eshop_url")
    .in("sku", skus);
  return (data ?? []) as ProductResult[];
}

/**
 * Get a product by its SKU code.
 */
export async function getProductBySku(
  sku: string,
  client?: SupabaseClient,
): Promise<ProductResult | null> {
  const supabase = client ?? getAdminClient();

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("sku", sku)
    .single();

  if (error) return null;
  return data as ProductResult;
}
