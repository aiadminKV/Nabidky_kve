/**
 * kitKnowledgeBase.ts
 *
 * Loads set composition recipes from the admin-managed knowledge base (Supabase).
 * Used by decomposeSet as the primary source before falling back to web search.
 */

import { getAdminClient } from "./supabase.js";
import type { SetComponent } from "./searchPipeline.js";

interface KBSharedComponent {
  role: string;
  name: string;
  manufacturer_code: string | null;
  ean: string | null;
  quantity: number;
}

interface KBFunctionComponent {
  role: string;
  name: string;
  manufacturer_code: string | null;
  ean: string | null;
  quantity: number;
}

interface KBFunctionType {
  id: string;
  name: string;
  notes: string | null;
  examples: { example_query: string }[];
  components: KBFunctionComponent[];
}

export interface KBSeries {
  id: string;
  brand: string;
  series: string;
  color_name: string;
  notes: string | null;
  sharedComponents: KBSharedComponent[];
  functionTypes: KBFunctionType[];
}

/** In-memory cache to avoid repeated DB queries within a single request */
let cachedSeries: KBSeries[] | null = null;
let cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadAll(): Promise<KBSeries[]> {
  const now = Date.now();
  if (cachedSeries && now - cacheTs < CACHE_TTL_MS) return cachedSeries;

  const sb = getAdminClient();
  const [seriesRes, sharedRes, ftRes, exRes, fcRes] = await Promise.all([
    sb.from("kit_series").select("id, brand, series, color_name, notes"),
    sb.from("kit_shared_components").select("series_id, role, name, manufacturer_code, ean, quantity").order("sort_order"),
    sb.from("kit_function_types").select("id, series_id, name, notes").order("sort_order"),
    sb.from("kit_function_examples").select("function_type_id, example_query").order("sort_order"),
    sb.from("kit_function_components").select("function_type_id, role, name, manufacturer_code, ean, quantity").order("sort_order"),
  ]);

  const series = (seriesRes.data ?? []) as { id: string; brand: string; series: string; color_name: string; notes: string | null }[];
  const shared = (sharedRes.data ?? []) as (KBSharedComponent & { series_id: string })[];
  const fts = (ftRes.data ?? []) as { id: string; series_id: string; name: string; notes: string | null }[];
  const exs = (exRes.data ?? []) as { function_type_id: string; example_query: string }[];
  const fcs = (fcRes.data ?? []) as (KBFunctionComponent & { function_type_id: string })[];

  cachedSeries = series.map((s) => ({
    ...s,
    sharedComponents: shared.filter((c) => c.series_id === s.id),
    functionTypes: fts
      .filter((ft) => ft.series_id === s.id)
      .map((ft) => ({
        ...ft,
        examples: exs.filter((e) => e.function_type_id === ft.id),
        components: fcs.filter((c) => c.function_type_id === ft.id),
      })),
  }));
  cacheTs = now;
  return cachedSeries;
}

/** Invalidate cache (call after admin saves) */
export function invalidateKBCache() {
  cachedSeries = null;
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Normalize text for fuzzy matching (lowercase, remove diacritics, collapse whitespace).
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Simple token overlap score between two normalized strings.
 */
function tokenOverlap(a: string, b: string): number {
  // Keep numeric tokens (e.g. "1", "2") since they distinguish "1-násobná" vs "2-násobná"
  const relevant = (t: string) => t.length > 1 || /^\d+$/.test(t);
  const ta = new Set(normalize(a).split(" ").filter(relevant));
  const tb = new Set(normalize(b).split(" ").filter(relevant));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.max(ta.size, tb.size);
}

/**
 * Find the best matching KBSeries for a given brand+series+color hint.
 * Returns null if no match found (score < threshold).
 */
export function findBestSeries(setHint: string): KBSeries | null {
  if (!cachedSeries) return null;

  let best: KBSeries | null = null;
  let bestScore = 0;

  for (const s of cachedSeries) {
    const candidate = `${s.brand} ${s.series} ${s.color_name}`;
    const score = tokenOverlap(setHint, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  // Require at least 2 matching tokens (brand + series or series + color)
  return bestScore >= 0.3 ? best : null;
}

/**
 * Find the best matching function type within a series for a given product name.
 * Matches against both the function type name and its example queries.
 */
export function findBestFunctionType(series: KBSeries, productName: string): KBFunctionType | null {
  let best: KBFunctionType | null = null;
  let bestScore = 0;

  for (const ft of series.functionTypes) {
    // Score against function type name
    let score = tokenOverlap(productName, ft.name);

    // Also score against all examples — use the best example score
    for (const ex of ft.examples) {
      const exScore = tokenOverlap(productName, ex.example_query);
      if (exScore > score) score = exScore;
    }

    if (score > bestScore) {
      bestScore = score;
      best = ft;
    }
  }

  return bestScore >= 0.25 ? best : null;
}

/**
 * Build the full component list for a product:
 * = function-specific components (mechanism, cover) + shared components (frame, nosič)
 */
export function buildComponentList(
  series: KBSeries,
  ft: KBFunctionType,
): SetComponent[] {
  const toComp = (c: KBSharedComponent | KBFunctionComponent): SetComponent => ({
    name: c.name,
    role: c.role as SetComponent["role"],
    quantity: c.quantity,
    manufacturerCode: c.manufacturer_code,
    ean: c.ean,
  });

  return [
    ...ft.components.map(toComp),
    ...series.sharedComponents.map(toComp),
  ];
}

/**
 * Main entry point: look up a product in the KB.
 * Returns component list or null if not found.
 */
export async function lookupInKB(
  itemName: string,
  setHint: string,
): Promise<{ components: SetComponent[]; seriesName: string; functionTypeName: string } | null> {
  await loadAll();

  const series = findBestSeries(setHint);
  if (!series) return null;

  const ft = findBestFunctionType(series, itemName);
  if (!ft) {
    // Series found but function type unknown — still return shared components so at least
    // frame/nosič are included; caller will do web search for the mechanism
    return {
      components: series.sharedComponents.map((c) => ({
        name: c.name,
        role: c.role as SetComponent["role"],
        quantity: c.quantity,
        manufacturerCode: c.manufacturer_code,
        ean: c.ean,
      })),
      seriesName: `${series.brand} ${series.series} ${series.color_name}`,
      functionTypeName: "(neznámý typ funkce)",
    };
  }

  return {
    components: buildComponentList(series, ft),
    seriesName: `${series.brand} ${series.series} ${series.color_name}`,
    functionTypeName: ft.name,
  };
}
