/**
 * Model Cost Comparison: GPT-4.1 vs GPT-5-mini
 *
 * Tests both models on the same set of items to compare:
 *   - Quality (matchType, confidence, selected product)
 *   - Token usage (input, output, reasoning)
 *   - Cost per item & projected cost per offer
 *   - Latency
 *
 * Usage: npx tsx scripts/test-model-cost.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
  type ProductResult,
} from "../backend/src/services/search.js";
import { generateQueryEmbedding } from "../backend/src/services/embedding.js";

// ── Config ─────────────────────────────────────────────────

const MODELS = ["gpt-4.1", "gpt-5-mini"] as const;
type ModelId = (typeof MODELS)[number];

const PRICING: Record<ModelId, { input: number; output: number }> = {
  "gpt-4.1":    { input: 2.00, output: 8.00 },   // $/1M tokens
  "gpt-5-mini": { input: 0.25, output: 2.00 },
};

const MAX_FT = 30;
const MAX_SEM = 50;
const SIM_THRESH = 0.35;

function openai(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

// ── Types ──────────────────────────────────────────────────

interface OfferItem {
  name: string;
  unit: string;
  quantity: number;
}

interface MergedCandidate extends ProductResult {
  cosine_similarity: number;
  source: "raw" | "reformulated" | "fulltext" | "exact" | "both";
}

interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  total: number;
}

interface ModelCallResult {
  model: ModelId;
  step: string;
  result: string;
  parsedJson?: Record<string, unknown>;
  tokens: TokenUsage;
  costUsd: number;
  latencyMs: number;
}

// ── Test Items (subset of diverse offer) ───────────────────

const TEST_ITEMS: OfferItem[] = [
  { name: "Jistič B3x16", unit: "ks", quantity: 2 },
  { name: "svítidlo čtvercové 23,1W 2850 lm LED IP 54", unit: "ks", quantity: 32 },
  { name: "Zásuvka 230V/16A IP44", unit: "ks", quantity: 28 },
  { name: "Kabel CYKY 3x2,5", unit: "m", quantity: 250 },
  { name: "Vodič CY 10", unit: "m", quantity: 5 },
  { name: "Krabice KO8", unit: "ks", quantity: 80 },
  { name: "Proudový chránič s nadproudovou ochranou 0,03A/InB1x10A", unit: "ks", quantity: 2 },
  { name: "Kabel UTP cat5", unit: "m", quantity: 100 },
];

// ── Prompts ────────────────────────────────────────────────

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do formy, která nejlépe odpovídá českému B2B katalogu elektroinstalačního materiálu (KV Elektro).

## PRAVIDLA
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext
2. Pokud zkratce NEROZUMÍŠ, ponech originální text
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny
4. Používej × místo x u průřezů kabelů
5. Přidej i katalogový styl názvu

## PŘÍKLADY
- "jistič 1-pólový 16 A B" → "JISTIC PL6-B16/1 jistič jednopólový 16A charakteristika B"
- "kabel instalační ... (CYKY) 3x1,5mm2" → "KABEL 1-CYKY-J 3x1,5 CYKY kabel instalační 3×1,5"
- "Vodič CY 6" → "VODIC H07V-U 1x6 CY vodič 6mm2 jednodrátový"

Vrať plain text — jen přeformulovaný název.`;

const MATCHER_PROMPT = `Jsi expert na párování elektroinstalačních produktů. Tvůj JEDINÝ úkol: najít kandidáty, kteří odpovídají hledanému produktu TYPEM a PARAMETRY.

NEHODNOTÍŠ cenu, sklad, výrobce, dostupnost. Hodnotíš POUZE:
1. Je to STEJNÝ TYP produktu?
2. Sedí KLÍČOVÉ PARAMETRY?

## Postup
1. Urči TYP produktu z poptávky.
2. Projdi kandidáty a vyřaď všechny jiného typu.
3. U zbylých ověř shodu klíčových parametrů.
4. Vrať SHORTLIST max 8 nejlepších.

## POZOR — běžné záměny
- jistič ≠ pojistka, CY ≠ CYA, CYKY ≠ CXKH, UTP ≠ FTP, -J ≠ -O

## matchScore
- 90-100: PŘESNÁ shoda typu + všech parametrů
- 70-89: Typ sedí, většina parametrů
- 50-69: Typ sedí, parametry se liší
- <50: Nezařazuj

Vrať VÝHRADNĚ JSON:
{
  "shortlist": [{ "sku": "...", "matchScore": 95, "paramMatch": "full", "reasoning": "1 věta" }],
  "bestMatchType": "match" | "uncertain" | "not_found",
  "reasoning": "1 věta česky"
}`;

const SELECTOR_PROMPT = `Jsi obchodní rozhodovatel pro elektroinstalační nabídky. Dostaneš SHORTLIST produktů, které již prošly produktovou shodou. Vyber NEJLEPŠÍ variantu podle obchodních pravidel.

## Pravidla pro REALIZACI
1. Skladem (has_stock = true) → silně preferuj
2. Preferovaný výrobce → preferuj POUZE pokud cena ≤ 2× nejlevnější
3. Cena > 3× nejlevnější → NEVYBER, vyber levnější
4. Při rovných volbách → nižší cena

Vrať VÝHRADNĚ JSON:
{
  "selectedSku": "SKU nebo null",
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "reasoning": "1-2 věty česky",
  "priceNote": "varování o ceně nebo null"
}`;

// ── Search helpers ─────────────────────────────────────────

function normalizeQuery(raw: string): string {
  let q = raw;
  q = q.replace(/×/g, "x");
  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/(\d)\s*mm[²2]/gi, "$1");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

const EXACT_COSINE: Record<string, number> = { sku: 1.0, ean: 0.98, manufacturer_code: 0.95 };

async function searchAndMerge(name: string, reformulated: string): Promise<MergedCandidate[]> {
  const normalized = normalizeQuery(name);
  const [rawEmb, refEmb, ftOrig, ftRef, exactRes] = await Promise.all([
    generateQueryEmbedding(normalized),
    generateQueryEmbedding(reformulated),
    searchProductsFulltext(normalized, MAX_FT).catch(() => [] as FulltextResult[]),
    searchProductsFulltext(reformulated, MAX_FT).catch(() => [] as FulltextResult[]),
    lookupProductsExact(normalized, 10).catch(() => [] as ExactResult[]),
  ]);

  const ftMap = new Map<string, FulltextResult>();
  for (const r of ftOrig) ftMap.set(r.sku, r);
  for (const r of ftRef) {
    const ex = ftMap.get(r.sku);
    if (!ex || (r.rank ?? 0) > (ex.rank ?? 0)) ftMap.set(r.sku, r);
  }

  const [rawSem, refSem] = await Promise.all([
    searchProductsSemantic(rawEmb, MAX_SEM, SIM_THRESH),
    searchProductsSemantic(refEmb, MAX_SEM, SIM_THRESH),
  ]);

  const map = new Map<string, MergedCandidate>();
  for (const r of rawSem) map.set(r.sku, { ...r, source: "raw" });
  for (const r of refSem) {
    const ex = map.get(r.sku);
    if (ex) {
      if (r.cosine_similarity > ex.cosine_similarity) ex.cosine_similarity = r.cosine_similarity;
      ex.source = "both";
    } else {
      map.set(r.sku, { ...r, source: "reformulated" });
    }
  }

  for (const r of ftMap.values()) {
    if (!map.has(r.sku)) {
      map.set(r.sku, {
        ...r,
        cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
        source: "fulltext",
      });
    }
  }

  for (const r of exactRes) {
    if (!map.has(r.sku)) {
      map.set(r.sku, {
        ...r,
        cosine_similarity: EXACT_COSINE[r.match_type] ?? 0.95,
        source: "exact",
      });
    }
  }

  return [...map.values()].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
}

// ── Model call wrapper with token tracking ─────────────────

function extractTokens(usage: OpenAI.CompletionUsage | undefined): TokenUsage {
  if (!usage) return { input: 0, output: 0, reasoning: 0, total: 0 };
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const reasoning = (usage as Record<string, unknown>).completion_tokens_details
    ? ((usage as Record<string, unknown>).completion_tokens_details as Record<string, number>)?.reasoning_tokens ?? 0
    : 0;
  return { input, output, reasoning, total: input + output };
}

function calcCost(model: ModelId, tokens: TokenUsage): number {
  const p = PRICING[model];
  return (tokens.input * p.input + tokens.output * p.output) / 1_000_000;
}

async function callModel(
  model: ModelId,
  step: string,
  systemPrompt: string,
  userContent: string,
  jsonMode: boolean = false,
  maxTokens: number = 500,
): Promise<ModelCallResult> {
  const t0 = Date.now();

  const params: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  if (model === "gpt-5-mini") {
    params.max_completion_tokens = maxTokens;
    params.reasoning_effort = "minimal";
  } else {
    params.temperature = 0.1;
    params.max_tokens = maxTokens;
  }

  if (jsonMode) params.response_format = { type: "json_object" };

  const res = await openai().chat.completions.create(params as OpenAI.ChatCompletionCreateParamsNonStreaming);
  const latencyMs = Date.now() - t0;
  const content = res.choices[0]?.message?.content ?? "";
  const tokens = extractTokens(res.usage);
  const costUsd = calcCost(model, tokens);

  let parsedJson: Record<string, unknown> | undefined;
  if (jsonMode) {
    try { parsedJson = JSON.parse(content); } catch { /* skip */ }
  }

  return { model, step, result: content, parsedJson, tokens, costUsd, latencyMs };
}

// ── Run comparison ─────────────────────────────────────────

interface ItemComparison {
  itemName: string;
  candidateCount: number;
  models: Record<ModelId, {
    reformResult: string;
    matcherResult: Record<string, unknown> | undefined;
    selectorResult: Record<string, unknown> | undefined;
    selectedProduct: string | null;
    selectedPrice: number | null;
    matchType: string;
    confidence: number;
    totalTokens: TokenUsage;
    totalCost: number;
    totalLatency: number;
  }>;
}

async function runItemComparison(item: OfferItem): Promise<ItemComparison> {
  // First, get reformulation with GPT-4.1 (shared — same candidates for both)
  const reformRes = await callModel("gpt-4.1", "reform", REFORM_PROMPT, item.name, false, 200);
  const reformulated = reformRes.result.trim() || item.name;

  // Fetch candidates once (shared)
  const candidates = await searchAndMerge(item.name, reformulated);

  const top20 = candidates.slice(0, 20).map((c) => ({
    sku: c.sku, name: c.name, unit: c.unit,
    current_price: c.current_price,
    supplier_name: c.supplier_name,
    category_sub: c.category_sub,
    is_stock_item: c.is_stock_item,
    has_stock: c.has_stock,
    similarity: Math.round(c.cosine_similarity * 1000) / 1000,
    source: c.source,
  }));

  const matcherPayload = JSON.stringify({
    originalName: item.name,
    candidates: top20,
    ...(item.unit ? { demandUnit: item.unit } : {}),
    ...(item.quantity != null ? { demandQuantity: item.quantity } : {}),
  });

  const comparison: ItemComparison = {
    itemName: item.name,
    candidateCount: candidates.length,
    models: {} as ItemComparison["models"],
  };

  for (const model of MODELS) {
    const calls: ModelCallResult[] = [];

    // Reform (for GPT-5-mini, also test its reformulation)
    let reformForModel = reformulated;
    if (model === "gpt-5-mini") {
      const r = await callModel(model, "reform", REFORM_PROMPT, item.name, false, 200);
      calls.push(r);
      reformForModel = r.result.trim() || item.name;
    } else {
      calls.push(reformRes);
    }

    // Matcher
    const matcherRes = await callModel(model, "matcher", MATCHER_PROMPT, matcherPayload, true, 800);
    calls.push(matcherRes);

    // Selector (only if matcher found something)
    let selectorRes: ModelCallResult | null = null;
    const shortlist = (matcherRes.parsedJson?.shortlist as Array<Record<string, unknown>>) ?? [];
    if (shortlist.length > 0) {
      const candidateMap = new Map(candidates.map((c) => [c.sku, c]));
      const enrichedShortlist = shortlist.map((s) => {
        const c = candidateMap.get(s.sku as string);
        return {
          sku: s.sku, name: c?.name ?? "?", matchScore: s.matchScore, paramMatch: s.paramMatch,
          current_price: c?.current_price ?? null, supplier_name: c?.supplier_name ?? null,
          is_stock_item: c?.is_stock_item ?? false, has_stock: c?.has_stock ?? false,
        };
      });

      const selectorPayload = JSON.stringify({
        demand: { name: item.name, unit: item.unit, quantity: item.quantity },
        shortlist: enrichedShortlist,
        offerType: "realizace",
      });

      selectorRes = await callModel(model, "selector", SELECTOR_PROMPT, selectorPayload, true, 400);
      calls.push(selectorRes);
    }

    const totalTokens: TokenUsage = { input: 0, output: 0, reasoning: 0, total: 0 };
    let totalCost = 0;
    let totalLatency = 0;
    for (const c of calls) {
      totalTokens.input += c.tokens.input;
      totalTokens.output += c.tokens.output;
      totalTokens.reasoning += c.tokens.reasoning;
      totalTokens.total += c.tokens.total;
      totalCost += c.costUsd;
      totalLatency += c.latencyMs;
    }

    const selectedSku = (selectorRes?.parsedJson?.selectedSku as string) ?? null;
    const selectedCandidate = selectedSku ? candidates.find((c) => c.sku === selectedSku) : null;

    comparison.models[model] = {
      reformResult: reformForModel,
      matcherResult: matcherRes.parsedJson,
      selectorResult: selectorRes?.parsedJson ?? undefined,
      selectedProduct: selectedSku,
      selectedPrice: selectedCandidate?.current_price ?? null,
      matchType: (selectorRes?.parsedJson?.matchType as string) ?? (matcherRes.parsedJson?.bestMatchType as string) ?? "not_found",
      confidence: (selectorRes?.parsedJson?.confidence as number) ?? 0,
      totalTokens,
      totalCost,
      totalLatency,
    };
  }

  return comparison;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(80));
  console.log("MODEL COST COMPARISON: GPT-4.1 vs GPT-5-mini (reasoning_effort: none)");
  console.log("=".repeat(80));
  console.log(`\nTesting ${TEST_ITEMS.length} items...\n`);

  const results: ItemComparison[] = [];

  for (let i = 0; i < TEST_ITEMS.length; i++) {
    const item = TEST_ITEMS[i];
    console.log(`[${i + 1}/${TEST_ITEMS.length}] ${item.name}...`);
    const comparison = await runItemComparison(item);
    results.push(comparison);

    // Quick per-item summary
    for (const model of MODELS) {
      const m = comparison.models[model];
      const matchInfo = m.matchType === "not_found" ? "❌" : `✅ ${m.matchType} (${m.confidence}%)`;
      console.log(
        `  ${model.padEnd(12)} ${matchInfo.padEnd(25)} ` +
        `tokens: ${String(m.totalTokens.total).padStart(5)} (reason: ${String(m.totalTokens.reasoning).padStart(4)}) ` +
        `cost: $${m.totalCost.toFixed(5)} ` +
        `latency: ${(m.totalLatency / 1000).toFixed(1)}s`
      );
    }
    console.log();
  }

  // ── Aggregate Summary ─────────────────────────────────────

  console.log("\n" + "=".repeat(80));
  console.log("AGGREGATE RESULTS");
  console.log("=".repeat(80));

  for (const model of MODELS) {
    const items = results.map((r) => r.models[model]);
    const totalCost = items.reduce((s, i) => s + i.totalCost, 0);
    const totalTokensIn = items.reduce((s, i) => s + i.totalTokens.input, 0);
    const totalTokensOut = items.reduce((s, i) => s + i.totalTokens.output, 0);
    const totalReasoning = items.reduce((s, i) => s + i.totalTokens.reasoning, 0);
    const avgLatency = items.reduce((s, i) => s + i.totalLatency, 0) / items.length;
    const found = items.filter((i) => i.matchType !== "not_found").length;
    const avgConfidence = items.filter((i) => i.confidence > 0)
      .reduce((s, i) => s + i.confidence, 0) / Math.max(1, found);

    console.log(`\n── ${model} ──`);
    console.log(`  Match rate:    ${found}/${items.length} (${((found / items.length) * 100).toFixed(0)}%)`);
    console.log(`  Avg confidence: ${avgConfidence.toFixed(1)}%`);
    console.log(`  Avg latency:   ${(avgLatency / 1000).toFixed(1)}s per item`);
    console.log(`  Total tokens:  ${totalTokensIn + totalTokensOut} (in: ${totalTokensIn}, out: ${totalTokensOut}, reasoning: ${totalReasoning})`);
    console.log(`  Cost (${TEST_ITEMS.length} items): $${totalCost.toFixed(4)}`);
    console.log(`  Cost per item: $${(totalCost / items.length).toFixed(5)}`);

    // Project for a typical 33-item offer
    const costPer33 = (totalCost / items.length) * 33;
    // Add planner cost estimate (1 call, ~2K in / ~1K out)
    const plannerCost = (2000 * PRICING[model].input + 1000 * PRICING[model].output) / 1_000_000;
    const totalOffer33 = costPer33 + plannerCost;
    console.log(`  ── Projected 33-item offer ──`);
    console.log(`    Pipeline:  $${costPer33.toFixed(4)}`);
    console.log(`    Planner:   $${plannerCost.toFixed(5)}`);
    console.log(`    TOTAL:     $${totalOffer33.toFixed(4)}`);
  }

  // ── Quality comparison ──────────────────────────────────────

  console.log("\n" + "=".repeat(80));
  console.log("QUALITY COMPARISON (same product selected?)");
  console.log("=".repeat(80));

  let sameProduct = 0;
  let bothFound = 0;

  for (const r of results) {
    const g41 = r.models["gpt-4.1"];
    const g5m = r.models["gpt-5-mini"];

    const g41Found = g41.matchType !== "not_found";
    const g5mFound = g5m.matchType !== "not_found";

    if (g41Found && g5mFound) {
      bothFound++;
      if (g41.selectedProduct === g5m.selectedProduct) sameProduct++;
    }

    const status = g41.selectedProduct === g5m.selectedProduct
      ? "SAME"
      : g41Found && g5mFound
        ? "DIFF"
        : g41Found && !g5mFound
          ? "4.1 only"
          : !g41Found && g5mFound
            ? "5-mini only"
            : "both miss";

    const priceComp = g41.selectedPrice && g5m.selectedPrice
      ? `  price: ${g41.selectedPrice.toFixed(0)} vs ${g5m.selectedPrice.toFixed(0)} Kč`
      : "";

    console.log(
      `  ${status.padEnd(10)} ${r.itemName.substring(0, 45).padEnd(47)} ` +
      `4.1: ${(g41.selectedProduct ?? "—").substring(0, 15).padEnd(16)} ` +
      `5m: ${(g5m.selectedProduct ?? "—").substring(0, 15)}${priceComp}`
    );
  }

  console.log(`\n  Agreement: ${sameProduct}/${bothFound} items where both found (${bothFound > 0 ? ((sameProduct / bothFound) * 100).toFixed(0) : 0}%)`);

  // ── Cost savings summary ──────────────────────────────────

  console.log("\n" + "=".repeat(80));
  console.log("COST SAVINGS SUMMARY");
  console.log("=".repeat(80));

  const cost41 = results.reduce((s, r) => s + r.models["gpt-4.1"].totalCost, 0);
  const cost5m = results.reduce((s, r) => s + r.models["gpt-5-mini"].totalCost, 0);
  const savings = ((1 - cost5m / cost41) * 100).toFixed(0);

  console.log(`  GPT-4.1 total:     $${cost41.toFixed(4)}`);
  console.log(`  GPT-5-mini total:  $${cost5m.toFixed(4)}`);
  console.log(`  Savings:           ${savings}%`);
  console.log(`  Factor:            ${(cost41 / cost5m).toFixed(1)}x cheaper with GPT-5-mini`);

  // Monthly projection (assuming 50 offers/day, 33 items each)
  const dailyOffers = 50;
  const itemsPerOffer = 33;
  const monthly41 = (cost41 / TEST_ITEMS.length) * itemsPerOffer * dailyOffers * 30;
  const monthly5m = (cost5m / TEST_ITEMS.length) * itemsPerOffer * dailyOffers * 30;

  console.log(`\n  Monthly projection (${dailyOffers} offers/day × ${itemsPerOffer} items):`);
  console.log(`    GPT-4.1:     $${monthly41.toFixed(2)}/month`);
  console.log(`    GPT-5-mini:  $${monthly5m.toFixed(2)}/month`);
  console.log(`    Savings:     $${(monthly41 - monthly5m).toFixed(2)}/month`);
}

main().catch(console.error);
