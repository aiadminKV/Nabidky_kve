/**
 * Filter test: Supabase vs Qdrant with category / manufacturer / stock filters.
 *
 * Tests that filters actually restrict results correctly and compares quality.
 *
 * Usage:
 *   npx tsx backend/scripts/qdrant-filter-test.ts
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const { generateQueryEmbedding } = await import("../src/services/embedding.js");
const { searchProductsSemantic } = await import("../src/services/search.js");
const { searchProductsQdrant } = await import("../src/services/qdrantSearch.js");
import type { StockFilterOptions } from "../src/services/search.js";

const COL = "─".repeat(80);
const SEP = "═".repeat(80);

// ── Test cases ───────────────────────────────────────────────

interface FilterTestCase {
  id: string;
  desc: string;
  query: string;
  expectedSku?: string;
  category?: string;        // main category code e.g. "405"
  manufacturer?: string;    // e.g. "ABB"
  stockOpts?: StockFilterOptions;
  /** What we expect the filter to enforce — verified on each result */
  expectCategoryMain?: string;   // e.g. "Kabely a vodiče"
  expectSupplierWord?: string;   // word that must appear in supplier_name
  expectStockItem?: boolean;
}

// Category map (first 3 digits of category_code → category_main name):
// 405 = Kabely a vodiče | 407 = Modulové přístroje | 419 = Úložný materiál
// 402 = Domovní spínače a zásuvky | 404 = Kabelový spojovací, izolační materiál

const TESTS: FilterTestCase[] = [
  // ── Category filter ────────────────────────────────────────
  {
    id: "CAT-1",
    desc: "Žlab neperforovaný 50x50 — cat 419 (Úložný materiál)",
    query: "kabelový žlab neperforovaný 50x50",
    expectedSku: "1999917",
    category: "419",
    expectCategoryMain: "Úložný materiál",
  },
  {
    id: "CAT-2",
    desc: "CYKY 3x240+120 — cat 405 (Kabely a vodiče)",
    query: "CYKY 3x240+120 napájecí kabel buben",
    expectedSku: "1257441001",
    category: "405",
    expectCategoryMain: "Kabely a vodiče",
  },
  {
    id: "CAT-3",
    desc: "Trubka tuhá 32mm — cat 419 (Úložný materiál)",
    query: "trubka tuhá 32mm šedá",
    expectedSku: "1169372",
    category: "419",
    expectCategoryMain: "Úložný materiál",
  },
  {
    id: "CAT-4",
    desc: "Jistič B16 — cat 407 (Modulové přístroje)",
    query: "jednopólový jistič charakteristika B 16A",
    category: "407",
    expectCategoryMain: "Modulové přístroje",
  },
  {
    id: "CAT-5",
    desc: "Zásuvka IP44 — cat 402 (Domovní spínače a zásuvky)",
    query: "zásuvka s víčkem IP44 16A 230V",
    expectedSku: "2002984",
    category: "402",
    expectCategoryMain: "Domovní spínače a zásuvky",
  },

  // ── Manufacturer filter ────────────────────────────────────
  {
    id: "MFR-1",
    desc: "Jistič B16 — výrobce ABB",
    query: "jistič B16 jednopólový",
    manufacturer: "ABB",
    expectSupplierWord: "ABB",
  },
  {
    id: "MFR-2",
    desc: "Zásuvka IP44 — výrobce Schneider",
    query: "zásuvka s víčkem IP44 16A",
    manufacturer: "Schneider",
    expectSupplierWord: "Schneider",
  },
  {
    id: "MFR-3",
    desc: "Kabel CAT6 LSOH — výrobce Solarix (INTELEK)",
    query: "datový kabel UTP CAT6 LSOH",
    expectedSku: "1132208",
    manufacturer: "INTELEK",
    expectSupplierWord: "INTELEK",
  },
  {
    id: "MFR-4",
    desc: "Trubka tuhá — výrobce Kopos",
    query: "trubka tuhá 32mm šedá",
    manufacturer: "Kopos",
    expectSupplierWord: "Kopos",
  },

  // ── Stock item filter ──────────────────────────────────────
  {
    id: "STK-1",
    desc: "Datový kabel CAT6 — jen stock items",
    query: "datový kabel UTP CAT6 LSOH",
    stockOpts: { stockItemOnly: true },
    expectStockItem: true,
  },
  {
    id: "STK-2",
    desc: "Jistič B16 — jen stock items",
    query: "jednopólový jistič B16",
    stockOpts: { stockItemOnly: true },
    expectStockItem: true,
  },

  // ── Combined filters ───────────────────────────────────────
  {
    id: "CMB-1",
    desc: "Jistič B16 — cat 407 + ABB + stock item",
    query: "jistič B16 jednopólový 6kA",
    category: "407",
    manufacturer: "ABB",
    stockOpts: { stockItemOnly: true },
    expectCategoryMain: "Modulové přístroje",
    expectSupplierWord: "ABB",
    expectStockItem: true,
  },
  {
    id: "CMB-2",
    desc: "CYKY 3x1,5 — cat 405 + stock item",
    query: "CYKY-J 3x1,5 instalační kabel",
    expectedSku: "1257383007",
    category: "405",
    stockOpts: { stockItemOnly: true },
    expectCategoryMain: "Kabely a vodiče",
    expectStockItem: true,
  },
];

// ── Runner ───────────────────────────────────────────────────

interface Hit {
  sku: string;
  name: string;
  score: number;
  supplier: string | null;
  categoryMain: string | null;
  isStockItem: boolean;
}

async function runCase(tc: FilterTestCase) {
  const embedding = await generateQueryEmbedding(tc.query);

  const [sbRaw, qdRaw] = await Promise.all([
    searchProductsSemantic(embedding, 10, 0.0, undefined, tc.manufacturer, tc.category, tc.stockOpts),
    searchProductsQdrant(embedding, 10, 0.0, undefined, tc.manufacturer, tc.category, tc.stockOpts),
  ]);

  const toHits = (r: typeof sbRaw): Hit[] => r.map((x) => ({
    sku: x.sku, name: x.name, score: x.cosine_similarity,
    supplier: x.supplier_name, categoryMain: x.category_main, isStockItem: x.is_stock_item,
  }));

  const sbHits = toHits(sbRaw);
  const qdHits = toHits(qdRaw);

  // Verify filter compliance
  const checkHit = (h: Hit) => {
    const issues: string[] = [];
    if (tc.expectCategoryMain && h.categoryMain !== tc.expectCategoryMain)
      issues.push(`cat="${h.categoryMain}" ≠ expected "${tc.expectCategoryMain}"`);
    if (tc.expectSupplierWord && !(h.supplier ?? "").toLowerCase().includes(tc.expectSupplierWord.toLowerCase()))
      issues.push(`supplier="${h.supplier}" missing "${tc.expectSupplierWord}"`);
    if (tc.expectStockItem !== undefined && h.isStockItem !== tc.expectStockItem)
      issues.push(`is_stock_item=${h.isStockItem} ≠ ${tc.expectStockItem}`);
    return issues;
  };

  const sbViolations = sbHits.flatMap((h) => checkHit(h).map((e) => `SB #${sbHits.indexOf(h) + 1}: ${e}`));
  const qdViolations = qdHits.flatMap((h) => checkHit(h).map((e) => `QD #${qdHits.indexOf(h) + 1}: ${e}`));

  const sbFoundExpected = tc.expectedSku ? sbHits.findIndex((h) => h.sku === tc.expectedSku) + 1 || -1 : null;
  const qdFoundExpected = tc.expectedSku ? qdHits.findIndex((h) => h.sku === tc.expectedSku) + 1 || -1 : null;

  return { tc, sbHits, qdHits, sbViolations, qdViolations, sbFoundExpected, qdFoundExpected };
}

function printCase(r: Awaited<ReturnType<typeof runCase>>) {
  const { tc, sbHits, qdHits, sbViolations, qdViolations, sbFoundExpected, qdFoundExpected } = r;
  const rank = (n: number | null) => n === null ? "" : n === -1 ? "❌ not found" : n <= 3 ? `✅ #${n}` : `🟡 #${n}`;

  console.log(`\n${COL}`);
  console.log(`[${tc.id}] ${tc.desc}`);
  console.log(`  Query: "${tc.query}"`);
  const filters = [
    tc.category ? `cat=${tc.category}` : null,
    tc.manufacturer ? `mfr="${tc.manufacturer}"` : null,
    tc.stockOpts?.stockItemOnly ? "stock_item=true" : null,
    tc.stockOpts?.inStockOnly ? "in_stock=true" : null,
  ].filter(Boolean).join(" | ");
  if (filters) console.log(`  Filters: ${filters}`);
  if (tc.expectedSku) console.log(`  Expected: ${tc.expectedSku} | SB: ${rank(sbFoundExpected)} | QD: ${rank(qdFoundExpected)}`);

  // Filter violations
  if (sbViolations.length > 0) console.log(`  ⚠ SB filter violations: ${sbViolations.join(", ")}`);
  else console.log(`  ✅ SB: all ${sbHits.length} results comply with filter`);
  if (qdViolations.length > 0) console.log(`  ⚠ QD filter violations: ${qdViolations.join(", ")}`);
  else console.log(`  ✅ QD: all ${qdHits.length} results comply with filter`);

  // Top 5 side by side
  const col = (s: string, w: number) => String(s ?? "").slice(0, w).padEnd(w);
  console.log(`\n  ${"#".padEnd(3)} ${"── Supabase SKU / Name".padEnd(38)} ${"Score".padEnd(7)} │ ${"── Qdrant SKU / Name".padEnd(38)} ${"Score".padEnd(7)}`);
  for (let i = 0; i < 5; i++) {
    const sb = sbHits[i];
    const qd = qdHits[i];
    const sm = sb?.sku === tc.expectedSku ? "*" : " ";
    const qm = qd?.sku === tc.expectedSku ? "*" : " ";
    const sbStr = sb ? `${sm}${col(sb.sku, 12)} ${col(sb.name, 24)} ${sb.score.toFixed(3)}` : " ".repeat(46);
    const qdStr = qd ? `${qm}${col(qd.sku, 12)} ${col(qd.name, 24)} ${qd.score.toFixed(3)}` : " ".repeat(46);
    console.log(`  #${i + 1}  ${sbStr} │ ${qdStr}`);
  }
}

async function main() {
  console.log("Filter test: Supabase vs Qdrant");
  console.log("Verifying category / manufacturer / stock filters\n");

  let sbFilterOk = 0, qdFilterOk = 0;
  let sbExpectedFound = 0, qdExpectedFound = 0, withExpected = 0;
  const results = [];

  for (const tc of TESTS) {
    process.stdout.write(`  [${tc.id}] ${tc.desc.slice(0, 55)}... `);
    try {
      const r = await runCase(tc);
      results.push(r);
      if (r.sbViolations.length === 0) sbFilterOk++;
      if (r.qdViolations.length === 0) qdFilterOk++;
      if (tc.expectedSku) {
        withExpected++;
        if (r.sbFoundExpected !== null && r.sbFoundExpected > 0) sbExpectedFound++;
        if (r.qdFoundExpected !== null && r.qdFoundExpected > 0) qdExpectedFound++;
      }
      process.stdout.write("OK\n");
    } catch (err) {
      process.stdout.write(`ERROR: ${err}\n`);
    }
  }

  for (const r of results) printCase(r);

  console.log(`\n${SEP}`);
  console.log("SUMMARY");
  console.log(`  Filter compliance — SB: ${sbFilterOk}/${TESTS.length} | QD: ${qdFilterOk}/${TESTS.length}`);
  if (withExpected > 0) {
    console.log(`  Expected SKU found — SB: ${sbExpectedFound}/${withExpected} | QD: ${qdExpectedFound}/${withExpected}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
