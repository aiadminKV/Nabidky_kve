/**
 * Daily Sync Pipeline V2.
 *
 * Downloads a fresh CSV from the SAP API, compares it against the previous
 * baseline CSV (file-to-file, no unnecessary DB reads), and applies only
 * the differences to the V2 tables.
 *
 * Safety: --dry-run, configurable thresholds, --force to override, webhook alerts.
 *
 * Usage:
 *   npx tsx daily-sync-v2.ts                          # full sync
 *   npx tsx daily-sync-v2.ts --dry-run                # diff only, no writes
 *   npx tsx daily-sync-v2.ts --dry-run --skip-download # use already-downloaded CSV
 *   npx tsx daily-sync-v2.ts --skip-download          # apply using existing CSV
 *   npx tsx daily-sync-v2.ts --skip-embed             # skip re-embedding phase
 *   npx tsx daily-sync-v2.ts --force                  # override threshold checks
 */
import { config } from "dotenv";
import { resolve, join } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { parse } from "csv-parse";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { initLogger, log, sendWebhook, getSummary } from "./lib/sync-logger.js";

// ─── Config ──────────────────────────────────────────────────────────

const SYNC_DIR = process.env.SYNC_DATA_DIR || resolve(import.meta.dirname, "../data-model/sync");
const NEW_CSV = join(SYNC_DIR, "new_matnr_dispo_info.csv");
// No PREV_CSV — "previous" state is always loaded from DB directly, no volume/file needed

const API_BASE = process.env.SYNC_API_URL || "https://api.kvelektro.cz/ainabidky/KVP";
const API_USER = process.env.SYNC_API_USER || "access";
const API_PASS = process.env.SYNC_API_PASSWORD || "";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DB_URL = process.env.SUPABASE_DB_URL!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 256;
const EMBED_BATCH_SIZE = 500;
const EMBED_DELAY_MS = 200;
const EMBED_MAX_RETRIES = 5;

const DB_BATCH_SIZE = 500;

// Thresholds (overridable via env)
const T_NEW_PRODUCTS = parseInt(process.env.SYNC_THRESHOLD_NEW || "2000");
const T_REMOVED = parseInt(process.env.SYNC_THRESHOLD_REMOVED || "500");
const T_NAME_CHANGES = parseInt(process.env.SYNC_THRESHOLD_NAMES || "5000");
const T_REEMBED = parseInt(process.env.SYNC_THRESHOLD_REEMBED || "5000");
const T_ROW_DROP_PCT = parseFloat(process.env.SYNC_THRESHOLD_ROW_DROP_PCT || "5");
// Description threshold is strict — daily changes should be tens/hundreds, not thousands
const T_DESCRIPTION_CHANGES = parseInt(process.env.SYNC_THRESHOLD_DESCRIPTIONS || "500");

// ─── CLI Args ────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const SKIP_DOWNLOAD = process.argv.includes("--skip-download");
const SKIP_EMBED = process.argv.includes("--skip-embed");

// ─── Types ───────────────────────────────────────────────────────────

interface ProductSnapshot {
  name: string;
  supplier: string;
  price: number | null;
  statusP: string;
  statusS: string;
  matkl: string;
  dispo: string;
  unit: string;
  ean: string;
  idnlf: string;
  description: string;
  stockHash: string;
  stocks: Record<string, number>;
}

interface DiffResult {
  oldTotal: number;
  newTotal: number;
  newProducts: string[];
  removedProducts: string[];
  priceChanges: Array<{ matnr: string; oldPrice: number | null; newPrice: number | null }>;
  nameChanges: Array<{ matnr: string; old: string; new_: string }>;
  supplierChanges: Array<{ matnr: string; old: string; new_: string }>;
  statusChanges: Array<{ matnr: string; field: string; old: string; new_: string }>;
  stockChanges: string[];
  matklChanges: Array<{ matnr: string; old: string; new_: string }>;
  dispoChanges: Array<{ matnr: string; old: string; new_: string }>;
  descriptionChanges: Array<{ matnr: string; old: string; new_: string }>;
  newWhColumns: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function trim(s: string): string { return s?.trim() ?? ""; }

function parsePrice(val: string): number | null {
  if (!val || !val.trim()) return null;
  const n = parseFloat(val.replace(",", "."));
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

function matnrToSku(matnr: string): string {
  return matnr.replace(/^0+/, "") || "0";
}

function isStockItem(dispo: string): boolean {
  return dispo?.trim().toUpperCase() === "ANO";
}

function computeStockHash(row: Record<string, string>, whCols: string[]): string {
  const positives: Array<[string, number]> = [];
  for (const wh of whCols) {
    const val = parseFloat((row[wh] || "0").replace(",", "."));
    if (!isNaN(val) && val > 0) positives.push([wh, val]);
  }
  if (positives.length === 0) return "";
  positives.sort(([a], [b]) => a.localeCompare(b));
  return createHash("md5").update(JSON.stringify(positives)).digest("hex");
}

function parseStocks(row: Record<string, string>, whCols: string[]): Record<string, number> {
  const stocks: Record<string, number> = {};
  for (const wh of whCols) {
    const val = parseFloat((row[wh] || "0").replace(",", "."));
    if (!isNaN(val) && val > 0) stocks[wh] = val;
  }
  return stocks;
}

function fmt(n: number): string { return n.toLocaleString("cs-CZ"); }

function pct(part: number, total: number): string {
  return total === 0 ? "0%" : `${((part / total) * 100).toFixed(2)}%`;
}

function elapsed(startMs: number): string {
  const s = (Date.now() - startMs) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}min`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildEmbeddingText(p: {
  name: string; supplier_name: string | null;
  category_main: string | null; category_sub: string | null; category_line: string | null;
  description: string | null; search_hints: string | null;
}): string {
  const lines: string[] = [p.name];
  if (p.search_hints) lines.push(`Také známo jako: ${p.search_hints}`);
  if (p.supplier_name) lines.push(`Výrobce: ${p.supplier_name}`);
  const cats = [p.category_main, p.category_sub, p.category_line].filter(Boolean);
  if (cats.length > 0) lines.push(`Kategorie: ${cats.join(" > ")}`);
  if (p.description) lines.push(`Popis: ${p.description.slice(0, 500)}`);
  return lines.join("\n");
}

// ─── Phase 1: Download CSV ───────────────────────────────────────────

async function downloadCsv(): Promise<void> {
  const url = `${API_BASE}/matnr_dispo_info.csv`;
  const auth = Buffer.from(`${API_USER}:${API_PASS}`).toString("base64");

  log({ phase: "download", status: "info", message: `Fetching ${url}` });
  const t = Date.now();

  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  await pipeline(
    Readable.fromWeb(resp.body! as never),
    createWriteStream(NEW_CSV),
  );

  const size = statSync(NEW_CSV).size;
  log({
    phase: "download", status: "success",
    message: `Downloaded ${(size / 1024 / 1024).toFixed(1)} MB in ${elapsed(t)}`,
  });
}

// ─── Phase 2a: Load DB snapshot (replaces file-based baseline) ───────

async function loadDbSnapshot(): Promise<{
  map: Map<string, ProductSnapshot>;
  whColumns: string[];
}> {
  log({ phase: "db-snapshot", status: "info", message: "Loading current DB state as baseline..." });
  const t = Date.now();

  const client = await makePgClient();
  const map = new Map<string, ProductSnapshot>();

  try {
    // 1) WH columns
    const branchRes = await client.query<{ source_branch_code: string }>(
      "SELECT source_branch_code FROM branches_v2 ORDER BY source_branch_code",
    );
    const whColumns = branchRes.rows.map((r) => r.source_branch_code);

    // 2) Load products + price (no aggregation — fast sequential scan)
    await client.query("BEGIN");
    await client.query(`
      DECLARE prod_cur CURSOR FOR
      SELECT
        p.source_matnr,
        COALESCE(p.name, '')                   AS name,
        COALESCE(p.supplier_name, '')           AS supplier,
        pr.current_price,
        COALESCE(p.status_purchase_code, '')    AS status_p,
        COALESCE(p.status_sales_code, '')       AS status_s,
        COALESCE(p.category_code, '')           AS matkl,
        COALESCE(p.dispo, '')                   AS dispo,
        COALESCE(p.unit, '')                    AS unit,
        COALESCE(p.source_ean_raw, '')          AS ean,
        COALESCE(p.source_idnlf_raw, '')        AS idnlf,
        COALESCE(p.description, '')             AS description
      FROM products_v2 p
      LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
      WHERE p.removed_at IS NULL
    `);

    let count = 0;
    while (true) {
      const res = await client.query<{
        source_matnr: string; name: string; supplier: string;
        current_price: string | null; status_p: string; status_s: string;
        matkl: string; dispo: string; unit: string; ean: string; idnlf: string; description: string;
      }>("FETCH 10000 FROM prod_cur");
      if (res.rows.length === 0) break;

      for (const row of res.rows) {
        map.set(row.source_matnr, {
          name: row.name,
          supplier: row.supplier,
          price: row.current_price != null ? Math.round(parseFloat(row.current_price) * 100) / 100 : null,
          statusP: row.status_p,
          statusS: row.status_s,
          matkl: row.matkl,
          dispo: row.dispo,
          unit: row.unit,
          ean: row.ean,
          idnlf: row.idnlf,
          description: row.description ?? "",
          stockHash: "",
          stocks: {},
        });
        count++;
        if (count % 200_000 === 0) {
          log({ phase: "db-snapshot", status: "info", message: `  products: ${fmt(count)} loaded...` });
        }
      }
    }
    await client.query("COMMIT");

    log({ phase: "db-snapshot", status: "info", message: `Products loaded (${fmt(map.size)}). Loading stock...` });

    // 3) Load ALL positive stock in one cursor — no GROUP BY, no aggregation
    //    Then aggregate in-memory per matnr (O(n) single pass)
    const matnrById = new Map<string, string>(); // id → source_matnr
    {
      // Build id→matnr index first for O(1) lookup during stock pass
      const idxRes = await client.query<{ id: string; source_matnr: string }>(
        "SELECT id, source_matnr FROM products_v2 WHERE removed_at IS NULL",
      );
      for (const r of idxRes.rows) matnrById.set(r.id, r.source_matnr);
    }

    await client.query("BEGIN");
    await client.query(`
      DECLARE stock_cur CURSOR FOR
      SELECT
        bs.product_id,
        b.source_branch_code,
        bs.stock_qty
      FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.stock_qty > 0
    `);

    let stockRows = 0;
    while (true) {
      const res = await client.query<{
        product_id: string; source_branch_code: string; stock_qty: number;
      }>("FETCH 20000 FROM stock_cur");
      if (res.rows.length === 0) break;

      for (const row of res.rows) {
        const matnr = matnrById.get(row.product_id);
        if (!matnr) continue;
        const snap = map.get(matnr);
        if (!snap) continue;
        snap.stocks[row.source_branch_code] = row.stock_qty;
        stockRows++;
      }
    }
    await client.query("COMMIT");

    // 4) Compute stock hashes in a single O(n) pass
    for (const snap of map.values()) {
      const positives = Object.entries(snap.stocks)
        .filter(([, qty]) => qty > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      snap.stockHash = positives.length === 0
        ? ""
        : createHash("md5").update(JSON.stringify(positives)).digest("hex");
    }

    log({
      phase: "db-snapshot", status: "success",
      message: `Loaded ${fmt(map.size)} products + ${fmt(stockRows)} stock rows from DB in ${elapsed(t)}`,
    });

    return { map, whColumns };
  } finally {
    await client.end();
  }
}

// ─── Phase 2b: Parse CSV to Map ──────────────────────────────────────

async function parseCsvToMap(filePath: string, label: string): Promise<{
  map: Map<string, ProductSnapshot>;
  whColumns: string[];
}> {
  log({ phase: "parse", status: "info", message: `Parsing ${label}...` });
  const t = Date.now();
  const map = new Map<string, ProductSnapshot>();
  let whColumns: string[] = [];
  let headerDone = false;
  let count = 0;

  const parser = createReadStream(filePath, { encoding: "utf-8" }).pipe(
    parse({
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
    if (!headerDone) {
      whColumns = Object.keys(row).filter((k) => k.startsWith("WH_"));
      headerDone = true;
    }

    const matnr = trim(row.MATNR);
    if (!matnr) continue;

    map.set(matnr, {
      name: trim(row.MAKTX),
      supplier: trim(row.LIFNR),
      price: parsePrice(row.C4_PRICE),
      statusP: trim(row.MSTAE),
      statusS: trim(row.MSTAV),
      matkl: trim(row.MATKL),
      dispo: trim(row.DISPO),
      unit: trim(row.MEINS),
      ean: trim(row.EAN),
      idnlf: trim(row.IDNLF),
      description: trim(row.LONGTEXT ?? ""),
      stockHash: computeStockHash(row, whColumns),
      stocks: parseStocks(row, whColumns),
    });

    count++;
    if (count % 200_000 === 0) {
      log({ phase: "parse", status: "info", message: `  ${label}: ${fmt(count)} rows...` });
    }
  }

  log({
    phase: "parse", status: "success",
    message: `${label}: ${fmt(count)} products in ${elapsed(t)}`,
  });
  return { map, whColumns };
}

// ─── Phase 3: Compute Diff ───────────────────────────────────────────

function computeDiff(
  oldMap: Map<string, ProductSnapshot>,
  newMap: Map<string, ProductSnapshot>,
  oldWh: string[],
  newWh: string[],
): DiffResult {
  const result: DiffResult = {
    oldTotal: oldMap.size,
    newTotal: newMap.size,
    newProducts: [],
    removedProducts: [],
    priceChanges: [],
    nameChanges: [],
    supplierChanges: [],
    statusChanges: [],
    stockChanges: [],
    matklChanges: [],
    dispoChanges: [],
    descriptionChanges: [],
    newWhColumns: newWh.filter((w) => !oldWh.includes(w)),
  };

  for (const [matnr, nw] of newMap) {
    const old = oldMap.get(matnr);
    if (!old) { result.newProducts.push(matnr); continue; }

    if (old.price !== nw.price)
      result.priceChanges.push({ matnr, oldPrice: old.price, newPrice: nw.price });
    if (old.name !== nw.name)
      result.nameChanges.push({ matnr, old: old.name, new_: nw.name });
    if (old.supplier !== nw.supplier)
      result.supplierChanges.push({ matnr, old: old.supplier, new_: nw.supplier });
    if (old.statusP !== nw.statusP)
      result.statusChanges.push({ matnr, field: "MSTAE", old: old.statusP, new_: nw.statusP });
    if (old.statusS !== nw.statusS)
      result.statusChanges.push({ matnr, field: "MSTAV", old: old.statusS, new_: nw.statusS });
    if (old.stockHash !== nw.stockHash)
      result.stockChanges.push(matnr);
    if (old.matkl !== nw.matkl)
      result.matklChanges.push({ matnr, old: old.matkl, new_: nw.matkl });
    if (old.dispo !== nw.dispo)
      result.dispoChanges.push({ matnr, old: old.dispo, new_: nw.dispo });
    if (old.description !== nw.description)
      result.descriptionChanges.push({ matnr, old: old.description, new_: nw.description });
  }

  for (const matnr of oldMap.keys()) {
    if (!newMap.has(matnr)) result.removedProducts.push(matnr);
  }

  return result;
}

function printDiffReport(d: DiffResult): void {
  const total = d.newTotal;
  console.log("\n" + "═".repeat(65));
  console.log("  DIFF REPORT");
  console.log("═".repeat(65));
  console.log(`  OLD: ${fmt(d.oldTotal)}  NEW: ${fmt(d.newTotal)}  (${d.newTotal >= d.oldTotal ? "+" : ""}${fmt(d.newTotal - d.oldTotal)})`);
  console.log(`  New products:       ${fmt(d.newProducts.length).padStart(8)}  (${pct(d.newProducts.length, total)})`);
  console.log(`  Removed:            ${fmt(d.removedProducts.length).padStart(8)}  (${pct(d.removedProducts.length, d.oldTotal)})`);
  console.log(`  Price changes:      ${fmt(d.priceChanges.length).padStart(8)}  (${pct(d.priceChanges.length, total)})`);
  console.log(`  Name changes:       ${fmt(d.nameChanges.length).padStart(8)}  (${pct(d.nameChanges.length, total)})`);
  console.log(`  Supplier changes:   ${fmt(d.supplierChanges.length).padStart(8)}  (${pct(d.supplierChanges.length, total)})`);
  console.log(`  Status changes:     ${fmt(d.statusChanges.length).padStart(8)}`);
  console.log(`  Stock changes:      ${fmt(d.stockChanges.length).padStart(8)}  (${pct(d.stockChanges.length, total)})`);
  console.log(`  Category changes:   ${fmt(d.matklChanges.length).padStart(8)}`);
  console.log(`  DISPO changes:      ${fmt(d.dispoChanges.length).padStart(8)}`);
  console.log(`  Description changes:${fmt(d.descriptionChanges.length).padStart(8)}`);
  if (d.newWhColumns.length > 0) console.log(`  New WH_ columns:    ${d.newWhColumns.join(", ")}`);

  const reembed = d.newProducts.length + d.nameChanges.length +
    d.supplierChanges.filter((c) => !d.nameChanges.some((n) => n.matnr === c.matnr)).length;
  console.log(`  Re-embed needed:    ${fmt(reembed).padStart(8)}`);
  console.log("═".repeat(65) + "\n");
}

// ─── Phase 3b: Threshold Check ───────────────────────────────────────

function checkThresholds(d: DiffResult): string[] {
  const violations: string[] = [];

  if (d.newProducts.length > T_NEW_PRODUCTS)
    violations.push(`New products (${fmt(d.newProducts.length)}) exceeds threshold (${fmt(T_NEW_PRODUCTS)})`);
  if (d.removedProducts.length > T_REMOVED)
    violations.push(`Removed products (${fmt(d.removedProducts.length)}) exceeds threshold (${fmt(T_REMOVED)})`);
  if (d.nameChanges.length > T_NAME_CHANGES)
    violations.push(`Name changes (${fmt(d.nameChanges.length)}) exceeds threshold (${fmt(T_NAME_CHANGES)})`);
  if (d.descriptionChanges.length > T_DESCRIPTION_CHANGES)
    violations.push(`Description changes (${fmt(d.descriptionChanges.length)}) exceeds threshold (${fmt(T_DESCRIPTION_CHANGES)}) — use --force for initial bulk migration`);

  const reembed = d.newProducts.length + d.nameChanges.length + d.supplierChanges.length + d.descriptionChanges.length;
  if (reembed > T_REEMBED)
    violations.push(`Re-embed count (${fmt(reembed)}) exceeds threshold (${fmt(T_REEMBED)})`);

  if (d.oldTotal > 0) {
    const dropPct = ((d.oldTotal - d.newTotal) / d.oldTotal) * 100;
    if (dropPct > T_ROW_DROP_PCT)
      violations.push(`Row count dropped by ${dropPct.toFixed(1)}% (threshold ${T_ROW_DROP_PCT}%)`);
  }

  return violations;
}

// ─── Phase 4: MATNR → ID Resolution (via direct pg for speed) ────────

async function makePgClient(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function resolveMatnrIds(): Promise<Map<string, number>> {
  log({ phase: "resolve", status: "info", message: "Loading MATNR→ID map from DB..." });
  const t = Date.now();

  const client = await makePgClient();
  const map = new Map<string, number>();

  try {
    // Single query — no pagination needed with direct pg
    const res = await client.query<{ id: number; source_matnr: string }>(
      "SELECT id, source_matnr FROM products_v2",
    );
    for (const row of res.rows) map.set(row.source_matnr, row.id);
  } finally {
    await client.end();
  }

  log({
    phase: "resolve", status: "success",
    message: `Loaded ${fmt(map.size)} MATNR→ID mappings in ${elapsed(t)}`,
  });
  return map;
}

async function resolveBranchIds(): Promise<Map<string, number>> {
  const client = await makePgClient();
  const map = new Map<string, number>();
  try {
    const res = await client.query<{ id: number; source_branch_code: string }>(
      "SELECT id, source_branch_code FROM branches_v2",
    );
    for (const row of res.rows) map.set(row.source_branch_code, row.id);
  } finally {
    await client.end();
  }
  return map;
}

// ─── Phase 5: Apply Changes ─────────────────────────────────────────

async function applyChanges(
  diff: DiffResult,
  newMap: Map<string, ProductSnapshot>,
  matnrIds: Map<string, number>,
  branchIds: Map<string, number>,
  categoryLookup: Map<string, string>,
  statusPurchaseMap: Map<string, string>,
  statusSalesMap: Map<string, string>,
): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5.0: Insert new branches if any
  if (diff.newWhColumns.length > 0) {
    log({ phase: "apply", status: "info", message: `Inserting ${diff.newWhColumns.length} new branches...` });
    for (const code of diff.newWhColumns) {
      await supabase.from("branches_v2").upsert(
        { source_branch_code: code, name: null },
        { onConflict: "source_branch_code" },
      );
    }
    const freshBranches = await resolveBranchIds();
    for (const [k, v] of freshBranches) branchIds.set(k, v);
  }

  // 5a: Insert new products
  if (diff.newProducts.length > 0) {
    log({ phase: "apply:new", status: "info", message: `Inserting ${fmt(diff.newProducts.length)} new products...` });
    const t = Date.now();
    let inserted = 0;
    let errors = 0;

    for (let i = 0; i < diff.newProducts.length; i += DB_BATCH_SIZE) {
      const batch = diff.newProducts.slice(i, i + DB_BATCH_SIZE);
      const rows = batch.map((matnr) => {
        const p = newMap.get(matnr)!;
        const catHier = resolveCategoryHierarchy(p.matkl, categoryLookup);
        return {
          source_matnr: matnr,
          sku: matnrToSku(matnr),
          name: p.name,
          unit: p.unit || null,
          supplier_name: p.supplier || null,
          category_code: p.matkl || null,
          category_main: catHier.main || null,
          category_sub: catHier.sub || null,
          category_line: catHier.line || null,
          status_purchase_code: p.statusP || null,
          status_sales_code: p.statusS || null,
          status_purchase_text: statusPurchaseMap.get(p.statusP) || null,
          status_sales_text: statusSalesMap.get(p.statusS) || null,
          dispo: p.dispo || null,
          is_stock_item: isStockItem(p.dispo),
          source_ean_raw: p.ean || null,
          source_idnlf_raw: p.idnlf || null,
          embedding_stale: true,
        };
      });

      const { error } = await supabase.from("products_v2").insert(rows);
      if (error) {
        errors++;
        log({ phase: "apply:new", status: "error", message: `Batch insert failed: ${error.message}` });
      } else {
        inserted += batch.length;
      }
    }

    // Refresh MATNR→ID map for newly inserted products
    const freshIds = await resolveMatnrIds();
    for (const matnr of diff.newProducts) {
      const id = freshIds.get(matnr);
      if (id) matnrIds.set(matnr, id);
    }

    // Insert identifiers, prices, stock for new products
    for (const matnr of diff.newProducts) {
      const pid = matnrIds.get(matnr);
      if (!pid) continue;
      const p = newMap.get(matnr)!;

      // Identifiers
      const identRows: Array<{ product_id: number; identifier_type: string; identifier_value: string }> = [];
      for (const ean of splitValues(p.ean, ",")) {
        identRows.push({ product_id: pid, identifier_type: "EAN", identifier_value: ean });
      }
      for (const idnlf of splitValues(p.idnlf, ",:")) {
        identRows.push({ product_id: pid, identifier_type: "IDNLF", identifier_value: idnlf });
      }
      if (identRows.length > 0) {
        await supabase.from("product_identifiers_v2").insert(identRows);
      }

      // Price
      if (p.price !== null) {
        await supabase.from("product_price_v2").insert({
          product_id: pid, current_price: p.price, currency: "CZK",
        });
      }

      // Stock
      const stockRows: Array<{ product_id: number; branch_id: number; stock_qty: number }> = [];
      for (const [wh, qty] of Object.entries(p.stocks)) {
        const bid = branchIds.get(wh);
        if (bid && qty > 0) stockRows.push({ product_id: pid, branch_id: bid, stock_qty: qty });
      }
      if (stockRows.length > 0) {
        await supabase.from("product_branch_stock_v2").insert(stockRows);
      }
    }

    log({
      phase: "apply:new", status: "success",
      message: `Inserted ${fmt(inserted)} products (${errors} errors) in ${elapsed(t)}`,
    });
  }

  // 5b: Update metadata (name, supplier, status, category, dispo) — batch via pg
  const metaUpdates = collectMetadataUpdates(diff, newMap, categoryLookup, statusPurchaseMap, statusSalesMap);
  if (metaUpdates.size > 0) {
    log({ phase: "apply:meta", status: "info", message: `Updating metadata for ${fmt(metaUpdates.size)} products via pg...` });
    const t = Date.now();
    let updated = 0;
    let errors = 0;

    const pgClient = await makePgClient();
    try {
      const entries = [...metaUpdates.entries()];
      for (let i = 0; i < entries.length; i += DB_BATCH_SIZE) {
        const batch = entries.slice(i, i + DB_BATCH_SIZE);
        await pgClient.query("BEGIN");
        try {
          for (const [matnr, patch] of batch) {
            const pid = matnrIds.get(matnr);
            if (!pid) continue;
            const keys = Object.keys(patch);
            const values = Object.values(patch);
            const setClauses = keys.map((k, idx) => `${k} = $${idx + 2}`).join(", ");
            await pgClient.query(
              `UPDATE products_v2 SET ${setClauses} WHERE id = $1`,
              [pid, ...values],
            );
            updated++;
          }
          await pgClient.query("COMMIT");
        } catch (err) {
          await pgClient.query("ROLLBACK");
          errors++;
          const msg = err instanceof Error ? err.message : String(err);
          log({ phase: "apply:meta", status: "error", message: `Batch failed: ${msg}` });
        }

        if (updated % 2000 === 0 && updated > 0) {
          log({ phase: "apply:meta", status: "info", message: `  ${fmt(updated)} updated...` });
        }
      }
    } finally {
      await pgClient.end();
    }

    log({
      phase: "apply:meta", status: "success",
      message: `Updated ${fmt(updated)} products (${errors} errors) in ${elapsed(t)}`,
    });
  }

  // 5c: Upsert prices
  if (diff.priceChanges.length > 0) {
    log({ phase: "apply:prices", status: "info", message: `Upserting ${fmt(diff.priceChanges.length)} prices...` });
    const t = Date.now();
    let upserted = 0;
    let errors = 0;

    for (let i = 0; i < diff.priceChanges.length; i += DB_BATCH_SIZE) {
      const batch = diff.priceChanges.slice(i, i + DB_BATCH_SIZE);
      const rows = batch
        .filter((c) => c.newPrice !== null)
        .map((c) => ({
          product_id: matnrIds.get(c.matnr)!,
          current_price: c.newPrice,
          currency: "CZK",
        }))
        .filter((r) => r.product_id);

      if (rows.length > 0) {
        const { error } = await supabase
          .from("product_price_v2")
          .upsert(rows, { onConflict: "product_id" });
        if (error) { errors++; } else { upserted += rows.length; }
      }

      // Handle prices that became null (delete)
      const nullPrices = batch
        .filter((c) => c.newPrice === null)
        .map((c) => matnrIds.get(c.matnr)!)
        .filter(Boolean);
      if (nullPrices.length > 0) {
        await supabase.from("product_price_v2").delete().in("product_id", nullPrices);
      }
    }

    log({
      phase: "apply:prices", status: "success",
      message: `Upserted ${fmt(upserted)} prices (${errors} errors) in ${elapsed(t)}`,
    });
  }

  // 5d: Stock changes (delete + insert per batch in logical groups)
  if (diff.stockChanges.length > 0) {
    log({ phase: "apply:stock", status: "info", message: `Updating stock for ${fmt(diff.stockChanges.length)} products...` });
    const t = Date.now();
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < diff.stockChanges.length; i += DB_BATCH_SIZE) {
      const batch = diff.stockChanges.slice(i, i + DB_BATCH_SIZE);
      const pids = batch.map((m) => matnrIds.get(m)!).filter(Boolean);

      if (pids.length === 0) continue;

      // Delete old stock for this batch
      const { error: delErr } = await supabase
        .from("product_branch_stock_v2")
        .delete()
        .in("product_id", pids);
      if (delErr) { errors++; continue; }

      // Insert new stock rows
      const stockRows: Array<{ product_id: number; branch_id: number; stock_qty: number }> = [];
      for (const matnr of batch) {
        const pid = matnrIds.get(matnr);
        if (!pid) continue;
        const p = newMap.get(matnr);
        if (!p) continue;
        for (const [wh, qty] of Object.entries(p.stocks)) {
          const bid = branchIds.get(wh);
          if (bid && qty > 0) stockRows.push({ product_id: pid, branch_id: bid, stock_qty: qty });
        }
      }

      if (stockRows.length > 0) {
        // Insert in sub-batches to avoid payload limits
        for (let j = 0; j < stockRows.length; j += 1000) {
          const subBatch = stockRows.slice(j, j + 1000);
          const { error: insErr } = await supabase
            .from("product_branch_stock_v2")
            .insert(subBatch);
          if (insErr) errors++;
        }
      }

      processed += batch.length;
      if (processed % 2000 === 0) {
        log({ phase: "apply:stock", status: "info", message: `  ${fmt(processed)} / ${fmt(diff.stockChanges.length)}...` });
      }
    }

    log({
      phase: "apply:stock", status: "success",
      message: `Updated stock for ${fmt(processed)} products (${errors} errors) in ${elapsed(t)}`,
    });
  }

  // 5e: Soft-delete removed products
  if (diff.removedProducts.length > 0) {
    log({ phase: "apply:remove", status: "info", message: `Soft-deleting ${fmt(diff.removedProducts.length)} products...` });
    const t = Date.now();

    for (let i = 0; i < diff.removedProducts.length; i += DB_BATCH_SIZE) {
      const batch = diff.removedProducts.slice(i, i + DB_BATCH_SIZE);
      const pids = batch.map((m) => matnrIds.get(m)!).filter(Boolean);
      if (pids.length > 0) {
        await supabase
          .from("products_v2")
          .update({ removed_at: new Date().toISOString() })
          .in("id", pids);
      }
    }

    log({ phase: "apply:remove", status: "success", message: `Soft-deleted in ${elapsed(t)}` });
  }

  // 5f: Un-remove re-appeared products (in DB with removed_at, now back in CSV)
  // This is checked against DB state — products that were previously removed but now reappear
  const reappeared = diff.newProducts.filter((m) => {
    // If a "new" product actually already existed in DB (was removed), clear removed_at
    // We check: if after fresh ID resolution we got an ID, it means it existed
    return matnrIds.has(m);
  });
  // Actually, newProducts won't have IDs in the original map. We handle reappearance
  // in future syncs when a product was soft-deleted and comes back.
}

// ─── Phase 6: Re-embed ──────────────────────────────────────────────

async function reembed(): Promise<void> {
  // Load all products marked as embedding_stale — set atomically in Phase 5
  // whenever name or supplier changes, or a new product is inserted.
  // This survives crashes: if Phase 6 fails, flags remain true for the next sync.
  const queryClient = await makePgClient();

  type StaleProduct = {
    id: number; source_matnr: string; sku: string; name: string;
    supplier_name: string | null; category_main: string | null;
    category_sub: string | null; category_line: string | null;
    description: string | null; search_hints: string | null;
  };

  let staleProducts: StaleProduct[];
  try {
    const res = await queryClient.query<StaleProduct>(
      `SELECT id, source_matnr, sku, name, supplier_name, category_main,
              category_sub, category_line, description, search_hints
       FROM products_v2
       WHERE embedding_stale = true AND removed_at IS NULL`,
    );
    staleProducts = res.rows;
  } finally {
    await queryClient.end();
  }

  // Filter out products with empty names (OpenAI rejects empty input)
  const validItems = staleProducts.filter((p) => {
    const text = buildEmbeddingText(p).trim();
    return text.length > 0;
  });
  const skipped = staleProducts.length - validItems.length;

  if (validItems.length === 0) {
    log({ phase: "embed", status: "info", message: "No products need re-embedding." });
    return;
  }

  log({
    phase: "embed", status: "info",
    message: `Re-embedding ${fmt(validItems.length)} products (${fmt(skipped)} skipped, empty name)...`,
  });
  const t = Date.now();

  // Threshold check — same safety limits apply to re-embedding
  if (!FORCE && validItems.length > T_REEMBED) {
    const msg = `Re-embed count (${fmt(validItems.length)}) exceeds threshold (${fmt(T_REEMBED)})`;
    log({ phase: "embed", status: "alert", message: msg });
    await sendWebhook("alert", `Embedding threshold exceeded: ${msg}`);
    log({ phase: "embed", status: "warn", message: "Skipping re-embed phase. Use --force to override." });
    return;
  }

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < validItems.length; i += EMBED_BATCH_SIZE) {
    const batch = validItems.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((p) => buildEmbeddingText(p));

    let retries = 0;
    let success = false;

    while (retries < EMBED_MAX_RETRIES && !success) {
      try {
        const resp = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMS,
          input: texts,
        });

        // Fresh pg connection per batch — prevents ETIMEDOUT on long-running syncs
        const embedPg = await makePgClient();
        try {
          await embedPg.query("BEGIN");
          for (let idx = 0; idx < batch.length; idx++) {
            const p = batch[idx];
            const vec = JSON.stringify(resp.data[idx].embedding);
            await embedPg.query(
              `INSERT INTO product_embeddings_v2 (product_id, sku, embedding, embedding_text, model_version, created_at)
               VALUES ($1, $2, $3::vector, $4, 'text-embedding-3-small-256', now())
               ON CONFLICT (product_id) DO UPDATE SET
                 sku = EXCLUDED.sku, embedding = EXCLUDED.embedding,
                 embedding_text = EXCLUDED.embedding_text, model_version = EXCLUDED.model_version`,
              [p.id, p.sku, vec, texts[idx]],
            );
          }
          // Clear stale flag for this batch — same transaction as the embedding write
          const batchIds = batch.map((p) => p.id);
          await embedPg.query(
            `UPDATE products_v2 SET embedding_stale = false WHERE id = ANY($1)`,
            [batchIds],
          );
          await embedPg.query("COMMIT");
        } catch (pgErr) {
          await embedPg.query("ROLLBACK");
          throw pgErr;
        } finally {
          await embedPg.end();
        }

        processed += batch.length;
        success = true;
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("rate_limit") || msg.includes("429")) {
          const wait = Math.min(2000 * Math.pow(2, retries), 120_000);
          log({ phase: "embed", status: "warn", message: `Rate limited, waiting ${(wait / 1000).toFixed(0)}s...` });
          await sleep(wait);
        } else if (retries >= EMBED_MAX_RETRIES) {
          errors += batch.length;
          log({ phase: "embed", status: "error", message: `Batch failed after ${EMBED_MAX_RETRIES} retries: ${msg}` });
        } else {
          await sleep(1000 * retries);
        }
      }
    }

    if (processed % (EMBED_BATCH_SIZE * 5) === 0 && processed > 0) {
      log({ phase: "embed", status: "info", message: `  ${fmt(processed)} / ${fmt(items.length)}...` });
    }

    await sleep(EMBED_DELAY_MS);
  }

  log({
    phase: "embed", status: "success",
    message: `Re-embedded ${fmt(processed)} products (${errors} errors) in ${elapsed(t)}`,
  });
}

// ─── Helpers for category/status resolution ──────────────────────────

function loadCategoryLookup(): Map<string, string> {
  const candidates = [
    join(SYNC_DIR, "new_name_of_category.csv"),
    resolve(import.meta.dirname, "data-model/sync/new_name_of_category.csv"),
    resolve(import.meta.dirname, "../data-model/sync/new_name_of_category.csv"),
    resolve(import.meta.dirname, "../data-model/name_of_category (2).csv"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return parseLookupCsv(p, 0, 1);
  }
  log({ phase: "lookups", status: "warn", message: "Category lookup CSV not found" });
  return new Map();
}

function loadStatusLookups(): { purchase: Map<string, string>; sales: Map<string, string> } {
  const purchase = new Map<string, string>();
  const sales = new Map<string, string>();

  const candidates = [
    join(SYNC_DIR, "new_status_type.csv"),
    resolve(import.meta.dirname, "data-model/sync/new_status_type.csv"),
    resolve(import.meta.dirname, "../data-model/sync/new_status_type.csv"),
    resolve(import.meta.dirname, "../data-model/status_type (2).csv"),
  ];
  const alt = candidates.find((p) => existsSync(p));
  if (!alt) {
    log({ phase: "lookups", status: "warn", message: "Status lookup CSV not found" });
    return { purchase, sales };
  }

  const content = readFileSync(alt, "utf-8");
  const lines = content.split(/\r?\n/).filter((l: string) => l.trim());
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const [mmsta, mmstb, vmsta, vmstb] = parts.map((s: string) => s?.trim() ?? "");
    if (mmsta) purchase.set(mmsta, mmstb);
    if (vmsta) sales.set(vmsta, vmstb);
  }

  return { purchase, sales };
}

function parseLookupCsv(filePath: string, keyCol: number, valCol: number): Map<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l: string) => l.trim());
  const map = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const key = parts[keyCol]?.trim();
    const val = parts[valCol]?.trim();
    if (key) map.set(key, val ?? "");
  }
  return map;
}

function resolveCategoryHierarchy(
  matkl: string,
  codeToName: Map<string, string>,
): { main: string; sub: string; line: string } {
  if (!matkl || !matkl.trim()) return { main: "", sub: "", line: "" };
  const code = matkl.trim();
  const l1 = code.length >= 3 ? code.slice(0, 3) : code;
  const l2 = code.length >= 5 ? code.slice(0, 5) : "";
  const l3 = code.length >= 7 ? code : "";
  return {
    main: codeToName.get(l1) ?? "",
    sub: l2 ? (codeToName.get(l2) ?? "") : "",
    line: l3 ? (codeToName.get(l3) ?? "") : "",
  };
}

function splitValues(raw: string, separator: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(separator).map((s) => s.trim()).filter(Boolean);
}

function collectMetadataUpdates(
  diff: DiffResult,
  newMap: Map<string, ProductSnapshot>,
  categoryLookup: Map<string, string>,
  statusPurchaseMap: Map<string, string>,
  statusSalesMap: Map<string, string>,
): Map<string, Record<string, unknown>> {
  const updates = new Map<string, Record<string, unknown>>();

  function getOrCreate(matnr: string): Record<string, unknown> {
    if (!updates.has(matnr)) updates.set(matnr, {});
    return updates.get(matnr)!;
  }

  for (const c of diff.nameChanges) {
    const patch = getOrCreate(c.matnr);
    patch.name = c.new_;
    patch.embedding_stale = true;
  }

  for (const c of diff.supplierChanges) {
    const patch = getOrCreate(c.matnr);
    patch.supplier_name = c.new_ || null;
    patch.embedding_stale = true;
  }

  for (const c of diff.statusChanges) {
    const patch = getOrCreate(c.matnr);
    if (c.field === "MSTAE") {
      patch.status_purchase_code = c.new_ || null;
      patch.status_purchase_text = statusPurchaseMap.get(c.new_) || null;
    } else {
      patch.status_sales_code = c.new_ || null;
      patch.status_sales_text = statusSalesMap.get(c.new_) || null;
    }
  }

  for (const c of diff.matklChanges) {
    const patch = getOrCreate(c.matnr);
    const hier = resolveCategoryHierarchy(c.new_, categoryLookup);
    patch.category_code = c.new_ || null;
    patch.category_main = hier.main || null;
    patch.category_sub = hier.sub || null;
    patch.category_line = hier.line || null;
  }

  for (const c of diff.dispoChanges) {
    const patch = getOrCreate(c.matnr);
    patch.dispo = c.new_ || null;
    patch.is_stock_item = isStockItem(c.new_);
  }

  for (const c of diff.descriptionChanges) {
    const patch = getOrCreate(c.matnr);
    patch.description = c.new_ || null;
    patch.embedding_stale = true;
  }

  return updates;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SYNC_DIR, { recursive: true });
  initLogger(process.env.SYNC_WEBHOOK_URL);

  console.log("\n" + "═".repeat(65));
  console.log("  KV Offer Manager — Daily Sync V2");
  console.log("═".repeat(65));
  console.log(`  Mode:      ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  Force:     ${FORCE}`);
  console.log(`  Download:  ${!SKIP_DOWNLOAD}`);
  console.log(`  Embed:     ${!SKIP_EMBED}`);
  console.log("");

  const globalStart = Date.now();

  await sendWebhook("start", `Sync started (${DRY_RUN ? "dry-run" : "live"})`);

  try {
    // Phase 1: Download
    if (!SKIP_DOWNLOAD) {
      await downloadCsv();
    } else {
      if (!existsSync(NEW_CSV)) throw new Error(`New CSV not found: ${NEW_CSV}`);
      log({ phase: "download", status: "info", message: "Skipped (--skip-download), using existing file" });
    }

    // Check if previous baseline exists
    // Phase 2: Parse new CSV + load DB snapshot in parallel
    const [{ map: newMap, whColumns: newWh }, { map: oldMap, whColumns: oldWh }] =
      await Promise.all([
        parseCsvToMap(NEW_CSV, "NEW"),
        loadDbSnapshot(),
      ]);

    // Phase 3: Diff + thresholds
    const diff = computeDiff(oldMap, newMap, oldWh, newWh);
    printDiffReport(diff);

    const violations = checkThresholds(diff);
    if (violations.length > 0) {
      for (const v of violations) {
        log({ phase: "threshold", status: "alert", message: v });
      }

      if (!FORCE) {
        const alertMsg = `Threshold violations:\n${violations.join("\n")}\nSync aborted. Use --force to override.`;
        await sendWebhook("alert", alertMsg);
        console.log("\n  SYNC ABORTED — threshold violations detected. Use --force to override.\n");
        process.exit(1);
      } else {
        log({ phase: "threshold", status: "warn", message: "Thresholds exceeded but --force is set, continuing..." });
      }
    }

    if (DRY_RUN) {
      log({ phase: "dry-run", status: "info", message: "Dry run complete — no changes applied." });
      await sendWebhook("complete", `Dry run complete. ${getSummary()}`);
      console.log("\n  DRY RUN — no changes applied.\n");
      return;
    }

    // Phase 4: MATNR→ID resolution
    const matnrIds = await resolveMatnrIds();
    const branchIds = await resolveBranchIds();

    // Load lookups for category/status resolution
    const categoryLookup = loadCategoryLookup();
    const statusLookups = loadStatusLookups();

    log({ phase: "lookups", status: "info", message: `Categories: ${fmt(categoryLookup.size)}, Status purchase: ${fmt(statusLookups.purchase.size)}, Status sales: ${fmt(statusLookups.sales.size)}` });

    // Phase 5: Apply
    log({ phase: "apply", status: "info", message: "Applying changes..." });
    await applyChanges(diff, newMap, matnrIds, branchIds, categoryLookup, statusLookups.purchase, statusLookups.sales);

    // Phase 6: Re-embed
    if (!SKIP_EMBED) {
      await reembed();
    } else {
      log({ phase: "embed", status: "info", message: "Skipped (--skip-embed)" });
    }

    // Phase 7: Cleanup — remove downloaded CSV (baseline is now always DB)
    if (existsSync(NEW_CSV)) {
      renameSync(NEW_CSV, NEW_CSV + ".last");
    }
    log({ phase: "cleanup", status: "info", message: "Downloaded CSV kept as .last for debugging." });

    const summary = [
      `Sync complete in ${elapsed(globalStart)}`,
      `New: ${fmt(diff.newProducts.length)}`,
      `Removed: ${fmt(diff.removedProducts.length)}`,
      `Prices: ${fmt(diff.priceChanges.length)}`,
      `Stock: ${fmt(diff.stockChanges.length)}`,
      `Names: ${fmt(diff.nameChanges.length)}`,
      `Suppliers: ${fmt(diff.supplierChanges.length)}`,
    ].join(" | ");

    log({ phase: "done", status: "success", message: summary });
    await sendWebhook("complete", summary);

    console.log("\n" + "═".repeat(65));
    console.log(`  SYNC COMPLETE in ${elapsed(globalStart)}`);
    console.log("═".repeat(65) + "\n");

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ phase: "fatal", status: "error", message: msg });
    await sendWebhook("error", `Sync FAILED: ${msg}`);
    console.error(`\n  FATAL: ${msg}\n`);
    process.exit(1);
  }
}

main();
