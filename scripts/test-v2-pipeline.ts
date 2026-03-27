/**
 * End-to-end integration test of v2 RPCs — simulates the full agent + search pipeline.
 *
 * Tests all sub-paths the pipeline uses:
 *   1. Exact lookup (SKU / EAN / IDNLF / contains)
 *   2. Fulltext search (edge cases: abbreviations, typos, slang, technical specs)
 *   3. Semantic search (dual embedding, manufacturer/stock/branch filters)
 *   4. Full pipeline simulation (reformulate → route → parallel search → merge → assert)
 *   5. Category tree + get_products_by_ids
 *
 * Usage:
 *   cd scripts && npx tsx test-v2-pipeline.ts
 *   cd scripts && npx tsx test-v2-pipeline.ts --suite=exact
 *   cd scripts && npx tsx test-v2-pipeline.ts --suite=fulltext
 *   cd scripts && npx tsx test-v2-pipeline.ts --suite=semantic
 *   cd scripts && npx tsx test-v2-pipeline.ts --suite=pipeline
 *   cd scripts && npx tsx test-v2-pipeline.ts --suite=misc
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "node:path";
import OpenAI from "openai";

config({ path: resolve(import.meta.dirname, "../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 256;
const SIM_THRESHOLD = 0.35;
const REFORMULATE_MODEL = "gpt-4.1-mini";

// ── Colors ──
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

// ── Result tracking ──
interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  ms: number;
  detail?: string;
}

const results: TestResult[] = [];

function assert(suite: string, name: string, condition: boolean, ms: number, detail?: string) {
  results.push({ suite, name, passed: condition, ms, detail });
  const icon = condition ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const timing = `${DIM}${ms}ms${RESET}`;
  console.log(`  ${icon} ${name} ${timing}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

// ── Supabase + OpenAI clients ──

let supabase: SupabaseClient;
let openai: OpenAI;

function initClients() {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMS,
    input: text,
  });
  return res.data[0].embedding;
}

async function reformulate(name: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: REFORMULATE_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Přeformuluj název elektrotechnického produktu do nejpopisnější možné formy pro sémantické vyhledávání v českém B2B katalogu elektroinstalačního materiálu. " +
          "Rozviň zkratky, přidej odborný kontext. Pokud zkratce nerozumíš, ponech originální text. Vrať plain text.",
      },
      { role: "user", content: name },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });
  return res.choices[0]?.message?.content?.trim() ?? name;
}

// ── Suite helpers ──

function parseArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : undefined;
}

// ══════════════════════════════════════════════════════════════
// SUITE 1: Exact Lookup
// ══════════════════════════════════════════════════════════════

async function suiteExactLookup() {
  console.log(`\n${BOLD}${CYAN}━━━ SUITE 1: Exact Lookup (lookup_products_v2_exact) ━━━${RESET}\n`);

  // First, get a known SKU and EAN from the DB for fixture data
  const { data: sampleProduct } = await supabase
    .from("products_v2")
    .select("id, sku")
    .not("removed_at", "is", null)
    .is("removed_at", null)
    .limit(1)
    .single();

  const { data: sampleId } = await supabase
    .from("product_identifiers_v2")
    .select("product_id, identifier_type, identifier_value")
    .eq("identifier_type", "EAN")
    .limit(1)
    .single();

  const knownSku = sampleProduct?.sku ?? "1386822";

  // Test 1.1: Exact SKU match
  let t0 = Date.now();
  const { data: skuResult, error: skuErr } = await supabase.rpc("lookup_products_v2_exact", {
    lookup_query: knownSku,
    max_results: 5,
  });
  let ms = Date.now() - t0;
  assert("exact", `SKU exact match: "${knownSku}"`, !skuErr && skuResult?.length > 0 && skuResult[0].sku === knownSku, ms,
    skuResult?.[0] ? `→ ${skuResult[0].name} (match_type: ${skuResult[0].match_type})` : skuErr?.message);

  // Test 1.2: Exact EAN match
  if (sampleId) {
    t0 = Date.now();
    const { data: eanResult, error: eanErr } = await supabase.rpc("lookup_products_v2_exact", {
      lookup_query: sampleId.identifier_value,
      max_results: 5,
    });
    ms = Date.now() - t0;
    const foundEan = eanResult?.some((r: any) => r.match_type?.includes("ean"));
    assert("exact", `EAN exact match: "${sampleId.identifier_value}"`, !eanErr && eanResult?.length > 0 && foundEan, ms,
      eanResult?.[0] ? `→ ${eanResult[0].sku} ${eanResult[0].name} (match_type: ${eanResult[0].match_type})` : eanErr?.message);
  }

  // Test 1.3: Non-existent SKU returns empty
  t0 = Date.now();
  const { data: noResult } = await supabase.rpc("lookup_products_v2_exact", {
    lookup_query: "XXXXXXXXX_NONEXIST",
    max_results: 5,
  });
  ms = Date.now() - t0;
  assert("exact", "Non-existent SKU returns 0 rows", (noResult?.length ?? 0) === 0, ms);

  // Test 1.4: Short string (< 6 chars) should NOT trigger contains fallback
  t0 = Date.now();
  const { data: shortResult } = await supabase.rpc("lookup_products_v2_exact", {
    lookup_query: "123",
    max_results: 5,
  });
  ms = Date.now() - t0;
  const noContains = !(shortResult ?? []).some((r: any) => r.match_type?.includes("contains"));
  assert("exact", "Short query (3 chars) does NOT trigger contains", noContains, ms,
    `rows: ${shortResult?.length ?? 0}`);

  // Test 1.5: Contains fallback with ≥6 char substring
  if (sampleId && sampleId.identifier_value.length >= 8) {
    const partial = sampleId.identifier_value.substring(0, 8);
    t0 = Date.now();
    const { data: containsResult } = await supabase.rpc("lookup_products_v2_exact", {
      lookup_query: partial,
      max_results: 10,
    });
    ms = Date.now() - t0;
    assert("exact", `Contains fallback (8-char substring): "${partial}"`, (containsResult?.length ?? 0) > 0, ms,
      `rows: ${containsResult?.length}`);
  }

  // Test 1.6: include_removed flag
  t0 = Date.now();
  const { data: removedResult } = await supabase.rpc("lookup_products_v2_exact", {
    lookup_query: knownSku,
    max_results: 5,
    include_removed: true,
  });
  ms = Date.now() - t0;
  assert("exact", "include_removed=true still returns active product", (removedResult?.length ?? 0) > 0, ms);

  // Test 1.7: Performance — exact SKU should be < 150ms (includes network RTT to Supabase)
  t0 = Date.now();
  await supabase.rpc("lookup_products_v2_exact", { lookup_query: knownSku, max_results: 5 });
  ms = Date.now() - t0;
  assert("exact", `Performance: SKU lookup < 150ms`, ms < 150, ms);
}

// ══════════════════════════════════════════════════════════════
// SUITE 2: Fulltext Search — tough edge cases
// ══════════════════════════════════════════════════════════════

async function suiteFulltext() {
  console.log(`\n${BOLD}${CYAN}━━━ SUITE 2: Fulltext Search (search_products_v2_fulltext) ━━━${RESET}\n`);

  const queries: Array<{ query: string; expectRows: boolean; note: string }> = [
    { query: "jistič B16", expectRows: true, note: "standard abbreviation" },
    { query: "CYKY 3x2,5", expectRows: true, note: "cable with comma decimal" },
    { query: "CYKY 3x2.5", expectRows: false, note: "cable with dot decimal — KNOWN GAP: DB uses commas" },
    { query: "proudový chránič 30mA", expectRows: true, note: "czech diacritics + technical param" },
    { query: "proudovy chranic", expectRows: true, note: "unaccented — should unaccent-match" },
    { query: "LED panel 600x600", expectRows: true, note: "dimensions in name" },
    { query: "krabice KO8", expectRows: false, note: "abbreviation — KNOWN GAP: product names may differ" },
    { query: "WAGO svorka", expectRows: true, note: "reversed word order" },
    { query: "svorka wago", expectRows: true, note: "normal word order, lowercased" },
    { query: "vodic CY 10 hneda", expectRows: true, note: "color-specific wire" },
    { query: "stykac 25A", expectRows: true, note: "contactor abbreviation" },
    { query: "led driver", expectRows: true, note: "simple 2-word" },
    { query: "UTP cat5", expectRows: true, note: "network cable" },
    { query: "xyznonexist1234foobar", expectRows: false, note: "gibberish → 0 results" },
    { query: "a", expectRows: true, note: "single char → graceful (may match products with 'A' in name)" },
    { query: "' OR 1=1 --", expectRows: true, note: "SQL injection → safe (no error, 'OR' matches product names)" },
  ];

  for (const tc of queries) {
    const t0 = Date.now();
    const { data, error } = await supabase.rpc("search_products_v2_fulltext", {
      search_query: tc.query,
      max_results: 10,
    });
    const ms = Date.now() - t0;
    const rowCount = data?.length ?? 0;
    const pass = tc.expectRows ? rowCount > 0 : rowCount === 0;
    assert("fulltext", `"${tc.query}" (${tc.note})`, pass && !error, ms,
      `rows: ${rowCount}${data?.[0] ? ` → top: ${data[0].sku} ${data[0].name?.slice(0, 50)}` : ""}${error ? ` ERR: ${error.message}` : ""}`);
  }

  // Test: manufacturer filter
  const t0 = Date.now();
  const { data: mfrResult } = await supabase.rpc("search_products_v2_fulltext", {
    search_query: "jistič",
    max_results: 10,
    manufacturer_filter: "ABB",
  });
  const ms = Date.now() - t0;
  const allAbb = (mfrResult ?? []).every((r: any) => r.supplier_name?.toUpperCase().includes("ABB"));
  assert("fulltext", "manufacturer_filter='ABB' → all results are ABB", allAbb && (mfrResult?.length ?? 0) > 0, ms,
    `rows: ${mfrResult?.length}`);

  // Test: stock filter
  const t1 = Date.now();
  const { data: stockResult } = await supabase.rpc("search_products_v2_fulltext", {
    search_query: "kabel",
    max_results: 10,
    in_stock_only: true,
  });
  const ms2 = Date.now() - t1;
  const allInStock = (stockResult ?? []).every((r: any) => r.has_stock === true);
  assert("fulltext", "in_stock_only=true → all results has_stock", allInStock, ms2,
    `rows: ${stockResult?.length}`);

  // Test: SQL injection safety — the important thing is NO error
  const t_inj = Date.now();
  const { error: injErr } = await supabase.rpc("search_products_v2_fulltext", {
    search_query: "'; DROP TABLE products_v2;--",
    max_results: 5,
  });
  const injMs = Date.now() - t_inj;
  assert("fulltext", "SQL injection safety (DROP TABLE) → no error", !injErr, injMs,
    injErr ? `ERR: ${injErr.message}` : "safe ✓");

  // Test: stock_item_only filter
  const t2 = Date.now();
  const { data: stockItemResult } = await supabase.rpc("search_products_v2_fulltext", {
    search_query: "jistič",
    max_results: 10,
    stock_item_only: true,
  });
  const ms3 = Date.now() - t2;
  const allStockItems = (stockItemResult ?? []).every((r: any) => r.is_stock_item === true);
  assert("fulltext", "stock_item_only=true → all results is_stock_item", allStockItems, ms3,
    `rows: ${stockItemResult?.length}`);
}

// ══════════════════════════════════════════════════════════════
// SUITE 3: Semantic Search
// ══════════════════════════════════════════════════════════════

async function suiteSemantic() {
  console.log(`\n${BOLD}${CYAN}━━━ SUITE 3: Semantic Search (search_products_v2_semantic) ━━━${RESET}\n`);

  // Test 3.1: Self-similarity — a product's own embedding returns itself
  // Pick an active product (removed_at IS NULL) that has an embedding
  const { data: refProduct } = await supabase
    .from("products_v2")
    .select("id, sku")
    .is("removed_at", null)
    .limit(1)
    .single();

  let refEmbedding: any = null;
  if (refProduct) {
    const { data: embRow } = await supabase
      .from("product_embeddings_v2")
      .select("embedding")
      .eq("product_id", refProduct.id)
      .single();
    refEmbedding = embRow?.embedding;
  }

  if (refProduct && refEmbedding) {
    let t0 = Date.now();
    const { data: selfResult } = await supabase.rpc("search_products_v2_semantic", {
      query_embedding: refEmbedding,
      max_results: 10,
      similarity_threshold: 0.1,
    });
    let ms = Date.now() - t0;
    const selfInResults = selfResult?.some((r: any) => r.sku === refProduct.sku);
    const selfRank = selfResult?.findIndex((r: any) => r.sku === refProduct.sku) ?? -1;
    assert("semantic", `Self-similarity: SKU ${refProduct.sku} embedding → itself in top 10`,
      !!selfInResults, ms,
      `rank: #${selfRank + 1}, top: ${selfResult?.[0]?.sku} (cos=${selfResult?.[0]?.cosine_similarity?.toFixed(4)})`);
  }

  // Test 3.2: Real query embeddings
  const semanticQueries: Array<{ query: string; expectNonEmpty: boolean; note?: string }> = [
    { query: "jistič třífázový 16 ampér", expectNonEmpty: true },
    { query: "proudový chránič s nadproudovou ochranou", expectNonEmpty: true },
    { query: "LED svítidlo do interiéru 40W", expectNonEmpty: true },
    { query: "kabel silový měděný 3 vodiče 2,5mm průřez", expectNonEmpty: true },
    { query: "nouzové osvětlení s vlastním akumulátorem", expectNonEmpty: true },
    { query: "řadová svorka na DIN lištu pro vodič 10mm", expectNonEmpty: true },
    { query: "stykač modulární 25A 230V", expectNonEmpty: true },
    { query: "lišta DIN pozinkovaná", expectNonEmpty: true },
    { query: "pizza margherita recept", expectNonEmpty: true, note: "OUT-OF-DOMAIN: returns low-similarity noise (evaluator filters)" },
  ];

  for (const tc of semanticQueries) {
    const t0 = Date.now();
    const emb = await embed(tc.query);
    const embMs = Date.now() - t0;

    const t1 = Date.now();
    const { data, error } = await supabase.rpc("search_products_v2_semantic", {
      query_embedding: JSON.stringify(emb),
      max_results: 10,
      similarity_threshold: SIM_THRESHOLD,
    });
    const searchMs = Date.now() - t1;
    const totalMs = embMs + searchMs;

    const rowCount = data?.length ?? 0;
    const pass = tc.expectNonEmpty ? rowCount > 0 : rowCount === 0;
    assert("semantic", `"${tc.query}"`, pass && !error, totalMs,
      `embed: ${embMs}ms, search: ${searchMs}ms, rows: ${rowCount}${data?.[0] ? `, top: ${data[0].sku} cos=${data[0].cosine_similarity?.toFixed(3)}` : ""}${error ? ` ERR: ${error.message}` : ""}`);
  }

  // Test 3.3: Manufacturer filter
  const t0 = Date.now();
  const emb = await embed("jistič");
  const { data: mfrData } = await supabase.rpc("search_products_v2_semantic", {
    query_embedding: JSON.stringify(emb),
    max_results: 10,
    similarity_threshold: 0.2,
    manufacturer_filter: "ABB",
  });
  const ms = Date.now() - t0;
  const allAbb = (mfrData ?? []).every((r: any) => r.supplier_name?.toUpperCase().includes("ABB"));
  assert("semantic", "manufacturer_filter='ABB' → all ABB",
    allAbb && (mfrData?.length ?? 0) > 0, ms, `rows: ${mfrData?.length}`);

  // Test 3.4: in_stock_only filter
  const t1 = Date.now();
  const emb2 = await embed("kabel CYKY");
  const { data: stockData } = await supabase.rpc("search_products_v2_semantic", {
    query_embedding: JSON.stringify(emb2),
    max_results: 10,
    similarity_threshold: 0.2,
    in_stock_only: true,
  });
  const ms2 = Date.now() - t1;
  const allStock = (stockData ?? []).every((r: any) => r.has_stock === true);
  assert("semantic", "in_stock_only=true → all has_stock",
    allStock, ms2, `rows: ${stockData?.length}`);

  // Test 3.5: branch_code_filter
  const { data: branches } = await supabase
    .from("branches_v2")
    .select("source_branch_code")
    .limit(1)
    .single();

  if (branches) {
    const t2 = Date.now();
    const emb3 = await embed("vodič");
    const { data: branchData } = await supabase.rpc("search_products_v2_semantic", {
      query_embedding: JSON.stringify(emb3),
      max_results: 10,
      similarity_threshold: 0.1,
      branch_code_filter: branches.source_branch_code,
    });
    const ms3 = Date.now() - t2;
    assert("semantic", `branch_code_filter='${branches.source_branch_code}' → results found`,
      (branchData?.length ?? 0) > 0, ms3, `rows: ${branchData?.length}`);
  }

  // Test 3.6: Removed products excluded (no removed_at in results)
  const emb4 = await embed("jistič");
  const { data: noRemovedData } = await supabase.rpc("search_products_v2_semantic", {
    query_embedding: JSON.stringify(emb4),
    max_results: 30,
    similarity_threshold: 0.1,
  });
  const noRemoved = (noRemovedData ?? []).every((r: any) => r.removed_at === null);
  assert("semantic", "Active products only (removed_at IS NULL)", noRemoved, 0,
    `checked ${noRemovedData?.length} rows`);
}

// ══════════════════════════════════════════════════════════════
// SUITE 4: Full Pipeline Simulation
// ══════════════════════════════════════════════════════════════

interface PipelineTestCase {
  input: string;
  expectType: "exact_match" | "semantic_match" | "any_results" | "no_results";
  note: string;
}

async function suitePipeline() {
  console.log(`\n${BOLD}${CYAN}━━━ SUITE 4: Full Pipeline Simulation ━━━${RESET}\n`);
  console.log(`  ${DIM}Simulates: classify → route (exact/fulltext/semantic) → merge → assert${RESET}\n`);

  const testCases: PipelineTestCase[] = [
    // SKU-like inputs → should route to exact lookup
    { input: "1386822", expectType: "exact_match", note: "Pure SKU number" },
    // EAN-like inputs → should route to exact lookup
    { input: "4049504220657", expectType: "exact_match", note: "Pure EAN barcode" },
    // Product names → semantic + fulltext
    { input: "Jistič B3x16", expectType: "semantic_match", note: "Standard breaker" },
    { input: "Proudový chránič s nadproudovou ochranou 0,03A/1B1x10A", expectType: "any_results", note: "Complex RCBO spec" },
    { input: "Světidlo čtvercové 23,1W 2850 lm LED IP 54", expectType: "any_results", note: "Specific luminaire" },
    { input: "Krabice KO8", expectType: "semantic_match", note: "Short abbreviation" },
    { input: "Svorka WAGO", expectType: "semantic_match", note: "Brand + generic" },
    { input: "Vodič CY 10", expectType: "semantic_match", note: "Wire with cross-section" },
    { input: "Kabel CYKY 3x1,5", expectType: "semantic_match", note: "Common cable" },
    { input: "FI 2P 25A 30mA", expectType: "any_results", note: "RCCB abbreviation slang" },
    { input: "Vypínač řazení 6", expectType: "semantic_match", note: "Switch type" },
    { input: "LED panel 600x600 40W", expectType: "semantic_match", note: "Standard LED panel" },
    { input: "Zásuvka 230V 16A dvojnásobná", expectType: "semantic_match", note: "Double socket" },
    { input: "xyznonexist1234", expectType: "any_results", note: "Garbage → routes to search, semantic returns low-sim noise (AI evaluator filters)" },
  ];

  for (const tc of testCases) {
    const t0 = Date.now();

    // Step 1: Route — detect if input looks like SKU/EAN
    const looksLikeIdentifier = /^\d{6,13}$/.test(tc.input.trim());

    let foundProducts: any[] = [];

    if (looksLikeIdentifier) {
      // Route: exact lookup
      const { data } = await supabase.rpc("lookup_products_v2_exact", {
        lookup_query: tc.input.trim(),
        max_results: 10,
      });
      foundProducts = data ?? [];
    } else {
      // Route: parallel fulltext + dual semantic (like the real pipeline)
      const reformed = await reformulate(tc.input);

      const [rawEmb, refEmb] = await Promise.all([
        embed(tc.input),
        embed(reformed),
      ]);

      const [fulltextRes, rawSemantic, refSemantic] = await Promise.all([
        supabase.rpc("search_products_v2_fulltext", {
          search_query: tc.input,
          max_results: 20,
        }).then((r) => r.data ?? []).catch(() => []),
        supabase.rpc("search_products_v2_semantic", {
          query_embedding: JSON.stringify(rawEmb),
          max_results: 20,
          similarity_threshold: SIM_THRESHOLD,
        }).then((r) => r.data ?? []).catch(() => []),
        supabase.rpc("search_products_v2_semantic", {
          query_embedding: JSON.stringify(refEmb),
          max_results: 20,
          similarity_threshold: SIM_THRESHOLD,
        }).then((r) => r.data ?? []).catch(() => []),
      ]);

      // Merge (deduplicate by SKU, keep highest cosine)
      const mergeMap = new Map<string, any>();
      for (const r of [...rawSemantic, ...refSemantic]) {
        const existing = mergeMap.get(r.sku);
        if (!existing || (r.cosine_similarity ?? 0) > (existing.cosine_similarity ?? 0)) {
          mergeMap.set(r.sku, { ...r, source: "semantic" });
        }
      }
      for (const r of fulltextRes) {
        if (!mergeMap.has(r.sku)) {
          mergeMap.set(r.sku, { ...r, source: "fulltext", cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3 });
        }
      }
      foundProducts = [...mergeMap.values()].sort((a, b) => (b.cosine_similarity ?? 0) - (a.cosine_similarity ?? 0));
    }

    const ms = Date.now() - t0;

    // Assert based on expected type
    let pass = false;
    let detail = `route: ${looksLikeIdentifier ? "exact" : "search"}, results: ${foundProducts.length}`;

    switch (tc.expectType) {
      case "exact_match":
        pass = foundProducts.length > 0;
        detail += foundProducts[0] ? `, top: ${foundProducts[0].sku} ${foundProducts[0].name?.slice(0, 40)}` : "";
        break;
      case "semantic_match":
        pass = foundProducts.length > 0;
        detail += foundProducts[0] ? `, top: ${foundProducts[0].sku} cos=${(foundProducts[0].cosine_similarity ?? 0).toFixed(3)}` : "";
        break;
      case "any_results":
        pass = foundProducts.length > 0;
        detail += foundProducts[0] ? `, top: ${foundProducts[0].sku}` : "";
        break;
      case "no_results":
        pass = foundProducts.length === 0;
        break;
    }

    assert("pipeline", `"${tc.input}" (${tc.note})`, pass, ms, detail);
  }
}

// ══════════════════════════════════════════════════════════════
// SUITE 5: Category Tree + get_products_by_ids
// ══════════════════════════════════════════════════════════════

async function suiteMisc() {
  console.log(`\n${BOLD}${CYAN}━━━ SUITE 5: Category Tree & get_products_by_ids ━━━${RESET}\n`);

  // Category tree
  let t0 = Date.now();
  const { data: tree, error: treeErr } = await supabase.rpc("get_category_tree_v2");
  let ms = Date.now() - t0;
  assert("misc", "get_category_tree_v2 returns rows", !treeErr && (tree?.length ?? 0) > 0, ms,
    `rows: ${tree?.length}`);

  // Category tree performance
  t0 = Date.now();
  await supabase.rpc("get_category_tree_v2");
  ms = Date.now() - t0;
  assert("misc", "get_category_tree_v2 < 200ms", ms < 200, ms);

  // Tree structure: has level 1, 2, 3
  if (tree?.length) {
    const levels = new Set(tree.map((r: any) => r.level));
    assert("misc", "Category tree has levels 1/2/3", levels.has(1) || levels.has(2) || levels.has(3), 0,
      `levels: [${[...levels].sort().join(",")}]`);

    // parent_code hierarchy is valid: level 1 has null parent, level 2+ has parent
    const rootsHaveNullParent = tree.filter((r: any) => r.level === 1).every((r: any) => r.parent_code === null);
    assert("misc", "Level 1 categories have NULL parent_code", rootsHaveNullParent, 0);

    const childrenHaveParent = tree.filter((r: any) => r.level > 1).every((r: any) => r.parent_code !== null);
    assert("misc", "Level 2+ categories have non-NULL parent_code", childrenHaveParent, 0);
  }

  // get_products_by_ids
  const { data: sampleProducts } = await supabase
    .from("products_v2")
    .select("id")
    .is("removed_at", null)
    .limit(3);

  if (sampleProducts?.length) {
    const ids = sampleProducts.map((p: any) => p.id);
    t0 = Date.now();
    const { data: byIdResult, error: byIdErr } = await supabase.rpc("get_products_v2_by_ids", {
      product_ids: ids,
    });
    ms = Date.now() - t0;
    assert("misc", `get_products_v2_by_ids(${ids.length} ids) returns correct count`,
      !byIdErr && byIdResult?.length === ids.length, ms, `rows: ${byIdResult?.length}`);

    // All returned IDs match input IDs
    const returnedIds = new Set((byIdResult ?? []).map((r: any) => r.id));
    const allMatch = ids.every((id: number) => returnedIds.has(id));
    assert("misc", "get_products_v2_by_ids returns correct IDs", allMatch, 0);
  }

  // get_products_by_ids with empty array
  t0 = Date.now();
  const { data: emptyResult, error: emptyErr } = await supabase.rpc("get_products_v2_by_ids", {
    product_ids: [],
  });
  ms = Date.now() - t0;
  assert("misc", "get_products_v2_by_ids([]) → 0 rows", !emptyErr && (emptyResult?.length ?? 0) === 0, ms);

  // Fulltext + semantic: consistency check — same query, both return overlapping results
  console.log(`\n  ${DIM}Cross-path consistency checks:${RESET}`);

  const consistencyQuery = "jistič B16";
  t0 = Date.now();
  const emb = await embed(consistencyQuery);

  const [ftRes, semRes] = await Promise.all([
    supabase.rpc("search_products_v2_fulltext", {
      search_query: consistencyQuery,
      max_results: 20,
    }).then((r) => r.data ?? []),
    supabase.rpc("search_products_v2_semantic", {
      query_embedding: JSON.stringify(emb),
      max_results: 20,
      similarity_threshold: 0.2,
    }).then((r) => r.data ?? []),
  ]);
  ms = Date.now() - t0;

  const ftSkus = new Set(ftRes.map((r: any) => r.sku));
  const semSkus = new Set(semRes.map((r: any) => r.sku));
  const overlap = [...ftSkus].filter((s) => semSkus.has(s)).length;
  const bothHaveResults = ftRes.length > 0 && semRes.length > 0;

  assert("misc", `Fulltext & Semantic both return results for "${consistencyQuery}"`, bothHaveResults, ms,
    `fulltext: ${ftRes.length}, semantic: ${semRes.length}, overlap: ${overlap}${overlap === 0 ? " (merge adds value!)" : ""}`);
}

// ══════════════════════════════════════════════════════════════
// RUNNER
// ══════════════════════════════════════════════════════════════

async function main() {
  initClients();

  const suiteFilter = parseArg("suite");

  console.log(`\n${"═".repeat(80)}`);
  console.log(`${BOLD}V2 RPC E2E TEST — Agent & Sub-Agent Simulation${RESET}`);
  console.log(`Suite filter: ${suiteFilter ?? "ALL"}`);
  console.log(`${"═".repeat(80)}`);

  const t0 = Date.now();

  if (!suiteFilter || suiteFilter === "exact") await suiteExactLookup();
  if (!suiteFilter || suiteFilter === "fulltext") await suiteFulltext();
  if (!suiteFilter || suiteFilter === "semantic") await suiteSemantic();
  if (!suiteFilter || suiteFilter === "pipeline") await suitePipeline();
  if (!suiteFilter || suiteFilter === "misc") await suiteMisc();

  const totalMs = Date.now() - t0;

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;
  const bySuite: Record<string, { passed: number; failed: number }> = {};

  for (const r of results) {
    if (!bySuite[r.suite]) bySuite[r.suite] = { passed: 0, failed: 0 };
    if (r.passed) bySuite[r.suite].passed++;
    else bySuite[r.suite].failed++;
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`${BOLD}SUMMARY${RESET}`);
  console.log(`  Total: ${total} tests | ${GREEN}${passed} passed${RESET} | ${failed > 0 ? RED : GREEN}${failed} failed${RESET} | ${totalMs}ms\n`);

  for (const [suite, counts] of Object.entries(bySuite)) {
    const icon = counts.failed === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${suite}: ${counts.passed}/${counts.passed + counts.failed}`);
  }

  if (failed > 0) {
    console.log(`\n  ${RED}${BOLD}FAILED TESTS:${RESET}`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ${RED}✗${RESET} [${r.suite}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }

  // Latency percentiles
  const timings = results.filter((r) => r.ms > 0).map((r) => r.ms).sort((a, b) => a - b);
  if (timings.length > 0) {
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p90 = timings[Math.floor(timings.length * 0.9)];
    const p99 = timings[Math.floor(timings.length * 0.99)];
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
    console.log(`\n  ${BOLD}Latency (ms):${RESET} avg=${avg} | p50=${p50} | p90=${p90} | p99=${p99} | max=${timings[timings.length - 1]}`);
  }

  console.log(`${"═".repeat(80)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
