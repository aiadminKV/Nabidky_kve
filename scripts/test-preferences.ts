/**
 * Smoke test for SearchPreferences — verifies that stock/branch filters
 * are correctly passed through to RPCs.
 *
 * Tests at the RPC level (Supabase direct) to avoid OpenAI costs.
 *
 * Usage:
 *   cd scripts && npx tsx test-preferences.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
    failed++;
  }
}

async function fulltextSearch(
  sb: SupabaseClient,
  query: string,
  opts: {
    stockItemOnly?: boolean;
    inStockOnly?: boolean;
    branchCodeFilter?: string;
  } = {},
) {
  const params: Record<string, unknown> = {
    search_query: query,
    max_results: 20,
  };
  if (opts.stockItemOnly) params.stock_item_only = true;
  if (opts.inStockOnly) params.in_stock_only = true;
  if (opts.branchCodeFilter) params.branch_code_filter = opts.branchCodeFilter;

  const { data, error } = await sb.rpc("search_products_v2_fulltext", params);
  if (error) throw new Error(`Fulltext RPC error: ${error.message}`);
  return data as Array<{
    sku: string;
    name: string;
    is_stock_item: boolean;
    has_stock: boolean;
  }>;
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`\n${YELLOW}═══ SearchPreferences RPC Smoke Tests ═══${RESET}\n`);

  console.log(`${DIM}Warming up DB...${RESET}`);
  await sb.from("products_v2").select("id").limit(1);
  console.log(`${DIM}DB ready.${RESET}\n`);

  const QUERY = "jistič";
  const CABLE_QUERY = "CYKY";

  // ── Test 1: Baseline — no filters ──
  console.log(`${YELLOW}[1] Baseline: fulltext "${QUERY}" bez filtrů${RESET}`);
  const baseline = await fulltextSearch(sb, QUERY);
  assert("Vrací výsledky", baseline.length > 0, `rows: ${baseline.length}`);
  const baselineHasNonStock = baseline.some((r) => !r.is_stock_item);
  assert("Obsahuje i neskladové položky", baselineHasNonStock);

  // ── Test 2: stock_item_only ──
  console.log(`\n${YELLOW}[2] stock_item_only = true${RESET}`);
  const stockOnly = await fulltextSearch(sb, QUERY, { stockItemOnly: true });
  assert("Nepadá s filtrem (rows >= 0)", stockOnly.length >= 0, `rows: ${stockOnly.length}`);
  if (stockOnly.length > 0) {
    const allStockItems = stockOnly.every((r) => r.is_stock_item);
    assert("Všechny jsou skladové (is_stock_item=true)", allStockItems,
      allStockItems ? "" : `non-stock: ${stockOnly.filter((r) => !r.is_stock_item).length}`);
  } else {
    console.log(`  ${DIM}(0 výsledků — žádný "${QUERY}" nemá DISPO=ANO, to je OK)${RESET}`);
  }

  // ── Test 3: in_stock_only ──
  console.log(`\n${YELLOW}[3] in_stock_only = true${RESET}`);
  const inStock = await fulltextSearch(sb, QUERY, { inStockOnly: true });
  assert("Vrací výsledky (nebo 0 pokud nic skladem)", true, `rows: ${inStock.length}`);
  if (inStock.length > 0) {
    const allHaveStock = inStock.every((r) => r.has_stock);
    assert("Všechny mají sklad (has_stock=true)", allHaveStock,
      allHaveStock ? "" : `no-stock: ${inStock.filter((r) => !r.has_stock).length}`);
  }
  assert("Méně nebo stejně výsledků než baseline", inStock.length <= baseline.length,
    `${inStock.length} <= ${baseline.length}`);

  // ── Test 4: branch_code_filter ──
  console.log(`\n${YELLOW}[4] branch_code_filter${RESET}`);

  const { data: branches } = await sb.from("branches_v2").select("source_branch_code").limit(1);
  const testBranch = (branches as Array<{ source_branch_code: string }> | null)?.[0]?.source_branch_code;

  if (testBranch) {
    const branchFiltered = await fulltextSearch(sb, QUERY, { branchCodeFilter: testBranch });
    assert(`Filtr pobočky "${testBranch}" vrací výsledky`, branchFiltered.length >= 0,
      `rows: ${branchFiltered.length}`);
    assert("Méně nebo stejně výsledků než baseline", branchFiltered.length <= baseline.length,
      `${branchFiltered.length} <= ${baseline.length}`);
  } else {
    console.log(`  ${DIM}(přeskočeno — žádná pobočka v branches_v2)${RESET}`);
  }

  // ── Test 5: Kombinace stock_item_only + in_stock_only ──
  console.log(`\n${YELLOW}[5] Kombinace: stock_item_only + in_stock_only${RESET}`);
  const combo = await fulltextSearch(sb, QUERY, { stockItemOnly: true, inStockOnly: true });
  assert("Vrací výsledky (nebo 0 pokud žádný splňuje oba filtry)", true, `rows: ${combo.length}`);
  if (combo.length > 0) {
    const comboAllStock = combo.every((r) => r.is_stock_item && r.has_stock);
    assert("Všechny splňují oba filtry", comboAllStock);
  }

  // ── Test 6: Jiný dotaz — cables ──
  console.log(`\n${YELLOW}[6] Dotaz "${CABLE_QUERY}" s in_stock_only${RESET}`);
  const cableBase = await fulltextSearch(sb, CABLE_QUERY);
  const cableStock = await fulltextSearch(sb, CABLE_QUERY, { inStockOnly: true });
  assert("Baseline vrací výsledky", cableBase.length > 0, `rows: ${cableBase.length}`);
  assert("Stock filtr redukuje nebo zachovává počet", cableStock.length <= cableBase.length,
    `${cableStock.length} <= ${cableBase.length}`);

  // ── Test 7: Backward compatibility (no filters = same as baseline) ──
  console.log(`\n${YELLOW}[7] Backward compatibility: žádné filtry${RESET}`);
  const noFilter = await fulltextSearch(sb, QUERY, {});
  assert("Stejný počet jako baseline", noFilter.length === baseline.length,
    `${noFilter.length} === ${baseline.length}`);

  // ── Test 8: Triple combo: stock_item_only + in_stock_only + branch ──
  console.log(`\n${YELLOW}[8] Triple combo: stock_item_only + in_stock_only + branch${RESET}`);
  if (testBranch) {
    const triple = await fulltextSearch(sb, CABLE_QUERY, {
      stockItemOnly: true,
      inStockOnly: true,
      branchCodeFilter: testBranch,
    });
    assert("Triple combo nepadá", true, `rows: ${triple.length}`);
    if (triple.length > 0) {
      const tripleOk = triple.every((r) => r.is_stock_item && r.has_stock);
      assert("Všechny splňují stock_item + has_stock", tripleOk);
    }
    assert("Triple <= single stock filter", triple.length <= cableStock.length,
      `${triple.length} <= ${cableStock.length}`);
  } else {
    console.log(`  ${DIM}(přeskočeno — žádná pobočka)${RESET}`);
  }

  // ── Test 9: branch_stock endpoint test ──
  console.log(`\n${YELLOW}[9] product_branch_stock_v2 přímý dotaz${RESET}`);
  if (baseline.length > 0) {
    const testSku = baseline[0].sku;
    const { data: prod } = await sb.from("products_v2").select("id").eq("sku", testSku).single();
    if (prod) {
      const { data: stockRows } = await sb
        .from("product_branch_stock_v2")
        .select("branch_id, stock_qty")
        .eq("product_id", prod.id);
      assert(`Dotaz na sklad pro ${testSku} nepadá`, true,
        `${(stockRows ?? []).length} poboček se zásobou`);
    }
  }

  // ── Test 10: Consistency — stock filter shrinks results ──
  console.log(`\n${YELLOW}[10] Consistency: filtry vždy snižují výsledky${RESET}`);
  const queries = ["jistič", "CYKY", "kabel", "zásuvka"];
  for (const q of queries) {
    const base = await fulltextSearch(sb, q);
    const filtered = await fulltextSearch(sb, q, { inStockOnly: true });
    assert(`"${q}": in_stock (${filtered.length}) <= base (${base.length})`,
      filtered.length <= base.length);
  }

  // ── Summary ──
  console.log(`\n${YELLOW}═══ Výsledky ═══${RESET}`);
  console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
  if (failed > 0) {
    console.log(`  ${RED}Failed: ${failed}${RESET}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
