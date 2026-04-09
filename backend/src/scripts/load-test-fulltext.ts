/**
 * load-test-fulltext.ts
 *
 * Stress test pro search_products_agent_fulltext RPC.
 * Simuluje paralelní agenty volající fulltext search.
 *
 * Použití:
 *   npx tsx src/scripts/load-test-fulltext.ts [--concurrency=N] [--rounds=N] [--delay=N]
 *
 * Příklady:
 *   npx tsx src/scripts/load-test-fulltext.ts --concurrency=5 --rounds=3
 *   npx tsx src/scripts/load-test-fulltext.ts --concurrency=30 --rounds=5
 */

import { getAdminClient } from "../services/supabase.js";

// ── CLI args ───────────────────────────────────────────────

const args = process.argv.slice(2);
const CONCURRENCY = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "10", 10);
const ROUNDS      = parseInt(args.find(a => a.startsWith("--rounds="))?.split("=")[1] ?? "3", 10);
const DELAY_MS    = parseInt(args.find(a => a.startsWith("--delay="))?.split("=")[1] ?? "0", 10);

// ── Reprezentativní dotazy (mix lehkých i těžkých) ────────

const QUERIES: Array<{ query: string; label: string; manufacturer?: string }> = [
  // Přesné technické označení — typicky málo výsledků, rychlé
  { query: "1-CYKY-J 3x1,5",          label: "kabel CYKY přesný" },
  { query: "1-CXKH-R-J 5x2,5",        label: "kabel CXKH přesný" },
  { query: "PL6-B16",                  label: "jistič PL6" },
  { query: "H07V-K 1x6",              label: "vodič H07V-K" },
  { query: "S201-B16",                 label: "jistič ABB kód" },
  { query: "SDN0500121",               label: "Schneider kód" },
  // Obecnější — více výsledků, potenciálně pomalejší
  { query: "zásuvka schuko",           label: "zásuvka schuko" },
  { query: "UTP Cat6",                 label: "datový kabel Cat6" },
  { query: "LED panel 60x60 40W",      label: "svítidlo panel" },
  { query: "jistič jednopólový B16",   label: "jistič popis" },
  { query: "kabel CYKY instalační",    label: "kabel obecný" },
  { query: "trubka ohebná 20mm",       label: "trubka" },
  // S filtrem výrobce (přesný match = rychlejší)
  { query: "jistič B16", label: "jistič + výrobce ABB", manufacturer: "ABB" },
  { query: "zásuvka",    label: "zásuvka + výrobce Legrand", manufacturer: "Legrand" },
];

// ── Typy ──────────────────────────────────────────────────

interface QueryResult {
  query: string;
  label: string;
  hits: number;
  ms: number;
  error?: string;
}

interface RoundStats {
  round: number;
  concurrency: number;
  totalMs: number;
  results: QueryResult[];
}

// ── Jedno volání RPC ─────────────────────────────────────

async function callRpc(q: { query: string; label: string; manufacturer?: string }): Promise<QueryResult> {
  const supabase = getAdminClient();
  const t0 = performance.now();

  try {
    const params: Record<string, unknown> = {
      search_query: q.query,
      max_results: 40,
    };
    if (q.manufacturer) params.manufacturer_filter = q.manufacturer;

    const { data, error } = await supabase.rpc("search_products_agent_fulltext", params);

    const ms = Math.round(performance.now() - t0);

    if (error) {
      return { query: q.query, label: q.label, hits: 0, ms, error: error.message };
    }

    return { query: q.query, label: q.label, hits: (data ?? []).length, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    return { query: q.query, label: q.label, hits: 0, ms, error: String(err) };
  }
}

// ── Percentil ────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
  return sorted[idx]!;
}

// ── Jeden round (N paralelních dotazů) ───────────────────

async function runRound(round: number, queries: typeof QUERIES): Promise<RoundStats> {
  const t0 = performance.now();
  const results = await Promise.all(queries.map(q => callRpc(q)));
  const totalMs = Math.round(performance.now() - t0);
  return { round, concurrency: queries.length, totalMs, results };
}

// ── Výpis výsledků kola ───────────────────────────────────

function printRound(stats: RoundStats) {
  const latencies = stats.results.map(r => r.ms).sort((a, b) => a - b);
  const errors = stats.results.filter(r => r.error);

  console.log(`\n  Round ${stats.round}: wall=${stats.totalMs}ms | p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${latencies[latencies.length - 1]}ms | errors=${errors.length}`);

  for (const r of stats.results) {
    const flag = r.error ? " ❌ ERROR" : r.ms > 500 ? " ⚠️  SLOW" : r.ms > 200 ? " 🔶" : "";
    const errStr = r.error ? ` [${r.error.slice(0, 60)}]` : "";
    console.log(`    ${String(r.ms).padStart(4)}ms  ${String(r.hits).padStart(3)} hits  ${r.label}${flag}${errStr}`);
  }
}

// ── Souhrnná statistika přes všechna kola ────────────────

function printSummary(allStats: RoundStats[]) {
  const allLatencies = allStats.flatMap(s => s.results.map(r => r.ms)).sort((a, b) => a - b);
  const allErrors = allStats.flatMap(s => s.results.filter(r => r.error));
  const totalQueries = allLatencies.length;

  console.log("\n" + "═".repeat(60));
  console.log("SOUHRN");
  console.log("═".repeat(60));
  console.log(`  Celkem dotazů:    ${totalQueries}`);
  console.log(`  Souběžnost:       ${CONCURRENCY} dotazů/kolo × ${ROUNDS} kol`);
  console.log(`  Chyby:            ${allErrors.length} / ${totalQueries}`);
  console.log(`  Latence:`);
  console.log(`    min:  ${allLatencies[0]}ms`);
  console.log(`    p50:  ${percentile(allLatencies, 50)}ms`);
  console.log(`    p75:  ${percentile(allLatencies, 75)}ms`);
  console.log(`    p90:  ${percentile(allLatencies, 90)}ms`);
  console.log(`    p95:  ${percentile(allLatencies, 95)}ms`);
  console.log(`    p99:  ${percentile(allLatencies, 99)}ms`);
  console.log(`    max:  ${allLatencies[allLatencies.length - 1]}ms`);
  console.log("═".repeat(60));

  // Posouzení
  const p95 = percentile(allLatencies, 95);
  const p99 = percentile(allLatencies, 99);
  if (allErrors.length > 0) {
    console.log(`\n⛔ KRITICKÉ: ${allErrors.length} chyb (timeouty nebo DB errory)`);
    for (const e of allErrors) console.log(`   - ${e.label}: ${e.error}`);
  } else if (p95 > 800) {
    console.log(`\n⚠️  POZOR: p95=${p95}ms — produkční latence bude pravděpodobně přes 1s pro agenty`);
    console.log("   Doporučení: přidat connection pool limit nebo optimalizovat RPC");
  } else if (p95 > 400) {
    console.log(`\n🔶 UPOZORNĚNÍ: p95=${p95}ms — na hraně, sledovat pod plnou zátěží agentů`);
  } else {
    console.log(`\n✅ OK: p95=${p95}ms, p99=${p99}ms — v cílovém rozsahu`);
  }
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("FULLTEXT LOAD TEST — search_products_agent_fulltext");
  console.log("═".repeat(60));
  console.log(`  Souběžnost: ${CONCURRENCY} dotazů zároveň`);
  console.log(`  Kol:        ${ROUNDS}`);
  console.log(`  Delay:      ${DELAY_MS}ms mezi koly`);
  console.log(`  Dotazy:     ${QUERIES.length} vzorových queries`);
  console.log("");

  // Pokud je concurrency > počet queries, opakujeme queries dokud nedosáhneme concurrency
  const buildBatch = (): typeof QUERIES => {
    const batch: typeof QUERIES = [];
    while (batch.length < CONCURRENCY) {
      batch.push(...QUERIES.slice(0, CONCURRENCY - batch.length));
    }
    return batch.slice(0, CONCURRENCY);
  };

  const allStats: RoundStats[] = [];

  // Warm-up kolo (nezapočítáváme do statistik)
  console.log("Warm-up...");
  await runRound(0, QUERIES.slice(0, 3));
  console.log("Warm-up done.\n");

  for (let round = 1; round <= ROUNDS; round++) {
    process.stdout.write(`  Kolo ${round}/${ROUNDS}...`);
    const batch = buildBatch();
    const stats = await runRound(round, batch);
    allStats.push(stats);
    printRound(stats);

    if (DELAY_MS > 0 && round < ROUNDS) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  printSummary(allStats);
}

main().catch(e => { console.error(e); process.exit(1); });
