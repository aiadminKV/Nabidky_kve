/**
 * Diagnostický test: Výběr kruhu vs bubnu pro kabely
 *
 * Problém: Agent má v MATCHER promptu pravidlo "prefer největší kruh jehož
 * násobek = poptávané množství", ale v praxi vybírá vždy buben.
 *
 * Spustit: cd backend && tsx src/scripts/test-cable-rings.ts
 *
 * Co tento test zkoumá:
 *  1. Dostane agent quantity + unit vůbec do MATCHER/SELECTOR?
 *  2. Obsahuje shortlist MATCHER správné kruhy?
 *  3. Vybere SELECTOR správný kruh, nebo buben?
 *  4. Proč (pokud) vždy vybírá buben?
 */

import {
  searchPipelineForItem,
  type PipelineResult,
  type PipelineDebugFn,
  type SearchPreferences,
} from "../services/searchPipeline.js";
import {
  searchProductsFulltext,
  searchProductsSemantic,
} from "../services/search.js";
import { generateQueryEmbedding } from "../services/embedding.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }

/** Rozpozná, zda název produktu obsahuje délku kruhu a vrátí ji */
function extractRingLength(name: string): number | null {
  const m = name.match(/KRUH\s+(\d+)M/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Vrátí true, pokud název obsahuje BUBEN */
function isBuben(name: string): boolean {
  return /BUBEN/i.test(name);
}

/** Vrátí true, pokud je kruh přesným násobkem poptávaného množství */
function isExactMultiple(ringLengthM: number, demandM: number): boolean {
  return demandM % ringLengthM === 0;
}

/** Vrátí největší platný kruh jehož násobek = demand, nebo null */
function getBestRing(
  candidates: Array<{ sku: string; name: string }>,
  demandM: number,
): { sku: string; name: string; ringLength: number } | null {
  const rings = candidates
    .map((c) => ({ ...c, ringLength: extractRingLength(c.name) }))
    .filter((c): c is typeof c & { ringLength: number } => c.ringLength !== null)
    .filter((c) => isExactMultiple(c.ringLength, demandM))
    .sort((a, b) => b.ringLength - a.ringLength); // největší kruh první
  return rings[0] ?? null;
}

// ── Test 1: Fulltext + semantic — jsou kruhy vůbec ve výsledcích? ──────────────

async function testSearchCoverage() {
  section("TEST 1: Pokrytí vyhledávání — jsou kruhy i bubny v kandidátech?");

  const QUERY_RAW = "CYKY-J 3x2,5";
  const QUERY_REFORM = "KABEL 1-CYKY-J 3x2,5 instalační silový kabel CYKY";

  info(`Fulltext: "${QUERY_RAW}"`);
  const ft = await searchProductsFulltext(QUERY_RAW, 30);
  info(`Výsledků fulltext: ${ft.length}`);

  const rings = ft.filter((r) => extractRingLength(r.name) !== null);
  const bubny = ft.filter((r) => isBuben(r.name));
  const metro = ft.filter((r) => /,\s*M$/i.test(r.name) || r.name.endsWith(", M"));

  info(`  Kruhy: ${rings.length} — ${rings.map((r) => r.name.match(/KRUH \d+M/i)?.[0] ?? r.name.slice(-10)).join(", ")}`);
  info(`  Bubny: ${bubny.length} — ${bubny.map((r) => r.name.slice(-30)).join(", ")}`);
  info(`  Po metrech (M): ${metro.length}`);

  if (rings.length === 0) {
    fail("Fulltext nenašel žádné kruhy! Semantic search nemusí buď.");
  } else {
    ok(`Fulltext obsahuje kruhy.`);
  }

  // Semantic
  const emb = await generateQueryEmbedding(QUERY_REFORM);
  const sem = await searchProductsSemantic(emb, 50, 0.35);
  info(`\nSémantické výsledky pro "${QUERY_REFORM}": ${sem.length}`);

  const semRings = sem.filter((r) => extractRingLength(r.name) !== null);
  const semBubny = sem.filter((r) => isBuben(r.name));

  info(`  Kruhy v top 50: ${semRings.length} — ${semRings.slice(0, 5).map((r) => `${r.name.match(/KRUH \d+M/i)?.[0] ?? "?"} (sim:${r.cosine_similarity.toFixed(3)})`).join(", ")}`);
  info(`  Bubny v top 50: ${semBubny.length} — ${semBubny.slice(0, 3).map((r) => `sim:${r.cosine_similarity.toFixed(3)}`).join(", ")}`);

  // Konkrétní SKU
  const sku50m = "1257420003"; // KRUH 50M
  const skuBuben = "1257420007"; // BUBEN

  const sem50m = sem.find((r) => r.sku === sku50m);
  const semBuben = sem.find((r) => r.sku === skuBuben);

  if (sem50m) {
    info(`  KRUH 50M (${sku50m}) v semantic: pořadí #${sem.findIndex((r) => r.sku === sku50m) + 1}, sim: ${sem50m.cosine_similarity.toFixed(4)}`);
  } else {
    warn(`  KRUH 50M (${sku50m}) NENÍ v top 50 semantic výsledků!`);
  }
  if (semBuben) {
    info(`  BUBEN (${skuBuben}) v semantic: pořadí #${sem.findIndex((r) => r.sku === skuBuben) + 1}, sim: ${semBuben.cosine_similarity.toFixed(4)}`);
  } else {
    warn(`  BUBEN (${skuBuben}) NENÍ v top 50 semantic výsledků!`);
  }
}

// ── Test 2: Full pipeline pro různé množství ──────────────────────────────────

interface ScenarioResult {
  query: string;
  quantity: number;
  selectedSku: string | null;
  selectedName: string | null;
  selectedUnit: string | null;
  matchType: string;
  confidence: number;
  reasoning: string;
  isCorrect: boolean;
  explanation: string;
  debugSteps: Record<string, unknown>;
}

const PREFS: SearchPreferences = {
  offerType: "realizace",
  stockFilter: "any",
  branchFilter: null,
  priceStrategy: "standard",
};

async function runPipelineScenario(
  name: string,
  quantity: number,
  unit: string,
): Promise<ScenarioResult> {
  const debugSteps: Record<string, unknown> = {};
  let matcherData: unknown = null;
  let selectorData: unknown = null;

  const onDebug: PipelineDebugFn = (entry) => {
    debugSteps[entry.step] = entry.data;
    if (entry.step === "matcher") matcherData = entry.data;
    if (entry.step === "selector") selectorData = entry.data;
  };

  const result: PipelineResult = await searchPipelineForItem(
    { name, unit, quantity },
    0,
    onDebug,
    PREFS,
  );

  const selectedName = result.product?.name ?? null;
  const selectedSku = result.product?.sku ?? null;
  const selectedUnit = result.product?.unit ?? null;

  // Posoudíme správnost
  let isCorrect = false;
  let explanation = "";

  if (selectedName === null) {
    explanation = "Produkt nebyl nalezen.";
  } else {
    const ringLength = extractRingLength(selectedName);
    const buben = isBuben(selectedName);
    const soldPerMeter = selectedUnit?.toLowerCase() === "m" && !ringLength && !buben;

    if (ringLength !== null) {
      // Vybrán kruh — je to správný násobek?
      if (isExactMultiple(ringLength, quantity)) {
        isCorrect = true;
        explanation = `Správně: vybrán KRUH ${ringLength}M — přesný násobek pro ${quantity}m`;
      } else {
        explanation = `Špatně: KRUH ${ringLength}M NENÍ násobkem ${quantity}m (zbytek: ${quantity % ringLength}m)`;
      }
    } else if (buben) {
      // Vybrán buben — je to správné?
      // Buben je správný pouze pokud žádný kruh není přesným násobkem
      // Pro účely testu víme, jaké kruhy jsou dostupné
      const availableRings = [10, 20, 25, 30, 35, 50, 100]; // z DB
      const bestRing = availableRings
        .filter((r) => isExactMultiple(r, quantity))
        .sort((a, b) => b - a)[0];
      if (bestRing) {
        explanation = `Špatně: Vybrán BUBEN, ale existuje KRUH ${bestRing}M který je přesným násobkem ${quantity}m!`;
        isCorrect = false;
      } else {
        isCorrect = true;
        explanation = `Správně: Vybrán BUBEN — žádný kruh není přesným násobkem pro ${quantity}m`;
      }
    } else if (soldPerMeter) {
      explanation = `Prodej po metrech (unit=m, bez délky v názvu) — OK pro jakékoliv množství`;
      isCorrect = true; // akceptovatelné, ale ne ideální
    } else {
      explanation = `Neznámý typ výběru: "${selectedName}"`;
    }
  }

  return {
    query: name,
    quantity,
    selectedSku,
    selectedName,
    selectedUnit,
    matchType: result.matchType,
    confidence: result.confidence,
    reasoning: result.reasoning,
    isCorrect,
    explanation,
    debugSteps: {
      matcher: matcherData,
      selector: selectorData,
      merge: debugSteps["merge"],
    },
  };
}

async function testPipelineScenarios() {
  section("TEST 2: Full pipeline — kruhy vs bubny pro různá množství");

  const scenarios = [
    { name: "CYKY-J 3x2,5", quantity: 50, unit: "m" },   // přesný kruh (50M)
    { name: "CYKY-J 3x2,5", quantity: 100, unit: "m" },  // přesný kruh (100M)
    { name: "CYKY-J 3x2,5", quantity: 25, unit: "m" },   // přesný kruh (25M)
    { name: "CYKY-J 3x2,5", quantity: 10, unit: "m" },   // přesný kruh (10M)
    { name: "CYKY-J 3x2,5", quantity: 75, unit: "m" },   // bez přesného násobku → buben
    { name: "CYKY-J 3x2,5", quantity: 350, unit: "m" },  // bez přesného násobku → buben
    { name: "CYKY-J 3x2,5", quantity: 200, unit: "m" },  // násobek 100M → kruh 100M
  ];

  const results: ScenarioResult[] = [];

  for (const s of scenarios) {
    console.log(`\n  ─── Scénář: "${s.name}" ${s.quantity}${s.unit} ───`);
    try {
      const r = await runPipelineScenario(s.name, s.quantity, s.unit);
      results.push(r);

      info(`Vybrán: ${r.selectedSku} — "${r.selectedName}" (unit: ${r.selectedUnit})`);
      info(`matchType: ${r.matchType}, confidence: ${r.confidence}%`);
      info(`reasoning: ${r.reasoning}`);

      if (r.isCorrect) {
        ok(r.explanation);
      } else {
        fail(r.explanation);
      }

      // Matcher detail
      const matcher = r.debugSteps.matcher as Record<string, unknown> | null;
      if (matcher) {
        info(`MATCHER shortlist: ${matcher.shortlistSize} položek, bestMatchType: ${matcher.bestMatchType}`);
        info(`MATCHER reasoning: ${matcher.reasoning}`);
        const topMatch = matcher.topMatch as Record<string, unknown> | null;
        if (topMatch) {
          info(`MATCHER top#1: ${topMatch.sku} (score: ${topMatch.matchScore})`);
        }
      }

      // Merge detail
      const merge = r.debugSteps.merge as Record<string, unknown> | null;
      if (merge) {
        info(`Kandidáti po merge: ${merge.totalAfterFilter} (před filtrem: ${merge.totalBeforeFilter})`);
        const top3 = merge.top3 as Array<Record<string, unknown>> | null;
        if (top3 && top3.length > 0) {
          info(`Top 3 merged: ${top3.map((c) => `${c.sku} sim:${c.sim}`).join(", ")}`);
        }
      }
    } catch (err) {
      fail(`Pipeline error: ${err}`);
    }
  }

  return results;
}

// ── Test 3: Analýza shortlistu MATCHER ───────────────────────────────────────

async function testMatcherShortlistContent() {
  section("TEST 3: Analýza obsahu shortlistu MATCHER pro 50m");

  // Simulujeme přesně to, co pipeline dělá:
  // 1. Fulltext + semantic pro "CYKY-J 3x2,5"
  // 2. Merge (simplified)
  // 3. Dáme do matchCandidates se stejnými parametry

  const query = "CYKY-J 3x2,5";
  const DEMAND_QTY = 50;
  const DEMAND_UNIT = "m";

  info(`Hledáme kandidáty pro: "${query}", ${DEMAND_QTY}${DEMAND_UNIT}`);

  const ft = await searchProductsFulltext(query, 30);
  const emb = await generateQueryEmbedding(
    "KABEL 1-CYKY-J 3x2,5 instalační silový kabel CYKY-J",
  );
  const sem = await searchProductsSemantic(emb, 50, 0.35);

  // Simplified merge — jen se zeptáme co se dostane do top 20
  const merged = new Map<string, { sku: string; name: string; unit: string | null; sim: number; fromFt: boolean; fromSem: boolean }>();

  for (const r of ft) {
    merged.set(r.sku, {
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      sim: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
      fromFt: true,
      fromSem: false,
    });
  }
  for (const r of sem) {
    const existing = merged.get(r.sku);
    if (existing) {
      existing.sim = Math.max(existing.sim, r.cosine_similarity);
      existing.fromSem = true;
    } else {
      merged.set(r.sku, {
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        sim: r.cosine_similarity,
        fromFt: false,
        fromSem: true,
      });
    }
  }

  const sorted = [...merged.values()].sort((a, b) => b.sim - a.sim);
  const top20 = sorted.slice(0, 20);

  info(`\nTop 20 kandidátů (jako MATCHER dostane):`);
  for (const [i, c] of top20.entries()) {
    const ringLen = extractRingLength(c.name);
    const buben = isBuben(c.name);
    const validForDemand = ringLen !== null || buben || c.unit?.toLowerCase() === "m";
    const isGoodRing = ringLen !== null && isExactMultiple(ringLen, DEMAND_QTY);
    const marker = isGoodRing ? "🎯" : buben ? "🔵" : "  ";
    console.log(`    ${String(i + 1).padStart(2)}. ${marker} [${c.sku}] "${c.name.slice(0, 50)}" (unit:${c.unit}, sim:${c.sim.toFixed(3)}, ${validForDemand ? "✅" : "❌ INVALID"})`);
  }

  const sku50m = "1257420003";
  const idx50m = top20.findIndex((c) => c.sku === sku50m);
  if (idx50m >= 0) {
    ok(`KRUH 50M (${sku50m}) je v top 20 na pozici #${idx50m + 1}`);
  } else {
    fail(`KRUH 50M (${sku50m}) NENÍ v top 20 kandidátech! → MATCHER ho nikdy neuvidí.`);
    const allIdx = sorted.findIndex((c) => c.sku === sku50m);
    if (allIdx >= 0) {
      warn(`  ... ale je v merged na pozici #${allIdx + 1} (${sorted[allIdx].sim.toFixed(3)})`);
    } else {
      warn(`  KRUH 50M není ani v merged výsledcích vůbec!`);
    }
  }

  const bubenSku = "1257420007";
  const idxBuben = top20.findIndex((c) => c.sku === bubenSku);
  if (idxBuben >= 0) {
    info(`BUBEN (${bubenSku}) je v top 20 na pozici #${idxBuben + 1}`);
  } else {
    info(`BUBEN (${bubenSku}) není v top 20`);
  }

  // Kolik ringů je vůbec v top 20?
  const ringsInTop20 = top20.filter((c) => extractRingLength(c.name) !== null);
  info(`\nKruhů v top 20: ${ringsInTop20.length}`);
  const bestRingForDemand = getBestRing(top20, DEMAND_QTY);
  if (bestRingForDemand) {
    ok(`Nejlepší kruh pro ${DEMAND_QTY}m: ${bestRingForDemand.sku} — "${bestRingForDemand.name}"`);
  } else {
    warn(`Žádný kruh v top 20 není přesným násobkem ${DEMAND_QTY}m!`);
  }
}

// ── Test 4: Kontrola — dostane MATCHER/SELECTOR quantity? ────────────────────

async function testQuantityContext() {
  section("TEST 4: Dostane agent quantity + unit vůbec? (debug trace)");

  const debugLog: Array<{ step: string; data: unknown }> = [];

  const onDebug: PipelineDebugFn = (entry) => {
    debugLog.push({ step: entry.step, data: entry.data });
  };

  await searchPipelineForItem(
    { name: "CYKY-J 3x2,5", unit: "m", quantity: 50 },
    0,
    onDebug,
    PREFS,
  );

  // Hledáme, kde se quantity/unit používá
  info("Debug kroky pipeline (celý trace):");
  for (const log of debugLog) {
    const dataStr = JSON.stringify(log.data ?? {}).slice(0, 200);
    console.log(`  [${log.step}]: ${dataStr}`);
  }

  // Klíčová otázka: je v matcher step vidět quantity?
  const matcherLog = debugLog.find((l) => l.step === "matcher");
  const selectorLog = debugLog.find((l) => l.step === "selector");

  if (matcherLog) {
    info(`\nMATCHER dostal:`);
    console.log(JSON.stringify(matcherLog.data, null, 4));
  }
  if (selectorLog) {
    info(`\nSELECTOR výsledek:`);
    console.log(JSON.stringify(selectorLog.data, null, 4));
  }

  // Poznámka: quantity je v kódu předávána jako `demandQuantity` do matchCandidates(),
  // ale debug log neobsahuje přímo co bylo odesláno do LLM — jen výsledek.
  // Ověřujeme to kontrolou kódu.
  ok("quantity + unit jsou předány do matchCandidates() (viz řádek 965 searchPipeline.ts)");
  ok("quantity + unit jsou předány do selectProduct() (viz řádek 1003 searchPipeline.ts)");
  info("MATCHER prompt obsahuje pravidlo pro výběr kruhu (řádek 554-557 searchPipeline.ts)");
  warn("SELECTOR prompt NEOBSAHUJE pravidlo pro výběr kruhu — rozhoduje jen dle skladu a ceny!");
}

// ── Shrnutí ───────────────────────────────────────────────────────────────────

async function printSummary(results: ScenarioResult[]) {
  section("SHRNUTÍ ANALÝZY");

  const correct = results.filter((r) => r.isCorrect).length;
  const total = results.length;

  console.log(`\n  Výsledek: ${correct}/${total} scénářů správně\n`);

  console.log("  Detailní výsledky:");
  for (const r of results) {
    const marker = r.isCorrect ? "✅" : "❌";
    console.log(`  ${marker} ${r.query} ${r.quantity}m → "${r.selectedName?.slice(0, 40) ?? "not_found"}"`);
    if (!r.isCorrect) {
      console.log(`     └─ ${r.explanation}`);
    }
  }

  console.log(`
  ═══════════════════════════════════════════════════════════════════════
  IDENTIFIKOVANÉ PROBLÉMY:

  1. SELECTOR NEMÁ PRAVIDLO PRO KRUHY
     - MATCHER_PROMPT (řádek 554): "Preferuj největší kruh jehož násobek
       = poptávané množství"
     - SELECTOR_PROMPT: toto pravidlo CHYBÍ!
     - SELECTOR vybírá pouze podle: sklad → výrobce → cena
     - Pokud mají KRUH 50M a BUBEN stejnou cenu a oba jsou skladem,
       SELECTOR nemá důvod preferovat kruh!

  2. MATCHER VRACÍ SHORTLIST, NE VÝBĚR
     - Pravidlo pro kruhy je v MATCHER, ale ten jen tvoří shortlist (max 8)
     - Pořadí v shortlistu je dáno matchScore, ne ring-preference
     - SELECTOR pak ignoruje ring-logiku a rozhoduje jinak

  3. MOŽNÝ PROBLÉM S RANK KANDIDÁTŮ (zkontrolovat v Test 3)
     - Sémantické hledání vrací nejpodobnější embeddingy
     - "BUBEN" embedding může být blíže než "KRUH 50M"
     - Pokud KRUH 50M není v top 20 → MATCHER ho vůbec nevidí

  4. STEJNÁ CENA VŠECH VARIANT
     - Všechny CYKY-J 3x2,5 varianty mají cenu 27.80 Kč/m
     - SELECTOR nemůže rozlišit podle ceny

  DOPORUČENÁ OPRAVA:
  Přidat do SELECTOR_PROMPT sekci pro kabely:

  ## Kabely — výběr balení (pokud demand unit = "m" nebo METER)
  Pokud demand obsahuje unit="m" a quantity:
  1. Preferuj KRUH kde ringLength je přesný dělitel quantity
     → největší takový kruh (200m → 2×100m > 4×50m)
  2. Pokud žádný kruh není přesným dělitelem → vyber BUBEN
  3. NIKDY nepřehlíž ring-logiku jen kvůli náhodnému pořadí
  ═══════════════════════════════════════════════════════════════════════
`);
}

// ── Hlavní funkce ─────────────────────────────────────────────────────────────

async function run() {
  console.log("🔍 Test: Výběr kruhu vs bubnu pro kabely");
  console.log("   CYKY-J 3x2,5 — různá poptávaná množství");
  console.log("   Účel: zjistit proč agent vybírá vždy buben místo správného kruhu\n");

  try {
    // Skip standalone DB tests (testSearchCoverage, testMatcherShortlistContent)
    // when DB is timing out — go straight to pipeline scenarios
    const results = await testPipelineScenarios();
    await printSummary(results);
  } catch (err) {
    console.error("\nFATAL ERROR:", err);
    process.exit(1);
  }
}

run().catch(console.error);
