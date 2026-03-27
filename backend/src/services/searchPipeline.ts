import OpenAI from "openai";
import { env } from "../config/env.js";
import { generateQueryEmbedding } from "./embedding.js";
import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  getCategoryTree,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
  type CategoryTreeEntry,
  type ProductResult,
  type StockFilterOptions,
} from "./search.js";

const PIPELINE_MODEL = "gpt-5-mini";
const MAX_RESULTS_FULLTEXT = 30;
const MAX_RESULTS_SEMANTIC = 50;
const SIM_THRESHOLD = 0.35;
const MAX_REFINEMENTS = 2;

// ── Types ──────────────────────────────────────────────────

export type OfferType = "vyberko" | "realizace";

export interface SearchPreferences {
  offerType: OfferType;
  stockFilter: "any" | "in_stock" | "stock_items_only";
  branchFilter: string | null;
  priceStrategy: "lowest" | "standard";
}

export const DEFAULT_PREFERENCES: SearchPreferences = {
  offerType: "realizace",
  stockFilter: "any",
  branchFilter: null,
  priceStrategy: "standard",
};

export interface ParsedItem {
  name: string;
  unit: string | null;
  quantity: number | null;
  instruction?: string | null;
}

export interface PipelineResult {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  product: Partial<ProductResult> | null;
  candidates: Array<Partial<ProductResult>>;
  reasoning: string;
  priceNote: string | null;
  reformulatedQuery: string;
  pipelineMs: number;
  exactLookupAttempted: boolean;
  exactLookupFound: boolean;
}

export interface GroupContext {
  preferredManufacturer: string | null;
  preferredLine: string | null;
}

export type PipelineDebugFn = (entry: {
  position: number;
  step: string;
  data: unknown;
}) => void;

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

// ── Planning Agent ─────────────────────────────────────────

export interface SearchPlanGroup {
  groupName: string;
  category: string | null;
  suggestedManufacturer: string | null;
  suggestedLine: string | null;
  notes: string | null;
  itemIndices: number[];
}

export interface SearchPlan {
  groups: SearchPlanGroup[];
  enrichedItems: Array<ParsedItem & { groupIndex: number }>;
}

const PLANNING_PROMPT = `Jsi plánovací agent pro B2B elektroinstalační katalog KV Elektro (~471K položek).

## Tvůj úkol
Dostaneš seznam rozparsovaných položek z poptávky. Analyzuj VŠECHNY najednou a:

1. **Seskup** položky do logických skupin podle typu produktu / kategorie (jističe, kabely, svítidla, zásuvky, rozvaděčové komponenty atd.)
2. **Navrhni** pro každou skupinu preferovaného výrobce a produktovou řadu, pokud to lze z kontextu odvodit
3. **Obohatí** každou položku instrukcí pro vyhledávací pipeline

## Jak seskupovat
- Položky stejného typu do jedné skupiny (všechny jističe, všechny kabely, atd.)
- Pokud poptávka obsahuje výrobce (např. "ABB jistič"), nastav ho jako suggestedManufacturer pro celou skupinu
- Pokud je zmíněna řada/model (např. "Tango", "S200"), nastav suggestedLine
- Pokud nelze odvodit výrobce/řadu, nech null

## Jak obohacovat instrukce
Pro každou položku vytvoř pole "instruction" jako text pro vyhledávací AI:
- Pokud je znám výrobce: "Preferuj výrobce: ABB"
- Pokud je známa řada: "Preferuj výrobce: ABB, řada: S200"
- Pokud je stejná barva pro skupinu: "Preferuj výrobce: Schneider, řada: Unica, barva: bílá"
- Pokud není co dodat, instrukce = null

## Kontext nabídky
Pokud dostaneš "offerContext", zohledni ho:
- REALIZACE = standardní dodavatelé, spolehlivé řady
- VÝBĚRKO = nejnižší cena, i od méně známých dodavatelů

## Formát odpovědi
Vrať VÝHRADNĚ JSON:
{
  "groups": [
    {
      "groupName": "Jističe",
      "category": "jistic",
      "suggestedManufacturer": "ABB",
      "suggestedLine": "S200",
      "notes": "Zákazník specifikoval ABB",
      "itemIndices": [0, 1, 4]
    }
  ],
  "enrichedItems": [
    {
      "index": 0,
      "instruction": "Preferuj výrobce: ABB, řada: S200"
    }
  ]
}

### Pravidla
- itemIndices = 0-based index v původním poli items
- Každá položka MUSÍ být v právě jedné skupině
- enrichedItems musí obsahovat záznam pro KAŽDOU položku (i s instruction: null)
- Skupin může být 1 (všechno stejná kategorie) i N
- Neměň name, quantity, unit — jen přidáváš instruction a seskupuješ`;

export async function createSearchPlan(
  items: ParsedItem[],
  preferences?: SearchPreferences,
): Promise<SearchPlan> {
  const payload: Record<string, unknown> = {
    items: items.map((item, i) => ({
      index: i,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
    })),
  };

  if (preferences) {
    payload.offerContext =
      preferences.offerType === "vyberko"
        ? "Typ nabídky: VÝBĚRKO — preferuj nejnižší cenu."
        : "Typ nabídky: REALIZACE — preferuj standardní dodavatele a dostupnost.";
  }

  const content = await chatComplete({
    system: PLANNING_PROMPT,
    user: JSON.stringify(payload),
    json: true,
  });
  if (!content) {
    return buildFallbackPlan(items);
  }

  try {
    const parsed = JSON.parse(content) as {
      groups: SearchPlanGroup[];
      enrichedItems: Array<{ index: number; instruction: string | null }>;
    };

    const enrichedItems: Array<ParsedItem & { groupIndex: number }> = items.map((item, i) => {
      const enrichment = parsed.enrichedItems.find((e) => e.index === i);
      const groupIdx = parsed.groups.findIndex((g) => g.itemIndices.includes(i));
      return {
        ...item,
        instruction: enrichment?.instruction ?? item.instruction ?? null,
        groupIndex: Math.max(0, groupIdx),
      };
    });

    return {
      groups: parsed.groups,
      enrichedItems,
    };
  } catch {
    return buildFallbackPlan(items);
  }
}

function buildFallbackPlan(items: ParsedItem[]): SearchPlan {
  return {
    groups: [{
      groupName: "Všechny položky",
      category: null,
      suggestedManufacturer: null,
      suggestedLine: null,
      notes: null,
      itemIndices: items.map((_, i) => i),
    }],
    enrichedItems: items.map((item) => ({
      ...item,
      groupIndex: 0,
    })),
  };
}

// ── Category Tree Cache ────────────────────────────────────

let cachedTree: CategoryTreeEntry[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000;

export async function getCachedCategoryTree(): Promise<CategoryTreeEntry[]> {
  if (cachedTree && Date.now() - cachedAt < CACHE_TTL) return cachedTree;
  cachedTree = await getCategoryTree();
  cachedAt = Date.now();
  return cachedTree;
}

// ── OpenAI ─────────────────────────────────────────────────

function openai(): OpenAI {
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

/**
 * Wrapper that handles GPT-5-mini API differences:
 * - `max_completion_tokens` instead of `max_tokens`
 * - `reasoning_effort: "minimal"` (no custom temperature)
 */
async function chatComplete(opts: {
  system: string;
  user: string;
  json?: boolean;
}): Promise<string | null> {
  const params = {
    model: PIPELINE_MODEL,
    reasoning_effort: "minimal" as const,
    max_completion_tokens: 16000,
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      { role: "system" as const, content: opts.system },
      { role: "user" as const, content: opts.user },
    ],
  };
  const res = await openai().chat.completions.create(
    params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
  );
  return res.choices[0]?.message?.content ?? null;
}

// ── Step 1: LLM Reformulation ─────────────────────────────

const REFORM_PROMPT = `Přeformuluj název elektrotechnického produktu do formy, která nejlépe odpovídá českému B2B katalogu elektroinstalačního materiálu (KV Elektro).

## PRAVIDLA
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext, přidej alternativní názvy
2. Pokud zkratce NEROZUMÍŠ, ponech originální text — NIKDY nevymýšlej
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny (přidej kontext vedle)
4. Používej × místo x u průřezů kabelů (5×2,5 ne 5x2,5)
5. Přidej i katalogový styl názvu — v katalogu se produkty jmenují jinak než v poptávkách

## PŘÍKLADY KONVERZE (poptávka → katalogový styl)
- "jistič 1-pólový 16 A B" → "JISTIC PL6-B16/1 jistič jednopólový 16A charakteristika B"
- "jistič 3-pólový 25 A B 10kA" → "JISTIC PL6-B25/3 jistič třípólový 25A B"
- "chránič proudový 1+N pólový 16A typ B" → "chranic PFGM-16/2/003-B proudový chránič 16A 2P typ B"
- "Datový kabel UTP CAT6 LSOH" → "KABEL SXKD-6-UTP-LSOH datový kabel UTP kategorie 6 Cat6 bezhalogenový"
- "kabel instalační ... (CYKY) 3x1,5mm2" → "KABEL 1-CYKY-J 3x1,5 CYKY kabel instalační 3×1,5"
- "CYSY 361" → "KABEL 1-CYSY 3×6+1 ohebný kabel 6mm² 3 žíly CYSY 3G6 H05VV-F"
- "CYSY 3G6" → "KABEL 1-CYSY 3×6 ohebný kabel 6mm² s ochranným vodičem CYSY 3G6"
- "CYSY 3×1,5" → "KABEL 1-CYSY 3x1,5 měkký ohebný kabel CYSY H05VV-F"
- "CYSY 3x2,5" → "KABEL 1-CYSY 3x2,5 měkký ohebný kabel CYSY H05VV-F"
- "Vodič CY 6" → "VODIC H07V-U 1x6 CY vodič 6mm2 jednodrátový"
- "Vodič CYA 35" → "VODIC H07V-K 1x35 CYA vodič 35mm2 lanovaný"
- "H07V-K 6mm2" → "VODIC H07V-K 1x6 vodič lanovaný 6mm2 CYA"
- "CXKH-R-J 5×2,5" → "KABEL 1-CXKH-R-J 5x2,5 B2CAS1D0 kabel bezhalogenový požárně odolný"
- "rozvodnice nástěnná 72 modulů" → "ROZVODNICE rozváděčová skříň nástěnná 72 modulů IP41"
- "trubka ohebná pr. 20mm" → "TRUBKA ohebná elektroinstalační ohebná 20mm PVC"

## KABELY — zkrácené zápisy průřezů
Expanduj zkrácené zápisy (nejčastěji u CYSY, CYKY, CXKH):
- "361" → "3×6+1" = 3 žíly 6mm² + 1 žíla zemní 1mm² (přidej obě varianty: 3G6, 3x6+1)
- "3G6" → 3 žíly 6mm² s ochranným vodičem (= 3×6+1)
- "324" → "3×2,5+4" nebo "3×2,5+4×2,5"
- "2×1,5" a "2G1,5" jsou ekvivalenty pro 2-žilový kabel 1,5mm²
CYSY = ohebný/měkký silový kabel (H05VV-F), prodává se v rolích nebo bubnech.

## DŮLEŽITÉ
- V katalogu mají kabely prefix "1-" (např. 1-CYKY-J, 1-CYSY, 1-CXKH-R-J)
- V katalogu se vodiče značí H07V-U (drátový=CY) a H07V-K (lanovaný=CYA)
- Jističe se v katalogu značí jako PL6-BAMP/POLES nebo podobně
- Vždy přidej jak katalogový kód, tak popisný text pro lepší vyhledávání

Vrať plain text — jen přeformulovaný název.`;

async function reformulate(name: string, instruction?: string | null): Promise<string> {
  const userContent = instruction
    ? `${name}\n\nDodatečný kontext: ${instruction}`
    : name;

  const content = await chatComplete({ system: REFORM_PROMPT, user: userContent });
  return content?.trim() ?? name;
}

// ── Merge Helpers ──────────────────────────────────────────

function mergeResults(
  raw: SemanticResult[],
  ref: SemanticResult[],
): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();

  for (const r of raw) {
    map.set(r.sku, { ...r, source: "raw" });
  }

  for (const r of ref) {
    const existing = map.get(r.sku);
    if (existing) {
      if (r.cosine_similarity > existing.cosine_similarity) {
        existing.cosine_similarity = r.cosine_similarity;
      }
      existing.source = "both";
    } else {
      map.set(r.sku, { ...r, source: "reformulated" });
    }
  }

  return [...map.values()].sort(
    (a, b) => b.cosine_similarity - a.cosine_similarity,
  );
}

function mergeWithExisting(
  existing: MergedCandidate[],
  fresh: MergedCandidate[],
): MergedCandidate[] {
  const map = new Map<string, MergedCandidate>();
  for (const c of existing) map.set(c.sku, c);

  for (const c of fresh) {
    const ex = map.get(c.sku);
    if (ex) {
      ex.cosine_similarity = Math.max(
        ex.cosine_similarity,
        c.cosine_similarity,
      );
    } else {
      map.set(c.sku, c);
    }
  }

  return [...map.values()].sort(
    (a, b) => b.cosine_similarity - a.cosine_similarity,
  );
}

function fulltextToMerged(results: FulltextResult[]): MergedCandidate[] {
  return results.map((r) => ({
    ...r,
    cosine_similarity: 0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3,
    source: "fulltext" as const,
  }));
}

const EXACT_COSINE: Record<string, number> = {
  sku_exact: 1.0,
  ean_exact: 0.98,
  idnlf_exact: 0.98,
  ean_contains: 0.90,
  idnlf_contains: 0.90,
};

function exactToMerged(results: ExactResult[]): MergedCandidate[] {
  return results.map((r) => ({
    ...r,
    cosine_similarity: EXACT_COSINE[r.match_type] ?? 0.95,
    source: "exact" as const,
  }));
}

// ── Tier 1: MATCHER — product type + parameter matching ───

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
4. Vrať SHORTLIST max 8 nejlepších seřazený od nejlepšího.

## POZOR — běžné záměny (NIKDY nezaměňuj!)
- jistič ≠ pojistka (jiný produkt!)
- CY (drátový, H07V-U) ≠ CYA (lanovaný, H07V-K)
- CYKY ≠ CXKH (PVC vs bezhalogenový)
- UTP ≠ FTP (nestíněný vs stíněný)
- CXKH-R ≠ CXKH-V (kulatý vs plochý)
- -J ≠ -O (s/bez ochranného vodiče)

## Měrné jednotky — kabely/vodiče (KRITICKÉ PRAVIDLO)
Pokud poptávka je v **metrech** (demandUnit = "m") NEBO název obsahuje metráž (např. "200m CYKY"):

**Povolené katalogové položky:**
- Název obsahuje konkrétní délku balení: "100m", "50m", "200m", "500m" apod.
- Název obsahuje "BUBEN" (nebo "buben")
- Katalogová jednotka (unit) = "m" (prodáváno po metrech)

**ZAKÁZANÉ — NIKDY nezařazuj do shortlistu:**
- Položky kde název NEOBSAHUJE délku ani BUBEN a zároveň unit ≠ "m"
- Položky s unit = "ks" bez délky v názvu — "ks" kabelu bez metráže nedává smysl pro metrový odběr

**Výběr balení (po splnění výše):**
- Preferuj největší kruh jehož násobek = poptávané množství (200m → 2×100m > 4×50m)
- Pokud žádný kruh netvoří přesný násobek → vyber BUBEN
- Pokud katalog prodává po metrech (unit = "m") → také platný výběr
- Nikdy nevolej not_found jen kvůli MJ — buben je vždy záchrana

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

Pokud shortlist je prázdný nebo bestMatchType = "not_found", přidej pole "refinement":
{
  "refinement": {
    "action": "refine_search",
    "query": "upřesněný dotaz",
    "subcategory": "subcategorie nebo null",
    "manufacturer": "výrobce nebo null"
  }
}

- shortlist: max 8 položek, seřazeno od nejlepšího. Prázdný pokud žádný kandidát nesedí typem.
- bestMatchType: "match" pokud aspoň 1 má matchScore ≥ 85, "uncertain" pokud 60-84, "not_found" pokud prázdný shortlist.`;

async function matchCandidates(
  originalName: string,
  candidates: MergedCandidate[],
  demandUnit?: string | null,
  demandQuantity?: number | null,
): Promise<MatcherResult> {
  if (candidates.length === 0) {
    return { shortlist: [], bestMatchType: "not_found", reasoning: "Žádní kandidáti." };
  }

  const top20 = candidates.slice(0, 20).map((c) => ({
    sku: c.sku,
    name: c.name,
    unit: c.unit,
    category_sub: c.category_sub,
    category_line: c.category_line,
    similarity: Math.round(c.cosine_similarity * 1000) / 1000,
    source: c.source,
  }));

  const payload: Record<string, unknown> = { originalName, candidates: top20 };
  if (demandUnit) payload.demandUnit = demandUnit;
  if (demandQuantity != null) payload.demandQuantity = demandQuantity;

  const content = await chatComplete({
    system: MATCHER_PROMPT,
    user: JSON.stringify(payload),
    json: true,
  });
  if (!content) return { shortlist: [], bestMatchType: "not_found", reasoning: "AI matcher selhala." };

  try {
    const p = JSON.parse(content);
    return {
      shortlist: (p.shortlist ?? []).slice(0, 8),
      bestMatchType: p.bestMatchType ?? "not_found",
      reasoning: p.reasoning ?? "",
      refinement: p.refinement,
    };
  } catch {
    return { shortlist: [], bestMatchType: "not_found", reasoning: "Parse error." };
  }
}

// ── Tier 2: SELECTOR — business rules ─────────────────────

const SELECTOR_PROMPT = `Jsi obchodní rozhodovatel pro elektroinstalační nabídky. Dostaneš SHORTLIST produktů, které již prošly produktovou shodou (typ a parametry sedí). Tvůj úkol: vybrat NEJLEPŠÍ variantu podle obchodních pravidel.

## Vstup
- shortlist: kandidáti s matchScore, cenou, skladem, dodavatelem
- offerType: "vyberko" nebo "realizace"
- groupContext: preferovaný výrobce/řada (pokud existuje)
- additionalCandidates: pro VÝBĚRKO — další kandidáti seřazení dle ceny, kteří mohou být levnější alternativou

## Pravidla pro VÝBĚRKO
1. Projdi shortlist I additionalCandidates
2. Vyber NEJLEVNĚJŠÍHO kandidáta, který má matchScore ≥ 70 (nebo je v shortlistu)
3. Při stejné ceně → preferuj skladem (has_stock = true)
4. Při stejné ceně a skladu → preferuj is_stock_item = true

## Pravidla pro REALIZACI
Priorita (od nejvyšší po nejnižší):
1. **Skladem** (has_stock = true) → silně preferuj
2. **Preferovaný výrobce/řada** → preferuj POUZE pokud cenový rozdíl je přijatelný:
   - cena ≤ 2× nejlevnější v shortlistu → OK
   - cena 2-3× nejlevnější → jen pokud je skladem
   - cena > 3× nejlevnější → NEVYBER, vyber levnější alternativu a vysvětli v priceNote
3. **Cena** → při jinak rovných volbách preferuj nižší cenu
4. **is_stock_item** = true → mírný bonus (standardní sortiment)

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
- matchScore ≥ 85 → "match"
- matchScore 60-84 → "uncertain"
- matchScore < 60 → "alternative"
- Prázdný shortlist → "not_found"
- Více kandidátů se stejným skóre → "multiple" (ale stále vyber jednoho)`;

async function selectProduct(
  originalName: string,
  matcherResult: MatcherResult,
  candidates: MergedCandidate[],
  preferences?: SearchPreferences,
  groupContext?: GroupContext,
  demandUnit?: string | null,
  demandQuantity?: number | null,
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

  const payload: Record<string, unknown> = {
    demand: { name: originalName, unit: demandUnit, quantity: demandQuantity },
    shortlist: enrichedShortlist,
    offerType: preferences?.offerType ?? "realizace",
  };

  if (preferences?.offerType === "vyberko") {
    const shortlistSkus = new Set(matcherResult.shortlist.map((s) => s.sku));
    const additional = candidates
      .filter((c) => !shortlistSkus.has(c.sku) && c.current_price != null)
      .sort((a, b) => (a.current_price ?? Infinity) - (b.current_price ?? Infinity))
      .slice(0, 10)
      .map((c) => ({
        sku: c.sku,
        name: c.name,
        current_price: c.current_price,
        supplier_name: c.supplier_name,
        is_stock_item: c.is_stock_item,
        has_stock: c.has_stock,
        unit: c.unit,
      }));
    if (additional.length > 0) payload.additionalCandidates = additional;
  }

  const prices = enrichedShortlist
    .map((s) => s.current_price)
    .filter((p): p is number => p != null);

  if (prices.length > 0) {
    payload.priceRange = {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    };
  }

  if (groupContext?.preferredManufacturer || groupContext?.preferredLine) {
    payload.groupContext = groupContext;
  }

  const content = await chatComplete({
    system: SELECTOR_PROMPT,
    user: JSON.stringify(payload),
    json: true,
  });
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

// ── Query Normalization ────────────────────────────────────

/**
 * Universal query normalization — only character-level fixes that
 * the DB text search config can't handle on its own.
 * Everything domain-specific (catalog codes, Czech terms) is left to
 * the LLM reformulation step.
 */
function normalizeQuery(raw: string): string {
  let q = raw;
  q = q.replace(/×/g, "x");
  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/(\d)\s*mm[²2]/gi, "$1");
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

// ── Helpers ────────────────────────────────────────────────

function slimCandidate(c: MergedCandidate): Partial<ProductResult> {
  return {
    id: c.id,
    sku: c.sku,
    name: c.name,
    unit: c.unit,
    current_price: c.current_price,
    supplier_name: c.supplier_name,
    category_main: c.category_main,
    category_sub: c.category_sub,
    category_line: c.category_line,
    is_stock_item: c.is_stock_item,
    has_stock: c.has_stock,
    removed_at: c.removed_at,
  };
}

// ── Preferences → Stock filter conversion ─────────────────

function prefsToStockOpts(prefs?: SearchPreferences): StockFilterOptions | undefined {
  if (!prefs) return undefined;
  const opts: StockFilterOptions = {};
  if (prefs.stockFilter === "stock_items_only") opts.stockItemOnly = true;
  if (prefs.stockFilter === "in_stock") opts.inStockOnly = true;
  if (prefs.branchFilter) opts.branchCodeFilter = prefs.branchFilter;
  if (!opts.stockItemOnly && !opts.inStockOnly && !opts.branchCodeFilter) return undefined;
  return opts;
}

function applyStockPostFilter(
  candidates: MergedCandidate[],
  prefs?: SearchPreferences,
): MergedCandidate[] {
  if (!prefs) return candidates;
  let filtered = candidates;
  if (prefs.stockFilter === "stock_items_only") {
    filtered = filtered.filter((c) => c.is_stock_item);
  }
  if (prefs.stockFilter === "in_stock") {
    filtered = filtered.filter((c) => c.has_stock);
  }
  return filtered;
}

// ── Main Pipeline ──────────────────────────────────────────

export async function searchPipelineForItem(
  item: ParsedItem,
  position: number,
  onDebug?: PipelineDebugFn,
  preferences?: SearchPreferences,
  groupContext?: GroupContext,
): Promise<PipelineResult> {
  const t0 = Date.now();
  const stockOpts = prefsToStockOpts(preferences);

  try {
    const normalizedName = normalizeQuery(item.name);
    onDebug?.({ position, step: "normalize", data: { original: item.name, normalized: normalizedName } });

    const reformulated = await reformulate(normalizedName, item.instruction);
    onDebug?.({ position, step: "reformulation", data: { original: normalizedName, reformulated } });

    // Parallel fan-out: embeddings + fulltext + exact
    const fulltextOriginal = searchProductsFulltext(normalizedName, MAX_RESULTS_FULLTEXT, undefined, undefined, undefined, stockOpts).catch(() => [] as FulltextResult[]);
    const fulltextReform = searchProductsFulltext(reformulated, MAX_RESULTS_FULLTEXT, undefined, undefined, undefined, stockOpts).catch(() => [] as FulltextResult[]);
    const exactPromise = lookupProductsExact(normalizedName, 10).catch(() => [] as ExactResult[]);
    const [rawEmb, refEmb, ftOriginal, ftReform, exactResults] = await Promise.all([
      generateQueryEmbedding(normalizedName),
      generateQueryEmbedding(reformulated),
      fulltextOriginal,
      fulltextReform,
      exactPromise,
    ]);

    const ftMap = new Map<string, FulltextResult>();
    for (const r of ftOriginal) ftMap.set(r.sku, r);
    for (const r of ftReform) {
      const existing = ftMap.get(r.sku);
      if (!existing || (r.rank ?? 0) > (existing.rank ?? 0)) ftMap.set(r.sku, r);
    }
    const fulltextResults = [...ftMap.values()];

    onDebug?.({
      position, step: "embedding",
      data: {
        done: true,
        fulltextOriginalCount: ftOriginal.length,
        fulltextReformCount: ftReform.length,
        fulltextMergedCount: fulltextResults.length,
        exactCount: exactResults.length,
        exactTopMatch: exactResults[0]?.match_type ?? null,
      },
    });

    // Dual semantic search (parallel, unfiltered)
    const [rawResults, refResults] = await Promise.all([
      searchProductsSemantic(rawEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
      searchProductsSemantic(refEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
    ]);
    onDebug?.({
      position, step: "search",
      data: {
        rawCount: rawResults.length, refCount: refResults.length,
        fulltextCount: fulltextResults.length, exactCount: exactResults.length,
        rawTopSim: rawResults[0]?.cosine_similarity ?? 0,
        refTopSim: refResults[0]?.cosine_similarity ?? 0,
      },
    });

    // Quad merge + stock post-filter
    let merged = mergeResults(rawResults, refResults);
    merged = mergeWithExisting(merged, fulltextToMerged(fulltextResults));
    merged = mergeWithExisting(merged, exactToMerged(exactResults));
    const preFilterCount = merged.length;
    merged = applyStockPostFilter(merged, preferences);
    onDebug?.({
      position, step: "merge",
      data: {
        totalBeforeFilter: preFilterCount,
        totalAfterFilter: merged.length,
        top3: merged.slice(0, 3).map((c) => ({
          sku: c.sku, name: c.name,
          sim: Math.round(c.cosine_similarity * 1000) / 1000,
          src: c.source,
        })),
      },
    });

    // ── Tier 1: MATCHER — find products that match type + params
    let matcherResult = await matchCandidates(item.name, merged, item.unit, item.quantity);
    onDebug?.({
      position, step: "matcher",
      data: {
        shortlistSize: matcherResult.shortlist.length,
        bestMatchType: matcherResult.bestMatchType,
        reasoning: matcherResult.reasoning,
        topMatch: matcherResult.shortlist[0] ?? null,
      },
    });

    // Refinement loop: if matcher found nothing, refine search and re-match
    let attempts = 0;
    while (
      matcherResult.refinement &&
      matcherResult.shortlist.length === 0 &&
      attempts < MAX_REFINEMENTS
    ) {
      attempts++;
      const ref = matcherResult.refinement;
      onDebug?.({ position, step: "refinement", data: { attempt: attempts, ...ref } });

      const refinedEmb = await generateQueryEmbedding(ref.query);
      const refinedResults = await searchProductsSemantic(
        refinedEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD,
        undefined, ref.manufacturer ?? undefined, ref.subcategory ?? undefined,
      );
      const fresh: MergedCandidate[] = refinedResults.map((r) => ({ ...r, source: "reformulated" as const }));
      merged = mergeWithExisting(merged, applyStockPostFilter(fresh, preferences));

      matcherResult = await matchCandidates(item.name, merged, item.unit, item.quantity);
      onDebug?.({
        position, step: "refinement_match",
        data: { attempt: attempts, shortlistSize: matcherResult.shortlist.length, bestMatchType: matcherResult.bestMatchType },
      });
    }

    // ── Tier 2: SELECTOR — pick best variant using business rules
    const selectorResult = await selectProduct(
      item.name, matcherResult, merged, preferences, groupContext, item.unit, item.quantity,
    );
    onDebug?.({
      position, step: "selector",
      data: {
        matchType: selectorResult.matchType,
        confidence: selectorResult.confidence,
        selectedSku: selectorResult.selectedSku,
        reasoning: selectorResult.reasoning,
        priceNote: selectorResult.priceNote,
      },
    });

    // Build final result
    const selected = selectorResult.selectedSku
      ? merged.find((c) => c.sku === selectorResult.selectedSku) ?? null
      : null;

    const shortlistSkus = new Set(matcherResult.shortlist.map((s) => s.sku));
    const topCands = matcherResult.shortlist
      .map((s) => merged.find((c) => c.sku === s.sku))
      .filter((c): c is MergedCandidate => c != null);
    for (const c of merged) {
      if (topCands.length >= 5) break;
      if (!shortlistSkus.has(c.sku)) {
        topCands.push(c);
        shortlistSkus.add(c.sku);
      }
    }

    const pipelineMs = Date.now() - t0;
    onDebug?.({
      position, step: "done",
      data: { matchType: selectorResult.matchType, confidence: selectorResult.confidence, pipelineMs, refinementAttempts: attempts },
    });

    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: selectorResult.matchType,
      confidence: selectorResult.confidence,
      product: selected ? slimCandidate(selected) : null,
      candidates: topCands.slice(0, 5).map(slimCandidate),
      reasoning: selectorResult.reasoning,
      priceNote: selectorResult.priceNote,
      reformulatedQuery: reformulated,
      pipelineMs,
      exactLookupAttempted: true,
      exactLookupFound: exactResults.length > 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pipeline failed";
    onDebug?.({ position, step: "error", data: { error: msg } });

    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: "not_found",
      confidence: 0,
      product: null,
      candidates: [],
      reasoning: `Pipeline error: ${msg}`,
      priceNote: null,
      reformulatedQuery: "",
      pipelineMs: Date.now() - t0,
      exactLookupAttempted: false,
      exactLookupFound: false,
    };
  }
}
