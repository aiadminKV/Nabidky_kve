/**
 * Diverse offer pipeline test — realistic mixed-category offer.
 *
 * Tests planning + search pipeline on a complex offer with:
 * jističe, svítidla, zásuvky, vypínače, kabely, vodiče, svorky, rozvodnice...
 *
 * No expected SKUs — evaluates pipeline behavior:
 *   - Planner grouping quality
 *   - Evaluator confidence and match types
 *   - VÝBĚRKO vs REALIZACE price/supplier differences
 *
 * Usage: npx tsx scripts/test-diverse-offer.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

interface OfferItem {
  name: string;
  unit: string;
  quantity: number;
}

const OFFER_ITEMS: OfferItem[] = [
  { name: "rozvodnice RK - úprava zapojení stávající", unit: "ks", quantity: 1 },
  { name: "Jistič B3x16", unit: "ks", quantity: 2 },
  { name: "Jistič B1x16", unit: "ks", quantity: 1 },
  { name: "Proudový chránič s nadproudovou ochranou 0,03A/InB1x10A", unit: "ks", quantity: 2 },
  { name: "Napěťová spoušť", unit: "ks", quantity: 1 },
  { name: "svítidlo čtvercové 23,1W 2850 lm LED IP 54", unit: "ks", quantity: 32 },
  { name: "svítidlo lineární 38,4W 5350 lm LED IP 54", unit: "ks", quantity: 5 },
  { name: "svítidlo lineární 52,8W 7360 lm LED IP 54", unit: "ks", quantity: 1 },
  { name: "Svítidlo nouzové s vlastní baterií/m zdrojem (záloha 30 minut)", unit: "ks", quantity: 16 },
  { name: "Vypínač (řazení 6)", unit: "ks", quantity: 4 },
  { name: "Vypínač IP 44 (řazení 1)", unit: "ks", quantity: 4 },
  { name: "Vypínač IP 44 (řazení 6)", unit: "ks", quantity: 8 },
  { name: "Tlačítko bezpečnostní s omezeným přístupem", unit: "ks", quantity: 1 },
  { name: "Zásuvka 230V/16A dvounásobná", unit: "ks", quantity: 2 },
  { name: "Zásuvka 230V/16A IP44", unit: "ks", quantity: 28 },
  { name: "Zásuvka 400V/16A IP44", unit: "ks", quantity: 1 },
  { name: "Vypínač 3F/25A", unit: "ks", quantity: 2 },
  { name: "Krabice KO8", unit: "ks", quantity: 80 },
  { name: "Svorka WAGO", unit: "ks", quantity: 60 },
  { name: "Vývod 3f (připojení gastro zařízení VZT, chlazení)", unit: "ks", quantity: 4 },
  { name: "Vývod 1f (připojení digestoře)", unit: "ks", quantity: 1 },
  { name: "Svorkovnice v MET v krabici", unit: "ks", quantity: 1 },
  { name: "Ochranné pospojení (vývod)", unit: "ks", quantity: 9 },
  { name: "Svorka BERNARD vč. pásku CU", unit: "ks", quantity: 20 },
  { name: "Vodič CY 10", unit: "m", quantity: 5 },
  { name: "Vodič CY 4", unit: "m", quantity: 100 },
  { name: "Kabel CYKY 3x1,5", unit: "m", quantity: 350 },
  { name: "Kabel CYKY 3x2,5", unit: "m", quantity: 250 },
  { name: "Kabel CYKY 5x2,5", unit: "m", quantity: 120 },
  { name: "Kabel CYKY 5x4", unit: "m", quantity: 80 },
  { name: "Kabel CYKY 2x1,5", unit: "m", quantity: 20 },
  { name: "Kabel UTP cat5", unit: "m", quantity: 100 },
  { name: "Kabel CGSG J5x2,5", unit: "m", quantity: 20 },
];

type SearchPreferences = import("../backend/src/services/searchPipeline.js").SearchPreferences;
type PipelineResult = import("../backend/src/services/searchPipeline.js").PipelineResult;
type SearchPlan = import("../backend/src/services/searchPipeline.js").SearchPlan;

interface RunResult {
  label: string;
  plan: SearchPlan | null;
  results: PipelineResult[];
  totalMs: number;
}

async function runPipeline(
  label: string,
  items: OfferItem[],
  opts: { usePlanner: boolean; preferences?: SearchPreferences },
): Promise<RunResult> {
  const { searchPipelineForItem, createSearchPlan } = await import(
    "../backend/src/services/searchPipeline.js"
  );

  console.log(`\n${"═".repeat(60)}`);
  console.log(label);
  console.log(`${"═".repeat(60)}\n`);

  let plan: SearchPlan | null = null;
  type EnrichedItem = OfferItem & { instruction: string | null; groupName: string | null };
  let enriched: EnrichedItem[];

  if (opts.usePlanner) {
    console.log(`  Planning ${items.length} items...`);
    const t0 = Date.now();
    plan = await createSearchPlan(
      items.map((it) => ({ name: it.name, unit: it.unit, quantity: it.quantity })),
      opts.preferences,
    );
    console.log(`  Plan: ${plan.groups.length} groups (${Date.now() - t0}ms)\n`);
    for (const g of plan.groups) {
      const cnt = g.itemIndices.length;
      const names = g.itemIndices.slice(0, 3).map((i) => items[i]?.name.slice(0, 30));
      console.log(`    [${g.groupName}] ${cnt} items, mfr: ${g.suggestedManufacturer ?? "—"}, line: ${g.suggestedLine ?? "—"}`);
      console.log(`      e.g. ${names.join(", ")}${cnt > 3 ? ", ..." : ""}`);
    }
    console.log();

    enriched = items.map((item, i) => {
      const e = plan!.enrichedItems[i];
      const gIdx = e?.groupIndex ?? 0;
      const group = plan!.groups[gIdx];
      return { ...item, instruction: e?.instruction ?? null, groupName: group?.groupName ?? null };
    });
  } else {
    enriched = items.map((item) => ({ ...item, instruction: null, groupName: null }));
  }

  const results: PipelineResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < enriched.length; i++) {
    const item = enriched[i];
    try {
      const result = await searchPipelineForItem(
        { name: item.name, unit: item.unit, quantity: item.quantity, instruction: item.instruction },
        i,
        undefined,
        opts.preferences,
      );
      results.push(result);
    } catch {
      results.push({
        position: i,
        originalName: item.name,
        unit: item.unit,
        quantity: item.quantity,
        matchType: "not_found",
        confidence: 0,
        product: null,
        candidates: [],
        reasoning: "Pipeline error",
        reformulatedQuery: "",
        pipelineMs: 0,
      });
    }
    process.stdout.write(`\r  Progress: ${i + 1}/${enriched.length}`);
  }
  const totalMs = Date.now() - t0;

  // Summary
  const matchCounts: Record<string, number> = {};
  const confSum: Record<string, number> = {};
  let found = 0;
  let notFound = 0;

  for (const r of results) {
    matchCounts[r.matchType] = (matchCounts[r.matchType] ?? 0) + 1;
    confSum[r.matchType] = (confSum[r.matchType] ?? 0) + r.confidence;
    if (r.product) found++;
    else notFound++;
  }

  console.log(`\r  Done: ${results.length} items in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Found product: ${found}/${results.length} (${((found / results.length) * 100).toFixed(0)}%)`);
  console.log(`  Not found: ${notFound}/${results.length}\n`);

  console.log("  matchType distribution:");
  for (const [mt, cnt] of Object.entries(matchCounts)) {
    const avg = confSum[mt]! / cnt;
    console.log(`    ${mt}: ${cnt}x (avg conf ${avg.toFixed(0)}%)`);
  }

  // Detail table
  console.log("\n  Detail:");
  console.log("  " + "-".repeat(120));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const item = enriched[i];
    const price = r.product?.current_price != null ? `${(r.product as Record<string, unknown>).current_price}Kč` : "—";
    const supplier = r.product?.supplier_name?.slice(0, 15) ?? "—";
    const prodName = r.product?.name?.slice(0, 40) ?? "—";
    const groupTag = item.groupName ? `[${item.groupName}]` : "";
    const icon = r.matchType === "match" ? "✓" : r.matchType === "not_found" ? "✗" : "~";

    console.log(
      `  ${icon} ${String(r.confidence).padStart(3)}% ${r.matchType.padEnd(11)} ` +
      `"${item.name.slice(0, 45).padEnd(45)}" → ${prodName.padEnd(40)} ${price.padStart(10)} ${supplier.padStart(15)} ${groupTag}`,
    );
  }
  console.log();

  return { label, plan, results, totalMs };
}

function compareRuns(a: RunResult, b: RunResult) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`COMPARISON: ${a.label} vs ${b.label}`);
  console.log(`${"═".repeat(60)}\n`);

  let sameSku = 0;
  let diffSku = 0;
  const diffs: string[] = [];
  const priceDiffs: Array<{ name: string; priceA: number; priceB: number }> = [];

  for (let i = 0; i < a.results.length; i++) {
    const ra = a.results[i];
    const rb = b.results[i];
    if (!ra || !rb) continue;

    const skuA = ra.product?.sku ?? null;
    const skuB = rb.product?.sku ?? null;
    const priceA = (ra.product as Record<string, unknown>)?.current_price as number | null ?? null;
    const priceB = (rb.product as Record<string, unknown>)?.current_price as number | null ?? null;

    if (skuA === skuB) {
      sameSku++;
    } else {
      diffSku++;
      const nameA = ra.product?.name?.slice(0, 35) ?? "none";
      const nameB = rb.product?.name?.slice(0, 35) ?? "none";
      diffs.push(`  "${ra.originalName.slice(0, 40)}": ${nameA} → ${nameB}`);
    }

    if (priceA != null && priceB != null && skuA !== skuB) {
      priceDiffs.push({ name: ra.originalName, priceA, priceB });
    }
  }

  console.log(`  Same product selected: ${sameSku}/${a.results.length}`);
  console.log(`  Different product: ${diffSku}/${a.results.length}\n`);

  if (diffs.length > 0) {
    console.log(`  Product differences (${diffs.length}):`);
    for (const d of diffs.slice(0, 20)) console.log(d);
  }

  if (priceDiffs.length > 0) {
    console.log(`\n  Price diffs where product differs:`);
    for (const pd of priceDiffs.slice(0, 15)) {
      const delta = pd.priceB - pd.priceA;
      console.log(`    "${pd.name.slice(0, 40)}": ${pd.priceA}Kč → ${pd.priceB}Kč (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);
    }
  }
  console.log();
}

async function main() {
  console.log("\n--- Diverse Offer Pipeline Test ---");
  console.log(`${OFFER_ITEMS.length} items: jističe, svítidla, zásuvky, vypínače, kabely, vodiče, svorky...\n`);

  // Run 1: No planner (baseline)
  const baseline = await runPipeline("RUN 1: Pipeline WITHOUT Planner (baseline)", OFFER_ITEMS, {
    usePlanner: false,
  });

  // Run 2: With planner
  const withPlanner = await runPipeline("RUN 2: Pipeline WITH Planner", OFFER_ITEMS, {
    usePlanner: true,
  });

  // Run 3: Planner + VÝBĚRKO
  const vyberko = await runPipeline("RUN 3: Planner + VÝBĚRKO", OFFER_ITEMS, {
    usePlanner: true,
    preferences: { offerType: "vyberko", stockFilter: "any", branchFilter: null, priceStrategy: "lowest" },
  });

  // Run 4: Planner + REALIZACE
  const realizace = await runPipeline("RUN 4: Planner + REALIZACE", OFFER_ITEMS, {
    usePlanner: true,
    preferences: { offerType: "realizace", stockFilter: "any", branchFilter: null, priceStrategy: "standard" },
  });

  // Comparisons
  compareRuns(baseline, withPlanner);
  compareRuns(vyberko, realizace);

  console.log("═".repeat(60));
  console.log("Done.");
  console.log("═".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
