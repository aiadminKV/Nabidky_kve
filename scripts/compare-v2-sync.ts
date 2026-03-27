/**
 * File-to-file comparison of two matnr_dispo_info CSV feeds.
 *
 * Compares OLD (previous) vs NEW (just downloaded) CSV — purely local,
 * no DB reads. Reports what would change if we ran the daily sync.
 *
 * Usage: npx tsx compare-v2-sync.ts [--old=path] [--new=path]
 */
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse";

const DEFAULT_OLD = resolve(import.meta.dirname, "../data-model/matnr_dispo_info.csv");
const DEFAULT_NEW = resolve(import.meta.dirname, "../data-model/sync/new_matnr_dispo_info.csv");

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
  stockHash: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function trim(s: string): string {
  return s?.trim() ?? "";
}

function parsePrice(val: string): number | null {
  if (!val || !val.trim()) return null;
  const n = parseFloat(val.replace(",", "."));
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

function computeStockHash(row: Record<string, string>, whColumns: string[]): string {
  const positives: Array<[string, number]> = [];
  for (const wh of whColumns) {
    const val = parseFloat((row[wh] || "0").replace(",", "."));
    if (!isNaN(val) && val > 0) {
      positives.push([wh, val]);
    }
  }
  if (positives.length === 0) return "";
  positives.sort(([a], [b]) => a.localeCompare(b));
  return createHash("md5").update(JSON.stringify(positives)).digest("hex");
}

function fmt(n: number): string {
  return n.toLocaleString("cs-CZ");
}

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${((part / total) * 100).toFixed(2)}%`;
}

function getArg(name: string, defaultVal: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? resolve(arg.split("=")[1]) : defaultVal;
}

// ─── Parse CSV into Map ──────────────────────────────────────────────

async function parseCsvToMap(filePath: string, label: string): Promise<{
  map: Map<string, ProductSnapshot>;
  whColumns: string[];
}> {
  console.log(`  Parsing ${label}: ${filePath}`);
  const map = new Map<string, ProductSnapshot>();
  let whColumns: string[] = [];
  let headerProcessed = false;
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
    if (!headerProcessed) {
      whColumns = Object.keys(row).filter((k) => k.startsWith("WH_"));
      const allCols = Object.keys(row);
      console.log(`    Columns: ${allCols.length} (${whColumns.length} WH_)`);
      console.log(`    Has DESC: ${allCols.includes("DESC")}, Has THUMB_FILE: ${allCols.includes("THUMB_FILE")}`);
      headerProcessed = true;
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
      stockHash: computeStockHash(row, whColumns),
    });

    count++;
    if (count % 200_000 === 0) console.log(`    ${fmt(count)} rows...`);
  }

  console.log(`    Total: ${fmt(count)} products\n`);
  return { map, whColumns };
}

// ─── Compute Diff ────────────────────────────────────────────────────

interface DiffResult {
  oldTotal: number;
  newTotal: number;
  newProducts: string[];
  removedProducts: string[];
  priceChanges: Array<{ matnr: string; old: number | null; new_: number | null }>;
  nameChanges: Array<{ matnr: string; old: string; new_: string }>;
  supplierChanges: Array<{ matnr: string; old: string; new_: string }>;
  statusPChanges: Array<{ matnr: string; old: string; new_: string }>;
  statusSChanges: Array<{ matnr: string; old: string; new_: string }>;
  stockChanges: number;
  matklChanges: Array<{ matnr: string; old: string; new_: string }>;
  dispoChanges: Array<{ matnr: string; old: string; new_: string }>;
  unitChanges: Array<{ matnr: string; old: string; new_: string }>;
  eanChanges: number;
  idnlfChanges: number;
  reembedNeeded: number;
}

function computeDiff(
  oldMap: Map<string, ProductSnapshot>,
  newMap: Map<string, ProductSnapshot>,
): DiffResult {
  const result: DiffResult = {
    oldTotal: oldMap.size,
    newTotal: newMap.size,
    newProducts: [],
    removedProducts: [],
    priceChanges: [],
    nameChanges: [],
    supplierChanges: [],
    statusPChanges: [],
    statusSChanges: [],
    stockChanges: 0,
    matklChanges: [],
    dispoChanges: [],
    unitChanges: [],
    eanChanges: 0,
    idnlfChanges: 0,
    reembedNeeded: 0,
  };

  for (const [matnr, nw] of newMap) {
    const old = oldMap.get(matnr);

    if (!old) {
      result.newProducts.push(matnr);
      result.reembedNeeded++;
      continue;
    }

    // Price
    if (old.price !== nw.price) {
      result.priceChanges.push({ matnr, old: old.price, new_: nw.price });
    }

    // Name → re-embed
    if (old.name !== nw.name) {
      result.nameChanges.push({ matnr, old: old.name, new_: nw.name });
      result.reembedNeeded++;
    }

    // Supplier → re-embed (if name didn't already change)
    if (old.supplier !== nw.supplier) {
      result.supplierChanges.push({ matnr, old: old.supplier, new_: nw.supplier });
      if (old.name === nw.name) {
        result.reembedNeeded++;
      }
    }

    // Statuses
    if (old.statusP !== nw.statusP) {
      result.statusPChanges.push({ matnr, old: old.statusP, new_: nw.statusP });
    }
    if (old.statusS !== nw.statusS) {
      result.statusSChanges.push({ matnr, old: old.statusS, new_: nw.statusS });
    }

    // Stock
    if (old.stockHash !== nw.stockHash) {
      result.stockChanges++;
    }

    // Category
    if (old.matkl !== nw.matkl) {
      result.matklChanges.push({ matnr, old: old.matkl, new_: nw.matkl });
    }

    // DISPO
    if (old.dispo !== nw.dispo) {
      result.dispoChanges.push({ matnr, old: old.dispo, new_: nw.dispo });
    }

    // Unit
    if (old.unit !== nw.unit) {
      result.unitChanges.push({ matnr, old: old.unit, new_: nw.unit });
    }

    // EAN / IDNLF
    if (old.ean !== nw.ean) result.eanChanges++;
    if (old.idnlf !== nw.idnlf) result.idnlfChanges++;
  }

  // Removed: in old but not in new
  for (const matnr of oldMap.keys()) {
    if (!newMap.has(matnr)) {
      result.removedProducts.push(matnr);
    }
  }

  return result;
}

// ─── Report ──────────────────────────────────────────────────────────

function report(diff: DiffResult) {
  const total = diff.newTotal;

  console.log("═".repeat(70));
  console.log("  SYNC DIFF REPORT — OLD CSV vs NEW CSV");
  console.log("═".repeat(70));

  console.log(`
  OLD file products:   ${fmt(diff.oldTotal)}
  NEW file products:   ${fmt(diff.newTotal)}
  Difference:          ${fmt(diff.newTotal - diff.oldTotal)} (${diff.newTotal >= diff.oldTotal ? "+" : ""}${fmt(diff.newTotal - diff.oldTotal)})
`);

  console.log("── PRODUCTS ─────────────────────────────────────────────");
  console.log(`  New (added):                   ${fmt(diff.newProducts.length).padStart(10)}  (${pct(diff.newProducts.length, total)})`);
  console.log(`  Removed:                       ${fmt(diff.removedProducts.length).padStart(10)}  (${pct(diff.removedProducts.length, diff.oldTotal)})`);
  console.log(`  Unchanged (exist in both):     ${fmt(total - diff.newProducts.length).padStart(10)}`);

  if (diff.newProducts.length > 0) {
    const show = diff.newProducts.slice(0, 10);
    console.log(`    Sample new: ${show.join(", ")}${diff.newProducts.length > 10 ? " ..." : ""}`);
  }
  if (diff.removedProducts.length > 0) {
    const show = diff.removedProducts.slice(0, 10);
    console.log(`    Sample removed: ${show.join(", ")}${diff.removedProducts.length > 10 ? " ..." : ""}`);
  }

  console.log("\n── PRICES ───────────────────────────────────────────────");
  console.log(`  Changed prices:                ${fmt(diff.priceChanges.length).padStart(10)}  (${pct(diff.priceChanges.length, total)})`);
  if (diff.priceChanges.length > 0) {
    const withOld = diff.priceChanges.filter((c) => c.old !== null && c.old > 0);
    const increases = withOld.filter((c) => c.new_! > c.old!);
    const decreases = withOld.filter((c) => c.new_! < c.old!);
    const gained = diff.priceChanges.filter((c) => (c.old === null || c.old === 0) && c.new_ !== null && c.new_ > 0);
    const lost = diff.priceChanges.filter((c) => c.old !== null && c.old > 0 && (c.new_ === null || c.new_ === 0));

    console.log(`    Increases:           ${fmt(increases.length)}`);
    console.log(`    Decreases:           ${fmt(decreases.length)}`);
    console.log(`    Gained price:        ${fmt(gained.length)} (was null/0 → has price)`);
    console.log(`    Lost price:          ${fmt(lost.length)} (had price → null/0)`);

    if (withOld.length > 0) {
      const avgChange =
        withOld.reduce((sum, c) => sum + Math.abs(c.new_! - c.old!) / c.old!, 0) / withOld.length;
      console.log(`    Avg relative change: ${(avgChange * 100).toFixed(2)}%`);
    }

    console.log("    Samples:");
    for (const c of diff.priceChanges.slice(0, 5)) {
      console.log(`      ${c.matnr}: ${c.old ?? "null"} → ${c.new_ ?? "null"}`);
    }
  }

  console.log("\n── NAMES (→ re-embed) ───────────────────────────────────");
  console.log(`  Changed names:                 ${fmt(diff.nameChanges.length).padStart(10)}  (${pct(diff.nameChanges.length, total)})`);
  if (diff.nameChanges.length > 0) {
    console.log("    Samples:");
    for (const c of diff.nameChanges.slice(0, 5)) {
      console.log(`      "${c.old}" → "${c.new_}"`);
    }
  }

  console.log("\n── SUPPLIERS (→ re-embed) ───────────────────────────────");
  console.log(`  Changed suppliers:             ${fmt(diff.supplierChanges.length).padStart(10)}  (${pct(diff.supplierChanges.length, total)})`);
  if (diff.supplierChanges.length > 0) {
    console.log("    Samples:");
    for (const c of diff.supplierChanges.slice(0, 5)) {
      console.log(`      "${c.old}" → "${c.new_}"`);
    }
  }

  console.log("\n── STATUSES ─────────────────────────────────────────────");
  console.log(`  MSTAE (purchase) changes:      ${fmt(diff.statusPChanges.length).padStart(10)}`);
  console.log(`  MSTAV (sales) changes:         ${fmt(diff.statusSChanges.length).padStart(10)}`);
  if (diff.statusPChanges.length > 0) {
    console.log("    MSTAE samples:");
    for (const c of diff.statusPChanges.slice(0, 3)) {
      console.log(`      ${c.matnr}: "${c.old}" → "${c.new_}"`);
    }
  }
  if (diff.statusSChanges.length > 0) {
    console.log("    MSTAV samples:");
    for (const c of diff.statusSChanges.slice(0, 3)) {
      console.log(`      ${c.matnr}: "${c.old}" → "${c.new_}"`);
    }
  }

  console.log("\n── STOCK ────────────────────────────────────────────────");
  console.log(`  Products with stock changes:   ${fmt(diff.stockChanges).padStart(10)}  (${pct(diff.stockChanges, total)})`);

  console.log("\n── CATEGORY (MATKL) ─────────────────────────────────────");
  console.log(`  Changed categories:            ${fmt(diff.matklChanges.length).padStart(10)}  (${pct(diff.matklChanges.length, total)})`);
  if (diff.matklChanges.length > 0) {
    console.log("    Samples:");
    for (const c of diff.matklChanges.slice(0, 5)) {
      console.log(`      ${c.matnr}: "${c.old}" → "${c.new_}"`);
    }
  }

  console.log("\n── WEEKLY FIELDS ────────────────────────────────────────");
  console.log(`  DISPO changes:                 ${fmt(diff.dispoChanges.length).padStart(10)}`);
  console.log(`  MEINS (unit) changes:          ${fmt(diff.unitChanges.length).padStart(10)}`);
  console.log(`  EAN changes:                   ${fmt(diff.eanChanges).padStart(10)}`);
  console.log(`  IDNLF changes:                 ${fmt(diff.idnlfChanges).padStart(10)}`);
  if (diff.dispoChanges.length > 0) {
    console.log("    DISPO samples:");
    for (const c of diff.dispoChanges.slice(0, 3)) {
      console.log(`      ${c.matnr}: "${c.old}" → "${c.new_}"`);
    }
  }

  console.log("\n── RE-EMBEDDING IMPACT ──────────────────────────────────");
  const supplierOnly = diff.supplierChanges.filter(
    (c) => !diff.nameChanges.some((n) => n.matnr === c.matnr),
  ).length;
  console.log(`  Total needing re-embed:        ${fmt(diff.reembedNeeded).padStart(10)}`);
  console.log(`    New products:                ${fmt(diff.newProducts.length).padStart(10)}`);
  console.log(`    Name changes:                ${fmt(diff.nameChanges.length).padStart(10)}`);
  console.log(`    Supplier changes (only):     ${fmt(supplierOnly).padStart(10)}`);
  const estTokens = diff.reembedNeeded * 30;
  console.log(`    Est. tokens:                 ~${fmt(estTokens)}`);
  console.log(`    Est. cost:                   ~$${((estTokens / 1_000_000) * 0.02).toFixed(4)}`);

  console.log("\n── WRITE LOAD SUMMARY ───────────────────────────────────");
  const metadataUpdates = diff.nameChanges.length + diff.supplierChanges.length +
    diff.statusPChanges.length + diff.statusSChanges.length + diff.matklChanges.length;
  console.log(`  product_price_v2 upserts:      ${fmt(diff.priceChanges.length).padStart(10)}`);
  console.log(`  product_branch_stock_v2 ops:   ${fmt(diff.stockChanges).padStart(10)}`);
  console.log(`  products_v2 metadata updates:  ${fmt(metadataUpdates).padStart(10)}`);
  console.log(`  products_v2 inserts (new):     ${fmt(diff.newProducts.length).padStart(10)}`);
  console.log(`  products_v2 soft-deletes:      ${fmt(diff.removedProducts.length).padStart(10)}`);
  console.log(`  product_embeddings_v2 writes:  ${fmt(diff.reembedNeeded).padStart(10)}`);

  console.log("\n" + "═".repeat(70));
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const oldPath = getArg("old", DEFAULT_OLD);
  const newPath = getArg("new", DEFAULT_NEW);

  console.log("KV Offer Manager — File-to-File Sync Comparison\n");

  const startTime = Date.now();

  console.log("[1/3] Parsing CSV files...");
  const { map: oldMap, whColumns: oldWh } = await parseCsvToMap(oldPath, "OLD");
  const { map: newMap, whColumns: newWh } = await parseCsvToMap(newPath, "NEW");

  // Report WH column changes
  const addedWh = newWh.filter((w) => !oldWh.includes(w));
  const removedWh = oldWh.filter((w) => !newWh.includes(w));
  if (addedWh.length > 0) console.log(`  New WH_ columns: ${addedWh.join(", ")}`);
  if (removedWh.length > 0) console.log(`  Removed WH_ columns: ${removedWh.join(", ")}`);

  console.log("[2/3] Computing diff...");
  const diff = computeDiff(oldMap, newMap);

  console.log("[3/3] Generating report...\n");
  report(diff);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
