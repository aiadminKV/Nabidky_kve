/**
 * eval-v2-skladovky.ts
 *
 * Spustí aktuální V2 pipeline na položkách z evaluace (skladovky filtr).
 * Výstup: CSV pro manuální hodnocení + summary do konzole.
 *
 * Použití:
 *   npx tsx src/scripts/eval-v2-skladovky.ts [--limit N] [--concurrency N]
 *
 * Výstupní soubor: eval-results-v2-skladovky-<timestamp>.csv
 */

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { ParsedItem, SearchPreferences } from "../services/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const limitArg = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "9999", 10);
const concurrencyArg = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "5", 10);

// ── Preferences: "Pouze skladovky", bez filtru dostupnosti ─
const PREFS: SearchPreferences = {
  stockFilter: "stock_items_only",
  branchFilter: null,
};

// ── Parse CSV ─────────────────────────────────────────────

interface CsvRow {
  demand: string;
  quantity: number;
  unit: string;
  expectedSku: string;
  dbName: string;
  dbDesc: string;
}

async function parseCsv(path: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    if (!line.trim()) continue;
    // Handle quoted fields (some rows have semicolons inside quotes)
    const parts = splitCsvLine(line);
    if (parts.length < 4) continue;
    rows.push({
      demand: parts[0].trim(),
      quantity: parseFloat(parts[1].replace(",", ".")) || 0,
      unit: parts[2].trim(),
      expectedSku: parts[3].trim(),
      dbName: parts[4]?.trim() ?? "",
      dbDesc: parts[5]?.trim() ?? "",
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ";" && !inQuote) {
      result.push(current); current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Deduplicate: unique (demand, unit) ───────────────────

function deduplicateItems(rows: CsvRow[]): CsvRow[] {
  const seen = new Set<string>();
  const unique: CsvRow[] = [];
  for (const row of rows) {
    const key = `${row.demand.toLowerCase()}|${row.unit.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }
  return unique;
}

// ── Result type ────────────────────────────────────────────

interface EvalRow {
  id: number;
  demand: string;
  unit: string;
  quantity: number;
  expectedSku: string;
  expectedName: string;
  v2SelectedSku: string;
  v2SelectedName: string;
  matchType: string;
  confidence: number;
  matchMethod: string;
  candidatesCount: number;
  candidateSkus: string;
  candidateNames: string;
  reasoning: string;
  pipelineMs: number;
  quickVerdict: string; // auto-computed, NOT authoritative
}

function quickVerdict(row: EvalRow): string {
  if (!row.expectedSku) return "?";
  if (row.v2SelectedSku === row.expectedSku) return "✅ exact";
  if (row.candidateSkus.includes(row.expectedSku)) return "🟡 in_candidates";
  if (row.v2SelectedSku === "") return "❌ not_found";
  return "⚠️ different";
}

// ── Concurrency runner ────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── CSV escape ────────────────────────────────────────────

function csvCell(val: string | number): string {
  const s = String(val ?? "");
  if (s.includes(";") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const csvPath = resolve(__dirname, "../../../docs/general/evaluace-master-final-db.csv");
  console.log(`\n📂 Načítám data z: ${csvPath}`);

  const allRows = await parseCsv(csvPath);
  console.log(`   Celkem řádků v CSV: ${allRows.length}`);

  const unique = deduplicateItems(allRows).slice(0, limitArg);
  console.log(`   Unikátních položek (demand+unit): ${unique.length}`);
  console.log(`   Concurrency: ${concurrencyArg}`);
  console.log(`\n🔍 Spouštím V2 pipeline (stockFilter=stock_items_only)...\n`);

  let done = 0;
  const t0 = Date.now();

  const evalRows = await runWithConcurrency(unique, async (row, idx): Promise<EvalRow> => {
    const item: ParsedItem = {
      name: row.demand,
      unit: row.unit,
      quantity: row.quantity,
    };

    const itemT0 = Date.now();
    let result;
    try {
      result = await searchPipelineV2ForItem(item, idx, undefined, PREFS);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ #${idx + 1} ERROR: ${row.demand} — ${errMsg}`);
      done++;
      return {
        id: idx + 1,
        demand: row.demand,
        unit: row.unit,
        quantity: row.quantity,
        expectedSku: row.expectedSku,
        expectedName: row.dbName,
        v2SelectedSku: "ERROR",
        v2SelectedName: errMsg,
        matchType: "error",
        confidence: 0,
        matchMethod: "",
        candidatesCount: 0,
        candidateSkus: "",
        candidateNames: "",
        reasoning: errMsg,
        pipelineMs: Date.now() - itemT0,
        quickVerdict: "❌ error",
      };
    }

    const pMs = Date.now() - itemT0;
    const selected = result.product;
    const candidates = result.candidates ?? [];

    const candidateSkus = candidates.map(c => c.sku ?? "").filter(Boolean).join(", ");
    const candidateNames = candidates.map(c => c.name ?? "").filter(Boolean).join(" | ");

    const er: EvalRow = {
      id: idx + 1,
      demand: row.demand,
      unit: row.unit,
      quantity: row.quantity,
      expectedSku: row.expectedSku,
      expectedName: row.dbName,
      v2SelectedSku: selected?.sku ?? "",
      v2SelectedName: selected?.name ?? "",
      matchType: result.matchType,
      confidence: result.confidence,
      matchMethod: result.matchMethod ?? "",
      candidatesCount: candidates.length,
      candidateSkus,
      candidateNames,
      reasoning: result.reasoning ?? "",
      pipelineMs: pMs,
      quickVerdict: "",
    };
    er.quickVerdict = quickVerdict(er);

    done++;
    const pct = Math.round((done / unique.length) * 100);
    const icon =
      er.quickVerdict.startsWith("✅") ? "✅" :
      er.quickVerdict.startsWith("🟡") ? "🟡" :
      er.quickVerdict.startsWith("⚠️") ? "⚠️" : "❌";

    console.log(
      `  ${icon} [${String(done).padStart(3)}/${unique.length}] ${String(pct).padStart(3)}%  ` +
      `${row.demand.substring(0, 40).padEnd(40)}  ` +
      `→ ${(selected?.name ?? "(nenalezeno)").substring(0, 35).padEnd(35)}  ` +
      `[${result.matchType} ${result.confidence}%] ${pMs}ms`,
    );

    return er;
  }, concurrencyArg);

  const totalMs = Date.now() - t0;

  // ── Summary ───────────────────────────────────────────────
  const exact = evalRows.filter(r => r.quickVerdict.startsWith("✅")).length;
  const inCandidates = evalRows.filter(r => r.quickVerdict.startsWith("🟡")).length;
  const different = evalRows.filter(r => r.quickVerdict.startsWith("⚠️")).length;
  const notFound = evalRows.filter(r => r.quickVerdict.startsWith("❌")).length;
  const total = evalRows.length;

  console.log(`\n${"─".repeat(80)}`);
  console.log(`📊 VÝSLEDKY (${total} položek, ${(totalMs / 1000).toFixed(1)}s celkem)\n`);
  console.log(`  ✅ Exact match (shodný SKU):       ${String(exact).padStart(3)} / ${total}  (${pct(exact, total)}%)`);
  console.log(`  🟡 SKU v kandidátech:              ${String(inCandidates).padStart(3)} / ${total}  (${pct(inCandidates, total)}%)`);
  console.log(`  ⚠️  Jiný SKU vybrán:               ${String(different).padStart(3)} / ${total}  (${pct(different, total)}%)`);
  console.log(`  ❌ Nenalezeno / chyba:             ${String(notFound).padStart(3)} / ${total}  (${pct(notFound, total)}%)`);
  console.log();

  // matchType breakdown
  const byMatchType: Record<string, number> = {};
  for (const r of evalRows) {
    byMatchType[r.matchType] = (byMatchType[r.matchType] ?? 0) + 1;
  }
  console.log("  Match types:");
  for (const [mt, cnt] of Object.entries(byMatchType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mt.padEnd(15)} ${String(cnt).padStart(3)}`);
  }

  // ── Write CSV ─────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const outPath = resolve(__dirname, `../../eval-v2-skladovky-${ts}.csv`);

  const headers = [
    "id", "demand", "unit", "quantity",
    "expected_sku", "expected_name",
    "v2_sku", "v2_name",
    "matchType", "confidence", "matchMethod",
    "candidates_count", "candidate_skus", "candidate_names",
    "quick_verdict",
    "reasoning",
    "pipeline_ms",
    "HODNOCENI",  // empty column for manual annotation
    "POZNAMKA",   // empty column for manual notes
  ];

  const csvLines = [
    headers.map(csvCell).join(";"),
    ...evalRows.map(r => [
      r.id, r.demand, r.unit, r.quantity,
      r.expectedSku, r.expectedName,
      r.v2SelectedSku, r.v2SelectedName,
      r.matchType, r.confidence, r.matchMethod,
      r.candidatesCount, r.candidateSkus, r.candidateNames,
      r.quickVerdict,
      r.reasoning,
      r.pipelineMs,
      "",  // HODNOCENI — vyplň ručně: ok / chyba / alternativa / zkontrolovat
      "",  // POZNAMKA
    ].map(csvCell).join(";")),
  ];

  writeFileSync(outPath, "\uFEFF" + csvLines.join("\n"), "utf8");
  console.log(`\n💾 Výsledky uloženy do: ${outPath}`);
  console.log(`   Otevři v Numbers/Excel — sloupce HODNOCENI a POZNAMKA jsou prázdné pro tvoje ručné hodnocení.`);
  console.log(`   ⚠️  "quick_verdict" je jen orientační — exact match neznamená vždy správnost (BUBEN vs KRUH)!\n`);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0" : ((n / total) * 100).toFixed(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
