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

const PIPELINE_MODEL = "gpt-5.4-mini";
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
  /** Výrobcova katalogová čísla (source_idnlf_raw) — přidají se jako prioritní kandidáti před MATCHER */
  extraLookupCodes?: string[];
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
  enrichedItems: Array<ParsedItem & { groupIndex: number; isSet?: boolean; setHint?: string | null }>;
}

const PLANNING_PROMPT = `Jsi plánovací agent pro B2B elektroinstalační katalog KV Elektro (~471K položek).

## Tvůj úkol
Dostaneš seznam rozparsovaných položek z poptávky. Analyzuj VŠECHNY najednou a:

1. **Seskup** položky do logických skupin podle typu produktu / kategorie (jističe, kabely, svítidla, zásuvky, rozvaděčové komponenty atd.)
2. **Navrhni** pro každou skupinu preferovaného výrobce a produktovou řadu, pokud to lze z kontextu odvodit
3. **Obohatí** každou položku instrukcí pro vyhledávací pipeline
4. **Identifikuj sady** — položky, které se v B2B katalogu prodávají jako KOMPONENTY (zvlášť), ne jako celek

## Detekce sad (isSet)
Domovní elektroinstalační prvky (vypínače, zásuvky, datové zásuvky, stmívače, termoregulátory) designových řad se v B2B katalogu prodávají ROZLOŽENĚ:
- **přístroj/strojek** (mechanism) — funkční elektrotechnická část
- **kryt/čelní deska** (cover) — dekorativní krytka
- **rámeček** (frame) — montážní a estetický rámeček

isSet = true pokud:
- zákazník poptává KOMPLETNÍ produkt (vypínač, zásuvka, stmívač...) konkrétní designové řady (Sedna, Tango, Mosaic, Gira...)
- NEBO pokud z kontextu plyne, že chce hotový výrobek a ne jen komponent

isSet = false pokud:
- zákazník poptává KONKRÉTNÍ KOMPONENT (jen rámeček, jen strojek, jen kryt)
- jedná se o průmyslovou zásuvku (CEE/IP44/IP65 — celek)
- jedná se o produkt který se neprodává rozloženě (jistič, kabel, svítidlo, rozvodnice...)

setHint: pro sady vyplň anglický/český search hint pro web search agenta:
- Příklad: "Schneider Sedna switch type 6 white mechanism cover frame catalog numbers order codes"
- Příklad: "ABB Tango socket 230V white components frame mechanism cover catalog numbers"
- Hint MUSÍ obsahovat "catalog numbers" nebo "order codes" — chceme konkrétní katalogová čísla

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
      "isSet": false,
      "setHint": null,
      "instruction": "Preferuj výrobce: ABB, řada: S200"
    },
    {
      "index": 2,
      "isSet": true,
      "setHint": "Schneider Sedna switch type 6 white components catalog numbers order codes",
      "instruction": null
    }
  ]
}

### Pravidla
- itemIndices = 0-based index v původním poli items
- Každá položka MUSÍ být v právě jedné skupině
- enrichedItems musí obsahovat záznam pro KAŽDOU položku (i s instruction: null)
- Skupin může být 1 (všechno stejná kategorie) i N
- Neměň name, quantity, unit — jen přidáváš instruction, isSet, setHint a seskupuješ`;

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
      enrichedItems: Array<{ index: number; instruction: string | null; isSet?: boolean; setHint?: string | null }>;
    };

    const enrichedItems: Array<ParsedItem & { groupIndex: number; isSet?: boolean; setHint?: string | null }> = items.map((item, i) => {
      const enrichment = parsed.enrichedItems.find((e) => e.index === i);
      const groupIdx = parsed.groups.findIndex((g) => g.itemIndices.includes(i));
      return {
        ...item,
        instruction: enrichment?.instruction ?? item.instruction ?? null,
        groupIndex: Math.max(0, groupIdx),
        isSet: enrichment?.isSet ?? false,
        setHint: enrichment?.setHint ?? null,
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
    reasoning_effort: "low" as const,
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

// ── Code Extractor ────────────────────────────────────────

const CODE_EXTRACTOR_PROMPT = `Jsi expert na B2B elektroinstalační katalogy (KV Elektro, ~471K položek).

Tvůj úkol: z textu poptávky extrahuj kódy, které vypadají jako katalogová nebo objednací čísla výrobce, nebo EAN kódy produktů.

## Co JE kód produktu — extrahuj
- Katalogová/objednací čísla výrobce: GXRE165, SDN0500121, 6EP1333-1LB00, LED-WSL-18W/4100, 3558A-A651 B, PL6-B16/1
- Typy/modely produktu identifikující konkrétní SKU: S201-B16, PFGM-16/2/003-B, GXRE288
- EAN kód (13místné číslo): 4015081677733
- Kombinace písmen a číslic tvořící jednoznačný identifikátor konkrétního výrobku

## Co NENÍ kód produktu — NEextrahuj
- Elektrické parametry: 330mA, 180-265V, 50/60Hz, 44W, 16A, 25A, 230V, 400V, 10kA, 6kA
- Průřezy a rozměry: 3x1,5mm², 2,5mm², 5x2,5, 20mm, 100m, 3×2,5
- Výrobci samotní bez modelu: GREENLUX, ABB, Schneider, Hager, OEZ, Legrand (jen jméno = ne kód)
- Obecná slova a anglické výrazy: Input, Output, Max, Model, Type, Current, Driver, Constant
- IP krytí: IP65, IP44, IP20
- Charakteristiky jističů samotné: B16, C25, D10 (ale S201-B16 jako celek = ano)
- Teplotní hodnoty: -25°C, 40°C

## Příklady
Vstup: "Constant Current LED Driver GREENLUX model GXRE165, Input 180-265V 50/60Hz, Output 90-120V 330mA, Max 44W"
Výstup: {"codes": ["GXRE165"]}

Vstup: "jistič ABB S201-B16 1-pólový 16A charakteristika B"
Výstup: {"codes": ["S201-B16"]}

Vstup: "kabel CYKY-J 3x1,5 instalační 100m"
Výstup: {"codes": []}

Vstup: "Zásuvka Schneider Electric Sedna SDN3502121 bílá 2x230V"
Výstup: {"codes": ["SDN3502121"]}

Vstup: "chránič OEZ PFGM-16/2/003-B 16A 2P 30mA typ B"
Výstup: {"codes": ["PFGM-16/2/003-B"]}

Vstup: "svítidlo LED panel 60x60 40W 4000K IP44"
Výstup: {"codes": []}

Vrať VÝHRADNĚ JSON: {"codes": ["KÓD1", "KÓD2"]}
Pokud žádný kód, vrať: {"codes": []}`;

export async function extractProductCodes(text: string): Promise<string[]> {
  const content = await chatComplete({
    system: CODE_EXTRACTOR_PROMPT,
    user: text,
    json: true,
  });
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { codes?: string[] };
    return (parsed.codes ?? []).filter((c) => typeof c === "string" && c.length >= 4);
  } catch {
    return [];
  }
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

## KATALOGOVÉ SYNONYMA — různí výrobci pojmenovávají produkty jinak
- "rámeček jednonásobný" = "JEDNORAMECEK" (ABB, Tango, Time) — přidej obě varianty
- "rámeček dvojnásobný" = "DVOJRAMECEK" — přidej obě
- "trojrámeček" = "TROJRAMECEK" — přidej obě
- "zásuvka s uzemněním" = "ZASUVKA CLON." nebo "ZASUVKA KOMPLET"

## PREFEROVANÝ VÝROBCE/ŘADA (pokud uveden v dodatečném kontextu)
Pokud je zadán preferovaný výrobce nebo řada, přidej do reformulace:
- Konkrétní katalogový kód řady (např. PL7-C2/1, S201-B16, Tango)
- Jméno výrobce zkratkou i plně (ABB, Eaton, Schneider)
- Reformuluj PRIMÁRNĚ pro tuto kombinaci výrobce+řada+parametry

Vrať plain text — jen přeformulovaný název.`;

async function reformulate(name: string, instruction?: string | null, groupContext?: GroupContext): Promise<string> {
  const parts: string[] = [name];
  if (instruction) parts.push(`Dodatečný kontext: ${instruction}`);
  if (groupContext?.preferredManufacturer) {
    parts.push(`Preferovaný výrobce: ${groupContext.preferredManufacturer}${groupContext.preferredLine ? `, řada: ${groupContext.preferredLine}` : ""}`);
  }
  const userContent = parts.join("\n\n");

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
      // Pokud nový zdroj je "exact", zachovej tuto informaci i po merge
      if (c.source === "exact") ex.source = "exact";
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
  idnlf_normalized: 0.97,  // space-normalized match: "5518-2929S" matches "5518-2929 S"
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
2. Sedí KLÍČOVÉ PARAMETRY přečtené přímo z názvů? (proud, póly, průřez, počet žil, IP, wattáž...)

## Vstup
Dostaneš:
- originalName: hledaný produkt z poptávky
- candidates: seznam produktů z katalogu seřazených přibližně podle sémantické relevance (první jsou nejbližší dotazu)
  - Každý kandidát má: sku, name, unit, category_sub, category_line, source, foundByExactCode
  - Volitelně: description (pokud existuje v katalogu)
- VAROVÁNÍ: Pořadí říká jen "sémanticky blízký", NE "správný". Produkt na 1. místě může být špatný průřez!
  Projdi KAŽDÉHO kandidáta — správný produkt může být kdekoliv v seznamu.

## ABSOLUTNÍ PRIORITA — Exact code match
Pokud kandidát má foundByExactCode = true:
→ AUTOMATICKY zařaď do shortlistu s matchScore: 97
→ Název nemusí vizuálně odpovídat poptávce — produkt byl nalezen přesnou shodou kódu/EAN/SKU
→ Toto pravidlo má přednost před všemi ostatními pravidly níže

## TVRDÉ PARAMETRY — Bezpečnostně kritické (platí pro všechny ostatní kandidáty)
Tyto parametry EXTRAHUJ číselně z názvu kandidáta a porovnej přesně s poptávkou.
Pokud nesedí → matchScore < 40 → kandidát se do shortlistu NEDOSTANE:
- Průřez vodiče/kabelu: "5×1,5" ≠ "5×95", "3×2,5" ≠ "5×2,5", "1×95" ≠ "1×120"
- Počet žil/pólů: "3×" ≠ "5×", 3-pólový ≠ 4-pólový
- Počet párů (datové kabely): "3×2×0,8" ≠ "2×2×0,8"
- Třída odolnosti (ohebné trubky): 320N ≠ 720N, 450N ≠ 750N
- Typ kabelu (každé písmeno záleží): CYKY ≠ CXKH, CY ≠ CYA, CXKH-R ≠ CXKH-V, -J ≠ -O

### Ukázky správné práce s tvrdými parametry

DEMAND: "CXKH-R-J 5×1,5"
→ Extrahuj: typ=CXKH-R-J, žil=5, průřez=1,5mm²
→ Kandidát "KABEL 1-CXKH-R-J 5X95": průřez=95 ≠ 1,5 → matchScore 10 → NEVYBER
→ Kandidát "KABEL CXKH-R-J 5×1,5 BUBEN": průřez=1,5 ✓, žil=5 ✓ → matchScore 92 → VYBER
→ Kandidát "KABEL CXKH-R-J 5×1,5 KRUH 50M": průřez=1,5 ✓, žil=5 ✓ → matchScore 90 → VYBER

DEMAND: "Vodič CYA 50"
→ Extrahuj: typ=CYA (lanovaný), průřez=50mm²
→ Kandidát "VODIČ CYA 95": průřez=95 ≠ 50 → matchScore 10 → NEVYBER
→ Kandidát "VODIČ CYA 50 ČERNÝ": průřez=50 ✓ → matchScore 90 → VYBER
→ Kandidát "VODIČ CYA 50 ZELENÝ": průřez=50 ✓ → matchScore 90 → VYBER (jiná barva OK)

## Postup
1. Zkontroluj foundByExactCode — přidej automaticky s matchScore 97.
2. Z originalName přesně extrahuj: typ produktu + všechny číselné parametry (průřez, počet žil, proud, IP...).
3. Projdi KAŽDÉHO kandidáta (pořadí v listu NEZARUČUJE správnost!):
   a. Jiný typ produktu → vyřaď okamžitě.
   b. Numericky porovnej tvrdé parametry z názvu kandidáta s extrahovanými parametry.
   c. Nesedí jakýkoliv tvrdý parametr → matchScore < 40 → vyřaď.
   d. Sedí vše → přidej do shortlistu s příslušným matchScore.
4. Vrať do shortlistu VŠECHNY kandidáty co splňují typ + tvrdé parametry — max 8.
   NESMÍŠ vyřadit kandidáty jen proto, že jich je víc. Shortlist může (a měl by) obsahovat více variant téhož produktu (různé barvy, balení, výrobci).

## POZOR — běžné záměny (NIKDY nezaměňuj!)
- jistič ≠ pojistka (jiný produkt!)
- CY (drátový, H07V-U) ≠ CYA (lanovaný, H07V-K)
- CYKY ≠ CXKH (PVC vs bezhalogenový)
- CXKH ≠ CXKE (různé typy bezhalogenových)
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

**Výběr balení — do shortlistu zařaď KRUH i BUBEN varianty:**
- Zařaď všechny kruhy (KRUH 10M, 25M, 50M, 100M atd.) které sedí typem kabelu
- Zařaď BUBEN varianty
- Zařaď položky s unit = "m" (prodej po metrech)
- SELECTOR rozhodne který kruh/buben je optimální — MATCHER jen filtruje typ!
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

- shortlist: max 8 položek, seřazeno od nejlepšího matchScore. Prázdný pokud žádný kandidát nesedí typem.
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

  const top20 = candidates.slice(0, 60).map((c) => {
    const item: Record<string, unknown> = {
      sku: c.sku,
      name: c.name,
      unit: c.unit,
      category_sub: c.category_sub,
      category_line: c.category_line,
      similarity: Math.round(c.cosine_similarity * 1000) / 1000,
      source: c.source,
      foundByExactCode: c.source === "exact",
    };
    if (c.description && c.description.trim().length > 5) {
      item.description = c.description.slice(0, 200);
    }
    return item;
  });

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

## Kabely — výběr kruhu vs buben (KRITICKÉ, má přednost před pravidly výše)
Pokud demand.unit = "m" a shortlist obsahuje KRUH i BUBEN varianty:

Krok 1: Všechny kruhy s délkou VĚTŠÍ než demand.quantity OKAMŽITĚ VYŘAĎ.
  - demand 50m → KRUH 100M je VĚTŠÍ (100>50) → pryč!
  - demand 10m → KRUH 25M, 50M, 100M všechny větší → pryč!

Krok 2: Ze zbylých kruhů (menší nebo rovno demand) ověř dělením:
  demand.quantity / ringLength = CELÉ číslo? → kruh JE vhodný
  demand.quantity / ringLength = DESETINNÉ číslo? → kruh NENÍ vhodný

Krok 3: Z vhodných kruhů vyber NEJVĚTŠÍ (minimalizuje počet balení).

Krok 4: Pokud žádný kruh nevyhověl → vyber BUBEN.

Příklady:
- 50m:  100M(větší→pryč) 50M(50/50=1 OK) 25M(50/25=2 OK) → vyber 50M
- 200m: 100M(200/100=2 OK) 50M(200/50=4 OK) → vyber 100M (větší)
- 75m:  100M(větší→pryč) 50M(75/50=1.5 NE) 25M(75/25=3 OK) → vyber 25M
- 10m:  100M(větší→pryč) 50M(větší→pryč) 25M(větší→pryč) 10M(10/10=1 OK) → vyber 10M
- 350m: 100M(350/100=3.5 NE) 50M(350/50=7 OK) 25M(350/25=14 OK) → vyber 50M (větší)

## Odpověď
Vrať VÝHRADNĚ JSON:
{
  "selectedSku": "SKU vybraného produktu nebo null",
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "reasoning": "1-2 věty česky — PROČ tuto variantu",
  "priceNote": "varování o ceně nebo null"
}

## ABSOLUTNÍ PRIORITA — Exact code match
Pokud vybraný kandidát má foundByExactCode = true:
→ VŽDY ho vyber, confidence: 99, matchType: "match"
→ Ostatní pravidla (cena, výrobce, varianta) se NEAPLIKUJÍ
→ reasoning: "Produkt nalezen přesnou shodou kódu/EAN/SKU."

## Varianta bez specifikace — KRITICKÉ PRAVIDLO
Pokud shortlist obsahuje více kandidátů lišících se POUZE v atributu, který poptávka NESPECIFIKUJE (barva, typ žíly J/O, typ balení BUBEN/BUBEN NEVRATNÝ, délka kusu, třída odolnosti 320N/720N, RAL kód):
→ NEVOLÍŠ libovolnou variantu
→ matchType: "multiple", selectedSku: null, confidence: 0
→ reasoning: vysvětli které atributy jsou nespecifikované a jaké varianty existují

Výjimka: pokud poptávka atribut EXPLICITNĚ specifikuje (např. "ŽLUTOZELENÁ", "typ J", "BUBEN NEVRATNÝ") → vyber správnou variantu, matchType: "match".

## matchType v kontextu selectoru
- foundByExactCode = true → "match", confidence: 99
- Více variant bez specifikace → "multiple", selectedSku: null, confidence: 0
- matchScore ≥ 85 → "match"
- matchScore 60-84 → "uncertain"
- matchScore < 60 → "alternative"
- Prázdný shortlist → "not_found"`;

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
      foundByExactCode: c?.source === "exact",
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

    // Reformulation + code extraction run in parallel
    const [reformulated, aiExtractedCodes] = await Promise.all([
      reformulate(normalizedName, item.instruction, groupContext),
      extractProductCodes(normalizedName),
    ]);
    onDebug?.({ position, step: "reformulation", data: { original: normalizedName, reformulated } });
    if (aiExtractedCodes.length > 0) {
      onDebug?.({ position, step: "code_extraction", data: { codes: aiExtractedCodes } });
    }

    // Merge AI-extracted codes with any codes passed in from decomp agent
    const allExtraCodes = [...new Set([...(item.extraLookupCodes ?? []), ...aiExtractedCodes])];

    // Parallel fan-out: embeddings + fulltext + exact
    const fulltextOriginal = searchProductsFulltext(normalizedName, MAX_RESULTS_FULLTEXT, undefined, undefined, undefined, stockOpts).catch(() => [] as FulltextResult[]);
    const fulltextReform = searchProductsFulltext(reformulated, MAX_RESULTS_FULLTEXT, undefined, undefined, undefined, stockOpts).catch(() => [] as FulltextResult[]);
    const exactPromise = lookupProductsExact(normalizedName, 10).catch(() => [] as ExactResult[]);
    // Extra lookup přes výrobcova katalogová čísla — z decomp agenta + AI extrakce z textu poptávky
    const extraExactPromises = allExtraCodes.map((code) =>
      lookupProductsExact(code, 3).catch(() => [] as ExactResult[])
    );
    const [rawEmb, refEmb, ftOriginal, ftReform, exactResults, ...extraExactResultsArr] = await Promise.all([
      generateQueryEmbedding(normalizedName),
      generateQueryEmbedding(reformulated),
      fulltextOriginal,
      fulltextReform,
      exactPromise,
      ...extraExactPromises,
    ]);
    const extraExactResults: ExactResult[] = extraExactResultsArr.flat();

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
        aiExtractedCodes,
        extraExactCount: extraExactResults.length,
      },
    });

    // Dual semantic search (parallel, unfiltered) + optional manufacturer boost
    const mfrQuery = groupContext?.preferredManufacturer
      ? `${groupContext.preferredManufacturer}${groupContext.preferredLine ? ` ${groupContext.preferredLine}` : ""} ${normalizedName}`
      : null;
    const mfrEmbPromise = mfrQuery ? generateQueryEmbedding(mfrQuery) : Promise.resolve(null);

    const [rawResults, refResults, mfrEmb] = await Promise.all([
      searchProductsSemantic(rawEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
      searchProductsSemantic(refEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD),
      mfrEmbPromise,
    ]);

    const mfrResults = mfrEmb
      ? await searchProductsSemantic(mfrEmb, MAX_RESULTS_SEMANTIC, SIM_THRESHOLD)
      : [];
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
    // Extra prioritní kandidáti z výrobcových katalogových čísel
    if (extraExactResults.length > 0) {
      merged = mergeWithExisting(merged, exactToMerged(extraExactResults));
    }
    // Manufacturer-boosted search — přidá výsledky pro preferovaného výrobce/řadu
    if (mfrResults.length > 0) {
      merged = mergeWithExisting(merged, mfrResults.map((r) => ({ ...r, source: "reformulated" as const })));
    }
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
        allSkus: merged.map((c) => c.sku),
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
      exactLookupFound: exactResults.length > 0 || extraExactResults.length > 0,
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

// ── Set Assembly ──────────────────────────────────────────

export interface SetComponent {
  name: string;
  role: "mechanism" | "cover" | "frame" | "module" | "socket" | "other";
  quantity: number;
  manufacturerCode: string | null;
  ean: string | null;
}

export interface SetPipelineResult {
  parentPosition: number;
  parentItemId: string;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  isSet: true;
  components: Array<SetComponent & { result: PipelineResult }>;
  decompositionMs: number;
  totalPipelineMs: number;
}

const DECOMP_PROMPT = `Jsi expert na domovní elektroinstalační materiál.

## Úkol
Rozlož produkt na komponenty prodávané ZVLÁŠŤ v B2B katalozích výrobce.
Použij web search pro nalezení PŘESNÝCH katalogových čísel výrobce (ne SAP/interní čísla).

## Příklady katalogových čísel
- Schneider Sedna: SDN0100121, SDN5800121, SDN3100121
- ABB Tango: 3558A-A651 B, 3901A-B10 B
- Legrand Mosaic: 067601, 067801, 080251

Tato čísla se vyhledávají v databázi B2B distributorů. Vrať je do pole "manufacturerCode".

## Pravidla
- manufacturerCode = katalogové/objednací číslo výrobce
- Pokud si NEJSI JISTÝ zdrojem → nastav manufacturerCode: null. NEVYMÝŠLEJ čísla.
- Typicky 2-3 komponenty (strojek + kryt/rámeček, nebo strojek + kryt + rámeček)
- U některých výrobců je kryt součástí strojku → pak jen 2 komponenty

## Formát odpovědi — VÝHRADNĚ JSON
{
  "components": [
    {
      "name": "strojek spínače č.6 Schneider Sedna bílý",
      "role": "mechanism",
      "quantity": 1,
      "manufacturerCode": "SDN0500121",
      "ean": null
    }
  ]
}`;

/**
 * Decompose a set product into components using web search.
 * Uses OpenAI Responses API with web_search_preview tool.
 */
export async function decomposeSet(
  itemName: string,
  setHint: string,
): Promise<{ components: SetComponent[]; ms: number }> {
  const t0 = Date.now();

  const client = openai();
  const response = await (client as unknown as {
    responses: {
      create: (p: unknown) => Promise<{
        output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      }>;
    };
  }).responses.create({
    model: PIPELINE_MODEL,
    reasoning: { effort: "low" },
    tools: [{ type: "web_search_preview" }],
    input: [
      { role: "system", content: DECOMP_PROMPT },
      { role: "user", content: `Produkt: "${itemName}"\nWeb search hint: "${setHint}"\n\nNajdi komponenty a jejich katalogová čísla výrobce.` },
    ],
  });

  const ms = Date.now() - t0;

  let text = "";
  for (const block of response.output) {
    if (block.type === "message" && block.content) {
      for (const c of block.content) {
        if (c.type === "output_text" && c.text) text += c.text;
      }
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { components: [], ms };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      components: Array<{
        name: string;
        role: string;
        quantity: number;
        manufacturerCode?: string | null;
        ean?: string | null;
      }>;
    };
    return {
      components: (parsed.components ?? []).map((c) => ({
        name: c.name,
        role: (c.role ?? "other") as SetComponent["role"],
        quantity: c.quantity ?? 1,
        manufacturerCode: c.manufacturerCode ?? null,
        ean: c.ean ?? null,
      })),
      ms,
    };
  } catch {
    return { components: [], ms };
  }
}

/**
 * Full set pipeline:
 *   1. Decompose set into components (web search → manufacturer codes)
 *   2. For each component, run searchPipelineForItem (with extraLookupCodes from decomp)
 *   3. Return parent + component results
 */
export async function searchPipelineForSet(
  item: ParsedItem & { isSet: true; setHint: string },
  position: number,
  parentItemId: string,
  onDebug?: PipelineDebugFn,
  preferences?: SearchPreferences,
  groupContext?: GroupContext,
): Promise<SetPipelineResult> {
  const t0 = Date.now();

  onDebug?.({ position, step: "set_decompose_start", data: { name: item.name, setHint: item.setHint } });

  const { components, ms: decompMs } = await decomposeSet(item.name, item.setHint);

  onDebug?.({
    position,
    step: "set_decompose_done",
    data: {
      componentCount: components.length,
      decompMs,
      components: components.map((c) => ({ name: c.name, role: c.role, code: c.manufacturerCode })),
    },
  });

  if (components.length === 0) {
    onDebug?.({ position, step: "set_fallback_single", data: { reason: "no components from decomposition" } });
    const singleResult = await searchPipelineForItem(item, position, onDebug, preferences, groupContext);
    return {
      parentPosition: position,
      parentItemId,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      isSet: true,
      components: [{
        name: item.name,
        role: "other",
        quantity: 1,
        manufacturerCode: null,
        ean: null,
        result: singleResult,
      }],
      decompositionMs: decompMs,
      totalPipelineMs: Date.now() - t0,
    };
  }

  const componentResults = await Promise.all(
    components.map((comp, i) => {
      const codes: string[] = [];
      if (comp.manufacturerCode) codes.push(comp.manufacturerCode);
      if (comp.ean) codes.push(comp.ean);

      const compItem: ParsedItem = {
        name: comp.name,
        unit: "ks",
        quantity: comp.quantity,
        instruction: groupContext?.preferredManufacturer
          ? `Preferuj výrobce: ${groupContext.preferredManufacturer}${groupContext.preferredLine ? `, řada: ${groupContext.preferredLine}` : ""}`
          : null,
        extraLookupCodes: codes.length > 0 ? codes : undefined,
      };

      return searchPipelineForItem(compItem, position * 100 + i, onDebug, preferences, groupContext);
    }),
  );

  const totalPipelineMs = Date.now() - t0;

  return {
    parentPosition: position,
    parentItemId,
    originalName: item.name,
    unit: item.unit,
    quantity: item.quantity,
    isSet: true,
    components: components.map((comp, i) => ({
      ...comp,
      result: componentResults[i]!,
    })),
    decompositionMs: decompMs,
    totalPipelineMs,
  };
}
