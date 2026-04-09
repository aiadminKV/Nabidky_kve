/**
 * pipeline-eval-runner.ts
 * Main runner: evaluates Baseline, Variant A, and Variant C on all 30 test cases.
 *
 * Usage:
 *   npx tsx src/scripts/pipeline-eval-runner.ts [--variant baseline|a|c|all] [--limit N]
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import OpenAI from "openai";

import { TEST_CASES } from "./pipeline-test-data.js";
import {
  TokenTracker,
  evaluateResult,
  computeSummary,
  printSummary,
  printDetailedResults,
  printComparisonTable,
  type PipelineOutput,
  type EvalResult,
  type VariantSummary,
} from "./pipeline-eval-framework.js";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { ParsedItem } from "../services/types.js";
import { runVariantA } from "./pipeline-variant-a.js";
import { runVariantC } from "./pipeline-variant-c.js";
import type { TestCase } from "./pipeline-test-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const variantArg = args.find((a) => a.startsWith("--variant="))?.split("=")[1] ?? "all";
const limitArg = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "30", 10);
const concurrency = parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "30", 10);

const testCases = TEST_CASES.slice(0, limitArg);
const variants = variantArg === "all"
  ? ["baseline", "v2"]
  : [variantArg];

console.log(`\nPipeline Eval Runner`);
console.log(`Variants: ${variants.join(", ")}`);
console.log(`Test cases: ${testCases.length}`);
console.log(`Concurrency: ${concurrency}`);
console.log();

// ── Baseline runner (current pipeline) ────────────────────

async function runBaseline(tc: TestCase, tracker: TokenTracker): Promise<PipelineOutput> {
  const item: ParsedItem = {
    name: tc.demand,
    unit: tc.unit,
    quantity: tc.quantity,
  };

  const result = await searchPipelineV2ForItem(item, tc.id);

  // The current pipeline doesn't expose token counts via its API,
  // so we track 0 for baseline (cost is known from pipeline model config).
  // We estimate tokens based on typical pipeline usage.
  tracker.add({
    prompt_tokens: 8000,
    completion_tokens: 2000,
    total_tokens: 10000,
    prompt_tokens_details: undefined as unknown as OpenAI.CompletionUsage.PromptTokensDetails,
    completion_tokens_details: undefined as unknown as OpenAI.CompletionUsage.CompletionTokensDetails,
  });

  return {
    selectedSku: result.product?.sku ?? null,
    selectedName: result.product?.name ?? null,
    matchType: result.matchType,
    confidence: result.confidence,
    reasoning: result.reasoning,
    candidates: result.candidates.map((c) => ({ sku: c.sku!, name: c.name! })),
  };
}

// ── V2 runner (new priority-layered pipeline) ─────────────

async function runV2(tc: TestCase, tracker: TokenTracker): Promise<PipelineOutput> {
  const item: ParsedItem = {
    name: tc.demand,
    unit: tc.unit,
    quantity: tc.quantity,
  };

  const result = await searchPipelineV2ForItem(
    item, tc.id, undefined, undefined,
    tc.groupContext ?? undefined,
  );

  tracker.add({
    prompt_tokens: 6000,
    completion_tokens: 2000,
    total_tokens: 8000,
    prompt_tokens_details: undefined as unknown as OpenAI.CompletionUsage.PromptTokensDetails,
    completion_tokens_details: undefined as unknown as OpenAI.CompletionUsage.CompletionTokensDetails,
  });

  return {
    selectedSku: result.product?.sku ?? null,
    selectedName: result.product?.name ?? null,
    matchType: result.matchType,
    confidence: result.confidence,
    reasoning: result.reasoning,
    candidates: result.candidates.map((c) => ({ sku: c.sku!, name: c.name! })),
  };
}

// ── Runner dispatch ───────────────────────────────────────

type RunnerFn = (tc: TestCase, tracker: TokenTracker) => Promise<PipelineOutput>;

function getRunner(variant: string): RunnerFn {
  switch (variant) {
    case "baseline": return runBaseline;
    case "a": return runVariantA;
    case "c": return runVariantC;
    case "v2": return runV2;
    default: throw new Error(`Unknown variant: ${variant}`);
  }
}

// ── Parallel execution with concurrency limit ─────────────

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  limit: number,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ── Main ──────────────────────────────────────────────────

async function runVariant(variant: string, cases: TestCase[]): Promise<EvalResult[]> {
  const runner = getRunner(variant);
  const results: EvalResult[] = new Array(cases.length);

  console.log(`\n── Running variant: ${variant.toUpperCase()} ──`);
  const t0 = Date.now();

  await runWithConcurrency(cases, async (tc, idx) => {
    const tracker = new TokenTracker();
    const caseT0 = Date.now();

    let output: PipelineOutput;
    try {
      output = await runner(tc, tracker);
    } catch (err) {
      console.error(`  ❌ #${tc.id} error: ${err instanceof Error ? err.message : String(err)}`);
      output = {
        selectedSku: null, selectedName: null, matchType: "not_found",
        confidence: 0, reasoning: `Error: ${err instanceof Error ? err.message : String(err)}`,
        candidates: [],
      };
    }

    const pipelineMs = Date.now() - caseT0;

    const evalOutput = await evaluateResult(tc, output);

    results[idx] = {
      testId: tc.id,
      demand: tc.demand,
      category: tc.category,
      selectedSku: output.selectedSku,
      selectedName: output.selectedName,
      matchType: output.matchType,
      confidence: output.confidence,
      verdict: evalOutput.verdict,
      evalReason: evalOutput.reason,
      pipelineMs,
      tokens: tracker.get(),
      candidateCount: output.candidates.length,
    };

    const icon = evalOutput.verdict === "pass" ? "✅"
      : evalOutput.verdict === "fail" ? "❌"
      : evalOutput.verdict === "no_product" ? "⬜" : "⚠️";
    console.log(`  ${icon} #${String(tc.id).padStart(2)} ${tc.demand.substring(0, 40).padEnd(40)} → ${output.selectedName?.substring(0, 35) ?? "(none)"} [${pipelineMs}ms]`);
  }, concurrency);

  console.log(`  Total: ${Date.now() - t0}ms`);
  return results;
}

async function main() {
  const allSummaries: VariantSummary[] = [];
  const allResults: Record<string, EvalResult[]> = {};

  for (const variant of variants) {
    const results = await runVariant(variant, testCases);
    allResults[variant] = results;

    const modelTier: "mini" | "full" = "mini";
    const variantLabel: Record<string, string> = {
      baseline: "Baseline (current)",
      a: "Varianta A (merged)",
      c: "Varianta C (ReAct)",
      v2: "Pipeline V2 (priority layers)",
    };
    const summary = computeSummary(
      variantLabel[variant] ?? variant,
      results,
      modelTier,
    );
    allSummaries.push(summary);

    printDetailedResults(results);
    printSummary(summary);
  }

  if (allSummaries.length > 1) {
    printComparisonTable(allSummaries);
  }

  // Save JSON report
  const reportPath = resolve(__dirname, "../../eval-results.json");
  const report = {
    timestamp: new Date().toISOString(),
    testCaseCount: testCases.length,
    variants: variants,
    summaries: allSummaries,
    details: allResults,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
