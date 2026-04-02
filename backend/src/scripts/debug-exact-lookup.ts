import "../../src/config/env";
import { lookupProductsExact } from "../services/search";

const tests = [
  { label: "3558N-C01510 (extrahováno ze spinace)", code: "3558N-C01510" },
  { label: "3558N-C01510 S (s mezerou+S)", code: "3558N-C01510 S" },
  { label: "5518-2929S (ABB bez mezery)", code: "5518-2929S" },
  { label: "5518-2929 S (ABB s mezerou)", code: "5518-2929 S" },
  { label: "IS-40/3 (hlavni vypinac)", code: "IS-40/3" },
  { label: "1183636 (SKU primo)", code: "1183636" },
  { label: "1257420007 (SKU EAN)", code: "1257420007" },
];

async function main() {
  for (const t of tests) {
    const results = await lookupProductsExact(t.code, 5);
    console.log(`\n[${t.label}]`);
    if (results.length === 0) {
      console.log("  → NENALEZENO");
    } else {
      for (const r of results) {
        console.log(`  → SKU: ${r.sku} | ${r.name} | matchType: ${r.matchType} | score: ${r.score}`);
      }
    }
  }
}
main().catch(console.error);
