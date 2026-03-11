import type { SSEEvent, Product, PricelistUpload, OfferItemSummary, OfferHeader } from "./types";

/** Backend URL — direct from browser, no proxy */
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

/**
 * Stream SSE events directly from the backend (bypasses Next.js proxy).
 */
async function* streamSSE(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): AsyncGenerator<SSEEvent> {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const json = trimmed.slice(6);
        if (json === "[DONE]") return;
        try {
          yield JSON.parse(json) as SSEEvent;
        } catch {
          // skip malformed
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse unstructured text via AI agent (SSE) */
export function parseChat(message: string, token: string) {
  return streamSSE("/agent/chat", { message }, token);
}

/** Search for already-parsed items (SSE) */
export function searchItems(
  items: Array<{ name: string; unit: string | null; quantity: number | null }>,
  token: string,
) {
  return streamSSE("/agent/search", { items }, token);
}

/** Offer chat agent – intelligent assistant for managing the offer (SSE) */
export function offerChat(
  message: string,
  offerItems: OfferItemSummary[],
  token: string,
) {
  return streamSSE("/agent/offer-chat", { message, offerItems }, token);
}

/** Semantic search for not_found items (SSE) – user-triggered Phase 2 */
export function searchItemsSemantic(
  items: Array<{ name: string; unit: string | null; quantity: number | null; position: number }>,
  token: string,
) {
  return streamSSE("/agent/search-semantic", { items }, token);
}

/** Manual single-product search for review modal (REST) */
export async function searchProducts(
  query: string,
  token: string,
): Promise<Product[]> {
  const res = await fetch(`${BACKEND_URL}/agent/product-search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

/** Download XLSX export (REST) */
export async function downloadXlsx(
  items: Array<Record<string, unknown>>,
  header: OfferHeader,
  token: string,
): Promise<Blob> {
  const res = await fetch(`${BACKEND_URL}/export/xlsx`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items, header }),
  });
  if (!res.ok) throw new Error("Export failed");
  return res.blob();
}

/** Upload a pricelist Excel file (REST) */
export async function uploadPricelist(
  file: File,
  token: string,
): Promise<{ uploadId: string; filename: string; fileSize: number }> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BACKEND_URL}/pricelist/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Upload failed: ${res.status}`);
  }

  return res.json();
}

/** Preview column headers + samples from uploaded file (REST) */
export async function previewColumns(
  uploadId: string,
  token: string,
): Promise<ColumnPreviewResponse> {
  const res = await fetch(`${BACKEND_URL}/pricelist/preview-columns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ uploadId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Preview failed: ${res.status}`);
  }

  return res.json();
}

export interface ColumnPreviewResponse {
  headers: string[];
  sampleRows: string[][];
  suggestedMapping: Record<string, string>;
  totalRows: number;
  productFields: Array<{ key: string; label: string; required: boolean }>;
}

/** Analyze an uploaded pricelist file (SSE) */
export function analyzePricelist(
  uploadId: string,
  token: string,
  columnMapping?: Record<string, string>,
) {
  return streamSSE("/pricelist/analyze", { uploadId, columnMapping }, token);
}

/** Apply pricelist changes to the database (SSE) */
export function applyPricelist(uploadId: string, token: string) {
  return streamSSE("/pricelist/apply", { uploadId }, token);
}

/** Fetch pricelist upload history (REST) */
export async function getPricelistHistory(
  token: string,
): Promise<PricelistUpload[]> {
  const res = await fetch(`${BACKEND_URL}/pricelist/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.uploads ?? [];
}

/** Fetch paginated product catalog preview (REST) */
export async function getProductsPreview(
  token: string,
  params: { page?: number; pageSize?: number; search?: string; category?: string } = {},
): Promise<ProductsPreviewResponse> {
  const qs = new URLSearchParams();
  if (params.page != null) qs.set("page", String(params.page));
  if (params.pageSize != null) qs.set("pageSize", String(params.pageSize));
  if (params.search) qs.set("search", params.search);
  if (params.category) qs.set("category", params.category);

  const res = await fetch(`${BACKEND_URL}/pricelist/products?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error("Failed to load products");
  return res.json();
}

/** Fetch product catalog stats (REST) */
export async function getPricelistStats(
  token: string,
): Promise<PricelistStats> {
  const res = await fetch(`${BACKEND_URL}/pricelist/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error("Failed to load stats");
  return res.json();
}

export interface ProductsPreviewResponse {
  products: ProductPreview[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ProductPreview {
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
}

export interface PricelistStats {
  totalProducts: number;
  categories: Array<{ category: string; count: number }>;
}

// ──────────────────────────────────────────────────────────
// Offers API
// ──────────────────────────────────────────────────────────

export interface OfferSummary {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface OfferDetail {
  id: string;
  title: string;
  status: string;
  messages: ChatMessageDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDTO {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
}

export interface OfferItemDTO {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: string;
  confidence: number;
  product: Product | null;
  candidates: Product[];
  confirmed: boolean;
  extraColumns: Record<string, string>;
}

export async function listOffers(token: string): Promise<OfferSummary[]> {
  const res = await fetch(`${BACKEND_URL}/offers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load offers");
  const data = await res.json();
  return data.offers ?? [];
}

export async function createOffer(
  title: string,
  token: string,
): Promise<OfferSummary> {
  const res = await fetch(`${BACKEND_URL}/offers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Create failed: ${res.status}`);
  }
  const data = await res.json();
  return data.offer;
}

export async function getOffer(
  id: string,
  token: string,
): Promise<{ offer: OfferDetail; items: OfferItemDTO[] }> {
  const res = await fetch(`${BACKEND_URL}/offers/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Offer not found");
  return res.json();
}

export async function updateOffer(
  id: string,
  data: { title?: string; status?: string },
  token: string,
): Promise<OfferSummary> {
  const res = await fetch(`${BACKEND_URL}/offers/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update offer");
  const json = await res.json();
  return json.offer;
}

export async function deleteOffer(
  id: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/offers/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to delete offer");
}

export async function saveOfferMessages(
  offerId: string,
  messages: ChatMessageDTO[],
  token: string,
): Promise<void> {
  await fetch(`${BACKEND_URL}/offers/${offerId}/messages`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages }),
  });
}

export interface SaveOfferItemInput {
  position: number;
  originalName: string;
  unit?: string | null;
  quantity?: number | null;
  matchType?: string;
  confidence?: number;
  productId?: string | null;
  confirmed?: boolean;
  candidates?: unknown[];
  extraColumns?: Record<string, string>;
}

export async function saveOfferItems(
  offerId: string,
  items: SaveOfferItemInput[],
  token: string,
): Promise<void> {
  await fetch(`${BACKEND_URL}/offers/${offerId}/items`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items }),
  });
}

/** User profile data */
export interface UserProfile {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
}

/** Fetch the current user's profile (REST) */
export async function getProfile(token: string): Promise<UserProfile> {
  const res = await fetch(`${BACKEND_URL}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Failed to load profile");
  return res.json();
}

/** Update the current user's profile (REST) */
export async function updateProfile(
  data: { first_name?: string; last_name?: string; phone?: string },
  token: string,
): Promise<UserProfile> {
  const res = await fetch(`${BACKEND_URL}/profile`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update profile");
  return res.json();
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/profile/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Nepodařilo se změnit heslo.");
  }
}
