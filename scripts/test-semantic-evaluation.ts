/**
 * Semantic Search Evaluation Test
 *
 * Evaluates quality of embedding-based semantic search against ground truth
 * test cases. Measures Hit@K, MRR, Category Precision, similarity
 * distribution, and latency.
 *
 * Supports two embedding sources:
 *   - products.embedding       (20K, used by search_products_semantic)
 *   - product_embeddings table (140K, used by search_product_embeddings_semantic)
 *
 * Usage:
 *   cd scripts && npx tsx test-semantic-evaluation.ts                  # both tables
 *   cd scripts && npx tsx test-semantic-evaluation.ts --table=products # products only
 *   cd scripts && npx tsx test-semantic-evaluation.ts --table=pe       # product_embeddings only
 *   cd scripts && npx tsx test-semantic-evaluation.ts --verbose        # detailed output
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 256;

const VERBOSE = process.argv.includes("--verbose");

type EmbeddingSource = "products" | "product_embeddings";

function parseTableArg(): EmbeddingSource[] {
  const tableArg = process.argv.find((a) => a.startsWith("--table="));
  if (!tableArg) return ["products", "product_embeddings"];
  const val = tableArg.split("=")[1];
  if (val === "products") return ["products"];
  if (val === "pe" || val === "product_embeddings") return ["product_embeddings"];
  return ["products", "product_embeddings"];
}

// ─── Test Case Definitions ──────────────────────────────────────────────────

interface TestCase {
  id: string;
  query: string;
  description: string;
  type: "exact" | "category" | "natural" | "cross_manufacturer" | "abbreviation" | "negative";
  expectedSkus?: string[];
  expectedCategory?: string;
  expectedSubcategory?: string;
  minSimilarity?: number;
  maxSimilarity?: number;
}

const TEST_CASES: TestCase[] = [
  // ── Exact / near-exact product searches ──
  {
    id: "E1",
    query: "výkonový jistič Siemens 3VA2010",
    description: "Exact search: Siemens circuit breaker 3VA2010",
    type: "exact",
    expectedSkus: ["1145088"],
    expectedCategory: "Výkonové jističe a stykače",
  },
  {
    id: "E2",
    query: "výkonový jistič EATON NZMB1-A80-NA 80A",
    description: "Exact search: EATON circuit breaker NZMB1 80A",
    type: "exact",
    expectedSkus: ["1000878"],
    expectedCategory: "Výkonové jističe a stykače",
  },
  {
    id: "E3",
    query: "kabel CYKY 19x2,5",
    description: "Exact search: CYKY cable 19x2.5",
    type: "exact",
    expectedSkus: ["1143609"],
    expectedCategory: "Kabely a vodiče",
  },
  {
    id: "E4",
    query: "proudový chránič ABB F204 AC 63A 30mA",
    description: "Exact search: ABB RCD F204 63A",
    type: "exact",
    expectedSkus: ["1003231"],
    expectedCategory: "Obchodní zboží",
    expectedSubcategory: "Modulové přístroje",
  },
  {
    id: "E5",
    query: "LED podhledové svítidlo Kanlux DAGO",
    description: "Exact search: Kanlux DAGO LED downlight",
    type: "exact",
    expectedSkus: ["1001188"],
    expectedCategory: "Svítidla",
  },

  // ── Category coherence ──
  {
    id: "C1",
    query: "třípólový výkonový jistič 160A",
    description: "Category: should return circuit breakers",
    type: "category",
    expectedCategory: "Výkonové jističe a stykače",
    minSimilarity: 0.3,
  },
  {
    id: "C2",
    query: "silový měděný kabel pro pevnou instalaci",
    description: "Category: should return power cables",
    type: "category",
    expectedCategory: "Kabely a vodiče",
    minSimilarity: 0.3,
  },
  {
    id: "C3",
    query: "LED svítidlo do podhledu",
    description: "Category: should return LED luminaires",
    type: "category",
    expectedCategory: "Svítidla",
    expectedSubcategory: "LED",
    minSimilarity: 0.3,
  },
  {
    id: "C4",
    query: "proudový chránič dvoupólový 30mA",
    description: "Category: should return RCDs (modulové přístroje)",
    type: "category",
    expectedCategory: "Obchodní zboží",
    expectedSubcategory: "Modulové přístroje",
    minSimilarity: 0.3,
  },
  {
    id: "C5",
    query: "elektrická zásuvka nástěnná bílá",
    description: "Category: should return wall sockets",
    type: "category",
    expectedCategory: "Domovní spínače a zásuvky",
    minSimilarity: 0.3,
  },
  {
    id: "C6",
    query: "stykač třípólový 38A cívka 230V",
    description: "Category: should return contactors",
    type: "category",
    expectedCategory: "Výkonové jističe a stykače",
    expectedSubcategory: "Výkonové stykače a ministykače",
    minSimilarity: 0.3,
  },
  {
    id: "C7",
    query: "kabelový žlab kovový",
    description: "Category: should return cable trays",
    type: "category",
    expectedCategory: "Úložný materiál",
    minSimilarity: 0.3,
  },

  // ── Natural language / vague queries ──
  {
    id: "N1",
    query: "ochrana elektrického obvodu proti zkratu a přetížení",
    description: "Natural: circuit protection against short-circuit",
    type: "natural",
    expectedCategory: "Obchodní zboží",
    minSimilarity: 0.2,
  },
  {
    id: "N2",
    query: "osvětlení pro kancelářské prostory úsporné",
    description: "Natural: office lighting, energy efficient",
    type: "natural",
    expectedCategory: "Svítidla",
    minSimilarity: 0.2,
  },
  {
    id: "N3",
    query: "měděný vodič pro silovou elektroinstalaci",
    description: "Natural: copper wire for power installation",
    type: "natural",
    expectedCategory: "Kabely a vodiče",
    minSimilarity: 0.2,
  },

  // ── Cross-manufacturer alternatives ──
  {
    id: "X1",
    query: "výkonový jistič 80A třípólový",
    description: "Cross-mfr: should find breakers from multiple manufacturers",
    type: "cross_manufacturer",
    expectedCategory: "Výkonové jističe a stykače",
    minSimilarity: 0.3,
  },
  {
    id: "X2",
    query: "stykač reverzační třípólový 230V",
    description: "Cross-mfr: reversing contactor from various brands",
    type: "cross_manufacturer",
    expectedCategory: "Výkonové jističe a stykače",
    minSimilarity: 0.3,
  },

  // ── Abbreviation / domain shorthand ──
  {
    id: "A1",
    query: "jistič 3P B16",
    description: "Abbreviation: 3-pole breaker char. B 16A",
    type: "abbreviation",
    expectedCategory: "Obchodní zboží",
    expectedSubcategory: "Modulové přístroje",
    minSimilarity: 0.2,
  },
  {
    id: "A2",
    query: "CYKY-J 3x2,5",
    description: "Abbreviation: CYKY cable with protective conductor",
    type: "abbreviation",
    expectedCategory: "Kabely a vodiče",
    minSimilarity: 0.3,
  },
  {
    id: "A3",
    query: "FI 2P 25A 30mA",
    description: "Abbreviation: RCD 2-pole 25A 30mA",
    type: "abbreviation",
    expectedCategory: "Obchodní zboží",
    minSimilarity: 0.2,
  },

  // ── Negative / unrelated ──
  // Note: 256-dim embeddings produce higher baseline similarity (0.4-0.5)
  // so thresholds must be adjusted accordingly
  {
    id: "NEG1",
    query: "jízdní kolo horské 26 palců",
    description: "Negative: bicycle - completely unrelated",
    type: "negative",
    maxSimilarity: 0.55,
  },
  {
    id: "NEG2",
    query: "receptář české kuchyně",
    description: "Negative: cookbook - completely unrelated",
    type: "negative",
    maxSimilarity: 0.6,
  },
];

// ─── Metrics ────────────────────────────────────────────────────────────────

interface TestResult {
  testCase: TestCase;
  results: SearchResult[];
  queryTimeMs: number;
  embeddingTimeMs: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  categoryPrecisionAt5: number;
  subcategoryPrecisionAt5: number;
  avgSimilarity: number;
  topSimilarity: number;
  passed: boolean;
  failReasons: string[];
}

interface SearchResult {
  sku: string;
  name: string;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  description: string | null;
  cosine_similarity: number;
}

function computeHitAtK(results: SearchResult[], expectedSkus: string[], k: number): boolean {
  const topK = results.slice(0, k);
  return expectedSkus.some((sku) => topK.some((r) => r.sku === sku));
}

function computeReciprocalRank(results: SearchResult[], expectedSkus: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expectedSkus.includes(results[i].sku)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function computeCategoryPrecision(results: SearchResult[], category: string, k: number): number {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const matching = topK.filter((r) => r.category === category).length;
  return matching / topK.length;
}

function computeSubcategoryPrecision(results: SearchResult[], subcategory: string, k: number): number {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const matching = topK.filter((r) => r.subcategory === subcategory).length;
  return matching / topK.length;
}

function evaluateTestCase(tc: TestCase, results: SearchResult[]): Omit<TestResult, "testCase" | "results" | "queryTimeMs" | "embeddingTimeMs"> {
  const failReasons: string[] = [];

  const hitAt1 = tc.expectedSkus ? computeHitAtK(results, tc.expectedSkus, 1) : false;
  const hitAt3 = tc.expectedSkus ? computeHitAtK(results, tc.expectedSkus, 3) : false;
  const hitAt5 = tc.expectedSkus ? computeHitAtK(results, tc.expectedSkus, 5) : false;
  const hitAt10 = tc.expectedSkus ? computeHitAtK(results, tc.expectedSkus, 10) : false;
  const reciprocalRank = tc.expectedSkus ? computeReciprocalRank(results, tc.expectedSkus) : 0;

  const categoryPrecisionAt5 = tc.expectedCategory
    ? computeCategoryPrecision(results, tc.expectedCategory, 5)
    : 0;

  const subcategoryPrecisionAt5 = tc.expectedSubcategory
    ? computeSubcategoryPrecision(results, tc.expectedSubcategory, 5)
    : 0;

  const avgSimilarity = results.length > 0
    ? results.reduce((sum, r) => sum + r.cosine_similarity, 0) / results.length
    : 0;

  const topSimilarity = results.length > 0 ? results[0].cosine_similarity : 0;

  let passed = true;

  if (tc.type === "exact" && tc.expectedSkus) {
    if (!hitAt10) {
      passed = false;
      failReasons.push(`Expected SKU(s) [${tc.expectedSkus.join(", ")}] not found in top 10`);
    }
  }

  if (tc.expectedCategory && results.length > 0) {
    if (categoryPrecisionAt5 < 0.4) {
      passed = false;
      failReasons.push(`Category precision@5 too low: ${(categoryPrecisionAt5 * 100).toFixed(0)}% (expected ≥40% "${tc.expectedCategory}")`);
    }
  }

  if (tc.minSimilarity && topSimilarity < tc.minSimilarity) {
    passed = false;
    failReasons.push(`Top similarity ${topSimilarity.toFixed(4)} below threshold ${tc.minSimilarity}`);
  }

  if (tc.type === "negative") {
    if (results.length === 0) {
      passed = true;
    } else if (tc.maxSimilarity && topSimilarity > tc.maxSimilarity) {
      passed = false;
      failReasons.push(`Negative test: top similarity ${topSimilarity.toFixed(4)} exceeds max ${tc.maxSimilarity}`);
    }
  }

  return {
    hitAt1,
    hitAt3,
    hitAt5,
    hitAt10,
    reciprocalRank,
    categoryPrecisionAt5,
    subcategoryPrecisionAt5,
    avgSimilarity,
    topSimilarity,
    passed,
    failReasons,
  };
}

// ─── Run evaluation against a specific embedding source ─────────────────────

async function runEvaluation(
  source: EmbeddingSource,
  supabase: SupabaseClient,
  openai: OpenAI,
  cachedEmbeddings: Map<string, number[]>,
): Promise<{ passed: number; total: number }> {
  const rpcName = source === "products"
    ? "search_products_semantic"
    : "search_product_embeddings_semantic";

  const sourceLabel = source === "products"
    ? "products.embedding (20K)"
    : "product_embeddings (140K)";

  // Fetch count for this source
  let embCount: number;
  if (source === "products") {
    const [{ count: totalCount }, { data: withoutData }] = await Promise.all([
      supabase.from("products").select("*", { count: "exact", head: true }),
      supabase.rpc("count_products_without_embedding"),
    ]);
    const totalProducts = totalCount ?? 471237;
    const withoutEmbedding = typeof withoutData === "number" ? withoutData : totalProducts;
    embCount = totalProducts - withoutEmbedding;
  } else {
    const { data: peCount } = await supabase
      .from("product_embeddings")
      .select("*", { count: "exact", head: true });
    // Use direct count for product_embeddings
    const { count: peTotal } = await supabase
      .from("product_embeddings")
      .select("*", { count: "exact", head: true });
    embCount = peTotal ?? 140400;
  }

  console.log("\n" + "━".repeat(90));
  console.log(`  EVALUATION: ${sourceLabel}`);
  console.log("━".repeat(90));
  console.log(`  RPC:         ${rpcName}`);
  console.log(`  Embeddings:  ${embCount.toLocaleString()}`);
  console.log(`  Model:       ${EMBEDDING_MODEL} @ ${EMBEDDING_DIMENSIONS} dims`);
  console.log(`  Threshold:   0.15`);
  console.log("━".repeat(90));

  const allResults: TestResult[] = [];
  let totalQueryMs = 0;

  for (const tc of TEST_CASES) {
    process.stdout.write(`  [${tc.id.padEnd(4)}] ${tc.description.slice(0, 55).padEnd(55)} `);

    // Reuse cached embeddings
    let queryEmbedding = cachedEmbeddings.get(tc.query);
    if (!queryEmbedding) {
      const embResponse = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: tc.query,
      });
      queryEmbedding = embResponse.data[0].embedding;
      cachedEmbeddings.set(tc.query, queryEmbedding);
    }

    const qStart = Date.now();
    const { data, error } = await supabase.rpc(rpcName, {
      query_embedding: JSON.stringify(queryEmbedding),
      max_results: 10,
      similarity_threshold: 0.15,
    });
    const queryTimeMs = Date.now() - qStart;
    totalQueryMs += queryTimeMs;

    if (error) {
      console.log(`ERROR: ${error.message}`);
      continue;
    }

    const results: SearchResult[] = (data ?? []).map((r: Record<string, unknown>) => ({
      sku: r.sku as string,
      name: r.name as string,
      manufacturer: r.manufacturer as string | null,
      category: r.category as string | null,
      subcategory: r.subcategory as string | null,
      description: r.description as string | null,
      cosine_similarity: r.cosine_similarity as number,
    }));

    const metrics = evaluateTestCase(tc, results);
    allResults.push({ testCase: tc, results, queryTimeMs, embeddingTimeMs: 0, ...metrics });

    const statusIcon = metrics.passed ? "PASS" : "FAIL";
    const simStr = results.length > 0
      ? `sim: ${metrics.topSimilarity.toFixed(3)}..${metrics.avgSimilarity.toFixed(3)}`
      : "no results";
    console.log(`${statusIcon}  ${simStr}  (${queryTimeMs}ms)`);

    if (VERBOSE || !metrics.passed) {
      for (const reason of metrics.failReasons) {
        console.log(`         ⚠ ${reason}`);
      }
      if (VERBOSE && results.length > 0) {
        for (let i = 0; i < Math.min(5, results.length); i++) {
          const r = results[i];
          const skuMatch = tc.expectedSkus?.includes(r.sku) ? " ◀ EXPECTED" : "";
          const catMatch = tc.expectedCategory === r.category ? " [cat✓]" : "";
          console.log(
            `         ${(i + 1).toString().padStart(2)}. ${r.sku.padEnd(12)} ${r.name.slice(0, 40).padEnd(40)} sim=${r.cosine_similarity.toFixed(4)}${catMatch}${skuMatch}`,
          );
        }
      }
    }
  }

  // ─── Aggregate ──────────────────────────────────────────────────────

  const exactTests = allResults.filter((r) => r.testCase.type === "exact");
  const categoryTests = allResults.filter((r) =>
    ["category", "natural", "cross_manufacturer", "abbreviation"].includes(r.testCase.type),
  );
  const negativeTests = allResults.filter((r) => r.testCase.type === "negative");

  console.log("\n  ── Aggregate ──");

  if (exactTests.length > 0) {
    const hitAt1Rate = exactTests.filter((r) => r.hitAt1).length / exactTests.length;
    const hitAt5Rate = exactTests.filter((r) => r.hitAt5).length / exactTests.length;
    const hitAt10Rate = exactTests.filter((r) => r.hitAt10).length / exactTests.length;
    const mrr = exactTests.reduce((s, r) => s + r.reciprocalRank, 0) / exactTests.length;
    console.log(`  Exact: Hit@1=${(hitAt1Rate * 100).toFixed(0)}% Hit@5=${(hitAt5Rate * 100).toFixed(0)}% Hit@10=${(hitAt10Rate * 100).toFixed(0)}% MRR=${mrr.toFixed(3)}`);
  }

  if (categoryTests.length > 0) {
    const avgCatPrec = categoryTests.reduce((s, r) => s + r.categoryPrecisionAt5, 0) / categoryTests.length;
    console.log(`  Category Precision@5: ${(avgCatPrec * 100).toFixed(1)}%`);
  }

  if (negativeTests.length > 0) {
    const avgNegSim = negativeTests.reduce((s, r) => s + r.topSimilarity, 0) / negativeTests.length;
    console.log(`  Negative avg top sim: ${avgNegSim.toFixed(4)} (all passed: ${negativeTests.every((r) => r.passed) ? "YES" : "NO"})`);
  }

  // Similarity distribution
  const allSims = allResults
    .filter((r) => r.testCase.type !== "negative")
    .flatMap((r) => r.results.map((s) => s.cosine_similarity));
  if (allSims.length > 0) {
    allSims.sort((a, b) => a - b);
    const mean = allSims.reduce((s, v) => s + v, 0) / allSims.length;
    const p50 = allSims[Math.floor(allSims.length * 0.5)];
    const p90 = allSims[Math.floor(allSims.length * 0.9)];
    console.log(`  Similarity: mean=${mean.toFixed(4)} P50=${p50.toFixed(4)} P90=${p90.toFixed(4)} (n=${allSims.length})`);
  }

  console.log(`  Avg DB query: ${Math.round(totalQueryMs / allResults.length)}ms`);

  // Per-type
  const types = ["exact", "category", "natural", "cross_manufacturer", "abbreviation", "negative"] as const;
  for (const type of types) {
    const tests = allResults.filter((r) => r.testCase.type === type);
    if (tests.length === 0) continue;
    const passRate = tests.filter((r) => r.passed).length / tests.length;
    const avgTopSim = tests.reduce((s, r) => s + r.topSimilarity, 0) / tests.length;
    console.log(`  ${type.padEnd(20)} pass: ${(passRate * 100).toFixed(0).padStart(3)}%  (${tests.filter((r) => r.passed).length}/${tests.length})  avg_top_sim: ${avgTopSim.toFixed(4)}`);
  }

  const totalPassed = allResults.filter((r) => r.passed).length;
  const totalTests = allResults.length;
  const passRate = totalPassed / totalTests;

  console.log(`\n  RESULT: ${totalPassed}/${totalTests} passed (${(passRate * 100).toFixed(0)}%) — ${passRate >= 0.85 ? "GOOD" : passRate >= 0.65 ? "ACCEPTABLE" : "NEEDS IMPROVEMENT"}`);

  return { passed: totalPassed, total: totalTests };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const sources = parseTableArg();

  console.log("━".repeat(90));
  console.log("  SEMANTIC SEARCH EVALUATION TEST");
  console.log("━".repeat(90));
  console.log(`  Sources:     ${sources.join(", ")}`);
  console.log(`  Test cases:  ${TEST_CASES.length} per source`);
  console.log("━".repeat(90));

  const cachedEmbeddings = new Map<string, number[]>();
  const summaries: Array<{ source: string; passed: number; total: number }> = [];

  for (const source of sources) {
    const result = await runEvaluation(source, supabase, openai, cachedEmbeddings);
    summaries.push({ source, ...result });
  }

  // ─── Comparison (if both sources) ───────────────────────────────────

  if (summaries.length > 1) {
    console.log("\n" + "━".repeat(90));
    console.log("  COMPARISON: products.embedding vs product_embeddings");
    console.log("━".repeat(90));
    for (const s of summaries) {
      const rate = ((s.passed / s.total) * 100).toFixed(0);
      const label = s.source === "products" ? "products.embedding (20K) " : "product_embeddings (140K)";
      console.log(`  ${label}:  ${s.passed}/${s.total} passed (${rate}%)`);
    }
    console.log("━".repeat(90));
  }

  const worstRate = Math.min(...summaries.map((s) => s.passed / s.total));
  if (worstRate < 0.5) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
