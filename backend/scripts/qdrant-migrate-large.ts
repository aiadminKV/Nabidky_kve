/**
 * qdrant-migrate-large.ts
 *
 * Re-embeds the full product catalog using text-embedding-3-large (512 dims)
 * into a new Qdrant collection `products_v2_large` with scalar quantization.
 *
 * Data sources:
 *   PRIMARY  — Sync API (SYNC_API_URL/matnr_dispo_info.csv): provides LONGTEXT
 *              descriptions that are often missing in Supabase. Downloaded
 *              automatically unless --skip-download or --csv is provided.
 *   FALLBACK — Local CSV file (--csv <path>): use instead of API download.
 *   METADATA — Supabase products_v2: category hierarchy, is_stock_item,
 *              branch_codes, supplier_name (cleaned), removed status.
 *
 * Embedding text order (optimised for semantic recall):
 *   1. {name}         — primary product identifier
 *   2. {description}  — richest semantic content (LONGTEXT from CSV/API)
 *   3. Výrobce: {X}   — brand context for brand-specific queries
 *
 * Filters are stored as Qdrant PAYLOAD (NOT embedded):
 *   supplier_name (text idx), category_code/category_prefixes (keyword),
 *   is_stock_item (bool), branch_codes (keyword), removed (bool)
 *
 * Flags:
 *   --csv <path>       Use local CSV instead of API download
 *   --skip-download    Skip download, use already-cached CSV from data dir
 *   --recreate         Drop and recreate the Qdrant collection
 *   --resume           Continue from last indexed product_id
 *   --from <id>        Start from specific product_id
 *   --dry-run          Estimate cost only, no writes
 *
 * Usage:
 *   npx tsx backend/scripts/qdrant-migrate-large.ts --recreate
 *   npx tsx backend/scripts/qdrant-migrate-large.ts --resume
 *   npx tsx backend/scripts/qdrant-migrate-large.ts --csv /path/to/file.csv
 */

import { config } from "dotenv";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { parse as csvParse } from "csv-parse";
import pg from "pg";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Config ───────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const COLLECTION_NAME = "products_v2_large";
const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMS = 512;
const DB_BATCH_SIZE = 2000;    // rows per Supabase page
const EMBED_BATCH_SIZE = 100;  // texts per OpenAI call (~15K tokens per call for large)
const UPSERT_BATCH_SIZE = 500; // points per Qdrant upsert
const DESC_MAX_LEN = 1000;     // max description chars in embedding text
const RATE_LIMIT_PAUSE_MS = 60_000;

// Sync API (same as daily-sync-v2.ts)
const API_BASE = process.env.SYNC_API_URL ?? "https://api.kvelektro.cz/ainabidky/KVP";
const API_USER = process.env.SYNC_API_USER ?? "access";
const API_PASS = process.env.SYNC_API_PASSWORD ?? "";
const SYNC_DATA_DIR = resolve(__dirname, "../../data-model/sync");
const CACHED_CSV = join(SYNC_DATA_DIR, "new_matnr_dispo_info.csv");

// ── CLI args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const RECREATE = args.includes("--recreate");
const RESUME = args.includes("--resume");
const DRY_RUN = args.includes("--dry-run");
const SKIP_DOWNLOAD = args.includes("--skip-download");
const CSV_PATH = (() => {
  const idx = args.indexOf("--csv");
  return idx !== -1 ? args[idx + 1] : null;
})();
const FROM_ID = (() => {
  const idx = args.indexOf("--from");
  return idx !== -1 ? parseInt(args[idx + 1] ?? "0", 10) : null;
})();

// ── Clients ──────────────────────────────────────────────────

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const DATABASE_URL = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "";

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
  checkCompatibility: false,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Sync API CSV loader ───────────────────────────────────────

/**
 * Download the full product CSV from the KV Elektro sync API.
 * Same source as daily-sync-v2.ts uses. Saves to CACHED_CSV.
 */
async function downloadSyncCsv(): Promise<void> {
  const url = `${API_BASE}/matnr_dispo_info.csv`;
  const auth = Buffer.from(`${API_USER}:${API_PASS}`).toString("base64");

  console.log(`Downloading catalog CSV from ${url}…`);
  const t = Date.now();

  const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`Sync API HTTP ${resp.status}: ${resp.statusText}`);

  mkdirSync(SYNC_DATA_DIR, { recursive: true });
  await streamPipeline(
    Readable.fromWeb(resp.body! as never),
    createWriteStream(CACHED_CSV),
  );

  const size = statSync(CACHED_CSV).size;
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)}s → ${CACHED_CSV}`);
}

/**
 * Parse the KV Elektro sync CSV (matnr_dispo_info.csv) and return a
 * map of SKU → description (LONGTEXT column).
 *
 * CSV columns used:
 *   MATNR    — SAP material number → SKU (strip leading zeros)
 *   LONGTEXT — long product description (may be empty)
 */
async function loadSyncCsvDescriptions(csvPath: string): Promise<Map<string, string>> {
  const descMap = new Map<string, string>();
  let loaded = 0;
  let total = 0;

  const parser = createReadStream(csvPath, { encoding: "utf-8" }).pipe(
    csvParse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      quote: false,
    }),
  );

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    total++;
    const matnr = (row["MATNR"] ?? "").trim();
    if (!matnr) continue;

    // Strip leading zeros to match SKU format (same as matnrToSku in daily-sync-v2)
    const sku = matnr.replace(/^0+/, "") || "0";
    const description = (row["LONGTEXT"] ?? "").trim();

    if (description) {
      descMap.set(sku, description);
      loaded++;
    }
  }

  console.log(`Sync CSV parsed: ${loaded.toLocaleString()} descriptions from ${total.toLocaleString()} rows`);
  return descMap;
}

/**
 * Load SKU → description map from either:
 *  1. Sync API (downloaded fresh) — default
 *  2. Existing cached CSV (--skip-download)
 *  3. Explicit local CSV path (--csv <path>)
 */
async function loadDescriptions(): Promise<Map<string, string>> {
  if (CSV_PATH) {
    // Use explicitly provided CSV — could be pricelist or any format with LONGTEXT/description
    console.log(`Using provided CSV: ${CSV_PATH}`);
    return loadSyncCsvDescriptions(CSV_PATH);
  }

  if (SKIP_DOWNLOAD && existsSync(CACHED_CSV)) {
    console.log(`Using cached CSV: ${CACHED_CSV}`);
    return loadSyncCsvDescriptions(CACHED_CSV);
  }

  // Download fresh from sync API
  await downloadSyncCsv();
  return loadSyncCsvDescriptions(CACHED_CSV);
}

// ── Embedding text builder ────────────────────────────────────

/**
 * Build embedding text optimised for semantic search.
 *
 * Order: name → description → manufacturer
 *   - Name first: primary product identifier (what people search for)
 *   - Description: richest semantic content (technical specs, use cases)
 *   - Manufacturer last: brand context for brand-specific queries
 *
 * Filters (supplier_name, category_code, is_stock_item…) are stored as
 * Qdrant payload fields — NOT embedded here. Embedding stays lean & semantic.
 */
function buildEmbeddingText(p: {
  name: string;
  description: string | null;
  supplier_name: string | null;
}): string {
  const lines: string[] = [p.name.trim()];

  if (p.description?.trim()) {
    lines.push(p.description.trim().slice(0, DESC_MAX_LEN));
  }

  if (p.supplier_name?.trim()) {
    lines.push(`Výrobce: ${p.supplier_name.trim()}`);
  }

  return lines.join("\n");
}

// ── Category prefix builder ───────────────────────────────────

/**
 * Build ancestor category codes for prefix-based filtering.
 * e.g. "4050205" → ["4050205", "40502", "405"]
 * Allows agent to filter by any level (main cat "405", subcat "40502", etc.)
 */
function buildCategoryPrefixes(code: string | null | undefined): string[] {
  if (!code) return [];
  const prefixes: string[] = [code];
  if (code.length > 5) prefixes.push(code.slice(0, 5));
  if (code.length > 3) prefixes.push(code.slice(0, 3));
  return [...new Set(prefixes)];
}

// ── Qdrant collection setup ───────────────────────────────────

async function ensureCollection(recreate: boolean): Promise<void> {
  if (recreate) {
    try {
      await qdrant.deleteCollection(COLLECTION_NAME);
      console.log(`Deleted existing collection "${COLLECTION_NAME}".`);
    } catch {
      // Collection didn't exist — that's fine
    }
  }

  try {
    await qdrant.getCollection(COLLECTION_NAME);
    console.log(`Collection "${COLLECTION_NAME}" already exists — skipping creation.`);
  } catch {
    console.log(`Creating collection "${COLLECTION_NAME}"…`);
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIMS, distance: "Cosine" },
      // Scalar quantization: INT8 reduces memory ~4× with minimal quality loss.
      // always_ram: true keeps quantized vectors in RAM for fast search.
      quantization_config: {
        scalar: {
          type: "int8",
          quantile: 0.99,
          always_ram: true,
        },
      },
      // Store original (non-quantized) vectors on disk to save RAM;
      // search uses quantized vectors in RAM for speed.
      on_disk_payload: false,
    });
    console.log("Collection created with INT8 scalar quantization.");
  }

  // Payload indexes — drop-and-recreate to guarantee correct type.
  // A stale keyword index on supplier_name silently breaks text-match queries.
  const indexes: Array<{ field: string; schema: string | { type: string; tokenizer: string; lowercase: boolean } }> = [
    { field: "removed",           schema: "bool" },
    { field: "is_stock_item",     schema: "bool" },
    { field: "category_code",     schema: "keyword" },
    { field: "category_prefixes", schema: "keyword" },
    { field: "branch_codes",      schema: "keyword" },
    { field: "supplier_name",     schema: { type: "text", tokenizer: "word", lowercase: true } },
  ];

  for (const idx of indexes) {
    try { await qdrant.deletePayloadIndex(COLLECTION_NAME, idx.field); } catch { /* didn't exist */ }
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: idx.field,
      field_schema: idx.schema as Parameters<typeof qdrant.createPayloadIndex>[1]["field_schema"],
    });
  }
  console.log("Payload indexes ensured (drop+recreate).");
}

// ── Resume helper ─────────────────────────────────────────────

/** Find the maximum product_id already indexed in Qdrant (for --resume). */
async function getResumeId(): Promise<number> {
  let maxId = 0;
  let offset: number | string | null = null;

  console.log("Scanning Qdrant for max indexed product_id (resume)…");
  while (true) {
    const page = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: false,
      with_vector: false,
      ...(offset !== null ? { offset } : {}),
    });

    for (const pt of page.points) {
      const id = typeof pt.id === "number" ? pt.id : parseInt(String(pt.id), 10);
      if (id > maxId) maxId = id;
    }

    offset = page.next_page_offset ?? null;
    if (offset === null) break;
  }

  console.log(`Resume from product_id > ${maxId}`);
  return maxId;
}

// ── Embedding generator ───────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generate embeddings for a batch of texts.
 * Retries once on rate limit errors with a 60s pause.
 */
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMS,
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("rate_limit") || msg.includes("429")) {
      console.warn(`Rate limited — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s…`);
      await sleep(RATE_LIMIT_PAUSE_MS);
      // Retry once
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMS,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    }
    throw err;
  }
}

// ── Main migration ────────────────────────────────────────────

async function migrate(): Promise<void> {
  console.log("=".repeat(60));
  console.log(`Model:      ${EMBEDDING_MODEL} (${EMBEDDING_DIMS}d)`);
  console.log(`Collection: ${COLLECTION_NAME}`);
  console.log(`Qdrant:     ${QDRANT_URL}`);
  const csvSource = CSV_PATH ? `local file: ${CSV_PATH}` : SKIP_DOWNLOAD ? `cached: ${CACHED_CSV}` : `sync API: ${API_BASE}`;
  console.log(`CSV source: ${csvSource}`);
  console.log(`Flags:      ${[RECREATE && "--recreate", RESUME && "--resume", DRY_RUN && "--dry-run", SKIP_DOWNLOAD && "--skip-download", FROM_ID != null && `--from ${FROM_ID}`].filter(Boolean).join(" ") || "none"}`);
  console.log("=".repeat(60));

  // 1. Load descriptions from sync API CSV (primary) or fallback sources
  const csvDescriptions = await loadDescriptions();

  // 2. Set up Qdrant collection
  if (!DRY_RUN) {
    await ensureCollection(RECREATE);
  }

  // 3. Determine start ID
  let startFromId = 0;
  if (FROM_ID !== null && !isNaN(FROM_ID)) {
    startFromId = FROM_ID;
  } else if (RESUME && !DRY_RUN) {
    startFromId = await getResumeId();
  }

  // 4. Connect to Supabase (raw pg for efficient streaming)
  const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log("Connected to Supabase.");

  // Count total remaining
  const countRes = await db.query(
    "SELECT COUNT(*) as n FROM products_v2 WHERE id > $1 AND removed_at IS NULL",
    [startFromId],
  );
  const totalRemaining = parseInt(countRes.rows[0].n, 10);
  console.log(`Products to process: ${totalRemaining.toLocaleString()} (from id > ${startFromId})\n`);

  if (DRY_RUN) {
    // Cost estimate: ~150 tokens per product on average (name + desc + brand)
    const estimatedTokens = totalRemaining * 150;
    const estimatedCostUSD = (estimatedTokens / 1_000_000) * 0.13; // $0.13 per 1M tokens
    const totalBatches = Math.ceil(totalRemaining / EMBED_BATCH_SIZE);
    // Realistic: ~500ms per batch (network + API latency + Qdrant upsert)
    const estimatedMinutes = Math.ceil(totalBatches * 0.5 / 60);
    console.log(`DRY RUN — estimated tokens: ${(estimatedTokens / 1_000_000).toFixed(1)}M`);
    console.log(`DRY RUN — estimated cost: $${estimatedCostUSD.toFixed(2)}`);
    console.log(`DRY RUN — estimated batches: ${totalBatches.toLocaleString()} × ${EMBED_BATCH_SIZE}`);
    console.log(`DRY RUN — estimated time: ~${estimatedMinutes} min (~${(estimatedMinutes / 60).toFixed(1)} hr)`);
    await db.end();
    return;
  }

  // 5. Stream products in pages, embed, upsert
  let lastId = startFromId;
  let totalProcessed = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  // Point buffer — accumulate up to UPSERT_BATCH_SIZE before flushing to Qdrant
  type QdrantPoint = {
    id: number;
    vector: number[];
    payload: Record<string, unknown>;
  };
  const pointBuffer: QdrantPoint[] = [];

  async function flushBuffer(): Promise<void> {
    if (pointBuffer.length === 0) return;
    await qdrant.upsert(COLLECTION_NAME, { wait: true, points: pointBuffer });
    pointBuffer.length = 0;
  }

  while (true) {
    // Fetch next page from Supabase (keyset pagination for efficiency)
    const { rows } = await db.query<{
      id: string;
      sku: string;
      name: string;
      description: string | null;
      supplier_name: string | null;
      category_code: string | null;
      category_main: string | null;
      category_sub: string | null;
      category_line: string | null;
      is_stock_item: boolean;
      removed_at: string | null;
      current_price: string | null;
      unit: string | null;
      branch_codes: string[] | null;
    }>(
      `SELECT
         p.id,
         p.sku,
         p.name,
         p.description,
         p.supplier_name,
         p.category_code,
         p.category_main,
         p.category_sub,
         p.category_line,
         p.is_stock_item,
         p.removed_at,
         p.unit,
         pr.current_price,
         COALESCE(
           array_agg(DISTINCT b.source_branch_code)
             FILTER (WHERE b.source_branch_code IS NOT NULL),
           ARRAY[]::text[]
         ) AS branch_codes
       FROM products_v2 p
       LEFT JOIN product_price_v2 pr         ON pr.product_id = p.id
       LEFT JOIN product_branch_stock_v2 bs  ON bs.product_id = p.id
       LEFT JOIN branches_v2 b              ON b.id = bs.branch_id
       WHERE p.id > $1 AND p.removed_at IS NULL
       GROUP BY p.id, p.sku, p.name, p.description, p.supplier_name,
                p.category_code, p.category_main, p.category_sub, p.category_line,
                p.is_stock_item, p.removed_at, p.unit, pr.current_price
       ORDER BY p.id ASC
       LIMIT $2`,
      [lastId, DB_BATCH_SIZE],
    );

    if (rows.length === 0) break;
    lastId = parseInt(rows[rows.length - 1]!.id, 10);

    // Build embedding texts in sub-batches of EMBED_BATCH_SIZE
    for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
      const chunk = rows.slice(i, i + EMBED_BATCH_SIZE);

      const texts = chunk.map((row) => {
        // Prefer CSV description (richer) over Supabase description (may be null/empty)
        const csvDesc = csvDescriptions.get(row.sku);
        const description = csvDesc ?? row.description ?? null;

        return buildEmbeddingText({
          name: row.name,
          description,
          supplier_name: row.supplier_name,
        });
      });

      // Generate embeddings
      let embeddings: number[][];
      try {
        embeddings = await generateEmbeddings(texts);
      } catch (err) {
        console.error(`Embedding error (ids ${chunk[0]!.id}–${chunk[chunk.length - 1]!.id}): ${err}`);
        totalErrors += chunk.length;
        continue;
      }

      // Build Qdrant points
      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j]!;
        const csvDesc = csvDescriptions.get(row.sku);
        const description = csvDesc ?? row.description ?? null;

        pointBuffer.push({
          id: parseInt(row.id, 10),
          vector: embeddings[j]!,
          payload: {
            sku: row.sku,
            name: row.name,
            description: description?.slice(0, DESC_MAX_LEN) ?? null,
            unit: row.unit ?? null,
            current_price: row.current_price != null ? parseFloat(row.current_price) : null,
            supplier_name: row.supplier_name ?? null,
            category_code: row.category_code ?? null,
            category_main: row.category_main ?? null,
            category_sub: row.category_sub ?? null,
            category_line: row.category_line ?? null,
            category_prefixes: buildCategoryPrefixes(row.category_code),
            is_stock_item: row.is_stock_item ?? false,
            branch_codes: row.branch_codes ?? [],
            removed: row.removed_at !== null,
          },
        });

        // Flush when buffer is full
        if (pointBuffer.length >= UPSERT_BATCH_SIZE) {
          await flushBuffer();
        }
      }

      totalProcessed += chunk.length;
    }

    // Flush remaining points after each DB page
    await flushBuffer();

    // Progress report every DB page
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = Math.round(totalProcessed / elapsed);
    const remaining = totalRemaining - totalProcessed;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
    const etaStr = `${Math.floor(etaSec / 60)}m${etaSec % 60}s`;
    const pct = Math.round((totalProcessed / totalRemaining) * 100);
    console.log(
      `[${pct}%] ${totalProcessed.toLocaleString()}/${totalRemaining.toLocaleString()} | ${rate}/s | ETA: ${etaStr} | errors: ${totalErrors}`,
    );
  }

  // Final flush
  await flushBuffer();

  await db.end();

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(0);
  const collInfo = await qdrant.getCollection(COLLECTION_NAME);

  console.log("\n" + "=".repeat(60));
  console.log("Migration complete.");
  console.log(`Processed: ${totalProcessed.toLocaleString()} | Errors: ${totalErrors} | Time: ${totalSec}s`);
  console.log(`Qdrant points in collection: ${collInfo.points_count?.toLocaleString() ?? "?"}`);
  console.log("=".repeat(60));
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
