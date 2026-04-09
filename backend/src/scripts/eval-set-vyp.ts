/**
 * eval-set-vyp.ts
 *
 * Testuje rozklad sady "vypínač" napříč výrobci.
 * Každý výrobce má jinou logiku — strojek + kryt + rámeček nebo strojek + rámeček.
 *
 * Run: npx tsx src/scripts/eval-set-vyp.ts
 */

import "dotenv/config";
import { searchPipelineForSet } from "../services/searchPipeline.js";
import { searchPipelineV2ForItem } from "../services/searchPipelineV2.js";
import type { SearchPreferences } from "../services/types.js";

const prefs: SearchPreferences = { stockFilter: "stock_items_only", branchFilter: null };

interface TestCase {
  label: string;
  name: string;
  setHint: string;
}

const TESTS: TestCase[] = [
  { label: "ABB Tango bílý",            name: "Vypínač ABB Tango bílý",                    setHint: "ABB Tango" },
  { label: "ABB Levit bílý",            name: "Jednopólový vypínač ABB Levit bílý",         setHint: "ABB Levit" },
  { label: "Schneider Sedna bílý",      name: "Jednopólový vypínač Schneider Sedna bílý",   setHint: "Schneider Sedna" },
  { label: "Schneider Unica bílý",      name: "Jednopólový vypínač Schneider Unica bílý",   setHint: "Schneider Unica" },
  { label: "Legrand Mosaic bílý",       name: "Jednopólový vypínač Legrand Mosaic bílý",    setHint: "Legrand Mosaic" },
  { label: "Legrand Niloe bílý",        name: "Jednopólový vypínač Legrand Niloe bílý",     setHint: "Legrand Niloe" },
  { label: "Hager Kallysta bílý",       name: "Jednopólový vypínač Hager Kallysta bílý",    setHint: "Hager Kallysta" },
  { label: "Hager Systo bílý",          name: "Jednopólový vypínač Hager Systo bílý",       setHint: "Hager Systo" },
  { label: "Jung AS 500 bílý",          name: "Jednopólový vypínač Jung AS 500 bílý",       setHint: "Jung AS 500" },
  { label: "Gira System 55 bílý",       name: "Jednopólový vypínač Gira System 55 bílý",    setHint: "Gira System 55" },
];

// ── ANSI ─────────────────────────────────────────────────────────────────────
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[34m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

function matchColor(type: string) {
  if (type === "match") return G;
  if (type === "uncertain" || type === "alternative") return Y;
  return R;
}

function roleIcon(role: string) {
  switch (role) {
    case "mechanism": return "⚙";
    case "cover":     return "▣";
    case "frame":     return "⬜";
    default:          return "•";
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RST}`);
  console.log(`${BOLD}  Full pipeline — vypínač napříč výrobci${RST}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RST}\n`);

  let totalFound = 0;
  let totalComps = 0;
  const summary: { label: string; found: number; total: number; ms: number }[] = [];

  for (const test of TESTS) {
    console.log(`${BOLD}▶ ${test.label}${RST}  ${DIM}(${test.name})${RST}`);

    const parentItemId = crypto.randomUUID();
    const t0 = Date.now();

    try {
      const result = await searchPipelineForSet(
        { name: test.name, unit: "sada", quantity: 1, isSet: true, setHint: test.setHint },
        0,
        parentItemId,
        undefined,
        prefs,
        undefined,
        // V2 pipeline for components — same as production
        (compItem, pos, dbg, p, gc) => searchPipelineV2ForItem(compItem, pos, dbg, p, gc),
      );

      const ms = Date.now() - t0;
      let found = 0;

      for (const comp of result.components) {
        const r = comp.result;
        const col = matchColor(r.matchType);
        const icon = roleIcon(comp.role);
        const prodName = r.product?.name?.slice(0, 58) ?? "—";
        const sku = r.product?.sku ?? "";
        const codeStr = comp.manufacturerCode ? `${DIM}[kód: ${comp.manufacturerCode}]${RST}` : `${DIM}[kód: null]${RST}`;

        console.log(`  ${icon} ${DIM}${comp.role.padEnd(9)}${RST} ${codeStr}`);
        if (r.product) {
          console.log(`    ${col}✓ ${prodName}${RST} ${DIM}SKU: ${sku}${RST}`);
          found++;
        } else {
          console.log(`    ${R}✗ nenalezeno${RST} ${DIM}(${r.matchType}, ${r.confidence}%)${RST}`);
        }
      }

      totalFound += found;
      totalComps += result.components.length;
      summary.push({ label: test.label, found, total: result.components.length, ms });

      const allFound = found === result.components.length;
      const status = allFound ? `${G}✓ ${found}/${result.components.length} nalezeno${RST}` : `${Y}⚠ ${found}/${result.components.length} nalezeno${RST}`;
      console.log(`  ${DIM}${ms}ms${RST}  ${status}\n`);

    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`  ${R}✗ ERROR: ${(e as Error).message}${RST}\n`);
      summary.push({ label: test.label, found: 0, total: 0, ms });
    }
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(`${BOLD}─────────────────────────────────────────────────────────────${RST}`);
  console.log(`${BOLD}  Shrnutí${RST}\n`);

  for (const s of summary) {
    const allOk = s.found === s.total && s.total > 0;
    const col = allOk ? G : s.found > 0 ? Y : R;
    const bar = `${s.found}/${s.total}`.padStart(5);
    console.log(`  ${col}${bar}${RST}  ${s.label.padEnd(30)} ${DIM}${s.ms}ms${RST}`);
  }

  const pct = totalComps > 0 ? Math.round((totalFound / totalComps) * 100) : 0;
  const col = pct >= 80 ? G : pct >= 50 ? Y : R;
  console.log(`\n  ${BOLD}Celkem: ${col}${totalFound}/${totalComps} komponent nalezeno (${pct}%)${RST}`);
  console.log();
}

main().catch(console.error);
