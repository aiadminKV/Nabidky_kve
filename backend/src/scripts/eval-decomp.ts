/**
 * eval-decomp.ts
 *
 * Izolovaný eval pro krok rozkladu sady (decomposeSet).
 * Testuje POUZE web search + decomp agenta — bez pipeline, bez DB lookupů.
 *
 * Zobrazuje:
 *   - jaké dotazy agent posílá do web search
 *   - jaké URL navštívil
 *   - jaké komponenty a kódy vrátil
 *   - srovnání s ground truth (počet komponent, role, formát kódů)
 *
 * Run: npx tsx src/scripts/eval-decomp.ts
 * Run (filtr):  npx tsx src/scripts/eval-decomp.ts abb
 *               npx tsx src/scripts/eval-decomp.ts schneider
 *               npx tsx src/scripts/eval-decomp.ts legrand
 */

import "dotenv/config";
import { decomposeSet } from "../services/searchPipeline.js";

// ── ANSI ─────────────────────────────────────────────────────────────────────
const G    = "\x1b[32m";
const R    = "\x1b[31m";
const Y    = "\x1b[33m";
const B    = "\x1b[34m";
const CY   = "\x1b[36m";
const DIM  = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST  = "\x1b[0m";

// ── Ground truth ──────────────────────────────────────────────────────────────
/**
 * Expected component structure per test.
 * roles: ordered list of expected roles ("mechanism" | "cover" | "frame" | "other")
 * componentCount: how many components we expect in total
 * noteworthy: things the agent MUST include (e.g. "nosič" for Schneider, "keystone" for data)
 */
interface TestCase {
  label: string;
  name: string;
  setHint: string;
  expectedRoles: string[];           // e.g. ["mechanism", "cover", "frame"]
  noteworthy?: string[];             // strings that should appear in component names (case-insensitive)
  codePattern?: RegExp;              // regex that codes should match (if not null)
}

const TESTS: TestCase[] = [
  // ── ABB Tango bílá ─────────────────────────────────────────────────────────
  {
    label: "ABB Tango bílá — vypínač č.1",
    name: "Jednopólový vypínač ABB Tango bílý",
    setHint: "ABB Tango bílá",
    expectedRoles: ["mechanism", "cover", "frame"],
    codePattern: /^\d{4}[A-Z]?-[A-Z0-9]+ ?[BN]?$/i,
  },
  {
    label: "ABB Tango bílá — zásuvka 230V",
    name: "Zásuvka 230V s uzemněním ABB Tango bílá",
    setHint: "ABB Tango bílá",
    expectedRoles: ["mechanism", "frame"],          // klapka bývá integrovaná nebo separátní
    codePattern: /^\d{4}[A-Z]?-[A-Z0-9]+ ?[BN]?$/i,
  },
  {
    label: "ABB Tango bílá — datová RJ45 jednoduchá",
    name: "Datová zásuvka RJ45 jednoduchá ABB Tango bílá",
    setHint: "ABB Tango bílá",
    expectedRoles: ["mechanism", "cover", "frame", "other"],   // keystone jako "other"
    noteworthy: ["keystone", "RJ45", "modul", "maska"],
    codePattern: /^\d{4}[A-Z]?-[A-Z0-9]+ ?[BN]?$/i,
  },
  {
    label: "ABB Tango bílá — termostat podlahový",
    name: "Termostat podlahový analogový ABB Tango bílá",
    setHint: "ABB Tango bílá",
    expectedRoles: ["mechanism", "cover", "frame", "other"],   // senzor podlahy jako "other"
    noteworthy: ["senzor", "čidlo", "teplotní"],
    codePattern: /^\d{4}[A-Z]?-[A-Z0-9]+ ?[BN]?$/i,
  },

  // ── ABB Tango černá ────────────────────────────────────────────────────────
  {
    label: "ABB Tango černá — vypínač č.1",
    name: "Jednopólový vypínač ABB Tango černý",
    setHint: "ABB Tango černá",
    expectedRoles: ["mechanism", "cover", "frame"],
    codePattern: /^\d{4}[A-Z]?-[A-Z0-9]+ ?N$/i,   // musí mít suffix N (černá)
  },

  // ── Schneider Unica bílá ───────────────────────────────────────────────────
  {
    label: "Schneider Unica bílá — vypínač č.1",
    name: "Jednopólový vypínač Schneider Unica bílý",
    setHint: "Schneider Unica bílá",
    expectedRoles: ["mechanism", "cover", "frame", "other"],   // nosič jako "other"
    noteworthy: ["nosič", "nosná", "support", "podložka"],
    codePattern: /^NU\d|^MGU/i,
  },
  {
    label: "Schneider Unica bílá — zásuvka 230V",
    name: "Zásuvka 230V Schneider Unica bílá",
    setHint: "Schneider Unica bílá",
    expectedRoles: ["mechanism", "cover", "frame", "other"],
    noteworthy: ["nosič", "nosná", "support"],
    codePattern: /^NU\d|^MGU/i,
  },
  {
    label: "Schneider Unica bílá — datová RJ45 jednoduchá",
    name: "Datová zásuvka RJ45 jednoduchá Schneider Unica bílá",
    setHint: "Schneider Unica bílá",
    expectedRoles: ["mechanism", "cover", "frame", "other"],
    noteworthy: ["nosič", "nosná", "support"],
    codePattern: /^NU\d|^MGU/i,
  },
  {
    label: "Schneider Unica antracit — zásuvka",
    name: "Zásuvka 230V Schneider Unica antracit",
    setHint: "Schneider Unica antracit",
    expectedRoles: ["mechanism", "cover", "frame", "other"],
    noteworthy: ["nosič", "nosná", "support"],
    codePattern: /^NU\d.*54|^MGU.*54/i,           // antracit suffix 54
  },

  // ── Legrand Valena bílá ────────────────────────────────────────────────────
  {
    label: "Legrand Valena bílá — vypínač č.1",
    name: "Jednopólový vypínač Legrand Valena bílý",
    setHint: "Legrand Valena bílá",
    expectedRoles: ["mechanism", "frame"],
    codePattern: /^75\d{4}$/,                      // kódy Valena/VALL jsou 6-místná čísla začínající 75x
  },
  {
    label: "Legrand Valena bílá — zásuvka 230V",
    name: "Zásuvka 230V Legrand Valena bílá",
    setHint: "Legrand Valena bílá",
    expectedRoles: ["mechanism", "frame"],
    codePattern: /^75\d{4}$/,
  },
  {
    label: "Legrand Valena bílá — datová RJ45",
    name: "Datová zásuvka RJ45 Legrand Valena bílá",
    setHint: "Legrand Valena bílá",
    expectedRoles: ["mechanism", "frame"],
    codePattern: /^75\d{4}$/,
  },
  {
    label: "Legrand Valena černá — vypínač č.5",
    name: "Schodišťový přepínač Legrand Valena černý",
    setHint: "Legrand Valena černá",
    expectedRoles: ["mechanism", "frame"],
    codePattern: /^75\d{4}$/,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function roleIcon(role: string): string {
  switch (role) {
    case "mechanism": return "⚙";
    case "cover":     return "▣";
    case "frame":     return "⬜";
    default:          return "•";
  }
}

function checkRoles(found: string[], expected: string[]): { ok: boolean; missing: string[]; extra: string[] } {
  const foundSet = [...found].sort().join(",");
  const expSet   = [...expected].sort().join(",");
  const missing  = expected.filter((r) => !found.includes(r));
  const extra    = found.filter((r) => !expected.includes(r));
  return { ok: foundSet === expSet, missing, extra };
}

function codeQuality(codes: (string | null)[], pattern?: RegExp): { good: number; bad: number; nulls: number } {
  let good = 0, bad = 0, nulls = 0;
  for (const c of codes) {
    if (!c) { nulls++; continue; }
    if (pattern && !pattern.test(c)) bad++;
    else good++;
  }
  return { good, bad, nulls };
}

function containsNoteworthy(comps: Array<{ name: string }>, noteworthy: string[]): { found: string[]; missing: string[] } {
  const allText = comps.map((c) => c.name.toLowerCase()).join(" ");
  const found = noteworthy.filter((n) => allText.includes(n.toLowerCase()));
  const missing = noteworthy.filter((n) => !allText.includes(n.toLowerCase()));
  return { found, missing };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const tests = filter ? TESTS.filter((t) => t.label.toLowerCase().includes(filter)) : TESTS;

  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════════${RST}`);
  console.log(`${BOLD}  Eval decomp — ${tests.length} testů${filter ? ` (filtr: "${filter}")` : ""}${RST}`);
  console.log(`${BOLD}  Testuje: web search queries + vrácené komponenty + kódy${RST}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════════${RST}\n`);

  const summary: {
    label: string;
    rolesOk: boolean;
    codesGood: number;
    codesBad: number;
    codesNull: number;
    noteworthyOk: boolean;
    searchCount: number;
    ms: number;
    error?: string;
  }[] = [];

  for (const test of tests) {
    console.log(`${BOLD}▶ ${test.label}${RST}`);
    console.log(`  ${DIM}Poptávka: "${test.name}"  |  Hint: ${test.setHint}${RST}`);

    const t0 = Date.now();
    try {
      const result = await decomposeSet(test.name, test.setHint);
      const ms = Date.now() - t0;

      // ── Web searches ──────────────────────────────────────────────────────
      if (result.webSearches.length === 0) {
        console.log(`  ${Y}⚠ Žádné web search queries!${RST}`);
      } else {
        console.log(`  ${CY}🔍 Web search (${result.webSearches.length} dotazů):${RST}`);
        for (const ws of result.webSearches) {
          console.log(`    ${DIM}→ "${ws.query}"${RST}`);
          for (const url of ws.urls.slice(0, 3)) {
            console.log(`      ${DIM}  ${url}${RST}`);
          }
        }
      }

      // ── Variants ──────────────────────────────────────────────────────────
      if (result.variants.length === 0) {
        console.log(`  ${R}✗ Žádné varianty nebyly vráceny!${RST}`);
      }

      // Evaluate using ALL components from all variants (for role/noteworthy checks)
      const allComponents = result.variants.flatMap((v) => v.components);
      const firstVariantComponents = result.variants[0]?.components ?? [];

      for (const [vi, variant] of result.variants.entries()) {
        const varLabel = result.variants.length > 1
          ? `${vi === 0 ? B : DIM}  Varianta ${vi + 1}: ${variant.name}${RST}`
          : `\n  ${B}Komponenty (${variant.components.length}):${RST}`;
        console.log(varLabel);
        for (const comp of variant.components) {
          const icon = roleIcon(comp.role);
          const codeOk = comp.manufacturerCode && (!test.codePattern || test.codePattern.test(comp.manufacturerCode));
          const codeColor = !comp.manufacturerCode ? DIM : codeOk ? G : R;
          const codeStr = comp.manufacturerCode ?? "—";
          console.log(`    ${icon} ${DIM}${comp.role.padEnd(10)}${RST}  ${codeColor}[${codeStr}]${RST}  ${DIM}${comp.name.slice(0, 55)}${RST}`);
        }
      }

      // Evaluate against first/primary variant
      const foundRoles = firstVariantComponents.map((c) => c.role);
      const allCodes   = firstVariantComponents.map((c) => c.manufacturerCode);
      const { ok: rolesOk, missing: rolesMissing, extra: rolesExtra } = checkRoles(foundRoles, test.expectedRoles);
      const { good: codesGood, bad: codesBad, nulls: codesNull } = codeQuality(allCodes, test.codePattern);

      // ── Role check ────────────────────────────────────────────────────────
      if (rolesOk) {
        console.log(`\n  ${G}✓ Role OK (varianta 1): ${test.expectedRoles.join(", ")}${RST}`);
      } else {
        if (rolesMissing.length > 0) console.log(`\n  ${R}✗ Chybí role (var. 1): ${rolesMissing.join(", ")}${RST}`);
        if (rolesExtra.length > 0)   console.log(`  ${Y}? Extra role (var. 1): ${rolesExtra.join(", ")}${RST}`);
      }

      // ── Code quality ──────────────────────────────────────────────────────
      const codeMsg = `kódy: ${codesGood}/${allCodes.length} správný formát, ${codesBad} špatný, ${codesNull} null`;
      const codeCol = codesBad > 0 ? R : codesNull > 0 ? Y : G;
      console.log(`  ${codeCol}${codeMsg}${RST}`);

      // ── Noteworthy ────────────────────────────────────────────────────────
      let noteworthyOk = true;
      if (test.noteworthy && test.noteworthy.length > 0) {
        // Check noteworthy across ALL variants (any variant having it is OK)
        const { found: nfound, missing: nmissing } = containsNoteworthy(allComponents, test.noteworthy);
        noteworthyOk = nmissing.length === 0;
        if (nmissing.length > 0) {
          console.log(`  ${R}✗ Chybí klíčová slova: ${nmissing.join(", ")}${RST}  ${DIM}(mělo by být v názvech komponent)${RST}`);
        } else {
          console.log(`  ${G}✓ Klíčová slova nalezena: ${nfound.join(", ")}${RST}`);
        }
      }

      console.log(`  ${DIM}${ms}ms${RST}\n`);

      summary.push({
        label: test.label,
        rolesOk,
        codesGood,
        codesBad,
        codesNull,
        noteworthyOk,
        searchCount: result.webSearches.length,
        ms,
      });

    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message;
      console.log(`  ${R}✗ ERROR: ${msg}${RST}\n`);
      summary.push({
        label: test.label,
        rolesOk: false,
        codesGood: 0,
        codesBad: 0,
        codesNull: 0,
        noteworthyOk: false,
        searchCount: 0,
        ms,
        error: msg,
      });
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log(`${BOLD}─────────────────────────────────────────────────────────────────${RST}`);
  console.log(`${BOLD}  Shrnutí${RST}\n`);

  let lastFamily = "";
  let totalOk = 0;

  for (const s of summary) {
    const family = s.label.split("—")[0]!.trim();
    if (family !== lastFamily) { lastFamily = family; console.log(`  ${B}${family}${RST}`); }

    const overall = s.rolesOk && s.noteworthyOk && s.codesBad === 0;
    if (overall) totalOk++;
    const col = s.error ? R : overall ? G : s.rolesOk ? Y : R;
    const subLabel = s.label.split("—")[1]?.trim() ?? s.label;
    const flags = [
      s.rolesOk     ? `${G}role✓${RST}` : `${R}role✗${RST}`,
      s.noteworthyOk ? `${G}kw✓${RST}`  : `${R}kw✗${RST}`,
      s.codesBad === 0 ? `${G}kódy✓${RST}` : `${R}kódy✗${RST}`,
      `${DIM}🔍${s.searchCount}${RST}`,
      `${DIM}${s.ms}ms${RST}`,
    ].join("  ");
    console.log(`  ${col}${subLabel.padEnd(38)}${RST}  ${flags}`);
  }

  const pct = summary.length > 0 ? Math.round((totalOk / summary.length) * 100) : 0;
  const col = pct >= 80 ? G : pct >= 50 ? Y : R;
  console.log(`\n  ${BOLD}Celkem: ${col}${totalOk}/${summary.length} testů plně ok (${pct}%)${RST}`);
  console.log();
}

main().catch(console.error);
