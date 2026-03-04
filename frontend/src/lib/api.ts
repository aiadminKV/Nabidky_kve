import type { SSEEvent, Product, PricelistUpload, OfferItemSummary } from "./types";

/** All calls (REST + SSE) go through Next.js rewrites → /api/:path* → backend */
const API_URL = "/api";

/**
 * Stream SSE events directly from the backend (bypasses Next.js proxy).
 */
async function* streamSSE(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): AsyncGenerator<SSEEvent> {
  const res = await fetch(`${API_URL}${endpoint}`, {
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
  const res = await fetch(`${API_URL}/agent/product-search`, {
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
  token: string,
): Promise<Blob> {
  const res = await fetch(`${API_URL}/export/xlsx`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items }),
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

  const res = await fetch(`${API_URL}/pricelist/upload`, {
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
  const res = await fetch(`${API_URL}/pricelist/preview-columns`, {
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
  const res = await fetch(`${API_URL}/pricelist/history`, {
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

  const res = await fetch(`${API_URL}/pricelist/products?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error("Failed to load products");
  return res.json();
}

/** Fetch product catalog stats (REST) */
export async function getPricelistStats(
  token: string,
): Promise<PricelistStats> {
  const res = await fetch(`${API_URL}/pricelist/stats`, {
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
  const res = await fetch(`${API_URL}/profile`, {
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
  const res = await fetch(`${API_URL}/profile`, {
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
