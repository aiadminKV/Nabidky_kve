/**
 * searchPipelineV2.ts
 * New pipeline: priority layers (EAN → code → ReAct agent) + checker + retry.
 * Drop-in replacement for searchPipelineForItem with same interface.
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import { generateQueryEmbedding } from "./embedding.js";
import {
  searchProductsSemantic,
  searchProductsFulltext,
  lookupProductsExact,
  fetchProductsBySkus,
  getCategoryTree,
  type SemanticResult,
  type FulltextResult,
  type ExactResult,
  type ProductResult,
  type CategoryTreeEntry,
} from "./search.js";
import type {
  ParsedItem,
  PipelineResult,
  SearchPreferences,
  GroupContext,
  PipelineDebugFn,
} from "./searchPipeline.js";

const MODEL = "gpt-5.4-mini";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Extended result with matchMethod ──────────────────────

export interface PipelineResultV2 extends PipelineResult {
  matchMethod: "ean" | "code" | "semantic" | "not_found";
}

// ── Phase 0: AI Preprocessing ─────────────────────────────

interface PreprocessResult {
  eans: string[];
  productCodes: string[];
  reformulated: string;
  productType: string;
  keyParams: Record<string, unknown>;
}

const PREPROCESS_PROMPT = `Jsi expert na analýzu poptávek elektroinstalačního materiálu. Dostaneš text poptávky jedné položky a tvým úkolem je ho rozebrat.

Vrať JSON s těmito poli:

1. "eans" — pole EAN kódů nalezených v textu. EAN je 8 nebo 13místné číslo (např. "4015081677733"). Pokud žádný EAN není, vrať prázdné pole.

2. "productCodes" — pole objednacích/katalogových kódů výrobce. Jsou to identifikátory jako "S201-B16", "GXRE165", "SDN0500121", "PL6-B16/1", "3558A-A651 B". NEJSOU to parametry jako 16A, 3x1,5, IP44, 230V, 10kA. Pokud žádný kód není, vrať prázdné pole.

3. "reformulated" — rozvinutý název produktu pro lepší vyhledávání v katalogu. Přidej alternativní označení, v katalogu mají kabely prefix "1-" (1-CYKY-J, 1-CXKH-R-J), vodiče se značí H07V-U (drátový, CY) a H07V-K (lanovaný, CYA). Jističe bývají jako PL6-B16/1, PL7-C25/3. Používej × místo x u průřezů. Přidej jak katalogový prefix, tak popisný text.

4. "productType" — stručný typ produktu česky (jistič, kabel, vodič, zásuvka, rámeček, trubka, chránič, žlab, svítidlo, spínač, svodič, krabice, čidlo...)

5. "keyParams" — klíčové technické parametry extrahované z textu. Například: {"poles": 1, "current": "16A", "characteristic": "B"} pro jistič, nebo {"cores": 5, "crossSection": "1.5", "type": "CXKH-R-J"} pro kabel.

Vrať VÝHRADNĚ JSON, žádný jiný text.`;

async function preprocess(name: string): Promise<PreprocessResult> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PREPROCESS_PROMPT },
      { role: "user", content: name },
    ],
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

  const content = res.choices[0]?.message?.content;
  if (!content) {
    return { eans: [], productCodes: [], reformulated: name, productType: "", keyParams: {} };
  }

  try {
    const p = JSON.parse(content) as Partial<PreprocessResult>;
    return {
      eans: (p.eans ?? []).filter((e) => typeof e === "string" && /^\d{8,13}$/.test(e)),
      productCodes: (p.productCodes ?? []).filter((c) => typeof c === "string" && c.length >= 3),
      reformulated: typeof p.reformulated === "string" ? p.reformulated : name,
      productType: typeof p.productType === "string" ? p.productType : "",
      keyParams: typeof p.keyParams === "object" && p.keyParams ? p.keyParams : {},
    };
  } catch {
    return { eans: [], productCodes: [], reformulated: name, productType: "", keyParams: {} };
  }
}

// ── Layer 1: EAN Lookup ───────────────────────────────────

async function tryEanLookup(
  eans: string[],
  onDebug?: PipelineDebugFn,
  position?: number,
): Promise<ProductResult | null> {
  if (eans.length === 0) return null;

  for (const ean of eans) {
    const results = await lookupProductsExact(ean, 5).catch(() => [] as ExactResult[]);
    const eanMatches = results.filter((r) => r.match_type === "ean_exact");

    onDebug?.({
      position: position ?? 0,
      step: "ean_lookup",
      data: { ean, resultCount: results.length, eanExactCount: eanMatches.length },
    });

    if (eanMatches.length === 1) {
      return eanMatches[0];
    }
  }

  return null;
}

// ── Layer 2: Code Lookup + Checker ────────────────────────

const CHECKER_PROMPT = `Jsi kontrolor kvality párování elektroinstalačních produktů. Dostaneš poptávku zákazníka a produkt(y) vybrané AI systémem.

Tvůj úkol: ověřit, zda vybraný produkt i alternativy technicky odpovídají poptávce.

Pravidla kontroly:
- Musí sedět TYP produktu (jistič je jistič, kabel je kabel, vodič je vodič)
- Musí sedět TVRDÉ PARAMETRY: průřez, počet žil, proud, počet pólů, charakteristika, typ kabelu
- Průřez: číslo za "x" v označení kabelu. 1,5 mm² je úplně jiný produkt než 95 mm²
- Počet žil: číslo před "x". 3-žilový kabel není 5-žilový kabel
- Typ kabelu: CYKY (PVC) není CXKH (bezhalogenový). CY (drátový) není CYA (lanovaný). -J (s ochranným vodičem) není -O (bez)
- Barva, výrobce, typ balení (BUBEN/KRUH) — tyto NEHODNOŤ jako chybu, pokud poptávka nespecifikuje
- Drobné formátové odchylky v názvech jsou OK: prefix "1-", prefix "KABEL"/"VODIC"/"JISTIC", "×" vs "x"
- Pokud je u produktu vyplněno pole "description", využij ho jako dodatečný kontext pro ověření parametrů. Popis může obsahovat technické detaily, které nejsou zřejmé z názvu.

Vrať VÝHRADNĚ JSON:
{
  "selected_ok": true/false,
  "selected_reason": "1 věta proč ok/fail",
  "alternatives_ok": ["SKU1", "SKU2"],
  "alternatives_fail": ["SKU3"],
  "alternatives_reasons": {"SKU3": "špatný průřez"}
}`;

interface ProductForChecker {
  sku: string;
  name: string;
  description?: string | null;
}

interface CheckerResult {
  selectedOk: boolean;
  selectedReason: string;
  alternativesOk: string[];
  alternativesFail: string[];
}

async function runChecker(
  demand: string,
  demandUnit: string | null,
  demandQuantity: number | null,
  selected: ProductForChecker | null,
  alternatives: ProductForChecker[],
): Promise<CheckerResult> {
  const payload = {
    demand,
    demandUnit,
    demandQuantity,
    selectedProduct: selected,
    alternatives,
  };

  const res = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CHECKER_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
  } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

  const content = res.choices[0]?.message?.content;
  if (!content) {
    return { selectedOk: true, selectedReason: "Checker nedostupný, předpokládáme OK.", alternativesOk: alternatives.map((a) => a.sku), alternativesFail: [] };
  }

  try {
    const p = JSON.parse(content) as {
      selected_ok?: boolean;
      selected_reason?: string;
      alternatives_ok?: string[];
      alternatives_fail?: string[];
    };
    return {
      selectedOk: p.selected_ok ?? true,
      selectedReason: p.selected_reason ?? "",
      alternativesOk: p.alternatives_ok ?? [],
      alternativesFail: p.alternatives_fail ?? [],
    };
  } catch {
    return { selectedOk: true, selectedReason: "Parse error, předpokládáme OK.", alternativesOk: alternatives.map((a) => a.sku), alternativesFail: [] };
  }
}

async function tryCodeLookup(
  codes: string[],
  demand: string,
  demandUnit: string | null,
  demandQuantity: number | null,
  onDebug?: PipelineDebugFn,
  position?: number,
): Promise<ProductResult | null> {
  if (codes.length === 0) return null;

  for (const code of codes) {
    const results = await lookupProductsExact(code, 5).catch(() => [] as ExactResult[]);
    const exactMatches = results.filter((r) =>
      r.match_type === "sku_exact" || r.match_type === "idnlf_exact" || r.match_type === "idnlf_normalized",
    );

    onDebug?.({
      position: position ?? 0,
      step: "code_lookup",
      data: { code, resultCount: results.length, exactMatchCount: exactMatches.length },
    });

    if (exactMatches.length === 1) {
      const product = exactMatches[0];
      const checkerResult = await runChecker(
        demand, demandUnit, demandQuantity,
        { sku: product.sku, name: product.name },
        [],
      );

      onDebug?.({
        position: position ?? 0,
        step: "code_checker",
        data: { sku: product.sku, checkerOk: checkerResult.selectedOk, reason: checkerResult.selectedReason },
      });

      if (checkerResult.selectedOk) {
        return product;
      }
    }
  }

  return null;
}

// ── Layer 3/4: ReAct Agent ────────────────────────────────

const AGENT_SYSTEM_PROMPT = `Jsi expert na vyhledávání a výběr elektroinstalačních produktů z B2B katalogu, který obsahuje přibližně 471 tisíc položek.

Zákazník poptává konkrétní produkt. Tvůj úkol je najít a vybrat technicky SPRÁVNÝ produkt z katalogu pomocí dostupných nástrojů.

## Jak postupovat

Krok 1: Analyzuj poptávku. Jaký typ produktu, jaké klíčové parametry (průřez, počet žil, proud, počet pólů...) a jestli v textu vidíš nějaký konkrétní kód.

Krok 2: Použij search_products pro textové vyhledání. Zkus nejdřív přesný název z poptávky. Pokud výsledky nejsou dobré, zkus alternativní formulaci — v katalogu se kabely často značí s prefixem "1-" (například "1-CYKY-J" místo "CYKY-J") a vodiče se označují normou (H07V-K místo CYA).

Krok 3: Z výsledků vyhledávání vyber kandidáty, kteří přesně odpovídají požadovanému typu A všem tvrdým parametrům. Každý produkt ve výsledcích může mít pole "description" — ČTI ho, obsahuje klíčové technické detaily, které v názvu chybí (například přesný typ balení kabelu, IP krytí, výkon, barvu, technický standard).

Krok 4: Pokud obecné vyhledávání vrací příliš široké výsledky (např. pro čidla, detektory, svítidla), použij list_categories pro nalezení správné kategorie a pak search_by_category pro cílené hledání v dané kategorii.

Krok 5: Pokud si nejsi jistý parametry nějakého kandidáta a description není dostupný nebo je krátký, ověř detaily nástrojem get_product_detail.

Krok 6: Jakmile máš rozhodnutí, odevzdej výsledek přes submit_result.

## Tvrdé parametry — tyto MUSÍ přesně sedět

**Průřez vodiče nebo kabelu** — číslo za znakem "x" v označení kabelu. Například "5x1,5" znamená průřez 1,5 mm². Kandidát s průřezem 95 mm² je úplně jiný produkt než kandidát s průřezem 1,5 mm², i když se oba jmenují podobně. Každý rozdíl v průřezu znamená špatný produkt.

**Počet žil nebo pólů** — číslo před znakem "x". Kabel "3x2,5" má 3 žíly, kabel "5x2,5" má 5 žil — nelze zaměnit. U jističů: 1-pólový a 3-pólový jsou odlišné přístroje.

**Typ kabelu** — každé písmeno v označení má konkrétní technický význam:
- CYKY je PVC kabel, CXKH je bezhalogenový — úplně jiný materiál izolace, nelze zaměnit
- CY je drátový (tuhý) vodič, CYA je lanovaný (ohebný) vodič — jiná konstrukce
- Koncovka "-J" znamená s ochranným vodičem, "-O" bez ochranného vodiče — záměna může být nebezpečná
- CXKH-R je kulatý profil, CXKH-V je plochý — jiná geometrie

**Proud u jističů** — 16A je jiný jistič než 25A. Charakteristika B, C a D jsou různé typy — každá má jiný náběhový proud.

**Datové kabely** — UTP je nestíněný, FTP je stíněný. Počet párů musí sedět. Jistič není pojistka — odlišný princip, nelze zaměnit.

## Kabely a vodiče — povinné pravidlo pro balení

Kabely a vodiče MUSÍ mít v názvu nebo popisu EXPLICITNĚ UVEDENÝ typ balení. Bez tohoto označení produkt NEVYBÍREJ — jde o neúplný záznam nebo jiný typ produktu.

Přijatelná označení balení:
- **BUBEN** — kabel na metráž (pro velká množství nebo délky, kde kruh nevychází)
- **KRUH** nebo konkrétní délka v názvu — například "50M", "KRUH 100M", "10 METRO" — pro malá množství
- **M** nebo **METRO** na konci názvu — označuje metráž
- Číselná délka za lomítkem nebo v závorce — například "100/", "(50M)"

Pokud zákazník poptává v metrech, porovnej množství s dostupnými délkami KRUHŮ. Vyber NEJVĚTŠÍ kruh, jehož délka se vejde do poptaného množství beze zbytku (například pro 80m vyber kruh 50m, ne kruh 100m). Pokud žádný kruh délkově nevyhovuje, vyber BUBEN.

Produkty bez jakéhokoli označení balení v názvu ani v popisu ZAHRŇ do alternativ jen pokud nemáš nic lepšího, ale RADĚJI VRAŤ not_found než neúplný produkt.

## Když najdeš více variant

Pokud najdeš více produktů, které se liší pouze v atributu, který zákazník nespecifikoval (například barva vodiče, typ bubnu), nastav matchType na "multiple" a selectedSku na null. V reasoning vysvětli, jaké varianty existují. Vrať je všechny jako alternativy.

## KLÍČOVÉ PRAVIDLO — technická správnost je jediná priorita
IGNORUJ cenu, sklad, dostupnost. Tvůj JEDINÝ úkol je najít technicky správný produkt. Pokud najdeš více technicky správných produktů, vrať je VŠECHNY jako alternativy (max 10).

## Důležitá pravidla
- NIKDY si nevymýšlej SKU. Používej pouze kódy z výsledků vyhledávání.
- Pokud si nejsi jistý, NEBER. Nastav selectedSku na null. Je lepší přiznat neúspěch než vybrat špatný produkt.
- Buď efektivní, obvykle stačí 2 až 4 volání nástrojů.
- VŽDY ukonči práci voláním submit_result.`;

function buildTools(): OpenAI.Responses.Tool[] {
  return [
    {
      type: "function",
      strict: true,
      name: "search_products",
      description: "Vyhledej produkty v katalogu podle textového dotazu. Vrací až 20 nejrelevantnějších produktů. Kombinuje sémantické a fulltextové vyhledávání.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Textový dotaz pro vyhledání (název produktu, typ, parametry)" },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      strict: true,
      name: "lookup_exact",
      description: "Přesné vyhledání podle SKU, EAN nebo objednacího kódu výrobce. Použij pokud máš konkrétní kód produktu.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "SKU, EAN, nebo objednací kód produktu" },
        },
        required: ["code"],
      },
    },
    {
      type: "function",
      strict: true,
      name: "get_product_detail",
      description: "Získej detailní informace o produktu podle SKU. Použij pro ověření parametrů kandidáta.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "SKU produktu" },
        },
        required: ["sku"],
      },
    },
    {
      type: "function",
      strict: true,
      name: "search_by_category",
      description: "Vyhledej produkty v katalogu s filtrem na konkrétní kategorii. Použij pokud obecné vyhledávání vrací příliš široké výsledky — například pro pohybové detektory, čidla, svítidla, spínače, zásuvky. Nejdřív získej seznam kategorií přes list_categories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Textový dotaz pro vyhledání" },
          category: { type: "string", description: "Kód kategorie pro filtraci (např. '4070802' pro Vypínače)" },
        },
        required: ["query", "category"],
      },
    },
    {
      type: "function",
      strict: true,
      name: "list_categories",
      description: "Vrať strom kategorií produktů v katalogu. Každá kategorie má kód, název a úroveň. Použij pro nalezení správné kategorie produktu.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      strict: true,
      name: "submit_result",
      description: "Odevzdej finální výsledek výběru produktu. MUSÍ být voláno jako poslední akce.",
      parameters: {
        type: "object",
        properties: {
          selectedSku: { type: ["string", "null"], description: "SKU vybraného produktu, nebo null pokud si nejsi jistý nebo je více variant" },
          matchType: { type: "string", enum: ["match", "uncertain", "multiple", "not_found"], description: "Typ shody" },
          confidence: { type: "number", description: "Confidence 0-100" },
          reasoning: { type: "string", description: "Zdůvodnění výběru (1-2 věty česky)" },
          alternativeSkus: {
            type: "array", items: { type: "string" },
            description: "SKU dalších technicky správných kandidátů (max 10)",
          },
        },
        required: ["selectedSku", "matchType", "confidence", "reasoning"],
      },
    },
  ];
}

// ── Tool handlers ─────────────────────────────────────────

async function handleSearchProducts(
  query: string,
  manufacturerFilter?: string | null,
): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const embedding = await generateQueryEmbedding(query);

  const [semanticResults, fulltextResults] = await Promise.all([
    searchProductsSemantic(embedding, 20, 0.35, undefined, manufacturerFilter ?? undefined).catch(() => [] as SemanticResult[]),
    searchProductsFulltext(query, 20, undefined, manufacturerFilter ?? undefined).catch(() => [] as FulltextResult[]),
  ]);

  const seen = new Set<string>();
  const combined: Array<{
    sku: string; name: string; unit: string | null;
    similarity: number; source: string;
    category_sub: string | null; description: string | null;
  }> = [];

  for (const r of semanticResults) {
    if (!seen.has(r.sku)) {
      seen.add(r.sku);
      combined.push({
        sku: r.sku, name: r.name, unit: r.unit,
        similarity: Math.round(r.cosine_similarity * 1000) / 1000,
        source: "semantic",
        category_sub: r.category_sub,
        description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
      });
    }
  }

  for (const r of fulltextResults) {
    if (!seen.has(r.sku)) {
      seen.add(r.sku);
      combined.push({
        sku: r.sku, name: r.name, unit: r.unit,
        similarity: Math.round((0.5 + Math.max(r.rank ?? 0, r.similarity_score ?? 0) * 0.3) * 1000) / 1000,
        source: "fulltext",
        category_sub: r.category_sub,
        description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
      });
    }
  }

  const top20 = combined.slice(0, 20);
  return {
    resultJson: JSON.stringify({ count: top20.length, products: top20 }),
    products: top20.map((p) => ({ sku: p.sku, name: p.name })),
  };
}

async function handleLookupExact(code: string): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const results = await lookupProductsExact(code, 5).catch(() => [] as ExactResult[]);
  const products = results.map((r) => ({
    sku: r.sku, name: r.name, unit: r.unit,
    match_type: r.match_type, matched_value: r.matched_value,
    description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
  }));
  return {
    resultJson: JSON.stringify({ count: products.length, products }),
    products: results.map((r) => ({ sku: r.sku, name: r.name })),
  };
}

async function handleSearchByCategory(
  query: string,
  category: string,
  manufacturerFilter?: string | null,
): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const embedding = await generateQueryEmbedding(query);

  const [semanticResults, fulltextResults] = await Promise.all([
    searchProductsSemantic(embedding, 15, 0.3, undefined, manufacturerFilter ?? undefined, category).catch(() => [] as SemanticResult[]),
    searchProductsFulltext(query, 15, undefined, manufacturerFilter ?? undefined, category).catch(() => [] as FulltextResult[]),
  ]);

  const seen = new Set<string>();
  const combined: Array<{
    sku: string; name: string; unit: string | null;
    category_sub: string | null; description: string | null;
  }> = [];

  for (const r of [...semanticResults, ...fulltextResults]) {
    if (!seen.has(r.sku)) {
      seen.add(r.sku);
      combined.push({
        sku: r.sku, name: r.name, unit: r.unit,
        category_sub: r.category_sub,
        description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
      });
    }
  }

  const top20 = combined.slice(0, 20);
  return {
    resultJson: JSON.stringify({ count: top20.length, products: top20 }),
    products: top20.map((p) => ({ sku: p.sku, name: p.name })),
  };
}

let cachedCategoryTree: CategoryTreeEntry[] | null = null;

async function handleListCategories(): Promise<string> {
  if (!cachedCategoryTree) {
    cachedCategoryTree = await getCategoryTree();
  }
  const simplified = cachedCategoryTree.map((c) => ({
    code: c.category_code,
    name: c.category_name,
    level: c.level,
    parent: c.parent_code,
  }));
  return JSON.stringify({ count: simplified.length, categories: simplified });
}

async function handleGetProductDetail(sku: string): Promise<string> {
  const products = await fetchProductsBySkus([sku]);
  if (products.length === 0) return JSON.stringify({ error: "Produkt nenalezen" });
  const p = products[0];
  return JSON.stringify({
    sku: p.sku, name: p.name, unit: p.unit,
    category_main: p.category_main, category_sub: p.category_sub,
    category_line: p.category_line, is_stock_item: p.is_stock_item,
    description: p.description, supplier_name: p.supplier_name,
  });
}

// ── ReAct agent runner ────────────────────────────────────

interface AgentResult {
  selectedSku: string | null;
  matchType: "match" | "uncertain" | "multiple" | "not_found";
  confidence: number;
  reasoning: string;
  alternativeSkus: string[];
  allDiscoveredProducts: Array<{ sku: string; name: string }>;
}

const MAX_TOOL_ROUNDS = 8;

async function runReactAgent(
  demand: string,
  unit: string | null,
  quantity: number | null,
  preprocessed: PreprocessResult,
  manufacturerFilter: string | null,
  lineFilter: string | null,
  onDebug?: PipelineDebugFn,
  position?: number,
  retryFeedback?: string,
): Promise<AgentResult> {
  let userMessage = `Poptávka: "${demand}"
Množství: ${quantity ?? "?"} ${unit ?? "ks"}
Typ produktu: ${preprocessed.productType || "neznámý"}
Klíčové parametry: ${JSON.stringify(preprocessed.keyParams)}
Rozvinutý název pro vyhledání: "${preprocessed.reformulated}"`;

  if (manufacturerFilter) {
    userMessage += `\n\nPOZOR — TVRDÉ OMEZENÍ: Hledej POUZE produkty výrobce "${manufacturerFilter}"${lineFilter ? ` z řady "${lineFilter}"` : ""}. Pokud od tohoto výrobce nic nenajdeš, vrať not_found. NESMÍŠ navrhnout jiného výrobce.`;
  }

  if (retryFeedback) {
    userMessage += `\n\nPŘEDCHOZÍ POKUS SELHAL: ${retryFeedback}\nZkus jiný přístup — hledej jinými klíčovými slovy nebo alternativním názvem.`;
  }

  const tools = buildTools();
  let allProducts: Array<{ sku: string; name: string }> = [];
  let finalResult: AgentResult | null = null;

  let response = await openai.responses.create({
    model: MODEL,
    instructions: AGENT_SYSTEM_PROMPT,
    input: userMessage,
    tools,
    reasoning: { effort: "low" },
  } as any);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const functionCalls = response.output.filter(
      (item: any) => item.type === "function_call",
    ) as Array<{ type: "function_call"; call_id: string; name: string; arguments: string }>;

    if (functionCalls.length === 0) {
      if (!finalResult) {
        finalResult = {
          selectedSku: null, matchType: "not_found", confidence: 0,
          reasoning: "Agent ukončil bez výsledku.",
          alternativeSkus: [], allDiscoveredProducts: allProducts,
        };
      }
      break;
    }

    const toolOutputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];

    for (const fc of functionCalls) {
      const args = JSON.parse(fc.arguments);
      let result: string;

      switch (fc.name) {
        case "search_products": {
          const searchResult = await handleSearchProducts(args.query, manufacturerFilter);
          result = searchResult.resultJson;
          for (const p of searchResult.products) {
            if (!allProducts.some((c) => c.sku === p.sku)) {
              allProducts.push(p);
            }
          }
          onDebug?.({
            position: position ?? 0,
            step: "agent_search",
            data: { query: args.query, manufacturer: manufacturerFilter, resultCount: searchResult.products.length },
          });
          break;
        }
        case "lookup_exact": {
          const lookupResult = await handleLookupExact(args.code);
          result = lookupResult.resultJson;
          for (const p of lookupResult.products) {
            if (!allProducts.some((c) => c.sku === p.sku)) {
              allProducts.push(p);
            }
          }
          break;
        }
        case "search_by_category": {
          const catResult = await handleSearchByCategory(args.query, args.category, manufacturerFilter);
          result = catResult.resultJson;
          for (const p of catResult.products) {
            if (!allProducts.some((c) => c.sku === p.sku)) {
              allProducts.push(p);
            }
          }
          onDebug?.({
            position: position ?? 0,
            step: "agent_search_category",
            data: { query: args.query, category: args.category, resultCount: catResult.products.length },
          });
          break;
        }
        case "list_categories": {
          result = await handleListCategories();
          break;
        }
        case "get_product_detail": {
          result = await handleGetProductDetail(args.sku);
          break;
        }
        case "submit_result": {
          const altSkus: string[] = (args.alternativeSkus ?? []).slice(0, 10);
          finalResult = {
            selectedSku: args.selectedSku ?? null,
            matchType: args.matchType ?? "not_found",
            confidence: args.confidence ?? 0,
            reasoning: args.reasoning ?? "",
            alternativeSkus: altSkus,
            allDiscoveredProducts: allProducts,
          };
          result = JSON.stringify({ status: "ok" });
          break;
        }
        default:
          result = JSON.stringify({ error: "Unknown tool" });
      }

      toolOutputs.push({ type: "function_call_output", call_id: fc.call_id, output: result });
    }

    if (finalResult) break;

    response = await openai.responses.create({
      model: MODEL,
      previous_response_id: response.id,
      input: toolOutputs,
      tools,
      reasoning: { effort: "low" },
    } as any);
  }

  if (!finalResult) {
    finalResult = {
      selectedSku: null, matchType: "not_found", confidence: 0,
      reasoning: "Agent vyčerpal maximální počet kroků.",
      alternativeSkus: [], allDiscoveredProducts: allProducts,
    };
  }

  onDebug?.({
    position: position ?? 0,
    step: "agent_result",
    data: {
      selectedSku: finalResult.selectedSku,
      matchType: finalResult.matchType,
      confidence: finalResult.confidence,
      alternativeCount: finalResult.alternativeSkus.length,
      totalDiscovered: allProducts.length,
    },
  });

  return finalResult;
}

// ── Slim helper ───────────────────────────────────────────

function slimProduct(p: ProductResult): Partial<ProductResult> {
  return {
    id: p.id, sku: p.sku, name: p.name, unit: p.unit,
    current_price: p.current_price, supplier_name: p.supplier_name,
    category_main: p.category_main, category_sub: p.category_sub,
    category_line: p.category_line, is_stock_item: p.is_stock_item,
    has_stock: p.has_stock, removed_at: p.removed_at,
  };
}

// ── Main Pipeline V2 ──────────────────────────────────────

export async function searchPipelineV2ForItem(
  item: ParsedItem,
  position: number,
  onDebug?: PipelineDebugFn,
  _preferences?: SearchPreferences,
  groupContext?: GroupContext,
): Promise<PipelineResultV2> {
  const t0 = Date.now();

  const buildResult = (
    matchType: PipelineResultV2["matchType"],
    confidence: number,
    product: Partial<ProductResult> | null,
    candidates: Array<Partial<ProductResult>>,
    reasoning: string,
    matchMethod: PipelineResultV2["matchMethod"],
    reformulated: string,
    exactFound: boolean,
  ): PipelineResultV2 => ({
    position,
    originalName: item.name,
    unit: item.unit,
    quantity: item.quantity,
    matchType,
    confidence,
    product,
    candidates,
    reasoning,
    priceNote: null,
    reformulatedQuery: reformulated,
    pipelineMs: Date.now() - t0,
    exactLookupAttempted: true,
    exactLookupFound: exactFound,
    matchMethod,
  });

  try {
    // ── Phase 0: AI Preprocessing ─────────────────────────
    const preprocessed = await preprocess(item.name);
    onDebug?.({
      position,
      step: "preprocess",
      data: {
        eans: preprocessed.eans,
        productCodes: preprocessed.productCodes,
        productType: preprocessed.productType,
        keyParams: preprocessed.keyParams,
        reformulated: preprocessed.reformulated,
      },
    });

    const allCodes = [...new Set([...(item.extraLookupCodes ?? []), ...preprocessed.productCodes])];

    // ── Layer 1: EAN Lookup ───────────────────────────────
    const eanProduct = await tryEanLookup(preprocessed.eans, onDebug, position);
    if (eanProduct) {
      onDebug?.({ position, step: "ean_match", data: { sku: eanProduct.sku, name: eanProduct.name } });
      return buildResult(
        "match", 100, slimProduct(eanProduct), [],
        `Produkt nalezen přesnou shodou EAN kódu.`,
        "ean", preprocessed.reformulated, true,
      );
    }

    // ── Layer 2: Code Lookup + Checker ────────────────────
    const codeProduct = await tryCodeLookup(
      allCodes, item.name, item.unit, item.quantity,
      onDebug, position,
    );
    if (codeProduct) {
      onDebug?.({ position, step: "code_match", data: { sku: codeProduct.sku, name: codeProduct.name } });
      return buildResult(
        "match", 98, slimProduct(codeProduct), [],
        `Produkt nalezen přesnou shodou kódu produktu, ověřeno checkerem.`,
        "code", preprocessed.reformulated, true,
      );
    }

    // ── Layer 3/4: ReAct Agent ────────────────────────────
    const manufacturerFilter = groupContext?.preferredManufacturer ?? null;
    const lineFilter = groupContext?.preferredLine ?? null;

    const agentResult = await runReactAgent(
      item.name, item.unit, item.quantity,
      preprocessed, manufacturerFilter, lineFilter,
      onDebug, position,
    );

    // Fetch full product data for selected + alternatives
    const allSkus = [
      ...(agentResult.selectedSku ? [agentResult.selectedSku] : []),
      ...agentResult.alternativeSkus,
    ].filter((s, i, arr) => arr.indexOf(s) === i);

    const fullProducts = allSkus.length > 0
      ? await fetchProductsBySkus(allSkus)
      : [];
    const productMap = new Map(fullProducts.map((p) => [p.sku, p]));

    const selectedProduct = agentResult.selectedSku
      ? productMap.get(agentResult.selectedSku) ?? null
      : null;
    const selectedInfo: ProductForChecker | null = selectedProduct
      ? { sku: selectedProduct.sku, name: selectedProduct.name, description: selectedProduct.description }
      : null;
    const alternativeInfos: ProductForChecker[] = agentResult.alternativeSkus.flatMap((sku) => {
      const p = productMap.get(sku);
      return p
        ? [{ sku: p.sku, name: p.name, description: p.description ?? null }]
        : [];
    });

    // ── Checker ───────────────────────────────────────────
    if (agentResult.matchType !== "not_found" && (selectedProduct || alternativeInfos.length > 0)) {
      const checkerResult = await runChecker(
        item.name, item.unit, item.quantity,
        selectedInfo, alternativeInfos,
      );

      onDebug?.({
        position, step: "checker",
        data: {
          selectedOk: checkerResult.selectedOk,
          selectedReason: checkerResult.selectedReason,
          alternativesOk: checkerResult.alternativesOk,
          alternativesFail: checkerResult.alternativesFail,
        },
      });

      const okAlternatives = checkerResult.alternativesOk
        .map((sku) => productMap.get(sku))
        .filter((p): p is ProductResult => p != null);

      if (checkerResult.selectedOk) {
        // Selected is OK — return as-is
        return buildResult(
          agentResult.matchType,
          agentResult.confidence,
          selectedProduct ? slimProduct(selectedProduct) : null,
          okAlternatives.map(slimProduct),
          agentResult.reasoning,
          "semantic", preprocessed.reformulated, false,
        );
      }

      // Selected FAILED checker — user picks from good alternatives, NEVER auto-pick
      if (okAlternatives.length > 0) {
        return buildResult(
          "multiple", 0, null,
          okAlternatives.map(slimProduct),
          `Checker vyřadil původní výběr (${checkerResult.selectedReason}). Zbývá ${okAlternatives.length} technicky správný kandidát(ů) — uživatel vybírá.`,
          "semantic", preprocessed.reformulated, false,
        );
      }

      // ALL candidates (selected + alternatives) failed checker — RETRY once
      onDebug?.({ position, step: "retry", data: { reason: checkerResult.selectedReason } });

      const retryResult = await runReactAgent(
        item.name, item.unit, item.quantity,
        preprocessed, manufacturerFilter, lineFilter,
        onDebug, position,
        `Vybraný produkt "${selectedInfo?.name ?? "?"}" byl zamítnut: ${checkerResult.selectedReason}. Všechny alternativy byly také špatné.`,
      );

      const retrySkus = [
        ...(retryResult.selectedSku ? [retryResult.selectedSku] : []),
        ...retryResult.alternativeSkus,
      ].filter((s, i, arr) => arr.indexOf(s) === i);

      const retryProducts = retrySkus.length > 0 ? await fetchProductsBySkus(retrySkus) : [];
      const retryMap = new Map(retryProducts.map((p) => [p.sku, p]));

      const retrySelected = retryResult.selectedSku ? retryMap.get(retryResult.selectedSku) ?? null : null;
      const retrySelectedInfo: ProductForChecker | null = retrySelected
        ? { sku: retrySelected.sku, name: retrySelected.name, description: retrySelected.description }
        : null;
      const retryAlts: ProductForChecker[] = retryResult.alternativeSkus
        .map((sku) => retryMap.get(sku))
        .filter((p): p is ProductResult => p != null)
        .map((p) => ({ sku: p.sku, name: p.name, description: p.description }));

      // Checker on retry result
      if (retrySelected || retryAlts.length > 0) {
        const retryChecker = await runChecker(
          item.name, item.unit, item.quantity,
          retrySelectedInfo, retryAlts,
        );

        onDebug?.({ position, step: "retry_checker", data: retryChecker });

        const retryOk = retryChecker.alternativesOk
          .map((sku) => retryMap.get(sku))
          .filter((p): p is ProductResult => p != null);

        if (retryChecker.selectedOk && retrySelected) {
          // Retry selected OK — return it with ok alternatives as candidates
          return buildResult(
            retryResult.matchType, retryResult.confidence,
            slimProduct(retrySelected), retryOk.map(slimProduct),
            `(retry) ${retryResult.reasoning}`,
            "semantic", preprocessed.reformulated, false,
          );
        }

        // Retry selected failed but alternatives OK — user picks, no auto-pick
        if (retryOk.length > 0) {
          return buildResult(
            "multiple", 0, null,
            retryOk.map(slimProduct),
            `(retry) Checker vyřadil výběr, zbývá ${retryOk.length} technicky správný kandidát(ů) — uživatel vybírá.`,
            "semantic", preprocessed.reformulated, false,
          );
        }
      }

      // Retry also fully failed — not_found
      return buildResult(
        "not_found", 0, null, [],
        `Agent ani po opakovaném pokusu nenašel technicky správný produkt.`,
        "not_found", preprocessed.reformulated, false,
      );
    }

    // Agent returned not_found or empty — pass through
    const candidatesFromAgent = agentResult.allDiscoveredProducts.slice(0, 10);
    const candidateProducts = candidatesFromAgent.length > 0
      ? await fetchProductsBySkus(candidatesFromAgent.map((c) => c.sku))
      : [];

    return buildResult(
      agentResult.matchType,
      agentResult.confidence,
      selectedProduct ? slimProduct(selectedProduct) : null,
      candidateProducts.map(slimProduct),
      agentResult.reasoning,
      agentResult.matchType === "not_found" ? "not_found" : "semantic",
      preprocessed.reformulated, false,
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pipeline V2 failed";
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
      matchMethod: "not_found",
    };
  }
}
