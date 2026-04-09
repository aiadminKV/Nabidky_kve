/**
 * eval-nabidka-v2.ts
 *
 * Spustí aktuální V2 pipeline na 49 položkách z manuální evaluace.
 * Výstup: CSV pro ruční hodnocení položku po položce.
 *
 * Použití:
 *   npx tsx src/scripts/eval-nabidka-v2.ts [--concurrency=N]
 *
 * Sloupce výstupu:
 *   id, demand, unit, qty
 *   previous_sku    — co bylo použito minule (NENÍ ground truth!)
 *   note_prev       — tvoje poznámka z minulého runu
 *   v2_sku          — co vybral V2 nyní
 *   v2_name         — název vybraného produktu
 *   v2_description  — popis (pro technickou kontrolu)
 *   matchType       — match / multiple / uncertain / not_found
 *   confidence      — % jistota agenta
 *   matchMethod     — ean / code / semantic
 *   candidates      — seznam SKU kandidátů (pro ruční výběr)
 *   candidate_names — názvy kandidátů
 *   reasoning       — zdůvodnění výběru od AI
 *   HODNOCENI       — prázdné: vyplň ok / chyba / alternativa / zkontrolovat
 *   POZNAMKA_NOVA   — prázdné: tvoje nová poznámka
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { ParsedItem, SearchPreferences } from "../services/types.js";
import { EVAL_ITEMS } from "./eval-data-nabidka.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const concurrencyArg = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);

const PREFS: SearchPreferences = {
  stockFilter: "stock_items_only",
  branchFilter: null,
};

// ── CSV helpers ────────────────────────────────────────────

function cell(val: string | number | null | undefined): string {
  const s = String(val ?? "");
  if (s.includes(";") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Concurrency ────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Eval V2 pipeline — ${EVAL_ITEMS.length} položek`);
  console.log(`   stockFilter: stock_items_only (Pouze skladovky)`);
  console.log(`   concurrency: ${concurrencyArg}\n`);

  const t0 = Date.now();
  let done = 0;

  const rows = await runWithConcurrency(EVAL_ITEMS, async (item, idx) => {
    const parsedItem: ParsedItem = {
      name: item.demand,
      unit: item.unit,
      quantity: item.quantity,
    };

    const itemT0 = Date.now();
    let result;
    try {
      result = await searchPipelineV2ForItem(parsedItem, idx, undefined, PREFS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      done++;
      console.error(`  ❌ [${String(done).padStart(2)}/${EVAL_ITEMS.length}] #${item.id} ERROR: ${msg}`);
      return {
        ...item,
        v2Sku: "ERROR",
        v2Name: msg,
        v2Desc: "",
        matchType: "error",
        confidence: 0,
        matchMethod: "",
        candidateSkus: "",
        candidateNames: "",
        reasoning: msg,
        pipelineMs: Date.now() - itemT0,
      };
    }

    const pMs = Date.now() - itemT0;
    const sel = result.product;
    const cands = result.candidates ?? [];

    const candidateSkus = cands.map(c => c.sku ?? "").filter(Boolean).join(", ");
    const candidateNames = cands.map(c => c.name ?? "").filter(Boolean).join(" | ");

    done++;

    // Console indicator: did SKU change vs previous?
    const skuChanged = sel?.sku && sel.sku !== item.previousSku;
    const skuSame = sel?.sku && sel.sku === item.previousSku;
    const notFound = !sel?.sku;

    const icon = notFound ? "⬜" : skuSame ? "=" : "≠";
    const prevNote = item.note1 ? ` (prev: "${item.note1.substring(0, 40)}")` : "";
    console.log(
      `  ${icon} [${String(done).padStart(2)}/${EVAL_ITEMS.length}] #${String(item.id).padStart(2)}  ` +
      `${item.demand.substring(0, 38).padEnd(38)}  ` +
      `${result.matchType.padEnd(10)} ${String(result.confidence).padStart(3)}%  ` +
      `${(sel?.name ?? "(nenalezeno)").substring(0, 40)}` +
      (skuChanged ? `  [prev: ${item.previousSku}]` : "") +
      prevNote,
    );

    return {
      ...item,
      v2Sku: sel?.sku ?? "",
      v2Name: sel?.name ?? "",
      v2Desc: (sel as { description?: string | null })?.description ?? "",
      matchType: result.matchType,
      confidence: result.confidence,
      matchMethod: result.matchMethod ?? "",
      candidateSkus,
      candidateNames,
      reasoning: result.reasoning ?? "",
      pipelineMs: pMs,
    };
  }, concurrencyArg);

  const totalMs = Date.now() - t0;

  // ── Summary ───────────────────────────────────────────────
  const found = rows.filter(r => r.v2Sku && r.v2Sku !== "ERROR").length;
  const notFoundRows = rows.filter(r => !r.v2Sku || r.v2Sku === "ERROR");
  const skuSame = rows.filter(r => r.v2Sku === r.previousSku).length;
  const skuDiff = rows.filter(r => r.v2Sku && r.v2Sku !== "ERROR" && r.v2Sku !== r.previousSku).length;

  console.log(`\n${"─".repeat(80)}`);
  console.log(`📊 PŘEHLED (${EVAL_ITEMS.length} položek, ${(totalMs / 1000).toFixed(1)}s)\n`);
  console.log(`  ✅ Nalezeno produkt:          ${String(found).padStart(3)} / ${EVAL_ITEMS.length}`);
  console.log(`  ⬜ Nenalezeno:                ${String(notFoundRows.length).padStart(3)} / ${EVAL_ITEMS.length}`);
  console.log(`  =  Stejný SKU jako minule:    ${String(skuSame).padStart(3)}`);
  console.log(`  ≠  Jiný SKU než minule:       ${String(skuDiff).padStart(3)}`);

  if (notFoundRows.length > 0) {
    console.log(`\n  Nenalezeno (${notFoundRows.length} položek):`);
    for (const r of notFoundRows) {
      console.log(`    #${r.id}  ${r.demand}  (prev: ${r.previousSku}, note: ${r.note1})`);
    }
  }

  // ── CSV výstup ─────────────────────────────────────────────
  const headers = [
    "id",
    "demand", "unit", "qty",
    "previous_sku",
    "note_prev_1", "note_prev_2",
    "v2_sku", "v2_name", "v2_description",
    "matchType", "confidence_%", "matchMethod",
    "candidates_count", "candidate_skus", "candidate_names",
    "reasoning",
    "pipeline_ms",
    // ── ruční hodnocení ──
    "HODNOCENI",      // ok / chyba / alternativa / zkontrolovat / nenašel-ok / nenašel-problem
    "POZNAMKA_NOVA",  // cokoliv
  ];

  const csvLines = [
    headers.map(cell).join(";"),
    ...rows.map(r => [
      r.id,
      r.demand, r.unit, r.quantity,
      r.previousSku,
      r.note1, r.note2,
      r.v2Sku, r.v2Name, r.v2Desc,
      r.matchType, r.confidence, r.matchMethod,
      r.candidateSkus.split(", ").filter(Boolean).length,
      r.candidateSkus,
      r.candidateNames,
      r.reasoning,
      r.pipelineMs,
      "", // HODNOCENI — prázdné pro ruční vyplnění
      "", // POZNAMKA_NOVA
    ].map(cell).join(";")),
  ];

  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const outPath = resolve(__dirname, `../../eval-nabidka-v2-${ts}.csv`);
  writeFileSync(outPath, "\uFEFF" + csvLines.join("\n"), "utf8");

  console.log(`\n💾 Výsledky: ${outPath}`);
  console.log(`\n  Sloupce pro ruční hodnocení:`);
  console.log(`    HODNOCENI    → ok / chyba / alternativa / zkontrolovat / nenašel-ok / nenašel-problem`);
  console.log(`    POZNAMKA_NOVA → cokoliv co si poznamenat\n`);
  console.log(`  ⚠️  previous_sku a note_prev jsou kontext z minulého runu — NEJSOU ground truth!\n`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
