/**
 * Phase 3 test: CYSY, cable metráže, parseNumberCzech logic
 *
 * Usage: cd backend && npx tsx ../scripts/test-phase3-cables.ts
 */
import { searchPipelineForItem, type PipelineResult, type PipelineDebugFn } from "../backend/src/services/searchPipeline.js";

// ── parseNumberCzech unit tests (inline, no import needed) ──
function parseNumberCzech(s: string): number {
  const trimmed = s.trim();
  if (trimmed.includes(",")) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".");
    return parseFloat(normalized);
  }
  if (/\.\d{3}$/.test(trimmed) || /\.\d{3}\./.test(trimmed)) {
    return parseFloat(trimmed.replace(/\./g, ""));
  }
  return parseFloat(trimmed);
}

function runParseTests() {
  const cases: [string, number][] = [
    ["1.000", 1000],
    ["1,5", 1.5],
    ["2.5", 2.5],
    ["1.000,50", 1000.5],
    ["1.000.000", 1000000],
    ["100", 100],
    ["0,5", 0.5],
    ["1.500,75", 1500.75],
  ];

  console.log("\n=== parseNumberCzech unit tests ===");
  let pass = 0;
  for (const [input, expected] of cases) {
    const result = parseNumberCzech(input);
    const ok = Math.abs(result - expected) < 0.0001;
    console.log(`  "${input}" → ${result} ${ok ? "✅" : `❌ (expected ${expected})`}`);
    if (ok) pass++;
  }
  console.log(`  Result: ${pass}/${cases.length} passed\n`);
}

// ── Cable pipeline tests ──
const CABLE_QUERIES: Array<{
  name: string;
  unit: string;
  quantity: number;
  expected: string;
}> = [
  {
    name: "kabel CYSY 361 100m",
    unit: "m",
    quantity: 100,
    expected: "CYSY kabel 3x6+1 nebo 3G6, balení 100m nebo buben",
  },
  {
    name: "kabel CYSY 3x2,5 200m",
    unit: "m",
    quantity: 200,
    expected: "CYSY kabel 3x2,5, 2×100m nebo buben",
  },
  {
    name: "CYKY-J 3x2,5 350m",
    unit: "m",
    quantity: 350,
    expected: "CYKY kabel, buben (ne přesný násobek kotoučů)",
  },
  {
    name: "kabel CYKY 3x1,5 100m",
    unit: "m",
    quantity: 100,
    expected: "CYKY kabel 3x1,5, 100m kruh nebo buben",
  },
];

async function runCableTests() {
  console.log("=== Cable pipeline tests ===\n");

  for (const q of CABLE_QUERIES) {
    console.log(`\n──────────────────────────────`);
    console.log(`Query: "${q.name}" (${q.quantity} ${q.unit})`);
    console.log(`Expected: ${q.expected}`);

    const debugLines: string[] = [];
    const onDebug: PipelineDebugFn = (msg, data) => {
      debugLines.push(`  [${msg}]`);
      if (data) {
        const summary = typeof data === "string" ? data : JSON.stringify(data).slice(0, 120);
        debugLines.push(`    ${summary}`);
      }
    };

    try {
      const result: PipelineResult = await searchPipelineForItem(
        { id: "test", name: q.name, unit: q.unit, quantity: q.quantity },
        0,
        onDebug,
        { offerType: "realizace", stockFilter: null, branchFilter: null, priceStrategy: "preferred" },
      );

      console.log(`\nResult:`);
      console.log(`  matchType: ${result.matchType}`);
      console.log(`  confidence: ${result.confidence}`);
      if (result.product) {
        console.log(`  product: ${result.product.name}`);
        console.log(`  unit: ${result.product.unit ?? "?"}`);
        console.log(`  price: ${result.product.current_price ?? "?"}`);
        console.log(`  supplier: ${result.product.supplier_name ?? "?"}`);
        // Check: does the name contain length or BUBEN?
        const name = result.product.name.toLowerCase();
        const hasLength = /\d+\s*m\b/.test(name);
        const hasBuben = name.includes("buben");
        const unitIsM = result.product.unit === "m";
        if (hasLength || hasBuben || unitIsM) {
          console.log(`  ✅ Packaging OK (hasLength=${hasLength}, hasBuben=${hasBuben}, unit=m=${unitIsM})`);
        } else {
          console.log(`  ❌ PACKAGING VIOLATION: product has no length/BUBEN in name and unit≠m!`);
        }
      } else {
        console.log(`  product: not_found`);
      }
      if (result.reasoning) console.log(`  reasoning: ${result.reasoning}`);
      if (result.priceNote) console.log(`  priceNote: ${result.priceNote}`);

      // Print debug summary
      if (debugLines.length > 0) {
        console.log(`\nDebug (last 5):`);
        debugLines.slice(-10).forEach((l) => console.log(l));
      }
    } catch (err) {
      console.error(`  ERROR: ${err}`);
    }
  }

  console.log("\n=== Done ===");
}

runParseTests();
runCableTests().catch(console.error);
