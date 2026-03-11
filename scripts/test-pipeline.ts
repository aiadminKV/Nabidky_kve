/**
 * End-to-end test of the deterministic search pipeline.
 *
 * Runs real queries through the full pipeline:
 *   Reformulation → Dual embedding → Dual semantic search → Merge → AI Evaluation → Refinement
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/test-pipeline.ts
 *   cd backend && npx tsx ../scripts/test-pipeline.ts --concurrency=5
 *   cd backend && npx tsx ../scripts/test-pipeline.ts --items=5
 */
import { searchPipelineForItem, type PipelineResult, type PipelineDebugFn } from "../backend/src/services/searchPipeline.js";

const QUERIES = [
  "Jistič B3x16",
  "Jistič B1x16",
  "Proudový chránič s nadproudovou ochranou 0,03A/1B1x10A",
  "Napěťová spoušť",
  "Světidlo čtvercové 23,1W 2850 lm LED IP 54",
  "Světidlo lineární 38,4W 5360 lm LED IP 54",
  "Světidlo nouzové s vlastní bateriovým zdrojem záloha 30 minut",
  "Vypínač řazení 6",
  "Vypínač IP44 řazení 1",
  "Vypínač IP44 řazení 6",
  "Tlačítko bezpečnosti s omezeným přístupem",
  "Zásuvka 230V 16A dvojnásobná",
  "Zásuvka 230V 16A IP44",
  "Zásuvka 400V 16A IP44",
  "Vypínač 3F 25A",
  "Krabice KO8",
  "Svorka WAGO",
  "Ochranné pospojení vývod",
  "Svorka s páskem CU",
  "Vodič CY 10",
  "Vodič CY 4",
  "Kabel CYKY 3x1,5",
  "Kabel CYKY 3x2,5",
  "Kabel CYKY 5x2,5",
  "Kabel CYKY 5x4",
  "Kabel CYKY 2x1,5",
  "Kabel UTP cat5",
  "Kabel CGSG J5x2,5",
  "Rozvodnice RK - uprava zapojení stávající",
  "LED panel 600x600 40W",
];

function parseArg(name: string, defaultValue: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split("=")[1], 10) : defaultValue;
}

function confidenceColor(c: number): string {
  if (c >= 85) return "\x1b[32m"; // green
  if (c >= 60) return "\x1b[33m"; // yellow
  if (c >= 30) return "\x1b[38;5;208m"; // orange
  return "\x1b[31m"; // red
}
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

async function main() {
  const maxItems = parseArg("items", QUERIES.length);
  const concurrency = parseArg("concurrency", 5);

  const queries = QUERIES.slice(0, maxItems);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${BOLD}SEARCH PIPELINE TEST${RESET}`);
  console.log(`Items: ${queries.length} | Concurrency: ${concurrency}`);
  console.log(`Pipeline: Reformulation → Dual Embedding → Dual Search → Merge → AI Eval → Refinement`);
  console.log(`${"=".repeat(80)}\n`);

  const results: PipelineResult[] = [];
  const batchT0 = Date.now();

  const makeDebug = (pos: number): PipelineDebugFn => {
    return ({ step, data }) => {
      const d = data as Record<string, unknown>;
      if (step === "reformulation") {
        process.stdout.write(`  ${DIM}[${pos}] reformulated: "${d.reformulated}"${RESET}\n`);
      } else if (step === "search") {
        process.stdout.write(
          `  ${DIM}[${pos}] raw: ${d.rawCount} results (top ${typeof d.rawTopSim === "number" ? (d.rawTopSim * 100).toFixed(1) : "?"}%) | ref: ${d.refCount} results (top ${typeof d.refTopSim === "number" ? (d.refTopSim * 100).toFixed(1) : "?"}%)${RESET}\n`,
        );
      } else if (step === "merge") {
        process.stdout.write(`  ${DIM}[${pos}] merged: ${d.total} unique candidates${RESET}\n`);
      } else if (step === "refinement") {
        process.stdout.write(
          `  ${DIM}[${pos}] refinement #${d.attempt}: query="${d.query}" subcat="${d.subcategory ?? "—"}"${RESET}\n`,
        );
      }
    };
  };

  let cursor = 0;
  const runNext = async (): Promise<void> => {
    const idx = cursor++;
    if (idx >= queries.length) return;

    const item = { name: queries[idx], unit: null, quantity: null };
    console.log(`${BOLD}[${idx + 1}/${queries.length}] "${item.name}"${RESET}`);

    const result = await searchPipelineForItem(item, idx, makeDebug(idx));
    results.push(result);

    const cc = confidenceColor(result.confidence);
    const productName = result.product?.name ?? "—";
    const productSku = result.product?.sku ?? "—";
    console.log(
      `  → ${cc}${result.matchType.toUpperCase()} (${result.confidence}%)${RESET} | SKU: ${productSku} | ${result.pipelineMs}ms`,
    );
    console.log(`    Product: ${productName}`);
    console.log(`    Reasoning: ${result.reasoning}`);
    if (result.candidates.length > 1) {
      console.log(`    Candidates: ${result.candidates.map((c) => c.sku).join(", ")}`);
    }
    console.log();

    await runNext();
  };

  const workers = Array.from(
    { length: Math.min(concurrency, queries.length) },
    () => runNext(),
  );
  await Promise.all(workers);

  const totalMs = Date.now() - batchT0;

  // ── Summary ──
  const byType: Record<string, number> = {};
  const confidences: number[] = [];
  const latencies: number[] = [];

  for (const r of results) {
    byType[r.matchType] = (byType[r.matchType] ?? 0) + 1;
    confidences.push(r.confidence);
    latencies.push(r.pipelineMs);
  }

  const avgConf = Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length);
  const avgLat = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const maxLat = Math.max(...latencies);
  const minLat = Math.min(...latencies);

  const highConf = confidences.filter((c) => c >= 85).length;
  const medConf = confidences.filter((c) => c >= 60 && c < 85).length;
  const lowConf = confidences.filter((c) => c >= 30 && c < 60).length;
  const noMatch = confidences.filter((c) => c < 30).length;

  console.log(`${"=".repeat(80)}`);
  console.log(`${BOLD}SUMMARY${RESET}`);
  console.log(`  Total items:   ${queries.length}`);
  console.log(`  Total time:    ${totalMs}ms (wall clock, ${concurrency} concurrent)`);
  console.log();
  console.log(`  ${BOLD}Match types:${RESET}`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count} (${Math.round((count / queries.length) * 100)}%)`);
  }
  console.log();
  console.log(`  ${BOLD}Confidence distribution:${RESET}`);
  console.log(`    \x1b[32m85-100 (match):\x1b[0m      ${highConf} (${Math.round((highConf / queries.length) * 100)}%)`);
  console.log(`    \x1b[33m60-84 (uncertain):\x1b[0m   ${medConf} (${Math.round((medConf / queries.length) * 100)}%)`);
  console.log(`    \x1b[38;5;208m30-59 (alternative):\x1b[0m ${lowConf} (${Math.round((lowConf / queries.length) * 100)}%)`);
  console.log(`    \x1b[31m0-29 (not_found):\x1b[0m    ${noMatch} (${Math.round((noMatch / queries.length) * 100)}%)`);
  console.log(`    Average confidence: ${avgConf}%`);
  console.log();
  console.log(`  ${BOLD}Latency per item:${RESET}`);
  console.log(`    avg: ${avgLat}ms | min: ${minLat}ms | max: ${maxLat}ms`);
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
