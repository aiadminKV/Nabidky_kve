/**
 * eval-cables.ts
 *
 * Eval agenta V2 na kabelových položkách se správnou metrikou:
 *   - hit_selected:   expectedSku === selectedSku
 *   - hit_candidate:  expectedSku ∈ alternativeSkus (nebo multiple varianty)
 *   - hit_any:        buď selected nebo candidate
 *   - expectMultiple: agent vrátil matchType: "multiple" (barevné varianty)
 *
 * Použití:
 *   npx tsx src/scripts/eval-cables.ts [--concurrency=N] [--ids=1,2,3]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { ParsedItem, SearchPreferences } from "../services/types.js";
import { CABLE_EVAL_ITEMS, type CableEvalItem } from "./eval-data-cables.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const CONCURRENCY = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "3", 10);
const idsArg = args.find(a => a.startsWith("--ids="))?.split("=")[1];
const FILTER_IDS = idsArg ? idsArg.split(",").map(Number) : null;

// ── Hodnocení jedné položky ────────────────────────────────

type Verdict =
  | "HIT_SELECTED"    // expectedSku je selectedSku
  | "HIT_CANDIDATE"   // expectedSku v alternativeSkus
  | "MULTI_OK"        // expectMultiple=true a agent vrátil multiple se správnými kandidáty
  | "MULTI_WRONG"     // expectMultiple=true ale agent nevybral multiple (vybral jednu barvu)
  | "NOT_FOUND"       // ani selected, ani candidate
  | "SKIP";           // expectedSkus prázdné (jen kontrola chování)

interface EvalResult {
  item: CableEvalItem;
  selectedSku: string | null;
  matchType: string;
  confidence: number;
  alternativeSkus: string[];
  reasoning: string;
  pipelineMs: number;
  verdict: Verdict;
  verdictDetail: string;
}

function evaluate(item: CableEvalItem, result: Awaited<ReturnType<typeof searchPipelineV2ForItem>>): EvalResult {
  const selectedSku = result.product?.sku ?? null;
  const alternativeSkus = (result.candidates ?? []).map((c: any) => c.sku).filter(Boolean);
  const matchType = result.matchType;

  const base = {
    item,
    selectedSku,
    matchType,
    confidence: result.confidence,
    alternativeSkus,
    reasoning: result.reasoning ?? "",
    pipelineMs: result.pipelineMs ?? 0,
  };

  // Případ: žádné expectedSkus — jen kontrola chování
  if (item.expectedSkus.length === 0) {
    if (item.expectMultiple) {
      const ok = matchType === "multiple" && alternativeSkus.length >= 2;
      return { ...base, verdict: ok ? "MULTI_OK" : "MULTI_WRONG",
        verdictDetail: ok
          ? `multiple OK, ${alternativeSkus.length} variant`
          : `čekal multiple se 2+ variantami, dostal matchType=${matchType}, alts=${alternativeSkus.length}` };
    }
    return { ...base, verdict: "SKIP", verdictDetail: "žádné expectedSkus" };
  }

  // Případ: expectMultiple — agent NESMÍ vybrat jednu, musí vrátit multiple
  if (item.expectMultiple) {
    if (matchType !== "multiple") {
      return { ...base, verdict: "MULTI_WRONG",
        verdictDetail: `čekal matchType=multiple, dostal=${matchType}, selected=${selectedSku}` };
    }
    // Zkontroluj, že aspoň jedno expectedSku je v alternativeSkus
    const hit = item.expectedSkus.some(e => alternativeSkus.includes(e));
    return { ...base,
      verdict: hit ? "MULTI_OK" : "MULTI_WRONG",
      verdictDetail: hit
        ? `multiple OK, nalezeno ${item.expectedSkus.filter(e => alternativeSkus.includes(e)).join(",")} v alternativách`
        : `multiple ale žádné z expectedSkus (${item.expectedSkus.join(",")}) není v alternativách [${alternativeSkus.join(",")}]` };
  }

  // Normální případ: hledáme expectedSku v selected nebo candidates
  const hitSelected = selectedSku !== null && item.expectedSkus.includes(selectedSku);
  if (hitSelected) {
    return { ...base, verdict: "HIT_SELECTED", verdictDetail: `selected=${selectedSku}` };
  }

  const hitCandidate = item.expectedSkus.some(e => alternativeSkus.includes(e));
  if (hitCandidate) {
    const found = item.expectedSkus.filter(e => alternativeSkus.includes(e));
    return { ...base, verdict: "HIT_CANDIDATE", verdictDetail: `v alternativách: ${found.join(",")}` };
  }

  return { ...base, verdict: "NOT_FOUND",
    verdictDetail: `hledal [${item.expectedSkus.join(",")}], selected=${selectedSku}, alts=[${alternativeSkus.join(",")}]` };
}

// ── Concurrency helper ─────────────────────────────────────

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
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── CSV ───────────────────────────────────────────────────

function cell(val: string | number | null | undefined): string {
  const s = String(val ?? "");
  if (s.includes(";") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const items = FILTER_IDS
    ? CABLE_EVAL_ITEMS.filter(i => FILTER_IDS.includes(i.id))
    : CABLE_EVAL_ITEMS;

  console.log(`\n🔍 Cables Eval — ${items.length} položek, concurrency=${CONCURRENCY}\n`);

  const t0 = Date.now();
  let done = 0;

  const evalResults = await runWithConcurrency(items, async (item) => {
    const prefs: SearchPreferences = {
      stockFilter: item.stockFilter === "stock_items_only" ? "stock_items_only" : "any",
      branchFilter: null,
    };

    const parsedItem: ParsedItem = {
      name: item.demand,
      unit: item.unit,
      quantity: item.quantity,
    };

    let pipelineResult: Awaited<ReturnType<typeof searchPipelineV2ForItem>>;
    try {
      pipelineResult = await searchPipelineV2ForItem(parsedItem, item.id, undefined, prefs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      done++;
      process.stdout.write(`  [${done}/${items.length}] #${item.id} ERROR: ${msg}\n`);
      return {
        item,
        selectedSku: null,
        matchType: "error",
        confidence: 0,
        alternativeSkus: [],
        reasoning: msg,
        pipelineMs: 0,
        verdict: "NOT_FOUND" as const,
        verdictDetail: `ERROR: ${msg}`,
      } satisfies EvalResult;
    }

    const evalResult = evaluate(item, pipelineResult);
    done++;

    const icon =
      evalResult.verdict === "HIT_SELECTED" ? "✅" :
      evalResult.verdict === "HIT_CANDIDATE" ? "🔶" :
      evalResult.verdict === "MULTI_OK" ? "✅" :
      evalResult.verdict === "MULTI_WRONG" ? "❌" :
      evalResult.verdict === "SKIP" ? "⬜" : "❌";

    process.stdout.write(
      `  [${done}/${items.length}] #${item.id} ${icon} ${evalResult.verdict.padEnd(14)} ${item.demand} (${evalResult.pipelineMs}ms)\n`
    );
    if (evalResult.verdict !== "HIT_SELECTED" && evalResult.verdict !== "SKIP") {
      process.stdout.write(`         → ${evalResult.verdictDetail}\n`);
    }

    return evalResult;
  }, CONCURRENCY);

  const totalMs = Date.now() - t0;

  // ── Statistiky ──────────────────────────────────────────
  const counts = {
    HIT_SELECTED:  evalResults.filter(r => r.verdict === "HIT_SELECTED").length,
    HIT_CANDIDATE: evalResults.filter(r => r.verdict === "HIT_CANDIDATE").length,
    MULTI_OK:      evalResults.filter(r => r.verdict === "MULTI_OK").length,
    MULTI_WRONG:   evalResults.filter(r => r.verdict === "MULTI_WRONG").length,
    NOT_FOUND:     evalResults.filter(r => r.verdict === "NOT_FOUND").length,
    SKIP:          evalResults.filter(r => r.verdict === "SKIP").length,
  };
  const total = evalResults.length;
  const scored = total - counts.SKIP;
  const hits = counts.HIT_SELECTED + counts.HIT_CANDIDATE + counts.MULTI_OK;
  const hitRate = scored > 0 ? Math.round(hits / scored * 100) : 0;

  console.log("\n" + "═".repeat(60));
  console.log("VÝSLEDKY");
  console.log("═".repeat(60));
  console.log(`  Celkem položek:       ${total}  (hodnocených: ${scored})`);
  console.log(`  ✅ HIT_SELECTED:      ${counts.HIT_SELECTED}`);
  console.log(`  🔶 HIT_CANDIDATE:     ${counts.HIT_CANDIDATE}`);
  console.log(`  ✅ MULTI_OK:          ${counts.MULTI_OK}`);
  console.log(`  ❌ MULTI_WRONG:       ${counts.MULTI_WRONG}`);
  console.log(`  ❌ NOT_FOUND:         ${counts.NOT_FOUND}`);
  console.log(`  ⬜ SKIP:              ${counts.SKIP}`);
  console.log(`  Hit rate (any):       ${hitRate}% (${hits}/${scored})`);
  console.log(`  Celkový čas:          ${totalMs}ms`);
  console.log("═".repeat(60));

  // Problémy
  const problems = evalResults.filter(r =>
    r.verdict === "NOT_FOUND" || r.verdict === "MULTI_WRONG"
  );
  if (problems.length > 0) {
    console.log("\nPROBLÉMY:");
    for (const r of problems) {
      console.log(`  #${r.item.id} ${r.item.demand} → ${r.verdictDetail}`);
    }
  }

  // ── CSV export ──────────────────────────────────────────
  const header = [
    "id", "demand", "unit", "qty", "stockFilter",
    "verdict", "verdict_detail",
    "selected_sku", "match_type", "confidence",
    "alternatives", "expected_skus",
    "reasoning", "pipeline_ms", "note",
  ].join(";");

  const rows = evalResults.map(r => [
    cell(r.item.id),
    cell(r.item.demand),
    cell(r.item.unit),
    cell(r.item.quantity),
    cell(r.item.stockFilter),
    cell(r.verdict),
    cell(r.verdictDetail),
    cell(r.selectedSku),
    cell(r.matchType),
    cell(r.confidence),
    cell(r.alternativeSkus.join("|")),
    cell(r.item.expectedSkus.join("|")),
    cell(r.reasoning),
    cell(r.pipelineMs),
    cell(r.item.note),
  ].join(";"));

  const csv = [header, ...rows].join("\n");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = resolve(__dirname, `../../../../eval-cables-${ts}.csv`);
  writeFileSync(outPath, "\uFEFF" + csv, "utf8");
  console.log(`\nCSV: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
