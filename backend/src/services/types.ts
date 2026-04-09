/**
 * types.ts
 * Shared types for the search pipeline (V2 production + legacy eval scripts).
 */

import type { ProductResult } from "./search.js";

// ── Preferences ────────────────────────────────────────────

export interface SearchPreferences {
  stockFilter: "any" | "in_stock" | "stock_items_only" | "stock_items_in_stock";
  branchFilter: string | null;
}

export const DEFAULT_PREFERENCES: SearchPreferences = {
  stockFilter: "any",
  branchFilter: null,
};

// ── Input ──────────────────────────────────────────────────

export interface ParsedItem {
  name: string;
  unit: string | null;
  quantity: number | null;
  instruction?: string | null;
  /** Výrobcova katalogová čísla (source_idnlf_raw) — přidají se jako prioritní kandidáti */
  extraLookupCodes?: string[];
}

// ── Output ─────────────────────────────────────────────────

export interface PipelineResult {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  product: Partial<ProductResult> | null;
  candidates: Array<Partial<ProductResult>>;
  reasoning: string;
  priceNote: string | null;
  reformulatedQuery: string;
  pipelineMs: number;
  exactLookupAttempted: boolean;
  exactLookupFound: boolean;
}

export interface GroupContext {
  preferredManufacturer: string | null;
  preferredLine: string | null;
}

export type PipelineDebugFn = (entry: {
  position: number;
  step: string;
  data: unknown;
}) => void;

// ── Search plan (output of createSearchPlan) ───────────────

export interface SearchPlanGroup {
  groupName: string;
  category: string | null;
  suggestedManufacturer: string | null;
  suggestedLine: string | null;
  notes: string | null;
  itemIndices: number[];
}

export interface SearchPlan {
  groups: SearchPlanGroup[];
  enrichedItems: Array<ParsedItem & { groupIndex: number }>;
}
