/**
 * Set Assembly — Integration Test
 *
 * Tests the full flow through the production pipeline:
 *   1. createSearchPlan detects isSet correctly
 *   2. searchPipelineForSet decomposes and finds components
 *   3. extraLookupCodes feed into standard pipeline with MATCHER validation
 *
 * Usage: npx tsx scripts/test-set-integration.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import {
  createSearchPlan,
  searchPipelineForItem,
  searchPipelineForSet,
  type SearchPreferences,
} from "../backend/src/services/searchPipeline.js";

const PREFS: SearchPreferences = {
  offerType: "realizace",
  stockFilter: "any",
  branchFilter: null,
  priceStrategy: "standard",
};

const TEST_ITEMS = [
  { name: "vypínač č.6 Schneider Sedna bílý", unit: "ks", quantity: 3 },
  { name: "rámeček 3-násobný ABB Tango bílý", unit: "ks", quantity: 1 },
  { name: "jistič B16 1P ABB", unit: "ks", quantity: 5 },
  { name: "zásuvka 230V Schneider Sedna bílá", unit: "ks", quantity: 4 },
];

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║     Set Assembly — Integration Test                    ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // Step 1: Planning Agent
  console.log("━━━ KROK 1: createSearchPlan ━━━");
  const t0 = Date.now();
  const plan = await createSearchPlan(TEST_ITEMS, PREFS);
  console.log(`  Plánování: ${Date.now() - t0}ms`);
  console.log(`  Skupiny: ${plan.groups.length}`);

  let setCount = 0;
  let normalCount = 0;

  for (const ei of plan.enrichedItems) {
    const isSet = (ei as { isSet?: boolean }).isSet ?? false;
    const setHint = (ei as { setHint?: string | null }).setHint ?? null;
    const icon = isSet ? "📦" : "📄";
    console.log(`  ${icon} [${isSet ? "SADA" : "item"}] ${ei.name}${isSet ? ` → hint: "${setHint?.slice(0, 60)}"` : ""}`);
    if (isSet) setCount++;
    else normalCount++;
  }
  console.log(`  Celkem: ${setCount} sad, ${normalCount} normálních\n`);

  // Step 2: Process sets and normal items
  console.log("━━━ KROK 2: Pipeline per item ━━━\n");
  const t1 = Date.now();

  for (let i = 0; i < plan.enrichedItems.length; i++) {
    const ei = plan.enrichedItems[i]!;
    const isSet = (ei as { isSet?: boolean }).isSet ?? false;
    const setHint = (ei as { setHint?: string | null }).setHint ?? null;
    const group = plan.groups[ei.groupIndex];
    const gc = group
      ? { preferredManufacturer: group.suggestedManufacturer ?? null, preferredLine: group.suggestedLine ?? null }
      : undefined;

    if (isSet && setHint) {
      console.log(`  📦 [SADA] ${ei.name}`);
      const setResult = await searchPipelineForSet(
        { ...ei, isSet: true, setHint },
        i,
        `parent-${i}`,
        undefined,
        PREFS,
        gc,
      );

      console.log(`     Decomp: ${setResult.decompositionMs}ms | Pipeline: ${setResult.totalPipelineMs}ms`);
      console.log(`     Komponenty (${setResult.components.length}):`);
      for (const comp of setResult.components) {
        const prod = comp.result.product;
        const icon = comp.result.matchType === "match" ? "✅" : comp.result.matchType === "not_found" ? "❌" : "⚠️";
        console.log(`     ${icon} [${comp.role}] ${comp.name}`);
        console.log(`        → ${prod?.name ?? "nenalezeno"} | SKU: ${prod?.sku ?? "–"} | conf: ${comp.result.confidence}%`);
      }
    } else {
      console.log(`  📄 ${ei.name}`);
      const result = await searchPipelineForItem(ei, i, undefined, PREFS, gc);
      const prod = result.product;
      const icon = result.matchType === "match" ? "✅" : result.matchType === "not_found" ? "❌" : "⚠️";
      console.log(`     ${icon} → ${prod?.name ?? "nenalezeno"} | SKU: ${prod?.sku ?? "–"} | conf: ${result.confidence}%`);
    }
    console.log();
  }

  console.log(`\n━━━ SOUHRN ━━━`);
  console.log(`  Celkový čas: ${Date.now() - t0}ms`);
  console.log(`  Pipeline čas: ${Date.now() - t1}ms`);
}

main().catch(console.error);
