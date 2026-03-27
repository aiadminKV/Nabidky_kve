/**
 * Search quality test against real demand data with expected SAP codes.
 *
 * Tests three layers:
 *   1. Exact lookup (SKU match) — does the SAP code exist in products_v2?
 *   2. Fulltext search — does the product name find the correct SAP code?
 *   3. Full pipeline (subset) — does the evaluator pick the right one?
 *
 * Usage: npx tsx scripts/test-search-quality.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface TestItem {
  name: string;
  unit: string | null;
  quantity: number | null;
  expectedSku: string;
  file: string;
}

// ── Query normalization (mirrors searchPipeline.ts) ──────

function normalizeQuery(raw: string): string {
  let q = raw;
  q = q.replace(/×/g, "x");
  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/(\d)\s*mm[²2]/gi, "$1");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

// ── Parse CSV files ──────────────────────────────────────

function parseCzechNumber(s: string): number | null {
  if (!s.trim()) return null;
  const cleaned = s.trim().replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseTestFiles(): TestItem[] {
  const items: TestItem[] = [];

  // popt1: název;mn;jednotka;kód SAP
  const popt1 = readFileSync(join(__dirname, "..", "test-data", "popt1.csv"), "utf-8");
  for (const line of popt1.split("\n").slice(1)) {
    const [name, mn, unit, sap] = line.split(";").map((s) => s.trim());
    if (!name || !sap) continue;
    const firstSap = sap.split("+")[0].trim();
    if (!firstSap || !/^\d+$/.test(firstSap)) continue;
    items.push({ name, unit: unit || null, quantity: parseCzechNumber(mn), expectedSku: firstSap, file: "popt1" });
  }

  // popt2: naz;mn;poc;sap
  const popt2 = readFileSync(join(__dirname, "..", "test-data", "popt2.csv"), "utf-8");
  for (const line of popt2.split("\n").slice(1)) {
    const parts = line.split(";").map((s) => s.replace(/^"|"$/g, "").trim());
    const [name, unit, qty, sap] = parts;
    if (!name || !sap) continue;
    const firstSap = sap.split("+")[0].trim();
    if (!firstSap || !/^\d+$/.test(firstSap)) continue;
    items.push({ name, unit: unit || null, quantity: parseCzechNumber(qty), expectedSku: firstSap, file: "popt2" });
  }

  // popt3: nam;mj;počet;sap
  const popt3 = readFileSync(join(__dirname, "..", "test-data", "popt3.csv"), "utf-8");
  for (const line of popt3.split("\n").slice(1)) {
    const parts = line.split(";").map((s) => s.replace(/^"|"$/g, "").trim());
    const [name, unit, qty, sap] = parts;
    if (!name || !sap) continue;
    const firstSap = sap.split("+")[0].trim();
    if (!firstSap || !/^\d+$/.test(firstSap)) continue;
    items.push({ name, unit: unit || null, quantity: parseCzechNumber(qty), expectedSku: firstSap, file: "popt3" });
  }

  return items;
}

// ── Test Layer 1: Do expected SKUs exist in DB? ─────────

async function testSkuExistence(sb: SupabaseClient, items: TestItem[]) {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("LAYER 1: SKU Existence Check");
  console.log("═══════════════════════════════════════════════════\n");

  const uniqueSkus = [...new Set(items.map((i) => i.expectedSku))];
  const { data, error } = await sb
    .from("products_v2")
    .select("sku, name")
    .in("sku", uniqueSkus);

  if (error) {
    console.error("  DB error:", error.message);
    return new Set<string>();
  }

  const foundSkus = new Set((data ?? []).map((r: { sku: string }) => r.sku));
  const missing = uniqueSkus.filter((s) => !foundSkus.has(s));

  console.log(`  Total unique SKUs: ${uniqueSkus.length}`);
  console.log(`  Found in DB: ${foundSkus.size}`);
  console.log(`  Missing: ${missing.length}`);
  if (missing.length > 0) {
    console.log("  Missing SKUs:");
    for (const sku of missing.slice(0, 20)) {
      const item = items.find((i) => i.expectedSku === sku);
      console.log(`    ${sku} — "${item?.name}"`);
    }
  }
  console.log(`  Existence rate: ${((foundSkus.size / uniqueSkus.length) * 100).toFixed(1)}%\n`);

  return foundSkus;
}

// ── Test Layer 2: Exact Lookup ──────────────────────────

async function testExactLookup(sb: SupabaseClient, items: TestItem[], existingSkus: Set<string>) {
  console.log("═══════════════════════════════════════════════════");
  console.log("LAYER 2: Exact Lookup (SAP code as query)");
  console.log("═══════════════════════════════════════════════════\n");

  const testable = items.filter((i) => existingSkus.has(i.expectedSku));
  const uniqueSkus = [...new Set(testable.map((i) => i.expectedSku))];
  let exactHit = 0;
  let exactMiss = 0;

  for (const sku of uniqueSkus) {
    const { data } = await sb.rpc("lookup_products_v2_exact", {
      lookup_query: sku,
      max_results: 5,
    });

    const foundSkus = (data ?? []).map((r: { sku: string }) => r.sku);
    if (foundSkus.includes(sku)) {
      exactHit++;
    } else {
      exactMiss++;
    }
  }

  console.log(`  Tested: ${uniqueSkus.length} unique SKUs`);
  console.log(`  Exact found: ${exactHit}`);
  console.log(`  Exact missed: ${exactMiss}`);
  console.log(`  Exact hit rate: ${((exactHit / uniqueSkus.length) * 100).toFixed(1)}%\n`);
}

// ── Test Layer 3: Fulltext Search ───────────────────────

async function testFulltext(sb: SupabaseClient, items: TestItem[], existingSkus: Set<string>) {
  console.log("═══════════════════════════════════════════════════");
  console.log("LAYER 3: Fulltext Search (product name → SKU)");
  console.log("  With query normalization + catalog term extraction");
  console.log("═══════════════════════════════════════════════════\n");

  const testable = items.filter((i) => existingSkus.has(i.expectedSku));
  let top1Hit = 0;
  let top5Hit = 0;
  let top20Hit = 0;
  let miss = 0;
  const misses: Array<{ name: string; expected: string; got: string[] }> = [];

  const BATCH = 5;
  for (let i = 0; i < testable.length; i += BATCH) {
    const batch = testable.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          const normalized = normalizeQuery(item.name);
          const { data } = await sb.rpc("search_products_v2_fulltext", {
            search_query: normalized,
            max_results: 20,
          });
          return { item, hits: (data ?? []) as Array<{ sku: string; name: string }> };
        } catch {
          return { item, hits: [] as Array<{ sku: string; name: string }> };
        }
      }),
    );

    for (const { item, hits } of batchResults) {
      const skus = hits.map((r) => r.sku);
      const pos = skus.indexOf(item.expectedSku);
      if (pos === 0) { top1Hit++; top5Hit++; top20Hit++; }
      else if (pos > 0 && pos < 5) { top5Hit++; top20Hit++; }
      else if (pos >= 5) { top20Hit++; }
      else {
        miss++;
        misses.push({
          name: item.name,
          expected: item.expectedSku,
          got: skus.slice(0, 3),
        });
      }
    }

    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH, testable.length)}/${testable.length}`);
  }

  console.log(`\r  Tested: ${testable.length} items`);
  console.log(`  Top-1 hit: ${top1Hit} (${((top1Hit / testable.length) * 100).toFixed(1)}%)`);
  console.log(`  Top-5 hit: ${top5Hit} (${((top5Hit / testable.length) * 100).toFixed(1)}%)`);
  console.log(`  Top-20 hit: ${top20Hit} (${((top20Hit / testable.length) * 100).toFixed(1)}%)`);
  console.log(`  Miss: ${miss} (${((miss / testable.length) * 100).toFixed(1)}%)`);

  if (misses.length > 0) {
    console.log(`\n  Fulltext misses (${misses.length} total, showing first 20):`);
    for (const m of misses.slice(0, 20)) {
      console.log(`    "${m.name.slice(0, 70)}" → exp: ${m.expected}, got: [${m.got.join(", ") || "none"}]`);
    }
  }
  console.log();
}

// ── Test Layer 4: Full Pipeline (sample) ────────────────

async function testFullPipeline(items: TestItem[], existingSkus: Set<string>) {
  console.log("═══════════════════════════════════════════════════");
  console.log("LAYER 4: Full Pipeline (LLM reform + fulltext + semantic + eval)");
  console.log("═══════════════════════════════════════════════════\n");

  let searchPipelineForItem: typeof import("../backend/src/services/searchPipeline.js").searchPipelineForItem;
  try {
    const mod = await import("../backend/src/services/searchPipeline.js");
    searchPipelineForItem = mod.searchPipelineForItem;
  } catch (e) {
    console.log(`  Cannot import pipeline: ${e instanceof Error ? e.message : e}\n`);
    return;
  }

  const testable = items.filter((i) => existingSkus.has(i.expectedSku));
  const sample = testable.slice(0, 30);

  let exactMatch = 0;
  let inCandidates = 0;
  let miss = 0;
  const details: Array<{
    name: string;
    expected: string;
    matchType: string;
    confidence: number;
    selectedSku: string | null;
    candidateSkus: string[];
    found: string;
  }> = [];

  for (let i = 0; i < sample.length; i++) {
    const item = sample[i];
    try {
      const result = await searchPipelineForItem(
        { name: item.name, unit: item.unit, quantity: item.quantity },
        i,
      );

      const selectedSku = result.product?.sku ?? null;
      const candidateSkus = result.candidates.map((c) => c.sku!).filter(Boolean);
      const allSkus = [selectedSku, ...candidateSkus].filter(Boolean) as string[];

      let found: string;
      if (selectedSku === item.expectedSku) {
        exactMatch++;
        inCandidates++;
        found = "SELECTED";
      } else if (allSkus.includes(item.expectedSku)) {
        inCandidates++;
        found = "IN_CANDIDATES";
      } else {
        miss++;
        found = "MISS";
      }

      details.push({
        name: item.name,
        expected: item.expectedSku,
        matchType: result.matchType,
        confidence: result.confidence,
        selectedSku,
        candidateSkus,
        found,
      });
    } catch (err) {
      miss++;
      details.push({
        name: item.name,
        expected: item.expectedSku,
        matchType: "error",
        confidence: 0,
        selectedSku: null,
        candidateSkus: [],
        found: "ERROR",
      });
    }
    process.stdout.write(`\r  Progress: ${i + 1}/${sample.length}`);
  }

  console.log(`\r  Tested: ${sample.length} items (first 30)`);
  console.log(`  Selected = expected: ${exactMatch} (${((exactMatch / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  Expected in candidates: ${inCandidates} (${((inCandidates / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  Miss: ${miss} (${((miss / sample.length) * 100).toFixed(1)}%)`);

  console.log("\n  Detail:");
  for (const d of details) {
    const icon = d.found === "SELECTED" ? "✓" : d.found === "IN_CANDIDATES" ? "~" : "✗";
    const extra = d.found === "MISS"
      ? ` sel:${d.selectedSku ?? "none"} cands:[${d.candidateSkus.slice(0, 3).join(",")}]`
      : "";
    console.log(`    ${icon} [${d.matchType} ${d.confidence}%] "${d.name.slice(0, 55)}" exp:${d.expected}${extra}`);
  }
  console.log();
}

// ── Test Layer 5: Pipeline with Planning Agent ─────────

interface PipelineDetail {
  name: string;
  expected: string;
  matchType: string;
  confidence: number;
  selectedSku: string | null;
  selectedName: string | null;
  selectedPrice: number | null;
  candidateSkus: string[];
  found: string;
  reasoning: string;
  group: string | null;
  instruction: string | null;
}

async function runPipelineTest(
  label: string,
  items: TestItem[],
  existingSkus: Set<string>,
  opts: {
    usePlanner: boolean;
    preferences?: import("../backend/src/services/searchPipeline.js").SearchPreferences;
    sampleSize?: number;
  },
): Promise<PipelineDetail[]> {
  let searchPipelineForItem: typeof import("../backend/src/services/searchPipeline.js").searchPipelineForItem;
  let createSearchPlan: typeof import("../backend/src/services/searchPipeline.js").createSearchPlan;
  try {
    const mod = await import("../backend/src/services/searchPipeline.js");
    searchPipelineForItem = mod.searchPipelineForItem;
    createSearchPlan = mod.createSearchPlan;
  } catch (e) {
    console.log(`  Cannot import pipeline: ${e instanceof Error ? e.message : e}\n`);
    return [];
  }

  const testable = items.filter((i) => existingSkus.has(i.expectedSku));
  const sample = testable.slice(0, opts.sampleSize ?? 30);

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`${label}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  type EnrichedItem = { name: string; unit: string | null; quantity: number | null; instruction: string | null; groupName: string | null };
  let enrichedSample: EnrichedItem[];

  if (opts.usePlanner) {
    console.log(`  Running Planning Agent on ${sample.length} items...`);
    const t0 = Date.now();
    const plan = await createSearchPlan(
      sample.map((it) => ({ name: it.name, unit: it.unit, quantity: it.quantity })),
      opts.preferences,
    );
    console.log(`  Plan created in ${Date.now() - t0}ms — ${plan.groups.length} groups:`);
    for (const g of plan.groups) {
      const itemCount = g.itemIndices.length;
      console.log(`    [${g.groupName}] ${itemCount} items, mfr: ${g.suggestedManufacturer ?? "—"}, line: ${g.suggestedLine ?? "—"}`);
    }
    console.log();

    enrichedSample = sample.map((item, i) => {
      const enriched = plan.enrichedItems[i];
      const groupIdx = enriched?.groupIndex ?? 0;
      const group = plan.groups[groupIdx];
      return {
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        instruction: enriched?.instruction ?? null,
        groupName: group?.groupName ?? null,
      };
    });
  } else {
    enrichedSample = sample.map((item) => ({
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      instruction: null,
      groupName: null,
    }));
  }

  let exactMatch = 0;
  let inCandidates = 0;
  let miss = 0;
  const details: PipelineDetail[] = [];

  for (let i = 0; i < sample.length; i++) {
    const item = sample[i];
    const enriched = enrichedSample[i];
    try {
      const result = await searchPipelineForItem(
        { name: enriched.name, unit: enriched.unit, quantity: enriched.quantity, instruction: enriched.instruction },
        i,
        undefined,
        opts.preferences,
      );

      const selectedSku = result.product?.sku ?? null;
      const candidateSkus = result.candidates.map((c) => c.sku!).filter(Boolean);
      const allSkus = [selectedSku, ...candidateSkus].filter(Boolean) as string[];

      let found: string;
      if (selectedSku === item.expectedSku) {
        exactMatch++;
        inCandidates++;
        found = "SELECTED";
      } else if (allSkus.includes(item.expectedSku)) {
        inCandidates++;
        found = "IN_CANDIDATES";
      } else {
        miss++;
        found = "MISS";
      }

      details.push({
        name: item.name,
        expected: item.expectedSku,
        matchType: result.matchType,
        confidence: result.confidence,
        selectedSku,
        selectedName: result.product?.name ?? null,
        selectedPrice: (result.product as Record<string, unknown>)?.current_price as number | null ?? null,
        candidateSkus,
        found,
        reasoning: result.reasoning,
        group: enriched.groupName,
        instruction: enriched.instruction,
      });
    } catch (err) {
      miss++;
      details.push({
        name: item.name,
        expected: item.expectedSku,
        matchType: "error",
        confidence: 0,
        selectedSku: null,
        selectedName: null,
        selectedPrice: null,
        candidateSkus: [],
        found: "ERROR",
        reasoning: err instanceof Error ? err.message : "unknown",
        group: enriched.groupName,
        instruction: enriched.instruction,
      });
    }
    process.stdout.write(`\r  Progress: ${i + 1}/${sample.length}`);
  }

  console.log(`\r  Tested: ${sample.length} items`);
  console.log(`  Selected = expected: ${exactMatch} (${((exactMatch / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  Expected in candidates: ${inCandidates} (${((inCandidates / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  Miss: ${miss} (${((miss / sample.length) * 100).toFixed(1)}%)`);

  const confByType: Record<string, number[]> = {};
  for (const d of details) {
    (confByType[d.matchType] ??= []).push(d.confidence);
  }
  console.log(`\n  Confidence distribution:`);
  for (const [mt, confs] of Object.entries(confByType)) {
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    console.log(`    ${mt}: ${confs.length}x, avg confidence ${avg.toFixed(0)}%`);
  }

  console.log(`\n  Detail:`);
  for (const d of details) {
    const icon = d.found === "SELECTED" ? "✓" : d.found === "IN_CANDIDATES" ? "~" : "✗";
    const groupTag = d.group ? ` [${d.group}]` : "";
    const instrTag = d.instruction ? ` instr:"${d.instruction.slice(0, 40)}"` : "";
    const priceTag = d.selectedPrice != null ? ` ${d.selectedPrice}Kč` : "";
    const extra = d.found === "MISS"
      ? ` sel:${d.selectedSku ?? "none"}${priceTag} cands:[${d.candidateSkus.slice(0, 3).join(",")}]`
      : priceTag;
    console.log(`    ${icon} [${d.matchType} ${d.confidence}%] "${d.name.slice(0, 50)}" exp:${d.expected}${extra}${groupTag}${instrTag}`);
  }
  console.log();

  return details;
}

function compareLayers(label: string, baseline: PipelineDetail[], variant: PipelineDetail[]) {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`COMPARISON: ${label}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  const bSel = baseline.filter((d) => d.found === "SELECTED").length;
  const bCand = baseline.filter((d) => d.found !== "MISS" && d.found !== "ERROR").length;
  const bMiss = baseline.filter((d) => d.found === "MISS" || d.found === "ERROR").length;
  const vSel = variant.filter((d) => d.found === "SELECTED").length;
  const vCand = variant.filter((d) => d.found !== "MISS" && d.found !== "ERROR").length;
  const vMiss = variant.filter((d) => d.found === "MISS" || d.found === "ERROR").length;

  console.log(`  Metric              | Baseline | Variant  | Delta`);
  console.log(`  --------------------|----------|----------|------`);
  console.log(`  Selected=expected   | ${String(bSel).padStart(8)} | ${String(vSel).padStart(8)} | ${vSel - bSel >= 0 ? "+" : ""}${vSel - bSel}`);
  console.log(`  In candidates       | ${String(bCand).padStart(8)} | ${String(vCand).padStart(8)} | ${vCand - bCand >= 0 ? "+" : ""}${vCand - bCand}`);
  console.log(`  Miss                | ${String(bMiss).padStart(8)} | ${String(vMiss).padStart(8)} | ${vMiss - bMiss >= 0 ? "+" : ""}${vMiss - bMiss}`);

  const improved: string[] = [];
  const regressed: string[] = [];
  const priceDiffs: string[] = [];

  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const v = variant[i];
    if (!b || !v) continue;

    const bScore = b.found === "SELECTED" ? 2 : b.found === "IN_CANDIDATES" ? 1 : 0;
    const vScore = v.found === "SELECTED" ? 2 : v.found === "IN_CANDIDATES" ? 1 : 0;

    if (vScore > bScore) {
      improved.push(`  + "${b.name.slice(0, 50)}" ${b.found} → ${v.found}`);
    } else if (vScore < bScore) {
      regressed.push(`  - "${b.name.slice(0, 50)}" ${b.found} → ${v.found}`);
    }

    if (b.selectedSku !== v.selectedSku && b.selectedPrice != null && v.selectedPrice != null) {
      const diff = v.selectedPrice - b.selectedPrice;
      priceDiffs.push(`  "${b.name.slice(0, 40)}" ${b.selectedPrice}Kč → ${v.selectedPrice}Kč (${diff >= 0 ? "+" : ""}${diff.toFixed(0)})`);
    }
  }

  if (improved.length > 0) {
    console.log(`\n  Improved (${improved.length}):`);
    for (const line of improved) console.log(line);
  }
  if (regressed.length > 0) {
    console.log(`\n  Regressed (${regressed.length}):`);
    for (const line of regressed) console.log(line);
  }
  if (priceDiffs.length > 0) {
    console.log(`\n  Price differences (${priceDiffs.length}):`);
    for (const line of priceDiffs.slice(0, 15)) console.log(line);
  }
  console.log();
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log("\n--- Search Quality Test — KV Offer Manager ---");
  console.log("Testing against popt1.csv, popt2.csv, popt3.csv\n");

  await sb.from("products_v2").select("id").limit(1);

  const items = parseTestFiles();
  console.log(`Parsed ${items.length} test items total:`);
  const byFile: Record<string, number> = {};
  for (const i of items) byFile[i.file] = (byFile[i.file] ?? 0) + 1;
  for (const [file, count] of Object.entries(byFile)) {
    console.log(`  ${file}: ${count} items`);
  }

  // Layer 1: SKU existence
  const existingSkus = await testSkuExistence(sb, items);

  // Layer 2: Exact lookup
  await testExactLookup(sb, items, existingSkus);

  // Layer 3: Fulltext (normalized)
  await testFulltext(sb, items, existingSkus);

  // Layer 4: Full Pipeline (no planner, no preferences) — BASELINE
  const layer4 = await runPipelineTest(
    "LAYER 4: Pipeline WITHOUT Planner (baseline)",
    items,
    existingSkus,
    { usePlanner: false, sampleSize: 30 },
  );

  // Layer 5: Full Pipeline WITH Planning Agent
  const layer5 = await runPipelineTest(
    "LAYER 5: Pipeline WITH Planning Agent",
    items,
    existingSkus,
    { usePlanner: true, sampleSize: 30 },
  );

  // Comparison: Layer 4 vs Layer 5
  if (layer4.length > 0 && layer5.length > 0) {
    compareLayers("No Planner vs With Planner", layer4, layer5);
  }

  // Layer 6a: Pipeline + Planner + VYBERKO preferences
  const vyberkoPrefs: import("../backend/src/services/searchPipeline.js").SearchPreferences = {
    offerType: "vyberko",
    stockFilter: "any",
    branchFilter: null,
    priceStrategy: "lowest",
  };
  const layer6v = await runPipelineTest(
    "LAYER 6a: Pipeline + Planner + VYBERKO",
    items,
    existingSkus,
    { usePlanner: true, preferences: vyberkoPrefs, sampleSize: 30 },
  );

  // Layer 6b: Pipeline + Planner + REALIZACE preferences
  const realizacePrefs: import("../backend/src/services/searchPipeline.js").SearchPreferences = {
    offerType: "realizace",
    stockFilter: "any",
    branchFilter: null,
    priceStrategy: "standard",
  };
  const layer6r = await runPipelineTest(
    "LAYER 6b: Pipeline + Planner + REALIZACE",
    items,
    existingSkus,
    { usePlanner: true, preferences: realizacePrefs, sampleSize: 30 },
  );

  // Comparison: Výběrko vs Realizace
  if (layer6v.length > 0 && layer6r.length > 0) {
    compareLayers("VYBERKO vs REALIZACE", layer6v, layer6r);
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("Done. Review results above to identify weak spots.");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
