/**
 * MATCHER Validation Test
 *
 * Ověřuje, že MATCHER správně vyhodnotí kandidáty z extraLookupCodes:
 *   ✅ Správný kód (Sedna SDN0100121) → MATCHER přijme
 *   ❌ Špatný kód (Gira 310600 = UPS baterie) → MATCHER odmítne
 *   📊 Bez kódu (pouze sémantika) → baseline
 *
 * Usage: npx tsx scripts/test-matcher-validation.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import {
  searchPipelineForItem,
  type SearchPreferences,
} from "../backend/src/services/searchPipeline.js";

const PREFS: SearchPreferences = {
  offerType: "realizace",
  stockFilter: "any",
  branchFilter: null,
  priceStrategy: "standard",
};

const TEST_CASES = [
  {
    label: "Sedna strojek — SPRÁVNÝ kód SDN0100121",
    item: {
      name: "strojek spínače č.1 Schneider Sedna bílý",
      unit: "ks",
      quantity: 1,
      extraLookupCodes: ["SDN0100121"],
    },
    expectMatch: true,
  },
  {
    label: "Gira strojek — ŠPATNÝ kód 310600 (UPS baterie)",
    item: {
      name: "strojek spínače č.1 Gira System 55 bílý",
      unit: "ks",
      quantity: 1,
      extraLookupCodes: ["310600"],
    },
    expectMatch: false,
  },
  {
    label: "Gira rámeček — SPRÁVNÝ kód 021103",
    item: {
      name: "rámeček 1-násobný Gira System 55 bílý",
      unit: "ks",
      quantity: 1,
      extraLookupCodes: ["021103"],
    },
    expectMatch: true,
  },
  {
    label: "Sedna strojek — BEZ kódu (baseline sémantika)",
    item: {
      name: "strojek spínače č.1 Schneider Sedna bílý",
      unit: "ks",
      quantity: 1,
    },
    expectMatch: true,
  },
];

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║        MATCHER Validation — extraLookupCodes          ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  let passed = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]!;
    console.log(`\n[${i + 1}/${TEST_CASES.length}] ${tc.label}`);
    console.log(`  Hledám: "${tc.item.name}"`);
    if (tc.item.extraLookupCodes) {
      console.log(`  Extra kódy: ${tc.item.extraLookupCodes.join(", ")}`);
    }

    const t0 = Date.now();
    const result = await searchPipelineForItem(tc.item, i, undefined, PREFS);
    const ms = Date.now() - t0;

    const matched = result.matchType === "match";
    const icon = matched === tc.expectMatch ? "✅" : "❌ FAIL";
    const productName = result.product?.name ?? "–";
    const sku = result.product?.sku ?? "–";

    console.log(`  ${icon} matchType: ${result.matchType} | conf: ${result.confidence}% | ${ms}ms`);
    console.log(`  Produkt: ${productName} (SKU: ${sku})`);
    console.log(`  Reasoning: ${(result.reasoning ?? "–").slice(0, 120)}`);

    if (matched === tc.expectMatch) {
      passed++;
    } else {
      console.log(`  ⚠️  Očekáváno: ${tc.expectMatch ? "MATCH" : "NO MATCH"}`);
    }
  }

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Výsledek: ${passed}/${TEST_CASES.length} prošlo`);

  if (passed === TEST_CASES.length) {
    console.log("🎉 Všechny testy prošly — MATCHER správně validuje extraLookupCodes");
  } else {
    console.log("⚠️  Některé testy selhaly — MATCHER potřebuje ladění");
  }
}

main().catch(console.error);
