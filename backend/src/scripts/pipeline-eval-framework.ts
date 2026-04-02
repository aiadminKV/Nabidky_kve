/**
 * pipeline-eval-framework.ts
 * Shared evaluation framework: LLM evaluator, token tracking, timing, reporting.
 * Used by all 3 pipeline variants.
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import type { TestCase } from "./pipeline-test-data.js";

// ── Types ──────────────────────────────────────────────────

export interface PipelineOutput {
  selectedSku: string | null;
  selectedName: string | null;
  matchType: string;
  confidence: number;
  reasoning: string;
  candidates: Array<{ sku: string; name: string }>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface EvalResult {
  testId: number;
  demand: string;
  category: string;
  selectedSku: string | null;
  selectedName: string | null;
  matchType: string;
  confidence: number;
  verdict: "pass" | "fail" | "no_product" | "eval_error";
  evalReason: string;
  pipelineMs: number;
  tokens: TokenUsage;
  candidateCount: number;
}

export interface VariantSummary {
  variant: string;
  total: number;
  pass: number;
  fail: number;
  noProduct: number;
  evalError: number;
  passRate: string;
  avgMs: number;
  avgTokens: number;
  totalTokens: number;
  estimatedCost: string;
  byCategory: Record<string, { total: number; pass: number; passRate: string }>;
}

// ── Token Tracker ─────────────────────────────────────────

export class TokenTracker {
  private promptTokens = 0;
  private completionTokens = 0;

  add(usage: OpenAI.CompletionUsage | undefined) {
    if (!usage) return;
    this.promptTokens += usage.prompt_tokens ?? 0;
    this.completionTokens += usage.completion_tokens ?? 0;
  }

  get(): TokenUsage {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }

  reset() {
    this.promptTokens = 0;
    this.completionTokens = 0;
  }
}

// ── LLM Evaluator ─────────────────────────────────────────

const EVAL_MODEL = "gpt-5.4-mini";

const EVAL_PROMPT = `Jsi přísný hodnotitel kvality vyhledávání elektroinstalačních produktů.

Dostaneš:
1. demand: co uživatel poptává (text poptávky)
2. criteria: co MUSÍ vybraný produkt splnit (přirozený jazyk)
3. selectedProduct: produkt vybraný pipeline (sku + name), nebo null pokud žádný

Tvůj úkol: vyhodnotit, zda vybraný produkt splňuje VŠECHNA kritéria.

## Pravidla hodnocení
- "pass": produkt splňuje VŠECHNA kritéria. Drobné formátové odchylky v názvech jsou OK (např. "1-CYKY-J" vs "CYKY-J", "×" vs "x").
- "fail": produkt NESPLŇUJE alespoň 1 kritérium. Uveď které.
- "no_product": žádný produkt nebyl vybrán (selectedProduct = null). Toto je FAIL POUZE pokud by produkt měl existovat.

## Časté OK odchylky (NEVYHODNOCUJ jako fail):
- Prefix "1-" u kabelů: "1-CYKY-J" = "CYKY-J"
- Prefix "KABEL", "VODIC", "JISTIC" jako katalogový prefix
- BUBEN vs KRUH — obojí je OK pro kabely/vodiče, pokud kritéria neříkají jinak
- Různé barvy pokud kritéria nespecifikují barvu
- Různí výrobci pokud kritéria nespecifikují výrobce

## Časté FAIL situace:
- Jiný průřez (5×1,5 vs 5×2,5)
- Jiný počet žil (3× vs 5×)
- Jiný typ kabelu (CYKY vs CXKH)
- Jiný provedení (J vs O)
- Jiný proud (16A vs 25A)
- Jiná kategorie (UTP vs FTP)

Vrať VÝHRADNĚ JSON:
{
  "verdict": "pass" | "fail" | "no_product",
  "confidence": "high" | "medium" | "low",
  "reason": "1-2 věty česky proč"
}`;

// Evaluates ALL candidates for "multiple" matchType — bouncer logic: at least one must pass
const EVAL_CANDIDATES_PROMPT = `Jsi přísný hodnotitel kvality vyhledávání elektroinstalačních produktů.

Pipeline vrátila více kandidátů bez jediného výběru (matchType = "multiple"). Tvůj úkol:

1. Projdi VŠECHNY kandidáty
2. Pro každého urči, zda splňuje kritéria (viz pravidla níže)
3. Pokud ALESPOŇ JEDEN kandidát splňuje všechna kritéria → celkový výsledek je "pass"
4. Pokud ŽÁDNÝ kandidát nesplňuje kritéria → výsledek je "fail"
5. Pokud nejsou žádní kandidáti → výsledek je "no_product"

## Pravidla hodnocení kandidátů (stejná jako pro jednoznačný výběr):
- Drobné formátové odchylky jsou OK: "1-CYKY-J" = "CYKY-J", prefix KABEL/VODIC/JISTIC
- BUBEN vs KRUH je OK pokud kritéria neurčí jinak
- Různé barvy jsou OK pokud kritéria nespecifikují barvu
- Různí výrobci jsou OK pokud kritéria nespecifikují výrobce
- Špatný průřez, jiný typ kabelu, jiný proud, jiný počet žil/pólů = FAIL

Vrať VÝHRADNĚ JSON:
{
  "verdict": "pass" | "fail" | "no_product",
  "passing_candidates": ["SKU1", "SKU2"],
  "reason": "1-2 věty česky — který kandidát prošel nebo proč žádný"
}`;

export async function evaluateResult(
  tc: TestCase,
  output: PipelineOutput,
): Promise<{ verdict: "pass" | "fail" | "no_product" | "eval_error"; reason: string }> {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  // "multiple" mode — bouncer: pass if at least one candidate meets criteria
  if (output.matchType === "multiple" || (output.selectedSku === null && output.candidates.length > 0)) {
    if (output.candidates.length === 0) {
      return { verdict: "no_product", reason: "matchType=multiple ale žádní kandidáti." };
    }

    const userContent = JSON.stringify({
      demand: tc.demand,
      quantity: tc.quantity,
      unit: tc.unit,
      criteria: tc.criteria,
      candidates: output.candidates,
    });

    try {
      const res = await openai.chat.completions.create({
        model: EVAL_MODEL,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EVAL_CANDIDATES_PROMPT },
          { role: "user", content: userContent },
        ],
      } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

      const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
        verdict?: string; reason?: string; passing_candidates?: string[];
      };
      const verdict = (parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "no_product")
        ? parsed.verdict
        : "eval_error";
      return { verdict, reason: parsed.reason ?? "" };
    } catch (err) {
      return { verdict: "eval_error", reason: `LLM evaluator error (candidates): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Standard mode — single selected product
  const userContent = JSON.stringify({
    demand: tc.demand,
    quantity: tc.quantity,
    unit: tc.unit,
    criteria: tc.criteria,
    selectedProduct: output.selectedSku
      ? { sku: output.selectedSku, name: output.selectedName }
      : null,
  });

  try {
    const res = await openai.chat.completions.create({
      model: EVAL_MODEL,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EVAL_PROMPT },
        { role: "user", content: userContent },
      ],
    } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as {
      verdict?: string; reason?: string;
    };
    const verdict = (parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "no_product")
      ? parsed.verdict
      : "eval_error";
    return { verdict, reason: parsed.reason ?? "" };
  } catch (err) {
    return { verdict: "eval_error", reason: `LLM evaluator error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Reporting ─────────────────────────────────────────────

const GPT54_MINI_INPUT_PRICE = 0.4 / 1_000_000;
const GPT54_MINI_OUTPUT_PRICE = 1.6 / 1_000_000;
const GPT54_INPUT_PRICE = 2.0 / 1_000_000;
const GPT54_OUTPUT_PRICE = 8.0 / 1_000_000;

export function computeSummary(
  variant: string,
  results: EvalResult[],
  modelTier: "mini" | "full" = "mini",
): VariantSummary {
  const total = results.length;
  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  const noProduct = results.filter((r) => r.verdict === "no_product").length;
  const evalError = results.filter((r) => r.verdict === "eval_error").length;

  const avgMs = Math.round(results.reduce((s, r) => s + r.pipelineMs, 0) / total);
  const totalTokens = results.reduce((s, r) => s + r.tokens.totalTokens, 0);
  const avgTokens = Math.round(totalTokens / total);

  const totalPrompt = results.reduce((s, r) => s + r.tokens.promptTokens, 0);
  const totalCompletion = results.reduce((s, r) => s + r.tokens.completionTokens, 0);

  const inputPrice = modelTier === "mini" ? GPT54_MINI_INPUT_PRICE : GPT54_INPUT_PRICE;
  const outputPrice = modelTier === "mini" ? GPT54_MINI_OUTPUT_PRICE : GPT54_OUTPUT_PRICE;
  const cost = totalPrompt * inputPrice + totalCompletion * outputPrice;

  const byCategory: Record<string, { total: number; pass: number; passRate: string }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, pass: 0, passRate: "0%" };
    byCategory[r.category].total++;
    if (r.verdict === "pass") byCategory[r.category].pass++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.passRate = `${Math.round((cat.pass / cat.total) * 100)}%`;
  }

  return {
    variant,
    total,
    pass,
    fail,
    noProduct,
    evalError,
    passRate: `${Math.round((pass / total) * 100)}%`,
    avgMs,
    avgTokens,
    totalTokens,
    estimatedCost: `$${cost.toFixed(4)}`,
    byCategory,
  };
}

export function printSummary(summary: VariantSummary) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${summary.variant}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pass rate:    ${summary.passRate} (${summary.pass}/${summary.total})`);
  console.log(`  Fail:         ${summary.fail}`);
  console.log(`  No product:   ${summary.noProduct}`);
  console.log(`  Eval error:   ${summary.evalError}`);
  console.log(`  Avg time:     ${summary.avgMs}ms`);
  console.log(`  Avg tokens:   ${summary.avgTokens}`);
  console.log(`  Total tokens: ${summary.totalTokens}`);
  console.log(`  Est. cost:    ${summary.estimatedCost}`);
  console.log(`\n  By category:`);
  for (const [cat, stats] of Object.entries(summary.byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`    ${cat.padEnd(14)} ${stats.passRate.padStart(4)} (${stats.pass}/${stats.total})`);
  }
}

export function printDetailedResults(results: EvalResult[]) {
  console.log(`\n${"─".repeat(80)}`);
  for (const r of results) {
    const icon = r.verdict === "pass" ? "✅" : r.verdict === "fail" ? "❌" : r.verdict === "no_product" ? "⬜" : "⚠️";
    console.log(`${icon} #${String(r.testId).padStart(2)} [${r.category}] "${r.demand}"`);
    console.log(`   → ${r.selectedName ?? "(žádný produkt)"} [${r.matchType}, ${r.confidence}%]`);
    console.log(`   → ${r.evalReason}`);
    console.log(`   → ${r.pipelineMs}ms | ${r.tokens.totalTokens} tok`);
  }
}

export function printComparisonTable(summaries: VariantSummary[]) {
  console.log(`\n${"═".repeat(80)}`);
  console.log("  POROVNÁNÍ VARIANT");
  console.log(`${"═".repeat(80)}`);

  const header = ["Metrika", ...summaries.map((s) => s.variant)];
  const rows = [
    ["Pass rate", ...summaries.map((s) => s.passRate)],
    ["Fail", ...summaries.map((s) => String(s.fail))],
    ["No product", ...summaries.map((s) => String(s.noProduct))],
    ["Avg time", ...summaries.map((s) => `${s.avgMs}ms`)],
    ["Avg tokens", ...summaries.map((s) => String(s.avgTokens))],
    ["Total tokens", ...summaries.map((s) => String(s.totalTokens))],
    ["Est. cost", ...summaries.map((s) => s.estimatedCost)],
  ];

  const colWidths = header.map((_, i) =>
    Math.max(header[i].length, ...rows.map((r) => r[i].length)) + 2,
  );

  console.log(header.map((h, i) => h.padEnd(colWidths[i])).join("│"));
  console.log(colWidths.map((w) => "─".repeat(w)).join("┼"));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(colWidths[i])).join("│"));
  }
}
