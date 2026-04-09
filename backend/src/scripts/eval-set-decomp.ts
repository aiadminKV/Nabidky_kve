/**
 * eval-set-decomp.ts
 *
 * Tests the set decomposition agent (decomposeSet + searchPipelineForSet)
 * on real-world Czech electrical installation items (domovní přístroje).
 *
 * Run: npx tsx src/scripts/eval-set-decomp.ts
 */

import "dotenv/config";
import { decomposeSet, searchPipelineForSet } from "../services/searchPipeline.js";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { SearchPreferences } from "../services/types.js";

const prefs: SearchPreferences = { stockFilter: "stock_items_only", branchFilter: null };

interface TestCase {
  label: string;
  name: string;
  setHint: string;
  quantity: number;
  unit: string;
  /** Expected roles in output (used for assertion) */
  expectedRoles?: string[];
  /** Expected component count (min) */
  minComponents?: number;
}

const TESTS: TestCase[] = [
  // ── ABB ─────────────────────────────────────────────────────────────────────
  {
    label: "ABB Levit bílý - jednopólový vypínač",
    name: "Jednopólový vypínač ABB Levit bílý",
    setHint: "ABB Levit",
    quantity: 1,
    unit: "sada",
    expectedRoles: ["mechanism", "cover", "frame"],
    minComponents: 2,
  },
  {
    label: "ABB Levit - zásuvka 230V s uzemněním",
    name: "Zásuvka 230V s uzemněním ABB Levit bílá",
    setHint: "ABB Levit",
    quantity: 1,
    unit: "sada",
    expectedRoles: ["mechanism", "frame"],
    minComponents: 2,
  },
  {
    label: "ABB Tango - schodišťový přepínač",
    name: "Schodišťový přepínač ABB Tango bílý",
    setHint: "ABB Tango",
    quantity: 1,
    unit: "sada",
    minComponents: 2,
  },

  // ── Schneider Electric ───────────────────────────────────────────────────────
  {
    label: "Schneider Sedna - jednopólový vypínač bílý",
    name: "Jednopólový vypínač Schneider Sedna bílý",
    setHint: "Schneider Sedna",
    quantity: 1,
    unit: "sada",
    expectedRoles: ["mechanism", "frame"],
    minComponents: 2,
  },
  {
    label: "Schneider Sedna - zásuvka 230V",
    name: "Zásuvka 230V Schneider Sedna bílá",
    setHint: "Schneider Sedna",
    quantity: 1,
    unit: "sada",
    minComponents: 2,
  },
  {
    label: "Schneider Unica - vypínač",
    name: "Jednopólový vypínač Schneider Unica bílý",
    setHint: "Schneider Unica",
    quantity: 1,
    unit: "sada",
    minComponents: 2,
  },

  // ── Legrand ──────────────────────────────────────────────────────────────────
  {
    label: "Legrand Mosaic - vypínač 1-pólový",
    name: "Vypínač jednopólový Legrand Mosaic bílý",
    setHint: "Legrand Mosaic",
    quantity: 1,
    unit: "sada",
    expectedRoles: ["mechanism", "frame"],
    minComponents: 2,
  },
  {
    label: "Legrand Niloe - zásuvka USB",
    name: "Zásuvka USB nabíječka Legrand Niloe Step bílá",
    setHint: "Legrand Niloe Step",
    quantity: 1,
    unit: "sada",
    minComponents: 1,
  },

  // ── Hager ────────────────────────────────────────────────────────────────────
  {
    label: "Hager Kallysta - jednopólový vypínač",
    name: "Jednopólový vypínač Hager Kallysta bílý",
    setHint: "Hager Kallysta",
    quantity: 1,
    unit: "sada",
    minComponents: 2,
  },

  // ── Bez výrobce (obecné) ──────────────────────────────────────────────────────
  {
    label: "Obecný - lustrový spínač (bez výrobce)",
    name: "Lustrový spínač bílý",
    setHint: "",
    quantity: 1,
    unit: "sada",
    minComponents: 1,
  },
  {
    label: "Obecný - zásuvka TV/SAT",
    name: "Zásuvka TV/SAT průchozí bílá",
    setHint: "",
    quantity: 1,
    unit: "sada",
    minComponents: 1,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function pad(s: string, n: number) {
  return s.padEnd(n, " ").slice(0, n);
}

function colorize(text: string, ok: boolean): string {
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  return `${ok ? GREEN : RED}${text}${RESET}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runDecompOnly() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  PHASE 1 — Decomposition only (decomposeSet)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    console.log(`▶ ${test.label}`);
    console.log(`  Produkt: "${test.name}"  |  Hint: "${test.setHint}"`);

    try {
      const { components, ms } = await decomposeSet(test.name, test.setHint);

      console.log(`  Čas: ${ms}ms  |  Komponent: ${components.length}`);

      if (components.length === 0) {
        console.log(colorize("  ✗ Žádné komponenty vráceny", false));
        failed++;
      } else {
        const minOk = !test.minComponents || components.length >= test.minComponents;

        for (const comp of components) {
          const codeStr = comp.manufacturerCode ? `kód: ${comp.manufacturerCode}` : "kód: null";
          const eanStr = comp.ean ? `EAN: ${comp.ean}` : "";
          console.log(
            `  • [${pad(comp.role, 9)}] ${pad(comp.name.slice(0, 55), 55)} | ${codeStr}${eanStr ? " | " + eanStr : ""}`,
          );
        }

        // Check expected roles
        let rolesOk = true;
        if (test.expectedRoles) {
          const gotRoles = components.map((c) => c.role);
          for (const r of test.expectedRoles) {
            if (!gotRoles.includes(r)) {
              rolesOk = false;
              console.log(colorize(`  ⚠ Chybí role: ${r}`, false));
            }
          }
        }

        if (minOk && rolesOk) {
          console.log(colorize("  ✓ OK", true));
          passed++;
        } else {
          if (!minOk) console.log(colorize(`  ✗ Příliš málo komponent (min ${test.minComponents})`, false));
          failed++;
        }
      }
    } catch (e) {
      console.log(colorize(`  ✗ ERROR: ${(e as Error).message}`, false));
      failed++;
    }

    console.log();
  }

  console.log(`─────────────────────────────────────────────────`);
  console.log(`Výsledek: ${colorize(`${passed} ✓`, passed > 0)} / ${TESTS.length} testů`);
  console.log(`Chyby: ${colorize(`${failed} ✗`, failed === 0)}`);
  return { passed, failed };
}

async function runFullPipeline(testIndex: number) {
  const test = TESTS[testIndex];
  if (!test) {
    console.error(`Test index ${testIndex} neexistuje`);
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  PHASE 2 — Plný pipeline test: ${test.label}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const parentItemId = crypto.randomUUID();

  try {
    const result = await searchPipelineForSet(
      { name: test.name, unit: test.unit, quantity: test.quantity, isSet: true, setHint: test.setHint },
      0,
      parentItemId,
      (entry) => {
        if (["set_decompose_start", "set_decompose_done", "set_fallback_single"].includes(entry.step)) {
          console.log(`  [DEBUG] ${entry.step}:`, JSON.stringify(entry.data, null, 2).slice(0, 300));
        }
      },
      prefs,
      undefined,
      // V2 pipeline for components — same as production
      (compItem, pos, dbg, p, gc) => searchPipelineV2ForItem(compItem, pos, dbg, p, gc),
    );

    console.log(`\nSada: "${result.originalName}"`);
    console.log(`Komponent: ${result.components.length}  |  Celkový čas: ${result.totalPipelineMs}ms`);
    console.log();

    for (const comp of result.components) {
      const r = comp.result;
      const found = r.product ? `✓ ${r.product.name?.slice(0, 60)} (SKU: ${r.product.sku})` : "✗ nenalezeno";
      const matchStr = `${r.matchType} ${r.confidence}%`;
      console.log(`  [${pad(comp.role, 9)}] ${pad(comp.name.slice(0, 40), 40)}`);
      console.log(`           → ${found}`);
      console.log(`           Shoda: ${matchStr} | kód: ${comp.manufacturerCode ?? "null"}`);
      console.log();
    }
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "full") {
  const idx = parseInt(args[1] ?? "0", 10);
  runFullPipeline(idx).catch(console.error);
} else {
  runDecompOnly().then(({ failed }) => {
    if (failed > 0) process.exit(1);
  }).catch(console.error);
}
