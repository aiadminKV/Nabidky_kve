/**
 * Compare Qdrant vs Supabase semantic search results.
 *
 * Uses real queries from the eval dataset to measure result overlap,
 * ranking quality and score differences.
 *
 * Required env vars (read from root .env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 *   QDRANT_URL (default: http://localhost:6333)
 *
 * Usage:
 *   npx tsx backend/scripts/qdrant-test.ts
 *   npx tsx backend/scripts/qdrant-test.ts --manufacturer ABB --category 407
 *   npx tsx backend/scripts/qdrant-test.ts --csv output.csv
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

// Lazy imports after env is loaded
const { generateQueryEmbedding } = await import("../src/services/embedding.js");
const { searchProductsSemantic } = await import("../src/services/search.js");
const { searchProductsQdrant, generateQueryEmbeddingLarge } = await import("../src/services/qdrantSearch.js");

// ── CLI args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}
const manufacturerFilter = getArg("--manufacturer");
const categoryFilter = getArg("--category");
const csvOutput = getArg("--csv");
const topN = parseInt(getArg("--top") ?? "10", 10);

// ── Test cases (derived from eval-nabidka-v2) ────────────────

interface TestCase {
  id: number;
  query: string;
  expectedSku?: string;
  expectedName?: string;
  category?: string;
  manufacturer?: string;
}

// NOTE: category codes (e.g. "405" = silové kabely, "407" = jistící přístroje)
// simulate the user pre-selecting a category — which happens in most real queries.
// manufacturer filter simulates user pre-selecting a brand for domovní elektro.
// expectedSku is the "ideal" hit; nearby variants are also acceptable in practice.

const TEST_CASES: TestCase[] = [
  // ── Datové kabely (cat 40502 = datové kabely) ─────────────────────────
  // 1132208 = KABEL SXKD-6-UTP-LSOH 500M — repeatedly hardest case
  { id: 1,  query: "Datový kabel UTP CAT6 LSOH metráž 500m buben",  expectedSku: "1132208", category: "40502" },
  { id: 2,  query: "Kabel FTP CAT5e LSOH Dca",                      expectedSku: "1227354", category: "40502" },
  { id: 3,  query: "Kabel JXFE-R B2cas1d0 2x2x0,8",                 expectedSku: "1948632", category: "40502" },
  { id: 4,  query: "Patch kabel Cat6 RJ45/RJ45 3m",                  expectedSku: "1196599", category: "40502" },

  // ── Silové kabely CYKY (cat 40501) ────────────────────────────────────
  { id: 5,  query: "CYKY-J 3x240+120 napájecí kabel buben",          expectedSku: "1257441001", category: "40501" },
  { id: 6,  query: "CYKY-J 5x1,5 instalační kabel buben",            expectedSku: "1257397007", category: "40501" },
  { id: 7,  query: "CYKY-J 3x6 kabel buben",                         expectedSku: "1257539",    category: "40501" },
  { id: 8,  query: "CYKY-J 3x1,5 instalační kabel buben",            expectedSku: "1257383007", category: "40501" },
  { id: 9,  query: "kabel instalační Cu PVC (CYKY) 3x1,5mm2 buben",  expectedSku: "1257383007", category: "40501" },
  { id: 10, query: "kabel instalační Cu PVC (CYKY) 5x2,5mm2 buben",  expectedSku: "1257427007", category: "40501" },

  // ── Kabely CXKH (bezhalogenové, cat 40501) ────────────────────────────
  { id: 11, query: "CXKH-R-J 5x6 bezhalogenový kabel buben",         expectedSku: "1257671",    category: "40501" },
  { id: 12, query: "CXKH-R-J 5x2,5 bezhalogenový kabel",             expectedSku: "1257673",    category: "40501" },
  { id: 13, query: "CXKH-R-J 5x16 bezhalogenový kabel buben",        expectedSku: "1753410",    category: "40501" },
  { id: 14, query: "CXKH-R-O 3x1,5 bezhalogenový",                   expectedSku: "1257676",    category: "40501" },
  { id: 15, query: "kabel bezhalogenový N2XH 3x1,5mm2",               expectedSku: "1314262",    category: "40501" },

  // ── Vodiče CYA (cat 40501) ─────────────────────────────────────────────
  { id: 16, query: "Vodič CYA 95mm H07V-K buben",                    expectedSku: "1257477003", category: "40501" },
  { id: 17, query: "Vodič CYA 50mm buben",                           expectedSku: "1257467004", category: "40501" },
  { id: 18, query: "vodič propojovací Cu H07V-K 1x6mm2",              expectedSku: "1189116",    category: "40501" },

  // ── Jistící přístroje (cat 407) ────────────────────────────────────────
  { id: 19, query: "jistič B 50A třípólový 6kA",                     expectedSku: "1157112",  category: "407" },
  { id: 20, query: "jistič 1-pólový 16A charakteristika B 6kA",      expectedSku: "1180880",  category: "407" },
  { id: 21, query: "jistič 1-pólový 2A charakteristika C 10kA",      expectedSku: "1183635",  category: "407" },
  { id: 22, query: "jistič 3-pólový 25A charakteristika B 10kA",     expectedSku: "1183608",  category: "407" },
  { id: 23, query: "chránič 1+N 16A typ B",                          expectedSku: "1754843",  category: "407" },

  // ── Domovní elektro — zásuvky/vypínače (cat 408, s výrobcem) ──────────
  // V reálu předchází výběr výrobce+řady uživatelem
  { id: 24, query: "spínač nástěnný jednopólový řazení 1 IP54 bezšroubový", expectedSku: "1213553", category: "408" },
  { id: 25, query: "přepínač střídavý řazení 6 IP54 bezšroubový",           expectedSku: "1213555", category: "408" },
  { id: 26, query: "zásuvka nástěnná jednonásobná s víčkem IP54 bezšroubová", expectedSku: "1213563", category: "408" },
  { id: 27, query: "zásuvka s víčkem IP44 230V 16A",                expectedSku: "2002984",  category: "408" },
  { id: 28, query: "rámeček jednonásobný",                          expectedSku: "1188530",  category: "408", manufacturer: "ABB" },

  // ── Krabice a trubky ──────────────────────────────────────────────────
  { id: 29, query: "krabice přístrojová do dutých stěn SDK hluboká 68mm", expectedSku: "1251537" },
  { id: 30, query: "krabice pod omítku PVC přístrojová kruhová D70mm hluboká", expectedSku: "1212052" },
  { id: 31, query: "trubka ohebná plastová 32mm 320N",              expectedSku: "1184615" },
  { id: 32, query: "trubka tuhá PVC 32mm šedá",                    expectedSku: "1185860" },

  // ── Žlaby ─────────────────────────────────────────────────────────────
  { id: 33, query: "žlab drátěný šířka 50mm",                      expectedSku: "1200220" },
  { id: 34, query: "kabelový žlab neperforovaný 50x50",             expectedSku: "1993714" },

  // ── Obtížné / specifické ──────────────────────────────────────────────
  { id: 35, query: "elektroměrová skříň ER222 pro přímé měření 2 elektroměry NVP7P", expectedSku: "2036894" },
  { id: 36, query: "rozvodnice nástěnná 72 modulů plné dveře IP41", expectedSku: "1181837" },
  { id: 37, query: "svítidlo vestavné stropní panelové kruhové D200-250mm 1500-2200lm", expectedSku: "2109431" },
  { id: 38, query: "ALU profil rovný vestavný mléčný difuzor dl 2m na LED pásek", expectedSku: "2077232" },
  { id: 39, query: "svodič přepětí DSH TNC 255 FM",               expectedSku: "1699350" },
  { id: 40, query: "hlavní vypínač 3P 40A",                        expectedSku: "1202455",  category: "407" },
];

// ── Comparison logic ─────────────────────────────────────────

interface SearchHit {
  rank: number;
  sku: string;
  name: string;
  score: number;
  isStockItem: boolean;
  supplier: string | null;
  category: string | null;
}

interface TestResult {
  id: number;
  query: string;
  expectedSku: string | undefined;
  sbResults: SearchHit[];
  qdResults: SearchHit[];
  sbHasExpected: boolean;
  qdHasExpected: boolean;
  sbRankOfExpected: number;
  qdRankOfExpected: number;
  overlapCount: number;
  overlapAtTop3: number;
  sbMs: number;
  qdMs: number;
}

async function runTest(tc: TestCase): Promise<TestResult> {
  const manufacturer = manufacturerFilter ?? tc.manufacturer;
  const category = categoryFilter ?? tc.category;

  // Supabase uses small model (256d), Qdrant uses large model (512d)
  const [sbEmbedding, qdEmbedding] = await Promise.all([
    generateQueryEmbedding(tc.query),
    generateQueryEmbeddingLarge(tc.query),
  ]);

  const sbT0 = Date.now();
  const sbResultsRaw = await searchProductsSemantic(
    sbEmbedding,
    topN,
    0.15,
    undefined,
    manufacturer,
    category,
  );
  const sbMs = Date.now() - sbT0;

  const qdT0 = Date.now();
  const qdResultsRaw = await searchProductsQdrant(
    qdEmbedding,
    topN,
    0.15,
    undefined,
    manufacturer,
    category,
  );
  const qdMs = Date.now() - qdT0;

  const toHits = (items: typeof sbResultsRaw): SearchHit[] =>
    items.map((r, i) => ({
      rank: i + 1,
      sku: r.sku,
      name: r.name,
      score: r.cosine_similarity,
      isStockItem: r.is_stock_item,
      supplier: r.supplier_name,
      category: r.category_main,
    }));

  const sbResults = toHits(sbResultsRaw);
  const qdResults = toHits(qdResultsRaw);

  const sbSkus = new Set(sbResults.map((r) => r.sku));
  const qdSkus = new Set(qdResults.map((r) => r.sku));

  const sbRankOfExpected = tc.expectedSku
    ? (sbResults.findIndex((r) => r.sku === tc.expectedSku) + 1) || -1
    : -1;
  const qdRankOfExpected = tc.expectedSku
    ? (qdResults.findIndex((r) => r.sku === tc.expectedSku) + 1) || -1
    : -1;

  const overlapSkus = [...sbSkus].filter((s) => qdSkus.has(s));
  const sbTop3 = new Set(sbResults.slice(0, 3).map((r) => r.sku));
  const qdTop3 = new Set(qdResults.slice(0, 3).map((r) => r.sku));
  const overlapAtTop3 = [...sbTop3].filter((s) => qdTop3.has(s)).length;

  return {
    id: tc.id,
    query: tc.query,
    expectedSku: tc.expectedSku,
    sbResults,
    qdResults,
    sbHasExpected: tc.expectedSku ? sbSkus.has(tc.expectedSku) : false,
    qdHasExpected: tc.expectedSku ? qdSkus.has(tc.expectedSku) : false,
    sbRankOfExpected,
    qdRankOfExpected,
    overlapCount: overlapSkus.length,
    overlapAtTop3,
    sbMs,
    qdMs,
  };
}

// ── Output formatters ─────────────────────────────────────────

function printResult(r: TestResult) {
  const rankStr = (rank: number) => rank === -1 ? "—" : `#${rank}`;
  const check = (has: boolean, rank: number) =>
    has ? (rank <= 3 ? "✅" : "🟡") : (r.expectedSku ? "❌" : "  ");

  console.log(`\n${"─".repeat(80)}`);
  console.log(`[${r.id}] ${r.query}`);
  if (r.expectedSku) {
    console.log(
      `    Expected: ${r.expectedSku} | ` +
      `SB: ${check(r.sbHasExpected, r.sbRankOfExpected)} ${rankStr(r.sbRankOfExpected)} | ` +
      `QD: ${check(r.qdHasExpected, r.qdRankOfExpected)} ${rankStr(r.qdRankOfExpected)}`,
    );
  }
  console.log(
    `    Overlap: ${r.overlapCount}/${topN} results shared | top-3 overlap: ${r.overlapAtTop3}/3 | ` +
    `SB: ${r.sbMs}ms | QD: ${r.qdMs}ms`,
  );

  const maxRows = Math.max(r.sbResults.length, r.qdResults.length);
  const col = (s: string, w: number) => s.slice(0, w).padEnd(w);

  console.log(
    "    " +
    col("Rank", 5) + col("── Supabase ──────────────── SKU", 38) + col("Score", 8) +
    " │ " +
    col("── Qdrant ──────────────────── SKU", 38) + col("Score", 8),
  );

  for (let i = 0; i < Math.min(maxRows, 5); i++) {
    const sb = r.sbResults[i];
    const qd = r.qdResults[i];
    const sbMark = sb?.sku === r.expectedSku ? "*" : " ";
    const qdMark = qd?.sku === r.expectedSku ? "*" : " ";
    const sbStr = sb
      ? `${sbMark}${col(sb.sku, 12)} ${col(sb.name, 24)} ${sb.score.toFixed(3)}`
      : " ".repeat(46);
    const qdStr = qd
      ? `${qdMark}${col(qd.sku, 12)} ${col(qd.name, 24)} ${qd.score.toFixed(3)}`
      : " ".repeat(46);
    console.log(`    #${i + 1}  ${sbStr} │ ${qdStr}`);
  }
}

function buildCsvRows(results: TestResult[]): string {
  const header = [
    "id", "query", "expected_sku",
    "sb_rank", "qd_rank",
    "sb_top1_sku", "sb_top1_name", "sb_top1_score",
    "qd_top1_sku", "qd_top1_name", "qd_top1_score",
    "overlap_count", "overlap_top3",
    "sb_ms", "qd_ms",
    "sb_found", "qd_found",
  ].join(";");

  const rows = results.map((r) => [
    r.id,
    `"${r.query}"`,
    r.expectedSku ?? "",
    r.sbRankOfExpected,
    r.qdRankOfExpected,
    r.sbResults[0]?.sku ?? "",
    `"${r.sbResults[0]?.name ?? ""}"`,
    r.sbResults[0]?.score.toFixed(4) ?? "",
    r.qdResults[0]?.sku ?? "",
    `"${r.qdResults[0]?.name ?? ""}"`,
    r.qdResults[0]?.score.toFixed(4) ?? "",
    r.overlapCount,
    r.overlapAtTop3,
    r.sbMs,
    r.qdMs,
    r.sbHasExpected ? 1 : 0,
    r.qdHasExpected ? 1 : 0,
  ].join(";"));

  return [header, ...rows].join("\n");
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`Running ${TEST_CASES.length} test cases | top-${topN}`);
  if (manufacturerFilter) console.log(`  Manufacturer filter: ${manufacturerFilter}`);
  if (categoryFilter) console.log(`  Category filter: ${categoryFilter}`);
  console.log();

  const results: TestResult[] = [];
  let sbFoundCount = 0;
  let qdFoundCount = 0;
  let withExpected = 0;

  for (const tc of TEST_CASES) {
    process.stdout.write(`  [${tc.id}/${TEST_CASES.length}] ${tc.query.slice(0, 50)}...`);
    try {
      const r = await runTest(tc);
      results.push(r);
      if (tc.expectedSku) {
        withExpected++;
        if (r.sbHasExpected) sbFoundCount++;
        if (r.qdHasExpected) qdFoundCount++;
      }
      process.stdout.write(` OK\n`);
    } catch (err) {
      process.stdout.write(` ERROR: ${err}\n`);
    }
  }

  // Print detailed results
  for (const r of results) {
    printResult(r);
  }

  // Summary
  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY");
  console.log(`  Test cases with expected SKU: ${withExpected}`);
  console.log(
    `  Supabase found expected: ${sbFoundCount}/${withExpected} (${Math.round((sbFoundCount / withExpected) * 100)}%)`,
  );
  console.log(
    `  Qdrant   found expected: ${qdFoundCount}/${withExpected} (${Math.round((qdFoundCount / withExpected) * 100)}%)`,
  );

  const avgOverlap =
    results.reduce((s, r) => s + r.overlapCount, 0) / results.length;
  const avgOverlapTop3 =
    results.reduce((s, r) => s + r.overlapAtTop3, 0) / results.length;
  const avgSbMs = results.reduce((s, r) => s + r.sbMs, 0) / results.length;
  const avgQdMs = results.reduce((s, r) => s + r.qdMs, 0) / results.length;

  console.log(
    `  Avg result overlap: ${avgOverlap.toFixed(1)}/${topN} | top-3 overlap: ${avgOverlapTop3.toFixed(2)}/3`,
  );
  console.log(
    `  Avg latency — Supabase: ${Math.round(avgSbMs)}ms | Qdrant: ${Math.round(avgQdMs)}ms`,
  );

  // CSV export
  if (csvOutput) {
    const csv = buildCsvRows(results);
    writeFileSync(csvOutput, csv, "utf-8");
    console.log(`\n  Results saved to: ${csvOutput}`);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
