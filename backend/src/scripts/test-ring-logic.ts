import "dotenv/config";
import { searchPipelineForItem } from "../services/searchPipeline";

const prefs = { offerType: "realizace" as const, stockFilter: "stock_items_only" as const };

const tests = [
  { name: "CYKY-J 3x2,5", qty: 50,  unit: "m", label: "50m → KRUH 50M expected" },
  { name: "CYKY-J 3x2,5", qty: 100, unit: "m", label: "100m → KRUH 100M expected (ne 4×25M)" },
  { name: "CYKY-J 3x2,5", qty: 200, unit: "m", label: "200m → KRUH 100M (×2) expected" },
  { name: "CYKY-J 3x2,5", qty: 690, unit: "m", label: "690m → BUBEN (690/100=6.9, nedělitelné!)" },
  { name: "CYKY-J 3x2,5", qty: 75,  unit: "m", label: "75m → BUBEN (75/50=1.5, nedělitelné)" },
  { name: "CYKY-J 3x1,5", qty: 386, unit: "m", label: "386m → BUBEN (386 není násobek žádného kruhu)" },
];

async function main() {
  for (const t of tests) {
    console.log("─".repeat(60));
    console.log(`TEST: ${t.label}`);
    try {
      const r = await searchPipelineForItem(
        { name: t.name, unit: t.unit, quantity: t.qty },
        prefs,
      );
      const pkg = (r.product?.name || "").match(/KRUH \d+M|BUBEN(?: NEVRATNY)?/i)?.[0] || "?";
      const status = r.product ? `SKU: ${r.product.sku}` : "nenalezeno";
      console.log(`  Výsledek: ${pkg} | ${status}`);
      console.log(`  Název: ${r.product?.name?.slice(0, 70) || "—"}`);
      console.log(`  matchType: ${r.matchType} | confidence: ${r.confidence}%`);
      console.log(`  Reasoning: ${r.reasoning?.slice(0, 150)}`);
    } catch (e: unknown) {
      console.error("  ERROR:", (e as Error).message);
    }
    console.log();
  }
}

main().catch(console.error);
