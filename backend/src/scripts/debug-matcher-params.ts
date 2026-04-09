import "../../src/config/env";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";

// Suite B problémové případy — co MATCHER dostane a co vrátí
const cases = [
  {
    label: "Zasuvka 32A 3pol → 5P (1146803) nesmí projít",
    item: { name: "ZASUVKA PRUMYSLOVA 32A 3-POLOVA IP44", unit: "ks", quantity: 1 },
    badSku: "1146803",
    goodSku: "1206144",
  },
  {
    label: "JXFE-R 3x2x0,8 → 2x2x0,8 nesmí projít",
    item: { name: "JXFE-R 3x2x0,8 signalizacni kabel", unit: "m", quantity: 100 },
    badSku: "1948632",
  },
  {
    label: "AKU35/5 → AKU70/5 nesmí projít",
    item: { name: "akumulatorova baterie AKU35/5", unit: "ks", quantity: 2 },
    badSku: "1004905",
    goodSku: "1752181",
  },
];

async function main() {
  for (const c of cases) {
    console.log(`\n=== ${c.label} ===`);
    const result = await searchPipelineV2ForItem(c.item, 0, (dbg) => {
      if (dbg.step === "matcher") {
        console.log(`  MATCHER shortlist (${dbg.data.shortlistSize}):`);
        const sl = dbg.data as { shortlistSize: number; reasoning: string; topMatch: { sku: string; matchScore: number; reasoning: string } | null };
        if (sl.topMatch) console.log(`    top: SKU ${sl.topMatch.sku} score=${sl.topMatch.matchScore} | ${sl.topMatch.reasoning}`);
        console.log(`  reasoning: ${sl.reasoning}`);
      }
    });
    console.log(`  → selected: ${result.product?.sku ?? "null"} | matchType: ${result.matchType} | conf: ${result.confidence}%`);
    console.log(`  → candidates: [${result.candidates.map(c => c.sku).join(", ")}]`);
    if (c.badSku) {
      const inCandidates = result.candidates.some(r => r.sku === c.badSku);
      console.log(`  → Bad SKU ${c.badSku} in candidates: ${inCandidates ? "ANO ❌" : "NE ✓"}`);
    }
  }
}
main().catch(console.error);
