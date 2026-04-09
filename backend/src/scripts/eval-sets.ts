/**
 * eval-sets.ts
 *
 * Test úspěšnosti vyhledávání sad z Knowledge Base.
 * Porovnává nalezená SKU produktů s očekávanými SKU z eval-sets.xlsx.
 *
 * Spuštění: npx tsx src/scripts/eval-sets.ts [--series ABB] [--color bílá] [--verbose]
 */

import { lookupProductsExact } from "../services/search.js";
import { lookupInKB } from "../services/kitKnowledgeBase.js";
import { invalidateKBCache } from "../services/kitKnowledgeBase.js";

// ── Test data ─────────────────────────────────────────────────────────────────
// Parsovaná data z eval-sets.xlsx
// Format: [setHint, functionType, expectedSkus[]]
// expectedSkus jsou katalogová čísla (products_v2.sku)
type TestCase = {
  brand: string;
  series: string;
  color: string;
  functionType: string;
  expectedSkus: string[];
};

const TEST_CASES: TestCase[] = [
  // ABB Tango bílá
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1183318","1195604","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Vypínač č.5 sčítkový", expectedSkus:["1183320","1188793","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Vypínač č.6 schodový přepínač", expectedSkus:["1183315","1195604","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Vypínač č.7 křížový", expectedSkus:["1183316","1195604","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Vypínač č.6+6 kolébkový", expectedSkus:["1177914","1188793","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Tlačítko", expectedSkus:["1213349","1195604","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Termostat podlahový analogový", expectedSkus:["1163106","1161164","1188530","1182855"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Termostat prostorový analogový", expectedSkus:["1163106","1161164","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["2002968","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Zásuvka 230V 2-násobná", expectedSkus:["1215381"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"Datová zásuvka RJ45 jednoduchá", expectedSkus:["1187428","1186622","1858654","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"TV/SAT zásuvka koncová", expectedSkus:["1188082","1180717","1188530"] },
  { brand:"ABB", series:"Tango", color:"bílá", functionType:"TV/SAT zásuvka průběžná", expectedSkus:["1209821","1180717","1188530"] },

  // ABB Tango černá
  { brand:"ABB", series:"Tango", color:"černá", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1183318","1188792","1188529"] },
  { brand:"ABB", series:"Tango", color:"černá", functionType:"Vypínač č.5 sčítkový", expectedSkus:["1183320","1188791","1188529"] },
  { brand:"ABB", series:"Tango", color:"černá", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["2002970","1188529"] },
  { brand:"ABB", series:"Tango", color:"černá", functionType:"Zásuvka 230V 2-násobná", expectedSkus:["1213427"] },
  { brand:"ABB", series:"Tango", color:"černá", functionType:"Datová zásuvka RJ45 jednoduchá", expectedSkus:["1187427","1186622","1858654","1188529"] },
  { brand:"ABB", series:"Tango", color:"černá", functionType:"TV/SAT zásuvka koncová", expectedSkus:["1188082","1190874","1188529"] },

  // Schneider Unica bílá
  { brand:"Schneider", series:"Unica", color:"bílá", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1794774","1794521","1795119"] },
  { brand:"Schneider", series:"Unica", color:"bílá", functionType:"Vypínač č.5 sčítkový", expectedSkus:["1794829","1794521","1795119"] },
  { brand:"Schneider", series:"Unica", color:"bílá", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["1794686","1794521","1795119"] },
  { brand:"Schneider", series:"Unica", color:"bílá", functionType:"Datová zásuvka RJ45 jednoduchá", expectedSkus:["1794889","1794521","1795119"] },
  { brand:"Schneider", series:"Unica", color:"bílá", functionType:"TV/SAT zásuvka koncová", expectedSkus:["1794958","1794521","1795119"] },

  // Schneider Unica antracit
  { brand:"Schneider", series:"Unica", color:"antracit", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1794780","1794524","1795119"] },
  { brand:"Schneider", series:"Unica", color:"antracit", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["1794692","1794524","1795119"] },

  // Legrand Valena bílá
  { brand:"Legrand", series:"Valena", color:"bílá", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1301679","1301883"] },
  { brand:"Legrand", series:"Valena", color:"bílá", functionType:"Vypínač č.5 sčítkový", expectedSkus:["1301683","1301883"] },
  { brand:"Legrand", series:"Valena", color:"bílá", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["1301821","1301883"] },
  { brand:"Legrand", series:"Valena", color:"bílá", functionType:"Datová zásuvka RJ45 jednoduchá", expectedSkus:["1302001","1301883"] },
  { brand:"Legrand", series:"Valena", color:"bílá", functionType:"TV/SAT zásuvka koncová", expectedSkus:["1301809","1301883"] },

  // Legrand Valena černá
  { brand:"Legrand", series:"Valena", color:"černá", functionType:"Vypínač č.1 jednopólový", expectedSkus:["1939581","1754174"] },
  { brand:"Legrand", series:"Valena", color:"černá", functionType:"Zásuvka 230V 1-násobná", expectedSkus:["1939467","1754174"] },
];

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const filterSeries = args.find((a) => a.startsWith("--series="))?.split("=")[1];
const filterColor = args.find((a) => a.startsWith("--color="))?.split("=")[1];

// ── Resolve SKU from manufacturer_code via lookup ─────────────────────────────
async function resolveComponentSkus(manufacturerCodes: (string | null)[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const code of manufacturerCodes) {
    if (!code) continue;
    try {
      const results = await lookupProductsExact(code, 3);
      if (results.length > 0) resolved.push(results[0].sku);
    } catch {
      // ignore lookup errors
    }
  }
  return resolved;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== EVAL SAD — test úspěšnosti KB lookupů ===\n");

  // Force fresh KB data
  invalidateKBCache();

  const cases = TEST_CASES.filter((tc) => {
    if (filterSeries && tc.series !== filterSeries) return false;
    if (filterColor && tc.color !== filterColor) return false;
    return true;
  });

  console.log(`Testuje se ${cases.length} sad\n`);

  let totalComponents = 0;
  let foundComponents = 0;
  let perfectCases = 0;
  let partialCases = 0;
  let failedCases = 0;

  for (const tc of cases) {
    const setHint = `${tc.brand} ${tc.series} ${tc.color}`;
    const label = `${setHint} — ${tc.functionType}`;

    const kbResult = await lookupInKB(tc.functionType, setHint);

    if (!kbResult) {
      console.log(`❌ MISS  ${label}`);
      console.log(`   KB: nenalezeno`);
      failedCases++;
      totalComponents += tc.expectedSkus.length;
      continue;
    }

    // Resolve manufacturer_codes → SKUs
    const resolvedSkus = await resolveComponentSkus(
      kbResult.components.map((c) => c.manufacturerCode)
    );

    const expectedSet = new Set(tc.expectedSkus);
    const foundSet = new Set(resolvedSkus);
    const hits = tc.expectedSkus.filter((sku) => foundSet.has(sku));
    const missing = tc.expectedSkus.filter((sku) => !foundSet.has(sku));
    const extra = resolvedSkus.filter((sku) => !expectedSet.has(sku));

    totalComponents += tc.expectedSkus.length;
    foundComponents += hits.length;

    const allFound = missing.length === 0;
    const anyFound = hits.length > 0;

    if (allFound) {
      perfectCases++;
      if (verbose) {
        console.log(`✅ OK    ${label}`);
        console.log(`   KB match: ${kbResult.functionTypeName}`);
        console.log(`   Nalezeno: ${resolvedSkus.join(", ")}`);
        if (extra.length > 0) console.log(`   Extra: ${extra.join(", ")}`);
      } else {
        console.log(`✅ ${label}`);
      }
    } else if (anyFound) {
      partialCases++;
      console.log(`⚠️  PARTIAL ${label}`);
      console.log(`   KB match: ${kbResult.functionTypeName}`);
      console.log(`   Nalezeno: ${resolvedSkus.join(", ")}`);
      console.log(`   Chybí: ${missing.join(", ")}`);
      if (extra.length > 0) console.log(`   Extra: ${extra.join(", ")}`);
    } else {
      failedCases++;
      console.log(`❌ FAIL  ${label}`);
      console.log(`   KB match: ${kbResult.functionTypeName}`);
      console.log(`   Nalezeno: ${resolvedSkus.join(", ")}`);
      console.log(`   Chybí: ${missing.join(", ")}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("VÝSLEDKY");
  console.log("═".repeat(60));
  const total = cases.length;
  const componentRate = totalComponents > 0 ? (foundComponents / totalComponents * 100).toFixed(1) : "0.0";
  const caseRate = total > 0 ? (perfectCases / total * 100).toFixed(1) : "0.0";
  console.log(`Sady:        ✅ ${perfectCases}/${total} perfektní (${caseRate}%)  ⚠️  ${partialCases} částečné  ❌ ${failedCases} chybí`);
  console.log(`Komponenty:  ${foundComponents}/${totalComponents} nalezeno (${componentRate}%)`);
  console.log("═".repeat(60));

  if (perfectCases === total) {
    console.log("🎉 Všechny sady nalezeny perfektně!");
  } else if (perfectCases + partialCases === total) {
    console.log("📊 Všechny sady nalezeny alespoň částečně.");
  }
}

main().catch((err) => {
  console.error("Chyba:", err);
  process.exit(1);
});
