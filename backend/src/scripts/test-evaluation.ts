/**
 * Evaluace search pipeline — evaluace-final.csv
 *
 * Spustit: cd backend && npx tsx src/scripts/test-evaluation.ts
 *
 * Co dělá:
 *  1. Načte CSV s poptávkami a očekávanými SKU
 *  2. Pro single-SKU položky: pre-fetch z DB (supplier_name, category_line) → GroupContext
 *  3. Spustí pipeline paralelně pro každou položku (CONCURRENCY = 10)
 *  4. Porovná výsledky s očekávanými SKU
 *  5. Vypíše console report + uloží eval-results.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { searchPipelineForItem, type GroupContext, type SearchPreferences } from "../services/searchPipeline.js";
import { getAdminClient } from "../services/supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Konfigurace ───────────────────────────────────────────────
const CONCURRENCY = 10;
const CSV_PATH = path.resolve(__dirname, "../../../evaluace-final.csv");
const OUTPUT_PATH = path.resolve(__dirname, "./eval-results.json");

const SEARCH_PREFS: SearchPreferences = {
  stockFilter: "stock_items_only",
  offerType: "realizace",
};

// ── Typy ──────────────────────────────────────────────────────
type ItemStatus = "exact_match" | "wrong" | "not_found" | "skip_set" | "skip_kpl";

interface CsvRow {
  demand: string;
  quantity: number | null;
  unit: string;
  rawSku: string;
  expectedSkus: string[];
  isSet: boolean;
  isKpl: boolean;
}

interface EvalResult {
  idx: number;
  demand: string;
  quantity: number | null;
  unit: string;
  expectedSku: string;
  expectedName: string | null;
  expectedManufacturer: string | null;
  expectedLine: string | null;
  expectedCategory: string | null;
  selectedSku: string | null;
  selectedName: string | null;
  matchType: string;
  confidence: number;
  exactLookupFound: boolean;
  reformulatedQuery: string;
  pipelineMs: number;
  status: ItemStatus;
  reasoning: string;
}

// ── CSV parser ────────────────────────────────────────────────
function parseCsv(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let demand = "";
    let rest = "";
    if (line.startsWith('"')) {
      const closeQuote = line.indexOf('";');
      if (closeQuote !== -1) {
        demand = line.slice(1, closeQuote);
        rest = line.slice(closeQuote + 2);
      } else {
        demand = line.replace(/^"|"$/g, "");
        rest = "";
      }
    } else {
      const firstSemi = line.indexOf(";");
      demand = line.slice(0, firstSemi);
      rest = line.slice(firstSemi + 1);
    }

    const parts = rest.split(";");
    const rawQty = parts[0]?.trim().replace(",", ".") ?? "";
    const unit = parts[1]?.trim() ?? "";
    const rawSku = parts[2]?.trim() ?? "";

    // Multi-SKU: SKU field contains + with spaces around it or numeric SKUs separated by +
    const skuParts = rawSku.split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
    const isSet = skuParts.length > 1;
    const isKpl = unit.toLowerCase() === "kpl";

    const qty = rawQty ? parseFloat(rawQty) : null;

    rows.push({
      demand: demand.trim(),
      quantity: qty !== null && !isNaN(qty) ? qty : null,
      unit,
      rawSku,
      expectedSkus: skuParts,
      isSet,
      isKpl,
    });
  }

  return rows;
}

// ── Pre-fetch produktů z DB ───────────────────────────────────
interface ProductMeta {
  sku: string;
  name: string;
  supplier_name: string | null;
  category_main: string | null;
  category_sub: string | null;
  category_line: string | null;
}

async function prefetchProducts(skus: string[]): Promise<Map<string, ProductMeta>> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("products_v2")
    .select("sku, name, supplier_name, category_main, category_sub, category_line")
    .in("sku", skus);

  if (error) throw new Error(`Pre-fetch failed: ${error.message}`);

  const map = new Map<string, ProductMeta>();
  for (const p of data ?? []) {
    map.set(p.sku, p as ProductMeta);
  }
  return map;
}

// ── Helpers ───────────────────────────────────────────────────
function statusLabel(status: ItemStatus): string {
  switch (status) {
    case "exact_match": return "✅";
    case "wrong":       return "❌";
    case "not_found":   return "🔴";
    case "skip_set":    return "⏭ ";
    case "skip_kpl":    return "⏭ ";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Evaluace jedné položky ────────────────────────────────────
async function evaluateItem(
  idx: number,
  row: CsvRow,
  productMeta: Map<string, ProductMeta>,
): Promise<EvalResult> {
  const expectedSku = row.expectedSkus[0];
  const meta = productMeta.get(expectedSku);

  const groupContext: GroupContext | undefined = meta ? {
    preferredManufacturer: meta.supplier_name,
    preferredLine: meta.category_line,
  } : undefined;

  let result;
  try {
    result = await searchPipelineForItem(
      { name: row.demand, unit: row.unit, quantity: row.quantity },
      idx,
      undefined,
      SEARCH_PREFS,
      groupContext,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "pipeline error";
    return {
      idx, demand: row.demand, quantity: row.quantity, unit: row.unit,
      expectedSku, expectedName: meta?.name ?? null,
      expectedManufacturer: meta?.supplier_name ?? null,
      expectedLine: meta?.category_line ?? null,
      expectedCategory: meta?.category_sub ?? null,
      selectedSku: null, selectedName: null,
      matchType: "error", confidence: 0,
      exactLookupFound: false, reformulatedQuery: "",
      pipelineMs: 0, status: "not_found",
      reasoning: `Pipeline error: ${msg}`,
    };
  }

  const selectedSku = result.product?.sku ?? null;
  let status: ItemStatus;
  if (selectedSku === expectedSku) {
    status = "exact_match";
  } else if (!selectedSku || result.matchType === "not_found") {
    status = "not_found";
  } else {
    status = "wrong";
  }

  return {
    idx, demand: row.demand, quantity: row.quantity, unit: row.unit,
    expectedSku, expectedName: meta?.name ?? null,
    expectedManufacturer: meta?.supplier_name ?? null,
    expectedLine: meta?.category_line ?? null,
    expectedCategory: meta?.category_sub ?? null,
    selectedSku, selectedName: result.product?.name ?? null,
    matchType: result.matchType, confidence: result.confidence,
    exactLookupFound: result.exactLookupFound,
    reformulatedQuery: result.reformulatedQuery,
    pipelineMs: result.pipelineMs,
    status,
    reasoning: result.reasoning ?? "",
  };
}

// ── Worker pool ───────────────────────────────────────────────
async function runParallel<T>(
  items: T[],
  worker: (item: T, workerIdx: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    const idx = cursor++;
    if (idx >= items.length) return;
    await worker(items[idx], idx);
    await runNext();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(72));
  console.log("  Evaluace search pipeline — evaluace-final.csv");
  console.log("═".repeat(72));

  const rows = parseCsv(CSV_PATH);
  console.log(`\n  Načteno ${rows.length} řádků z CSV`);

  const toEval = rows.filter((r) => !r.isSet && !r.isKpl);
  const skipSet = rows.filter((r) => r.isSet);
  const skipKpl = rows.filter((r) => r.isKpl);
  console.log(`  Evaluujeme: ${toEval.length} položek`);
  console.log(`  Skip (set): ${skipSet.length} položek`);
  console.log(`  Skip (kpl): ${skipKpl.length} položek\n`);

  const allSkus = toEval.map((r) => r.expectedSkus[0]).filter(Boolean);
  console.log(`  Pre-fetch ${allSkus.length} produktů z DB...`);
  const productMeta = await prefetchProducts(allSkus);
  const foundInDb = allSkus.filter((s) => productMeta.has(s)).length;
  console.log(`  Nalezeno v DB: ${foundInDb}/${allSkus.length}`);
  const missing = allSkus.filter((s) => !productMeta.has(s));
  if (missing.length > 0) {
    console.log(`  Nenalezeno v DB: ${missing.join(", ")}`);
  }

  const results: EvalResult[] = new Array(toEval.length);
  const t0 = Date.now();
  let done = 0;

  console.log(`\n  Spouštím evaluaci (CONCURRENCY=${CONCURRENCY})...\n`);

  await runParallel(toEval, async (row, workerIdx) => {
    const globalIdx = rows.indexOf(row) + 2; // 1-based + header
    const result = await evaluateItem(globalIdx, row, productMeta);
    results[workerIdx] = result;
    done++;
    const label = statusLabel(result.status);
    const skuInfo = result.status === "exact_match"
      ? result.expectedSku
      : `got:${result.selectedSku ?? "–"} exp:${result.expectedSku}`;
    console.log(
      `  [${String(done).padStart(3)}/${toEval.length}] ${label} ${truncate(row.demand, 42).padEnd(43)} [${skuInfo}] (${result.confidence}%)`
    );
  }, CONCURRENCY);

  const totalMs = Date.now() - t0;

  // Merge skip položky pro JSON výstup
  const skipResults: EvalResult[] = [
    ...skipSet.map((r) => ({
      idx: rows.indexOf(r) + 2,
      demand: r.demand, quantity: r.quantity, unit: r.unit,
      expectedSku: r.rawSku, expectedName: null,
      expectedManufacturer: null, expectedLine: null, expectedCategory: null,
      selectedSku: null, selectedName: null,
      matchType: "skip", confidence: 0,
      exactLookupFound: false, reformulatedQuery: "", pipelineMs: 0,
      status: "skip_set" as ItemStatus, reasoning: "Multi-SKU set — přeskočeno",
    })),
    ...skipKpl.map((r) => ({
      idx: rows.indexOf(r) + 2,
      demand: r.demand, quantity: r.quantity, unit: r.unit,
      expectedSku: r.rawSku, expectedName: null,
      expectedManufacturer: null, expectedLine: null, expectedCategory: null,
      selectedSku: null, selectedName: null,
      matchType: "skip", confidence: 0,
      exactLookupFound: false, reformulatedQuery: "", pipelineMs: 0,
      status: "skip_kpl" as ItemStatus, reasoning: "Jednotka kpl — abstraktní položka",
    })),
  ];

  const allResults = [...results.filter(Boolean), ...skipResults].sort((a, b) => a.idx - b.idx);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allResults, null, 2), "utf-8");

  // ── Finální report ────────────────────────────────────────
  const evaluated = results.filter(Boolean);
  const exactMatch = evaluated.filter((r) => r.status === "exact_match");
  const wrong = evaluated.filter((r) => r.status === "wrong");
  const notFound = evaluated.filter((r) => r.status === "not_found");

  console.log("\n" + "═".repeat(72));
  console.log("  VÝSLEDKY");
  console.log("═".repeat(72));
  console.log(`\n  Celkem evaluováno: ${evaluated.length} položek za ${Math.round(totalMs / 1000)}s`);
  console.log(`  ✅ exact_match: ${exactMatch.length}/${evaluated.length} (${Math.round(exactMatch.length / evaluated.length * 100)}%)`);
  console.log(`  ❌ wrong:       ${wrong.length}/${evaluated.length} (${Math.round(wrong.length / evaluated.length * 100)}%)`);
  console.log(`  🔴 not_found:   ${notFound.length}/${evaluated.length} (${Math.round(notFound.length / evaluated.length * 100)}%)`);

  if (wrong.length > 0) {
    console.log("\n" + "─".repeat(72));
    console.log("  ŠPATNĚ VYBRANÉ (wrong)");
    console.log("─".repeat(72));
    for (const r of wrong) {
      console.log(`\n  [řádek ${r.idx}] ${r.demand}`);
      console.log(`    Očekáváno: ${r.expectedSku} — ${r.expectedName ?? "?"}`);
      console.log(`    Vybráno:   ${r.selectedSku} — ${r.selectedName ?? "?"}`);
      console.log(`    Kontext:   výrobce=${r.expectedManufacturer ?? "–"} / řada=${r.expectedLine ?? "–"}`);
      console.log(`    matchType=${r.matchType}, confidence=${r.confidence}%, exactLookup=${r.exactLookupFound}`);
      console.log(`    Reasoning: ${truncate(r.reasoning, 150)}`);
    }
  }

  if (notFound.length > 0) {
    console.log("\n" + "─".repeat(72));
    console.log("  NENALEZENÉ (not_found)");
    console.log("─".repeat(72));
    for (const r of notFound) {
      console.log(`\n  [řádek ${r.idx}] ${r.demand}`);
      console.log(`    Očekáváno: ${r.expectedSku} — ${r.expectedName ?? "?"}`);
      console.log(`    Kontext:   výrobce=${r.expectedManufacturer ?? "–"} / řada=${r.expectedLine ?? "–"}`);
      console.log(`    exactLookup: ${r.exactLookupFound ? "nalezl" : "nenalezl"}`);
      console.log(`    Reasoning: ${truncate(r.reasoning, 150)}`);
    }
  }

  // Analýza po kategoriích
  console.log("\n" + "─".repeat(72));
  console.log("  PO KATEGORIÍCH (category_sub)");
  console.log("─".repeat(72));
  const byCategory = new Map<string, { total: number; exact: number; wrong: number; notFound: number }>();
  for (const r of evaluated) {
    const cat = r.expectedCategory ?? "(neznámá)";
    const e = byCategory.get(cat) ?? { total: 0, exact: 0, wrong: 0, notFound: 0 };
    e.total++;
    if (r.status === "exact_match") e.exact++;
    else if (r.status === "wrong") e.wrong++;
    else if (r.status === "not_found") e.notFound++;
    byCategory.set(cat, e);
  }
  const sorted = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [cat, s] of sorted) {
    const pct = Math.round(s.exact / s.total * 100);
    const bar = "█".repeat(Math.round(pct / 5)).padEnd(20, "░");
    console.log(`  ${bar} ${String(pct).padStart(3)}%  ${truncate(cat, 32).padEnd(33)} ${s.exact}/${s.total} (❌${s.wrong} 🔴${s.notFound})`);
  }

  console.log("\n" + "═".repeat(72));
  console.log(`  Detailní výsledky: ${OUTPUT_PATH}`);
  console.log("═".repeat(72) + "\n");
}

main().catch(console.error);
