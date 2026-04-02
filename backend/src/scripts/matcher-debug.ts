/**
 * matcher-debug.ts
 * Testuje MATCHER na reálných 60 kandidátech z pipeline.
 * Porovnává gpt-5.4 vs gpt-5.4-mini a přísný vs současný prompt.
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import * as path from "path";
import OpenAI from "openai";
import { searchPipelineForItem, DEFAULT_PREFERENCES, type ParsedItem } from "../services/searchPipeline.js";
import { getAdminClient } from "../services/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ── Fetch product data ───────────────────────────────────────

async function fetchProducts(skus: string[]) {
  if (skus.length === 0) return [];
  const supabase = getAdminClient();
  const { data } = await supabase
    .from("products_v2")
    .select("sku, name, unit, category_sub, category_line, description")
    .in("sku", skus);
  return (data ?? []) as Array<{
    sku: string; name: string; unit: string | null;
    category_sub: string | null; category_line: string | null;
    description: string | null;
  }>;
}

// ── Get real 60 candidates from pipeline ────────────────────

async function getPipelineCandidates(item: ParsedItem): Promise<{
  allSkus: string[];
  matcherSelectedSku: string | null;
}> {
  let allSkus: string[] = [];
  let matcherSelectedSku: string | null = null;

  await searchPipelineForItem(
    item,
    0,
    (entry) => {
      if (entry.step === "merge") {
        const d = entry.data as { allSkus?: string[] };
        allSkus = d.allSkus ?? [];
      }
      if (entry.step === "selector") {
        const d = entry.data as { selectedSku?: string };
        matcherSelectedSku = d.selectedSku ?? null;
      }
    },
    DEFAULT_PREFERENCES,
  );

  return { allSkus, matcherSelectedSku };
}

// ── Test cases ───────────────────────────────────────────────

const TEST_CASES = [
  {
    label: "① KABEL průřez — CXKH-R-J 5×1,5 (3310m)",
    item: { name: "CXKH-R-J 5×1,5", quantity: 3310, unit: "m" } as ParsedItem,
    expectedSku: "1756872",
    note: "Fail: MATCHER dával SKU 1352637 (5×95) s matchScore 97 v prod.",
  },
  {
    label: "② KABEL průřez — CXKH-R-J 3×1,5 (15019m)",
    item: { name: "CXKH-R-J 3×1,5", quantity: 15019, unit: "m" } as ParsedItem,
    expectedSku: "1748875",
    note: "Stejná rodina, jiný průřez + počet žil. Velké množství = BUBEN.",
  },
  {
    label: "③ KABEL průřez — Vodič CYA 50 (162m)",
    item: { name: "Vodič CYA50", quantity: 162, unit: "m" } as ParsedItem,
    expectedSku: "1257467004",
    note: "CYA ≠ CY, průřez 50 musí sedět přesně.",
  },
  {
    label: "④ JISTIČ — 1P 16A char B 6kA",
    item: { name: "jistič 1-pólový 16 A vypínací charakteristika B vypínací schopnost 6 kA", quantity: 10, unit: "ks" } as ParsedItem,
    expectedSku: "1180880",
    note: "Jistič fungoval v kontrolovaném testu — ověříme s 60 kandidáty.",
  },
  {
    label: "⑤ KRABICE — pod omítku hluboká D 70mm",
    item: { name: "krabice pod omítku PVC přístrojová kruhová D 70mm hluboká", quantity: 92, unit: "ks" } as ParsedItem,
    expectedSku: "1212052",
    note: "gpt-5.4-mini v kontrolovaném testu dával špatný produkt (mělká místo hluboká).",
  },
];

// ── Prompts ──────────────────────────────────────────────────

// Aktuální produkční prompt (zjednodušená verze pro debug)
const CURRENT_PROMPT = `Jsi expert na elektroinstalační produkty. Vyber TOP 10 technicky nejlepších shod.

KROK 1: Z originalName extrahuj typ + všechny číselné/technické parametry.

KROK 2: Vyber max 10 kandidátů technicky nejbližších poptávce.
Pro každého: matchScore 0-100 + 1 věta proč.

Pravidla (nesedí = nevyber):
- Průřez kabelu musí sedět číselně: 5×1,5 ≠ 5×95
- Počet žil/pólů musí sedět: 3× ≠ 5×
- Typ kabelu (každé písmeno záleží): CXKH ≠ CYKY, CXKH ≠ CXKE, -J ≠ -O
- Jmenovitý proud: 16A ≠ 10A
- Vypínací charakteristika: B ≠ C
- Montáž: pod omítku ≠ do dutých stěn
- Hloubka: hluboká ≠ mělká
- Balení kabelů (demandUnit=m): zařaď BUBEN i KRUH varianty, SELECTOR rozhodne

Odpověď JSON:
{
  "extracted_params": { "type": "...", "params": { "klic": "hodnota" } },
  "top10": [ { "sku": "...", "name": "...", "matchScore": 95, "reason": "1 věta" } ],
  "reasoning": "celkové zhodnocení"
}`;

// Přísnější prompt
const STRICT_PROMPT = `Jsi přísný technický filtr pro elektroinstalační produkty. Tvůj úkol: z kandidátů vybrat POUZE ty, které jsou technicky PŘESNĚ shodné s poptávkou.

KROK 1: Z originalName extrahuj parametry — typ + každé číslo zvlášť.
Příklad: "CXKH-R-J 5×1,5" → typ=CXKH-R-J, žil=5, průřez=1,5mm²

KROK 2: Pro každého kandidáta porovnej parametry ČÍSELNĚ. Vyber max 10 nejlepších.
Nejasné nebo přibližné shody NEVYBER — raději prázdný shortlist než špatný produkt.

ABSOLUTNÍ pravidla — 1 nesoulad = vyřazení:
- Průřez (mm²): 1,5 ≠ 2,5 ≠ 4 ≠ 6 ≠ 10 ≠ 16 ≠ 25 ≠ 35 ≠ 50 ≠ 70 ≠ 95 ≠ 120 ≠ 240
- Počet žil: 1 ≠ 2 ≠ 3 ≠ 4 ≠ 5
- Typ kabelu: CXKH ≠ CXKE ≠ CYKY ≠ CYA ≠ CY (každá zkratka jiný produkt!)
- Provedení: -J (s PE vodičem) ≠ -O (bez PE vodiče)
- Profil: -R (kulatý) ≠ -V (plochý)
- Jmenovitý proud jističe: každý ampér jiný produkt
- Charakteristika: B ≠ C ≠ D
- Montáž krabice: pod omítku ≠ do dutých stěn ≠ na povrch
- Hloubka: hluboká ≠ mělká (jsou to různé produkty!)

Pro kabely v metrech: Zařaď BUBEN i KRUH — SELECTOR vybere správné balení podle množství.

Odpověď JSON:
{
  "extracted_params": { "type": "...", "params": { "klic": "hodnota" } },
  "top10": [ { "sku": "...", "name": "...", "matchScore": 95, "reason": "1 věta proč přesně sedí" } ],
  "reasoning": "celkové zhodnocení — pokud prázdný shortlist, vysvětli proč žádný kandidát nesedí"
}`;

// ── Run MATCHER verbosely ────────────────────────────────────

async function runVerboseMatcher(
  promptLabel: string,
  prompt: string,
  model: string,
  demand: { name: string; unit: string; quantity: number },
  candidates: Array<{ sku: string; name: string; unit: string | null; category_sub: string | null; category_line: string | null; description: string | null }>,
  expectedSku: string,
) {
  const payload = candidates.map((c) => ({
    sku: c.sku,
    name: c.name,
    unit: c.unit,
    category_sub: c.category_sub,
    category_line: c.category_line,
    foundByExactCode: false,
    ...(c.description && c.description.trim().length > 5 ? { description: c.description.slice(0, 150) } : {}),
  }));

  const userMsg = JSON.stringify({
    originalName: demand.name,
    demandUnit: demand.unit,
    demandQuantity: demand.quantity,
    candidates: payload,
  });

  let raw: string | null = null;
  try {
    const res = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }, { role: "user", content: userMsg }],
      max_completion_tokens: 4000,
    });
    raw = res.choices[0]?.message?.content ?? null;
  } catch (e) {
    console.error(`  [${promptLabel}/${model}] API error:`, e);
    return;
  }

  let parsed: {
    extracted_params?: { type?: string; params?: Record<string, string> };
    top10?: Array<{ sku: string; name: string; matchScore?: number; reason: string }>;
    reasoning?: string;
  };
  try { parsed = JSON.parse(raw ?? "{}"); } catch { console.log("  JSON parse error"); return; }

  const top10 = parsed.top10 ?? [];
  const inTop = top10.some((e) => e.sku === expectedSku);
  const topSku = top10[0]?.sku ?? "(prázdný)";
  const isTopCorrect = topSku === expectedSku;

  console.log(`\n  [${promptLabel} / ${model}]`);
  console.log(`  Extrahováno: ${parsed.extracted_params?.type ?? "?"} | ${JSON.stringify(parsed.extracted_params?.params ?? {})}`);
  console.log(`  Top10 (${top10.length}): ${top10.map((e) => `${e.sku}(${e.matchScore ?? "?"})`).join(", ") || "(prázdný)"}`);
  console.log(`  Správný SKU ${expectedSku}: ${inTop ? "✅ v top10" : "❌ NENÍ v top10"}`);
  console.log(`  #1 výběr: ${topSku} ${isTopCorrect ? "✅ SPRÁVNĚ" : "❌ ŠPATNĚ"}`);
  if (!inTop || !isTopCorrect) {
    const topItem = top10[0];
    if (topItem) console.log(`  #1 reason: ${topItem.reason}`);
    console.log(`  Reasoning: ${parsed.reasoning}`);
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   MATCHER DEBUG — 60 reálných kandidátů, 2 modely, 2 prompty ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  for (const tc of TEST_CASES) {
    console.log(`\n${"━".repeat(70)}`);
    console.log(tc.label);
    console.log(`Poptávka: "${tc.item.name}" | ${tc.item.quantity} ${tc.item.unit}`);
    console.log(`Expected: ${tc.expectedSku} | ${tc.note}`);

    // Get real 60 candidates from pipeline
    process.stdout.write("  Získávám kandidáty z pipeline...");
    const { allSkus, matcherSelectedSku } = await getPipelineCandidates(tc.item);
    console.log(` ${allSkus.length} kandidátů`);
    console.log(`  Pipeline vybrala: ${matcherSelectedSku ?? "(nic)"} ${matcherSelectedSku === tc.expectedSku ? "✅" : "❌"}`);

    const expectedRank = allSkus.indexOf(tc.expectedSku);
    console.log(`  Správný SKU rank v merged: ${expectedRank === -1 ? "NENALEZEN" : `#${expectedRank}`}`);

    if (allSkus.length === 0) {
      console.log("  ⚠️  Retrieval miss — žádní kandidáti, přeskakuji.");
      continue;
    }

    // Fetch full product data
    const products = await fetchProducts(allSkus.slice(0, 60));
    const productMap = new Map(products.map((p) => [p.sku, p]));
    const candidates = allSkus
      .slice(0, 60)
      .map((sku) => productMap.get(sku))
      .filter((p): p is NonNullable<typeof p> => p != null);

    console.log(`  Produktová data: ${candidates.length}/${Math.min(allSkus.length, 60)}`);

    const demand = { name: tc.item.name, unit: tc.item.unit ?? "ks", quantity: tc.item.quantity ?? 1 };

    // Run 4 combinations: 2 prompts × 2 models
    await runVerboseMatcher("current", CURRENT_PROMPT, "gpt-5.4-mini", demand, candidates, tc.expectedSku);
    await runVerboseMatcher("strict",  STRICT_PROMPT,  "gpt-5.4-mini", demand, candidates, tc.expectedSku);
    await runVerboseMatcher("current", CURRENT_PROMPT, "gpt-5.4",      demand, candidates, tc.expectedSku);
    await runVerboseMatcher("strict",  STRICT_PROMPT,  "gpt-5.4",      demand, candidates, tc.expectedSku);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log("HOTOV");
  console.log("═".repeat(70));
}

main().catch(console.error);
