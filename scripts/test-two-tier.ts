/**
 * Two-Tier Evaluation Prototype
 *
 * Tests a split evaluation architecture:
 *   Tier 1: MATCHER — pure product type+parameter matching (no business logic)
 *   Tier 2: SELECTOR — business rules (price, stock, manufacturer) on shortlisted products
 *
 * Runs both single-tier (current) and two-tier on the SAME candidates for fair comparison.
 *
 * Usage: npx tsx scripts/test-two-tier.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
  type ProductResult,
} from "../backend/src/services/search.js";
import { generateQueryEmbedding } from "../backend/src/services/embedding.js";
import type { SearchPreferences, SearchPlan } from "../backend/src/services/searchPipeline.js";

// ── Config ─────────────────────────────────────────────────

const MODEL = "gpt-4.1";
const MAX_FT = 30;
const MAX_SEM = 50;
const SIM_THRESH = 0.35;

function openai(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

// ── Types ──────────────────────────────────────────────────

interface OfferItem {
  name: string;
  unit: string;
  quantity: number;
  instruction?: string | null;
}

interface MergedCandidate extends ProductResult {
  cosine_similarity: number;
  source: "raw" | "reformulated" | "fulltext" | "exact" | "both";
}

interface MatcherShortlistEntry {
  sku: string;
  matchScore: number;
  paramMatch: "full" | "partial" | "type_only";
  reasoning: string;
}

interface MatcherResult {
  shortlist: MatcherShortlistEntry[];
  bestMatchType: "match" | "uncertain" | "not_found";
  reasoning: string;
  refinement?: {
    action: "refine_search";
    query: string;
    subcategory: string | null;
    manufacturer: string | null;
  };
}

interface SelectorResult {
  selectedSku: string | null;
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  reasoning: string;
  priceNote: string | null;
}

interface SingleTierResult {
  matchType: string;
  confidence: number;
  selectedSku: string | null;
  reasoning: string;
}

interface ItemResult {
  position: number;
  name: string;
  unit: string;
  quantity: number;
  candidateCount: number;
  singleTier: SingleTierResult;
  twoTier: {
    matcher: MatcherResult;
    selector: SelectorResult;
  };
  singleTierProduct: Partial<ProductResult> | null;
  twoTierProduct: Partial<ProductResult> | null;
  pipelineMs: number;
}

// ── Test Data ──────────────────────────────────────────────

const OFFER_ITEMS: OfferItem[] = [
  { name: "rozvodnice RK - úprava zapojení stávající", unit: "ks", quantity: 1 },
  { name: "Jistič B3x16", unit: "ks", quantity: 2 },
  { name: "Jistič B1x16", unit: "ks", quantity: 1 },
  { name: "Proudový chránič s nadproudovou ochranou 0,03A/InB1x10A", unit: "ks", quantity: 2 },
  { name: "Napěťová spoušť", unit: "ks", quantity: 1 },
  { name: "svítidlo čtvercové 23,1W 2850 lm LED IP 54", unit: "ks", quantity: 32 },
  { name: "svítidlo lineární 38,4W 5350 lm LED IP 54", unit: "ks", quantity: 5 },
  { name: "svítidlo lineární 52,8W 7360 lm LED IP 54", unit: "ks", quantity: 1 },
  { name: "Svítidlo nouzové s vlastní baterií/m zdrojem (záloha 30 minut)", unit: "ks", quantity: 16 },
  { name: "Vypínač (řazení 6)", unit: "ks", quantity: 4 },
  { name: "Vypínač IP 44 (řazení 1)", unit: "ks", quantity: 4 },
  { name: "Vypínač IP 44 (řazení 6)", unit: "ks", quantity: 8 },
  { name: "Tlačítko bezpečnostní s omezeným přístupem", unit: "ks", quantity: 1 },
  { name: "Zásuvka 230V/16A dvounásobná", unit: "ks", quantity: 2 },
  { name: "Zásuvka 230V/16A IP44", unit: "ks", quantity: 28 },
  { name: "Zásuvka 400V/16A IP44", unit: "ks", quantity: 1 },
  { name: "Vypínač 3F/25A", unit: "ks", quantity: 2 },
  { name: "Krabice KO8", unit: "ks", quantity: 80 },
  { name: "Svorka WAGO", unit: "ks", quantity: 60 },
  { name: "Vývod 3f (připojení gastro zařízení VZT, chlazení)", unit: "ks", quantity: 4 },
  { name: "Vývod 1f (připojení digestoře)", unit: "ks", quantity: 1 },
  { name: "Svorkovnice v MET v krabici", unit: "ks", quantity: 1 },
  { name: "Ochranné pospojení (vývod)", unit: "ks", quantity: 9 },
  { name: "Svorka BERNARD vč. pásku CU", unit: "ks", quantity: 20 },
  { name: "Vodič CY 10", unit: "m", quantity: 5 },
  { name: "Vodič CY 4", unit: "m", quantity: 100 },
  { name: "Kabel CYKY 3x1,5", unit: "m", quantity: 350 },
  { name: "Kabel CYKY 3x2,5", unit: "m", quantity: 250 },
  { name: "Kabel CYKY 5x2,5", unit: "m", quantity: 120 },
  { name: "Kabel CYKY 5x4", unit: "m", quantity: 80 },
  { name: "Kabel CYKY 2x1,5", unit: "m", quantity: 20 },
  { name: "Kabel UTP cat5", unit: "m", quantity: 100 },
  { name: "Kabel CGSG J5x2,5", unit: "m", quantity: 20 },
];

// ── Reformulation ──────────────────────────────────────────

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do formy, která nejlépe odpovídá českému B2B katalogu elektroinstalačního materiálu (KV Elektro).

## PRAVIDLA
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext, přidej alternativní názvy
2. Pokud zkratce NEROZUMÍŠ, ponech originální text — NIKDY nevymýšlej
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny (přidej kontext vedle)
4. Používej × místo x u průřezů kabelů (5×2,5 ne 5x2,5)
5. Přidej i katalogový styl názvu

## PŘÍKLADY KONVERZE
- "jistič 1-pólový 16 A B" → "JISTIC PL6-B16/1 jistič jednopólový 16A charakteristika B"
- "jistič 3-pólový 25 A B 10kA" → "JISTIC PL6-B25/3 jistič třípólový 25A B"
- "kabel instalační ... (CYKY) 3x1,5mm2" → "KABEL 1-CYKY-J 3x1,5 CYKY kabel instalační 3×1,5"
- "Vodič CY 6" → "VODIC H07V-U 1x6 CY vodič 6mm2 jednodrátový"
- "Vodič CYA 35" → "VODIC H07V-K 1x35 CYA vodič 35mm2 lanovaný"
- "CXKH-R-J 5×2,5" → "KABEL 1-CXKH-R-J 5x2,5 B2CAS1D0 kabel bezhalogenový požárně odolný"
- "rozvodnice nástěnná 72 modulů" → "ROZVODNICE rozváděčová skříň nástěnná 72 modulů IP41"

## DŮLEŽITÉ
- V katalogu mají kabely prefix "1-" (např. 1-CYKY-J, 1-CXKH-R-J)
- V katalogu se vodiče značí H07V-U (drátový=CY) a H07V-K (lanovaný=CYA)
- Jističe se v katalogu značí jako PL6-BAMP/POLES nebo podobně

Vrať plain text — jen přeformulovaný název.`;

function normalizeQuery(raw: string): string {
  let q = raw;
  q = q.replace(/×/g, "x");
  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/(\d)\s*mm[²2]/gi, "$1");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

async function reformulate(name: string, instruction?: string | null): Promise<string> {
  const userContent = instruction ? `${name}\n\nDodatečný kontext: ${instruction}` : name;
  const res = await openai().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: REFORM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });
  return res.choices[0]?.message?.content?.trim() ?? name;
}

// ── Search + Merge ─────────────────────────────────────────

function mergeSemanticResults(raw: SemanticResult[], ref: SemanticResult[]): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const r of raw) map.set(r.sku, { ...r, source: "raw" });
  for (const r of ref) {
    const ex = map.get(r.sku);
    if (ex) {
      if (r.cosine_similarity > ex.cosine_similarity) ex.cosine_similarity = r.cosine_similarity;
      ex.source = "both";
    } else {
      map.set(r.sku, { ...r, source: "reformulated" });
    }
  }
  return [...map.values()].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
}

function mergeInto(existing: MergedCandidate[], fresh: MergedCandidate[]): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const c of existing) map.set(c.sku, c);
  for (const c of fresh) {
    const ex = map.get(c.sku);
    if (ex) ex.cosine_similarity = Math.max(ex.cosine_similarity, c.cosine_similarity);
    else map.set(c.sku, c);
  }
  return [...map.values()].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
}

const EXACT_COSINE: Record<string, number> = {
  sku_exact: 1.0, ean_exact: 0.98, idnlf_exact: 0.98,
  ean_contains: 0.90, idnlf_contains: 0.90,
};

async function searchAndMerge(
  item: OfferItem,
  reformulated: string,
): Promise<MergedCandidate[]> {
  const normalized = normalizeQuery(item.name);

  const [rawEmb, refEmb, ftOrig, ftRef, exactRes] = await Promise.all([
    generateQueryEmbedding(normalized),
    generateQueryEmbedding(reformulated),
    searchProductsFulltext(normalized, MAX_FT).catch(() => [] as FulltextResult[]),
    searchProductsFulltext(reformulated, MAX_FT).catch(() => [] as FulltextResult[]),
    lookupProductsExact(normalized, 10).catch(() => [] as ExactResult[]),
  ]);

  const ftMap = new Map<string, FulltextResult>();
  for (const r of ftOrig) ftMap.set(r.sku, r);
  for (const r of ftRef) {
    const ex = ftMap.get(r.sku);
    if (!ex || (r.rank ?? 0) > (ex.rank ?? 0)) ftMap.set(r.sku, r);
  }

  const [rawSem, refSem] = await Promise.all([
    searchProductsSemantic(rawEmb, MAX_SEM, SIM_THRESH),
    searchProductsSemantic(refEmb, MAX_SEM, SIM_THRESH),
  ]);

  let merged = mergeSemanticResults(rawSem, refSem);

  const ftMerged: MergedCandidate[] = [...ftMap.values()].map((r) => ({
    ...r,
    cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
    source: "fulltext" as const,
  }));
  merged = mergeInto(merged, ftMerged);

  const exactMerged: MergedCandidate[] = exactRes.map((r) => ({
    ...r,
    cosine_similarity: EXACT_COSINE[r.match_type] ?? 0.95,
    source: "exact" as const,
  }));
  merged = mergeInto(merged, exactMerged);

  return merged;
}

// ── Single-Tier Evaluator (current approach — baseline) ────

const SINGLE_TIER_PROMPT = `Jsi přísný hodnotitel výsledků vyhledávání v B2B katalogu elektroinstalačního materiálu (KV Elektro, ~470K položek).

Dostaneš originální název produktu z poptávky a seznam KANDIDÁTŮ z vyhledávání.

## KRITICKY DŮLEŽITÉ — povaha kandidátů
Kandidáti jsou SUROVÉ výsledky z fulltextového a sémantického vyhledávání. VĚTŠINA kandidátů je irelevantní šum. Projdi je kriticky a vyber JEN pokud máš vysokou jistotu.

## Jak hodnotit
1. Urči TYP produktu z poptávky — jistič? kabel? vodič? svítidlo? zásuvka?
2. Vyřaď kandidáty jiného typu — i když mají vysokou similarity.
3. Porovnej klíčové parametry — proud (A), póly (P), průřez (mm²), napětí (V), počet žil, IP krytí, wattáž (W).
4. Ověř shodu názvu — pokud název kandidáta obsahuje klíčová slova z poptávky, je to silný signál.

## POZOR — běžné záměny (NIKDY nezaměňuj!)
- jistič ≠ pojistka
- CY (drátový, H07V-U) ≠ CYA (lanovaný, H07V-K)
- CYKY ≠ CXKH
- UTP ≠ FTP
- CXKH-R ≠ CXKH-V
- -J ≠ -O u kabelů

## matchType
- match (85-100): TYP + VŠECHNY klíčové parametry sedí.
- uncertain (60-84): TYP sedí, parametry částečně.
- multiple (60-100): VÍCE vhodných kandidátů, nelze jednoznačně vybrat.
- alternative (30-59): Podobný produkt ale odlišné parametry.
- not_found: Žádný kandidát neodpovídá.

## Cena a kontext
Kandidáti mají pole current_price. Použij ho podle offerContext:
- VÝBĚRKO: preferuj NEJNIŽŠÍ cenu ze shodných.
- REALIZACE: preferuj skladové položky od známých dodavatelů. Cena až na třetím místě.

## Měrné jednotky
U kabelů/vodičů: preferuj největší kruh jehož násobek = poptávané množství. Pokud žádný → buben.

Vrať VÝHRADNĚ JSON:
{
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "selectedSku": "SKU nebo null",
  "candidates": ["SKU1", "SKU2"],
  "reasoning": "1 věta česky"
}`;

async function singleTierEvaluate(
  item: OfferItem,
  candidates: MergedCandidate[],
  preferences?: SearchPreferences,
): Promise<SingleTierResult> {
  if (candidates.length === 0) {
    return { matchType: "not_found", confidence: 0, selectedSku: null, reasoning: "Žádní kandidáti." };
  }

  const top20 = candidates.slice(0, 20).map((c) => ({
    sku: c.sku, name: c.name, unit: c.unit,
    current_price: c.current_price,
    supplier_name: c.supplier_name,
    category_sub: c.category_sub,
    is_stock_item: c.is_stock_item,
    has_stock: c.has_stock,
    similarity: Math.round(c.cosine_similarity * 1000) / 1000,
    source: c.source,
  }));

  const payload: Record<string, unknown> = {
    originalName: item.name,
    candidates: top20,
  };
  if (item.unit) payload.demandUnit = item.unit;
  if (item.quantity != null) payload.demandQuantity = item.quantity;

  if (preferences) {
    payload.offerContext = preferences.offerType === "vyberko"
      ? "Typ nabídky: VÝBĚRKO — preferuj nejnižší cenu."
      : "Typ nabídky: REALIZACE — preferuj kvalitu, dostupnost, standardní dodavatele.";
  }

  const res = await openai().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SINGLE_TIER_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });

  const content = res.choices[0]?.message?.content;
  if (!content) return { matchType: "not_found", confidence: 0, selectedSku: null, reasoning: "AI selhala." };

  try {
    const p = JSON.parse(content);
    return {
      matchType: p.matchType ?? "not_found",
      confidence: Math.min(100, Math.max(0, p.confidence ?? 0)),
      selectedSku: p.selectedSku ?? null,
      reasoning: p.reasoning ?? "",
    };
  } catch {
    return { matchType: "not_found", confidence: 0, selectedSku: null, reasoning: "Parse error." };
  }
}

// ── Tier 1: MATCHER ────────────────────────────────────────

const MATCHER_PROMPT = `Jsi expert na párování elektroinstalačních produktů. Tvůj JEDINÝ úkol: najít kandidáty, kteří odpovídají hledanému produktu TYPEM a PARAMETRY.

NEHODNOTÍŠ cenu, sklad, výrobce, dostupnost. Hodnotíš POUZE:
1. Je to STEJNÝ TYP produktu? (jistič, kabel, vodič, svítidlo, zásuvka...)
2. Sedí KLÍČOVÉ PARAMETRY? (proud, póly, průřez, počet žil, IP, wattáž...)

## Vstup
Dostaneš originální název z poptávky a seznam raw kandidátů z vyhledávání. VĚTŠINA kandidátů je šum — to je normální.

## Postup
1. Urči TYP produktu z poptávky.
2. Projdi kandidáty a vyřaď všechny jiného typu.
3. U zbylých ověř shodu klíčových parametrů.
4. Vrať SHORTLIST max 5 nejlepších seřazený od nejlepšího.

## POZOR — běžné záměny (NIKDY nezaměňuj!)
- jistič ≠ pojistka (jiný produkt!)
- CY (drátový, H07V-U) ≠ CYA (lanovaný, H07V-K)
- CYKY ≠ CXKH (PVC vs bezhalogenový)
- UTP ≠ FTP (nestíněný vs stíněný)
- CXKH-R ≠ CXKH-V (kulatý vs plochý)
- -J ≠ -O (s/bez ochranného vodiče)

## Měrné jednotky
U kabelů/vodičů v m: preferuj největší kruh jehož násobek = poptávané množství (200m → 2×100m > 4×50m). Pokud žádný → buben. Nikdy nevolej not_found jen kvůli MJ.

## matchScore
- 90-100: PŘESNÁ shoda typu + všech klíčových parametrů
- 70-89: Typ sedí, většina parametrů sedí (chybí barva, přesný model)
- 50-69: Typ sedí, ale parametry se liší (jiný proud, jiný průřez)
- <50: Nezařazuj do shortlistu

## paramMatch
- "full": Typ + všechny parametry sedí
- "partial": Typ sedí, ne všechny parametry
- "type_only": Správný typ ale parametry se výrazně liší

## Odpověď
Vrať VÝHRADNĚ JSON:
{
  "shortlist": [
    { "sku": "...", "matchScore": 95, "paramMatch": "full", "reasoning": "1 věta" }
  ],
  "bestMatchType": "match" | "uncertain" | "not_found",
  "reasoning": "Celkové zhodnocení (1 věta česky)"
}

- shortlist: max 5 položek, seřazeno od nejlepšího. Prázdný pokud žádný kandidát nesedí typem.
- bestMatchType: "match" pokud aspoň 1 má matchScore ≥ 85, "uncertain" pokud 60-84, "not_found" pokud prázdný shortlist.`;

async function matcher(
  item: OfferItem,
  candidates: MergedCandidate[],
): Promise<MatcherResult> {
  if (candidates.length === 0) {
    return { shortlist: [], bestMatchType: "not_found", reasoning: "Žádní kandidáti." };
  }

  const top20 = candidates.slice(0, 20).map((c) => ({
    sku: c.sku, name: c.name, unit: c.unit,
    category_sub: c.category_sub,
    category_line: c.category_line,
    similarity: Math.round(c.cosine_similarity * 1000) / 1000,
    source: c.source,
  }));

  const payload: Record<string, unknown> = {
    originalName: item.name,
    candidates: top20,
  };
  if (item.unit) payload.demandUnit = item.unit;
  if (item.quantity != null) payload.demandQuantity = item.quantity;

  const res = await openai().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: MATCHER_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    temperature: 0.1,
    max_tokens: 600,
  });

  const content = res.choices[0]?.message?.content;
  if (!content) return { shortlist: [], bestMatchType: "not_found", reasoning: "AI selhala." };

  try {
    const p = JSON.parse(content);
    return {
      shortlist: (p.shortlist ?? []).slice(0, 5),
      bestMatchType: p.bestMatchType ?? "not_found",
      reasoning: p.reasoning ?? "",
      refinement: p.refinement,
    };
  } catch {
    return { shortlist: [], bestMatchType: "not_found", reasoning: "Parse error." };
  }
}

// ── Tier 2: SELECTOR ───────────────────────────────────────

const SELECTOR_PROMPT = `Jsi obchodní rozhodovatel pro elektroinstalační nabídky. Dostaneš SHORTLIST produktů, které již prošly produktovou shodou (typ a parametry sedí). Tvůj úkol: vybrat NEJLEPŠÍ variantu podle obchodních pravidel.

## Vstup
- shortlist: max 5 kandidátů s matchScore, cenou, skladem, dodavatelem
- offerType: "vyberko" nebo "realizace"
- groupContext: preferovaný výrobce/řada (pokud existuje z plánování)

## Pravidla pro VÝBĚRKO
1. Seřaď podle ceny VZESTUPNĚ
2. Vyber NEJLEVNĚJŠÍHO kandidáta
3. Při stejné ceně → preferuj skladem (has_stock = true)
4. Při stejné ceně a skladu → preferuj is_stock_item = true

## Pravidla pro REALIZACI
Priorita (od nejvyšší po nejnižší):
1. **Skladem** (has_stock = true) → silně preferuj
2. **Preferovaný výrobce/řada** → preferuj POUZE pokud cenový rozdíl je přijatelný:
   - cena ≤ 2× nejlevnější v shortlistu → OK, vyber preferovaného výrobce
   - cena 2-3× nejlevnější → vyber JEN pokud je skladem
   - cena > 3× nejlevnější → NEVYBER, vyber levnější alternativu a vysvětli v priceNote
3. **Cena** → při jinak rovných volbách preferuj nižší cenu
4. **is_stock_item** = true → mírný bonus (znamená standardní sortiment)

## Price ceiling — KRITICKÉ pravidlo
Pokud preferovaný výrobce stojí >3× více než nejlevnější alternativa STEJNÉHO typu, VŽDY vyber levnější a v priceNote uveď: "Preferovaný výrobce [X] je [N]x dražší. Vybrána levnější alternativa."

## Odpověď
Vrať VÝHRADNĚ JSON:
{
  "selectedSku": "SKU vybraného produktu nebo null",
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "reasoning": "1-2 věty česky — PROČ tuto variantu",
  "priceNote": "varování o ceně nebo null"
}

## matchType v kontextu selectoru
- Přebírej matchType podle matchScore z matcheru:
  - matchScore ≥ 85 → "match"
  - matchScore 60-84 → "uncertain"
  - matchScore < 60 → "alternative"
- Pokud shortlist je prázdný → "not_found"
- Pokud více kandidátů se stejným skóre → "multiple" (ale stále vyber jednoho)`;

async function selector(
  item: OfferItem,
  matcherResult: MatcherResult,
  candidates: MergedCandidate[],
  preferences?: SearchPreferences,
  groupContext?: { preferredManufacturer: string | null; preferredLine: string | null },
): Promise<SelectorResult> {
  if (matcherResult.shortlist.length === 0) {
    return {
      selectedSku: null,
      matchType: "not_found",
      confidence: 0,
      reasoning: matcherResult.reasoning,
      priceNote: null,
    };
  }

  const candidateMap = new Map(candidates.map((c) => [c.sku, c]));

  const enrichedShortlist = matcherResult.shortlist.map((s) => {
    const c = candidateMap.get(s.sku);
    return {
      sku: s.sku,
      name: c?.name ?? "?",
      matchScore: s.matchScore,
      paramMatch: s.paramMatch,
      current_price: c?.current_price ?? null,
      supplier_name: c?.supplier_name ?? null,
      is_stock_item: c?.is_stock_item ?? false,
      has_stock: c?.has_stock ?? false,
      unit: c?.unit ?? null,
    };
  });

  const prices = enrichedShortlist
    .map((s) => s.current_price)
    .filter((p): p is number => p != null);

  const payload: Record<string, unknown> = {
    demand: { name: item.name, unit: item.unit, quantity: item.quantity },
    shortlist: enrichedShortlist,
    priceRange: prices.length > 0 ? {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    } : null,
    offerType: preferences?.offerType ?? "realizace",
  };

  if (groupContext?.preferredManufacturer || groupContext?.preferredLine) {
    payload.groupContext = groupContext;
  }

  const res = await openai().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SELECTOR_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    temperature: 0.1,
    max_tokens: 400,
  });

  const content = res.choices[0]?.message?.content;
  if (!content) {
    return {
      selectedSku: matcherResult.shortlist[0]?.sku ?? null,
      matchType: "uncertain",
      confidence: 50,
      reasoning: "Selector AI selhala, fallback na top kandidáta.",
      priceNote: null,
    };
  }

  try {
    const p = JSON.parse(content);
    return {
      selectedSku: p.selectedSku ?? null,
      matchType: p.matchType ?? "uncertain",
      confidence: Math.min(100, Math.max(0, p.confidence ?? 0)),
      reasoning: p.reasoning ?? "",
      priceNote: p.priceNote ?? null,
    };
  } catch {
    return {
      selectedSku: matcherResult.shortlist[0]?.sku ?? null,
      matchType: "uncertain",
      confidence: 50,
      reasoning: "Parse error, fallback.",
      priceNote: null,
    };
  }
}

// ── Pipeline Orchestration ─────────────────────────────────

async function runComparison(
  label: string,
  items: OfferItem[],
  preferences?: SearchPreferences,
  groupContexts?: Map<number, { preferredManufacturer: string | null; preferredLine: string | null }>,
): Promise<ItemResult[]> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(label);
  console.log(`${"═".repeat(70)}\n`);

  const results: ItemResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemT0 = Date.now();

    const normalized = normalizeQuery(item.name);
    const reformulated = await reformulate(normalized, item.instruction);
    const candidates = await searchAndMerge(item, reformulated);

    const [st, mt] = await Promise.all([
      singleTierEvaluate(item, candidates, preferences),
      matcher(item, candidates),
    ]);

    const groupCtx = groupContexts?.get(i);
    const sel = await selector(item, mt, candidates, preferences, groupCtx);

    const stProduct = st.selectedSku ? candidates.find((c) => c.sku === st.selectedSku) ?? null : null;
    const ttProduct = sel.selectedSku ? candidates.find((c) => c.sku === sel.selectedSku) ?? null : null;

    results.push({
      position: i,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      candidateCount: candidates.length,
      singleTier: st,
      twoTier: { matcher: mt, selector: sel },
      singleTierProduct: stProduct ? {
        sku: stProduct.sku, name: stProduct.name, current_price: stProduct.current_price,
        supplier_name: stProduct.supplier_name, is_stock_item: stProduct.is_stock_item, has_stock: stProduct.has_stock,
      } : null,
      twoTierProduct: ttProduct ? {
        sku: ttProduct.sku, name: ttProduct.name, current_price: ttProduct.current_price,
        supplier_name: ttProduct.supplier_name, is_stock_item: ttProduct.is_stock_item, has_stock: ttProduct.has_stock,
      } : null,
      pipelineMs: Date.now() - itemT0,
    });

    process.stdout.write(`\r  Progress: ${i + 1}/${items.length}`);
  }

  const totalMs = Date.now() - t0;
  console.log(`\r  Done: ${items.length} items in ${(totalMs / 1000).toFixed(1)}s\n`);

  printResults(results);
  return results;
}

// ── Reporting ──────────────────────────────────────────────

function printResults(results: ItemResult[]) {
  let stFound = 0, ttFound = 0, sameSku = 0, diffSku = 0;
  const stMatch: Record<string, number> = {};
  const ttMatch: Record<string, number> = {};
  let priceNotes = 0;

  for (const r of results) {
    if (r.singleTierProduct) stFound++;
    if (r.twoTierProduct) ttFound++;

    stMatch[r.singleTier.matchType] = (stMatch[r.singleTier.matchType] ?? 0) + 1;
    ttMatch[r.twoTier.selector.matchType] = (ttMatch[r.twoTier.selector.matchType] ?? 0) + 1;

    if (r.singleTierProduct?.sku === r.twoTierProduct?.sku) sameSku++;
    else if (r.singleTierProduct || r.twoTierProduct) diffSku++;

    if (r.twoTier.selector.priceNote) priceNotes++;
  }

  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │            AGGREGATE COMPARISON              │");
  console.log("  ├─────────────────────────────────────────────┤");
  console.log(`  │ Single-tier found:  ${String(stFound).padStart(2)}/${results.length}                     │`);
  console.log(`  │ Two-tier found:     ${String(ttFound).padStart(2)}/${results.length}                     │`);
  console.log(`  │ Same product:       ${String(sameSku).padStart(2)}/${results.length}                     │`);
  console.log(`  │ Different product:  ${String(diffSku).padStart(2)}/${results.length}                     │`);
  console.log(`  │ Price notes:        ${String(priceNotes).padStart(2)}                          │`);
  console.log("  └─────────────────────────────────────────────┘\n");

  console.log(`  Single-tier matchTypes: ${JSON.stringify(stMatch)}`);
  console.log(`  Two-tier matchTypes:    ${JSON.stringify(ttMatch)}\n`);

  console.log("  DETAIL (per item):");
  console.log("  " + "─".repeat(140));
  console.log(
    "  " +
    "Item".padEnd(45) +
    " │ ST matchType  conf │ TT matchType  conf │ " +
    "ST product".padEnd(30) + " │ " +
    "TT product".padEnd(30) + " │ priceNote",
  );
  console.log("  " + "─".repeat(140));

  for (const r of results) {
    const stName = r.singleTierProduct?.name?.toString().slice(0, 28) ?? "—";
    const ttName = r.twoTierProduct?.name?.toString().slice(0, 28) ?? "—";
    const stPrice = r.singleTierProduct?.current_price != null ? `${r.singleTierProduct.current_price}` : "";
    const ttPrice = r.twoTierProduct?.current_price != null ? `${r.twoTierProduct.current_price}` : "";
    const stLabel = `${stName}${stPrice ? ` (${stPrice}Kč)` : ""}`;
    const ttLabel = `${ttName}${ttPrice ? ` (${ttPrice}Kč)` : ""}`;

    const same = r.singleTierProduct?.sku === r.twoTierProduct?.sku;
    const icon = same ? " " : (r.twoTier.selector.priceNote ? "$" : "≠");

    console.log(
      `  ${icon} ${r.name.slice(0, 43).padEnd(43)}` +
      ` │ ${r.singleTier.matchType.padEnd(11)} ${String(r.singleTier.confidence).padStart(3)}%` +
      ` │ ${r.twoTier.selector.matchType.padEnd(11)} ${String(r.twoTier.selector.confidence).padStart(3)}%` +
      ` │ ${stLabel.padEnd(30)}` +
      ` │ ${ttLabel.padEnd(30)}` +
      ` │ ${r.twoTier.selector.priceNote?.slice(0, 50) ?? ""}`,
    );
  }
  console.log();

  const diffs = results.filter(
    (r) => r.singleTierProduct?.sku !== r.twoTierProduct?.sku &&
           (r.singleTierProduct || r.twoTierProduct),
  );

  if (diffs.length > 0) {
    console.log(`  PRODUCT DIFFERENCES (${diffs.length}):`);
    console.log("  " + "─".repeat(100));
    for (const r of diffs) {
      const stP = r.singleTierProduct;
      const ttP = r.twoTierProduct;
      console.log(`  "${r.name.slice(0, 50)}"`);
      console.log(
        `    ST: ${stP?.name?.toString().slice(0, 50) ?? "none"} ` +
        `(${stP?.current_price ?? "?"}Kč, ${stP?.supplier_name ?? "?"}, stock=${stP?.has_stock ?? "?"})`,
      );
      console.log(
        `    TT: ${ttP?.name?.toString().slice(0, 50) ?? "none"} ` +
        `(${ttP?.current_price ?? "?"}Kč, ${ttP?.supplier_name ?? "?"}, stock=${ttP?.has_stock ?? "?"})`,
      );
      console.log(`    Matcher shortlist: ${r.twoTier.matcher.shortlist.length} items, best: ${r.twoTier.matcher.bestMatchType}`);
      console.log(`    Selector reasoning: ${r.twoTier.selector.reasoning}`);
      if (r.twoTier.selector.priceNote) console.log(`    PRICE NOTE: ${r.twoTier.selector.priceNote}`);
      console.log();
    }
  }
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       TWO-TIER EVALUATION PROTOTYPE TEST                    ║");
  console.log("║  Single-tier vs Two-tier (Matcher+Selector) on same data    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Items: ${OFFER_ITEMS.length}`);

  // Run 1: No preferences (baseline comparison)
  const baseline = await runComparison(
    "RUN 1: Single-tier vs Two-tier (no preferences, no planner)",
    OFFER_ITEMS,
  );

  // Run 2: With planner + REALIZACE
  console.log("\n  Generating search plan for REALIZACE...");
  const { createSearchPlan } = await import("../backend/src/services/searchPipeline.js");
  const realizacePrefs: SearchPreferences = {
    offerType: "realizace", stockFilter: "any", branchFilter: null, priceStrategy: "standard",
  };
  const plan = await createSearchPlan(
    OFFER_ITEMS.map((it) => ({ name: it.name, unit: it.unit, quantity: it.quantity })),
    realizacePrefs,
  );

  console.log(`  Plan: ${plan.groups.length} groups`);
  for (const g of plan.groups) {
    console.log(`    [${g.groupName}] ${g.itemIndices.length} items, mfr: ${g.suggestedManufacturer ?? "—"}, line: ${g.suggestedLine ?? "—"}`);
  }

  const enrichedItems: OfferItem[] = OFFER_ITEMS.map((item, i) => ({
    ...item,
    instruction: plan.enrichedItems[i]?.instruction ?? null,
  }));

  const groupContexts = new Map<number, { preferredManufacturer: string | null; preferredLine: string | null }>();
  for (const g of plan.groups) {
    for (const idx of g.itemIndices) {
      groupContexts.set(idx, {
        preferredManufacturer: g.suggestedManufacturer,
        preferredLine: g.suggestedLine,
      });
    }
  }

  const realizace = await runComparison(
    "RUN 2: Single-tier vs Two-tier (REALIZACE + planner)",
    enrichedItems,
    realizacePrefs,
    groupContexts,
  );

  // Run 3: With planner + VÝBĚRKO
  const vyberkoPrefs: SearchPreferences = {
    offerType: "vyberko", stockFilter: "any", branchFilter: null, priceStrategy: "lowest",
  };
  const planV = await createSearchPlan(
    OFFER_ITEMS.map((it) => ({ name: it.name, unit: it.unit, quantity: it.quantity })),
    vyberkoPrefs,
  );

  const enrichedV: OfferItem[] = OFFER_ITEMS.map((item, i) => ({
    ...item,
    instruction: planV.enrichedItems[i]?.instruction ?? null,
  }));

  const groupCtxV = new Map<number, { preferredManufacturer: string | null; preferredLine: string | null }>();
  for (const g of planV.groups) {
    for (const idx of g.itemIndices) {
      groupCtxV.set(idx, { preferredManufacturer: g.suggestedManufacturer, preferredLine: g.suggestedLine });
    }
  }

  const vyberko = await runComparison(
    "RUN 3: Single-tier vs Two-tier (VÝBĚRKO + planner)",
    enrichedV,
    vyberkoPrefs,
    groupCtxV,
  );

  // Final cross-run summary
  console.log("\n" + "═".repeat(70));
  console.log("CROSS-RUN SUMMARY");
  console.log("═".repeat(70) + "\n");

  for (const run of [baseline, realizace, vyberko]) {
    const label = run === baseline ? "Baseline" : run === realizace ? "REALIZACE" : "VÝBĚRKO";
    let stFound = 0, ttFound = 0, same = 0;
    let stPriceSum = 0, ttPriceSum = 0, priceItems = 0;

    for (const r of run) {
      if (r.singleTierProduct) stFound++;
      if (r.twoTierProduct) ttFound++;
      if (r.singleTierProduct?.sku === r.twoTierProduct?.sku) same++;

      const stP = r.singleTierProduct?.current_price;
      const ttP = r.twoTierProduct?.current_price;
      if (typeof stP === "number" && typeof ttP === "number") {
        stPriceSum += stP; ttPriceSum += ttP; priceItems++;
      }
    }

    console.log(`  ${label}:`);
    console.log(`    ST found: ${stFound}/${run.length}, TT found: ${ttFound}/${run.length}, same: ${same}/${run.length}`);
    if (priceItems > 0) {
      console.log(`    Avg price (where both found): ST=${(stPriceSum / priceItems).toFixed(1)}Kč, TT=${(ttPriceSum / priceItems).toFixed(1)}Kč`);
    }
    const priceNotes = run.filter((r) => r.twoTier.selector.priceNote).length;
    if (priceNotes > 0) console.log(`    Price notes triggered: ${priceNotes}`);
    console.log();
  }

  console.log("═".repeat(70));
  console.log("Done.");
  console.log("═".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
