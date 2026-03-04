/** Match type returned by the search engine */
export type MatchType = "match" | "uncertain" | "multiple" | "alternative" | "not_found";

/** Phases of the offer processing flow */
export type OfferPhase = "idle" | "parsing" | "parsed" | "processing" | "review";

/** A product from the catalog */
export interface Product {
  id?: string;
  sku: string;
  name: string;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  unit: string | null;
  ean: string | null;
  name_secondary?: string | null;
  price?: number | null;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  eshop_url?: string | null;
}

/** A parsed item before search (editable by user) */
export interface ParsedItem {
  id: string;
  name: string;
  unit: string | null;
  quantity: number | null;
  extraColumns?: Record<string, string>;
}

/** A matched offer item after search */
export interface OfferItem {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: MatchType;
  confidence: number;
  product: Product | null;
  candidates: Product[];
  confirmed?: boolean;
  extraColumns?: Record<string, string>;
}

/** SSE event from backend */
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Compact offer item sent to the offer agent for context */
export interface OfferItemSummary {
  position: number;
  name: string;
  sku: string | null;
  manufacturer: string | null;
  category: string | null;
  matchType: string;
}

/** Actions returned by the offer agent */
export type OfferAction =
  | { type: "parse_items"; items: Array<{ name: string; quantity: number | null }> }
  | { type: "add_item"; name: string; quantity: number | null; selectedSku: string | null; product?: Product | null }
  | { type: "replace_product"; position: number; selectedSku: string; reasoning: string; product?: Product | null }
  | { type: "remove_item"; position: number };

/** Debug log entry from agent execution */
export interface DebugEntry {
  ts: number;
  type: "prompt" | "tool_call" | "tool_result" | "raw_output" | "parsed_actions" | "error";
  tool?: string;
  data: unknown;
}

/** Tool call indicator shown inline in the chat bubble */
export interface ToolCallStatus {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done";
}

/** Chat message displayed in the UI */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCallStatus[];
}

/** Phases of the pricelist upload flow */
export type PricelistPhase =
  | "idle"
  | "uploading"
  | "mapping"
  | "analyzing"
  | "analyzed"
  | "applying"
  | "completed"
  | "failed";

/** Summary of differences between uploaded file and current DB */
export interface DiffSummary {
  totalInFile: number;
  totalInDb: number;
  toAdd: number;
  toUpdate: number;
  toRemove: number;
  sampleNew: string[];
  sampleRemove: string[];
}

/** Record of a past pricelist upload */
export interface PricelistUpload {
  id: string;
  filename: string;
  status: string;
  total_in_file: number | null;
  total_in_db: number | null;
  items_added: number | null;
  items_updated: number | null;
  items_removed: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}
