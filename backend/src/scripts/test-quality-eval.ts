import "dotenv/config";
import {
  searchPipelineForItem,
  type PipelineDebugFn,
  type GroupContext,
} from "../services/searchPipeline";

const PREFS = { offerType: "realizace" as const, stockFilter: "stock_items_only" as const };

interface TestCase {
  suite: string;
  name: string;
  input: { name: string; unit?: string | null; quantity?: number | null };
  groupContext?: GroupContext;
  checks: Check[];
}

type Check =
  | { type: "matchType"; expected: string; desc: string }
  | { type: "confidenceMax"; max: number; desc: string }
  | { type: "selectedSku"; expected: string; desc: string }
  | { type: "skuInCandidates"; sku: string; desc: string }
  | { type: "skuNotInCandidates"; sku: string; desc: string }
  | { type: "exactLookupFound"; desc: string };

const TESTS: TestCase[] = [
  // SUITE A: Varianta bez specifikace
  { suite: "A", name: "Vodic CY 4 bez barvy → multiple",
    input: { name: "Vodic CY 4", unit: "m", quantity: 100 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "Bez barvy → multiple" },
      { type: "confidenceMax", max: 20, desc: "Confidence musi byt nizka" },
    ] },
  { suite: "A", name: "Vodic CY 4 ZLUTOZELENA → match",
    input: { name: "Vodic CY 4 ZLUTOZELENA", unit: "m", quantity: 100 },
    checks: [
      { type: "matchType", expected: "match", desc: "Barva explicitni → match" },
      { type: "skuInCandidates", sku: "1189181", desc: "ZZ varianta musi byt v candidates" },
    ] },
  { suite: "A", name: "H07V-K 50mm2 bez barvy → multiple",
    input: { name: "H07V-K 50mm2", unit: "m", quantity: 56 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "Bez barvy → multiple" },
      { type: "confidenceMax", max: 20, desc: "Confidence musi byt nizka" },
    ] },
  { suite: "A", name: "Trubka tuha 32mm bez delky kusu → multiple",
    input: { name: "trubka tuha 32mm", unit: "ks", quantity: 10 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "2M vs 3M → multiple" },
      { type: "confidenceMax", max: 30, desc: "Confidence musi byt nizka" },
    ] },
  { suite: "A", name: "CYKY-J 3x1,5 → multiple (BUBEN vs BUBEN NEVRATNY)",
    input: { name: "CYKY-J 3x1,5", unit: "m", quantity: 386 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "BUBEN vs BUBEN NEVRATNY → multiple" },
      { type: "confidenceMax", max: 30, desc: "Confidence musi byt nizka" },
    ] },
  { suite: "A", name: "JYTY 4x1 bez typu zily → multiple (J vs O)",
    input: { name: "JYTY 4x1", unit: "m", quantity: 62 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "JYTY-J vs JYTY-O → multiple" },
      { type: "confidenceMax", max: 30, desc: "Confidence musi byt nizka" },
    ] },
  { suite: "A", name: "Zlab neperforovany 50x50 bez barvy → multiple",
    input: { name: "zlab neperforovany 50x50", unit: "m", quantity: 10 },
    checks: [
      { type: "matchType", expected: "multiple", desc: "Barva zlabu → multiple" },
      { type: "confidenceMax", max: 30, desc: "Confidence musi byt nizka" },
    ] },

  // SUITE B: MATCHER tvrde parametry
  { suite: "B", name: "NSGAFOU 1x95 → 1x240 nesmí být v candidates",
    input: { name: "NSGAFOU 1x95mm2", unit: "m", quantity: 1108 },
    checks: [
      { type: "skuNotInCandidates", sku: "1257633", desc: "NSGAFOU 1x240 nesmi projit" },
      { type: "skuInCandidates", sku: "1524920", desc: "NSGAFOU 1x95 musi byt v candidates" },
    ] },
  { suite: "B", name: "Zasuvka 32A 3pol → 5P (SKU 1146803) nesmi projit",
    input: { name: "Nastenna zasuvka 230V 32A 3pol IP44", unit: "ks", quantity: 1 },
    checks: [
      { type: "skuNotInCandidates", sku: "1146803", desc: "5P zasuvka nesmi projit pro 3pol" },
    ] },
  { suite: "B", name: "JXFE-R 3x2x0,8 → 2x2x0,8 (SKU 1948632) nesmi projit",
    input: { name: "Kabel JXFE-R B2cas1d0 3x2x0,8", unit: "m", quantity: 100 },
    checks: [
      { type: "skuNotInCandidates", sku: "1948632", desc: "2-parovy kabel nesmi projit pro 3-parovy" },
    ] },
  { suite: "B", name: "AKU35/5 → AKU70/5 (SKU 1004905) nesmi projit",
    input: { name: "AKU35/5 SASY univerzalni svorka sbernice 5mm", unit: "ks", quantity: 28 },
    checks: [
      { type: "skuNotInCandidates", sku: "1004905", desc: "AKU70 nesmi projit pro AKU35" },
    ] },
  { suite: "B", name: "Trubka ohebna 25mm 720N → 320N (SKU 1169410) nesmi projit",
    input: { name: "Trubka ohebna 25mm 720N", unit: "m", quantity: 50 },
    checks: [
      { type: "skuNotInCandidates", sku: "1169410", desc: "320N trida nesmi projit pro 720N" },
    ] },

  // SUITE C: EAN a objednaci kody
  { suite: "C", name: "Spinac s kodem 3558N-C01510 S → exact match",
    input: { name: "Spinac jednopoovy 3558N-C01510 S IP54", unit: "ks", quantity: 5 },
    checks: [
      { type: "exactLookupFound", desc: "Kod musi byt nalezen" },
      { type: "selectedSku", expected: "1213553", desc: "Spravny sedy spinac" },
    ] },
  { suite: "C", name: "ABB kod bez mezery 5518-2929S → idnlf_normalized",
    input: { name: "ABB zasuvka 5518-2929S IP54", unit: "ks", quantity: 2 },
    checks: [
      { type: "exactLookupFound", desc: "idnlf_normalized musi najit kod bez mezery" },
      { type: "matchType", expected: "match", desc: "Presny nalez → match" },
    ] },
  { suite: "C", name: "Hlavni vypinac IS-40/3 → exact match",
    input: { name: "HLAVNI VYPINAC 3P 40A IS-40/3", unit: "ks", quantity: 1 },
    checks: [
      { type: "exactLookupFound", desc: "Presny kod v nazvu → exact lookup" },
      { type: "matchType", expected: "match", desc: "Jednoznacny nalez" },
    ] },
  { suite: "C", name: "Vagni popis + presny SKU 1183636 → exact match vyhraj",
    // P0: klic. test — poptavka neodpovida jmenu produktu, ale SKU je v textu
    // Bez P0 fix: MATCHER vyradi (jmena nesedi) → SELECTOR nenajde
    // Po P0 fix: foundByExactCode=true → MATCHER zachova → SELECTOR vybere
    input: { name: "elektroinstalacni prislusenstvi 1183636", unit: "ks", quantity: 1 },
    checks: [
      { type: "exactLookupFound", desc: "SKU musi byt extrahovano a nalezeno" },
      { type: "selectedSku", expected: "1183636", desc: "Spravny SKU musi vyhrat i pres vagni popis" },
    ] },
  { suite: "C", name: "P0: Kod v popisu nesedici s nazvem → MATCHER nesmi vyradi",
    // Simuluje situaci kde EAN/kod je v poptavce ale nazev produktu je jiny
    // "objednavame toto: SYKFY 25X2X0,5" vs nazev v DB "KABEL SYKFY 25x2x0,5, BUBEN"
    // Cílem je overit ze exact match projde pres MATCHER i kdyz semanticka shoda je nizka
    input: { name: "pozadujeme kabel SYKFY 25X2X0,5 dle projektove dokumentace", unit: "m", quantity: 44 },
    checks: [
      { type: "exactLookupFound", desc: "SYKFY 25X2X0,5 musi byt nalezeno exact lookupem" },
      { type: "matchType", expected: "match", desc: "Exact match → match, ne uncertain" },
    ] },
  { suite: "C", name: "P0: Cisty EAN kod v poptavce → vybran spravny produkt",
    // Pokud uzivatel zada jen EAN (napr. ze ctecky carovych kodu), musi to fungovat
    // SKU 1257420007 = KABEL CYKY-J 3x2,5 BUBEN — testujeme ze SKU v poptavce funguje jako klic
    input: { name: "1257420007", unit: "m", quantity: 50 },
    checks: [
      { type: "exactLookupFound", desc: "SKU zadany primo musi fungovat jako klic" },
      { type: "selectedSku", expected: "1257420007", desc: "Spravny CYKY-J 3x2,5 BUBEN" },
    ] },

  // SUITE D: Brand preference
  { suite: "D", name: "Ramecek jednonasobny + ABB → ABB v candidates a vybran",
    input: { name: "ramecek jednonasobny", unit: "ks", quantity: 1 },
    groupContext: { preferredManufacturer: "ABB", preferredLine: null },
    checks: [
      { type: "skuInCandidates", sku: "1188530", desc: "ABB ramecek musi byt v candidates" },
      { type: "selectedSku", expected: "1188530", desc: "ABB musi byt vybran nad Legrandem" },
    ] },
  { suite: "D", name: "Jistic 2A C + Eaton PL7 → PL7 vybran",
    input: { name: "jistic 1-polovy 2A charakteristika C 6kA", unit: "ks", quantity: 5 },
    groupContext: { preferredManufacturer: "Eaton", preferredLine: "PL7" },
    checks: [
      { type: "skuInCandidates", sku: "1183635", desc: "PL7-C2/1 musi byt v candidates" },
      { type: "selectedSku", expected: "1183635", desc: "PL7 musi byt vybran" },
    ] },
  { suite: "D", name: "Cidlo pohybove + preferredLine ZONA → ZONA v candidates",
    input: { name: "cidlo pohybove stropni 360", unit: "ks", quantity: 1 },
    groupContext: { preferredManufacturer: null, preferredLine: "ZONA" },
    checks: [
      { type: "skuInCandidates", sku: "1394321", desc: "ZONA FLAT-W musi byt v candidates" },
    ] },
];

interface TestResult {
  suite: string; name: string; pass: boolean; failures: string[];
  matchType: string; confidence: number; selectedSku: string;
  candidateSkus: string[]; exactLookupFound: boolean;
}

async function runTest(tc: TestCase): Promise<TestResult> {
  const noop: PipelineDebugFn = () => {};
  let result: Awaited<ReturnType<typeof searchPipelineForItem>> | undefined;
  try {
    result = await searchPipelineForItem(
      { name: tc.input.name, unit: tc.input.unit ?? null, quantity: tc.input.quantity ?? null },
      0, noop, PREFS, tc.groupContext,
    );
  } catch (e) {
    return { suite: tc.suite, name: tc.name, pass: false,
      failures: [`Pipeline error: ${(e as Error).message}`],
      matchType: "error", confidence: 0, selectedSku: "", candidateSkus: [], exactLookupFound: false };
  }
  const failures: string[] = [];
  const candidateSkus = result.candidates.map(c => String(c.sku ?? ""));
  const selectedSku = String(result.product?.sku ?? "");
  for (const check of tc.checks) {
    switch (check.type) {
      case "matchType":
        if (result.matchType !== check.expected)
          failures.push(`${check.desc}: got "${result.matchType}", expected "${check.expected}"`);
        break;
      case "confidenceMax":
        if (result.confidence > check.max)
          failures.push(`${check.desc}: got ${result.confidence}%, max ${check.max}%`);
        break;
      case "selectedSku":
        if (selectedSku !== check.expected)
          failures.push(`${check.desc}: got "${selectedSku}", expected "${check.expected}"`);
        break;
      case "skuInCandidates":
        if (!candidateSkus.includes(check.sku))
          failures.push(`${check.desc}: SKU ${check.sku} CHYBI v candidates [${candidateSkus.join(", ")}]`);
        break;
      case "skuNotInCandidates":
        if (candidateSkus.includes(check.sku))
          failures.push(`${check.desc}: SKU ${check.sku} NESMI byt v candidates ale je tam`);
        break;
      case "exactLookupFound":
        if (!result.exactLookupFound)
          failures.push(`${check.desc}: exact lookup NENALEZL nic`);
        break;
    }
  }
  return { suite: tc.suite, name: tc.name, pass: failures.length === 0, failures,
    matchType: result.matchType, confidence: result.confidence,
    selectedSku, candidateSkus, exactLookupFound: result.exactLookupFound };
}

const SUITE_NAMES: Record<string, string> = {
  A: "Varianta bez specifikace (P1)",
  B: "MATCHER tvrde parametry (P3)",
  C: "EAN a objednaci kody",
  D: "Brand preference (P2)",
};

async function main() {
  const allResults: TestResult[] = [];
  for (const suite of ["A", "B", "C", "D"]) {
    const cases = TESTS.filter(t => t.suite === suite);
    console.log(`\n--- SUITE ${suite}: ${SUITE_NAMES[suite]} (${cases.length} testu) ---`);
    for (const tc of cases) {
      process.stdout.write(`  ${tc.name.slice(0, 55).padEnd(56)}... `);
      const r = await runTest(tc);
      allResults.push(r);
      if (r.pass) {
        console.log("PASS");
      } else {
        console.log("FAIL");
        r.failures.forEach(f => console.log(`     -> ${f}`));
        console.log(`     matchType: ${r.matchType} | conf: ${r.confidence}% | selected: ${r.selectedSku || "null"}`);
        if (r.candidateSkus.length) console.log(`     candidates: [${r.candidateSkus.join(", ")}]`);
      }
    }
  }
  const total = allResults.length;
  const passed = allResults.filter(r => r.pass).length;
  const pct = Math.round(passed / total * 100);
  console.log(`\n=== CELKEM: ${passed}/${total} = ${pct}% ===`);
  for (const suite of ["A", "B", "C", "D"]) {
    const sr = allResults.filter(r => r.suite === suite);
    const sp = sr.filter(r => r.pass).length;
    console.log(`  Suite ${suite}: ${sp}/${sr.length} — ${SUITE_NAMES[suite]}`);
  }
  if (pct >= 80) {
    console.log("\nCil 80% SPLNEN — navrzene zmeny jsou spravnym smerem");
  } else {
    console.log(`\nCil 80% NESPLNEN (${pct}%) — nutna architekturalni uprava pred implementaci`);
  }
}

main().catch(console.error);
