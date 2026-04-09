/**
 * searchPipelineV2.ts
 * New pipeline: priority layers (EAN → code → ReAct agent) + checker + retry.
 * Drop-in replacement for searchPipelineForItem with same interface.
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import {
  searchProductsAgentFulltext,
  lookupProductsExact,
  fetchProductsBySkus,
  getCategoryTree,
  type SemanticResult,
  type AgentFulltextResult,
  type ExactResult,
  type ProductResult,
  type CategoryTreeEntry,
  type StockFilterOptions,
} from "./search.js";
import {
  searchProductsQdrant,
  generateQueryEmbeddingLarge,
} from "./qdrantSearch.js";
import type {
  ParsedItem,
  PipelineResult,
  SearchPreferences,
  GroupContext,
  PipelineDebugFn,
} from "./types.js";

const MODEL = "gpt-5.4-mini";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ── Stock cascade types ────────────────────────────────────

export type StockLevel = "branch" | "stock_item" | "stock_item_in_stock" | "in_stock" | "any";

export interface StockContext {
  requestedLevel: StockLevel;
  effectiveLevel: StockLevel;
  fallbackUsed: boolean;
}

// ── Extended result with matchMethod + stockContext ────────

export interface PipelineResultV2 extends PipelineResult {
  matchMethod: "ean" | "code" | "semantic" | "not_found";
  stockContext?: StockContext;
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

// Used ONLY for code-based matches — much more lenient than full checker.
// EAN matches bypass the checker entirely (Layer 1 returns immediately).
// Code matches are highly reliable; we only catch obvious nonsense.
const CODE_CHECKER_PROMPT = `Zákazník poptává produkt a byl nalezen přes katalogový/objednací kód výrobce.
Katalogový kód je specifický identifikátor — pokud byl nalezen, produkt téměř jistě odpovídá.

Odmítni POUZE pokud jde o ZŘEJMÝ NESMYSL:
- Typ produktu je úplně jiný (hledáme kabel, nalezeno svítidlo nebo jistič)
- Nalezený produkt je z jiné kategorie než poptávka (např. hledáme vypínač, nalezena zásuvka)
- Název produktu vůbec nesouvisí s poptávkou

PŘIJMI vždy, pokud:
- Produkt je ze stejné kategorie (vypínač = vypínač, kabel = kabel, rámeček = rámeček)
- Liší se pouze barva, varianta, způsob montáže nebo drobný detail
- Název produktu je zkrácený nebo v jiném formátu (SPINAC C.1 = jednopólový vypínač = OK)
- Výrobce nebo řada se liší — to je přijatelné, kód je autoritativní

Vrať VÝHRADNĚ JSON (bez dalšího textu):
{"selected_ok": true, "selected_reason": "1 věta"}`;

const CHECKER_PROMPT = `Jsi kontrolor kvality párování elektroinstalačních produktů. Dostaneš poptávku zákazníka a produkt(y) vybrané AI systémem.

Tvůj úkol: ověřit, zda vybraný produkt i alternativy technicky odpovídají poptávce.

## Kategorie 1 — Kabely a vodiče
- Musí sedět PRŮŘEZ: číslo za "x" v označení. 1,5 mm² ≠ 95 mm². Každý rozdíl = špatný produkt.
- Musí sedět POČET ŽIL: číslo před "x". 3-žilový ≠ 5-žilový.
- Musí sedět TYP KABELU: CYKY (PVC) ≠ CXKH (bezhalogenový). CY ≠ CYA. -J ≠ -O.
- Typ balení (BUBEN/KRUH) — nehodnoť jako chybu, pokud poptávka neurčuje.

### Barevné varianty jednožílových vodičů
Jednožílové vodiče (CY, CYA, H07V-K, H07V-U, AYKY a podobné) existují v barevných provedeních.
Barva bývá uvedena v názvu (C=černá, ZZ=žlutozelená, M=modrá, R=rudá, HN=hnědá, SE=šedá…) i v poli description — VŽDY zkontroluj description pro zjištění barvy produktu.
Pokud poptávka EXPLICITNĚ NEUVÁDÍ barvu (ani zkratkou, ani slovem) A vybraný produkt má v názvu nebo description konkrétní barvu A alternativy jsou stejný vodič v jiných barvách → nastav selected_ok: false. Důvod: zákazník musí sám vybrat barvu.
V takovém případě nastav alternatives_ok na VŠECHNY barevné varianty (všechny jsou technicky správné, jen barva není určena).

## Kategorie 2 — Domovní přístroje (vypínače, zásuvky, stmívače, datové zásuvky)
Česká katalogová názvosloví pro domovní přístroje:
- SPINAC / PREPINAC = vypínač / přepínač
- ZASUVKA = zásuvka
- RAMECEK / JEDNORAMECEK / DVOJRAMECEK = rámeček
- KRYT / KLAPKA / DESKA = kryt / krycí deska
- C.1 = jednopólový vypínač, C.6 = schodišťový přepínač (č. 6), C.7 = křížový
- SO / BEZ.SROUB = šroubovací / bezšroubový
Pravidla:
- Pokud poptávka říká "strojek vypínače" a produkt je SPINAC → TYP sedí. OK.
- Pokud poptávka říká "kryt/krycí deska" a produkt je KRYT nebo KLAPKA → OK.
- Pokud poptávka říká "rámeček" a produkt je RAMECEK → OK.
- Výrobce a řada: pokud produkt obsahuje katalogový kód výrobce (např. 3558-A01340, SDN0100121) → považuj shodu za OK, kód je identifikátor konkrétní varianty.
- Barvu (bílá, titán, antracit) a způsob montáže NEHODNOŤ jako chybu, pokud poptávka neurčuje.
- Počet modulů/pozic: jednonásobný ≠ dvojnásobný (pokud poptávka určuje).

## Kategorie 3 — Jistící přístroje (jističe, chrániče, svodiče)
- Musí sedět PROUD: 10A ≠ 16A ≠ 32A.
- Musí sedět POČET PÓLŮ: 1P ≠ 3P.
- Musí sedět CHARAKTERISTIKA: B ≠ C ≠ D.
- Citlivost chráničů: 30mA ≠ 100mA.

## Obecná pravidla
- Drobné formátové odchylky jsou OK: prefix "1-", prefix "KABEL"/"VODIC"/"JISTIC", "×" vs "x".
- Pokud je vyplněno pole "description", využij ho jako dodatečný kontext.
- Pokud si nejsi jistý kategorií produktu → buď benevolentní (selected_ok: true) pokud typ sedí.

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
  category_main?: string | null;
  category_sub?: string | null;
  category_line?: string | null;
  supplier_name?: string | null;
}

interface CheckerResult {
  selectedOk: boolean;
  selectedReason: string;
  alternativesOk: string[];
  alternativesFail: string[];
}

/** Lightweight checker for code-based matches — only rejects obvious nonsense. */
async function runCodeChecker(
  demand: string,
  selected: ProductForChecker,
): Promise<boolean> {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CODE_CHECKER_PROMPT },
        { role: "user", content: JSON.stringify({ demand, product: { sku: selected.sku, name: selected.name } }) },
      ],
    } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming);

    const content = res.choices[0]?.message?.content;
    if (!content) return true; // Default OK if unavailable
    const p = JSON.parse(content) as { selected_ok?: boolean };
    return p.selected_ok !== false; // Default to true unless explicitly false
  } catch {
    return true; // Default OK on any error
  }
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
      alternatives_reasons?: Record<string, string>;
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

    if (exactMatches.length > 0) {
      const primary = exactMatches[0]!;
      const isIdnlf = primary.match_type === "idnlf_exact" || primary.match_type === "idnlf_normalized";

      let ok: boolean;
      if (isIdnlf) {
        // IDNLF codes identify a product family, not a unique product — must run full checker
        // to validate dimensions, conductor count, cross-section, etc.
        const primaryForChecker: ProductForChecker = {
          sku: primary.sku,
          name: primary.name,
          description: primary.description ?? null,
          category_main: primary.category_main ?? null,
          category_sub: primary.category_sub ?? null,
          category_line: primary.category_line ?? null,
          supplier_name: primary.supplier_name ?? null,
        };
        const checkerResult = await runChecker(demand, demandUnit, demandQuantity, primaryForChecker, []);
        ok = checkerResult.selectedOk;
      } else {
        // SKU exact match is deterministic — lightweight check is sufficient.
        ok = await runCodeChecker(demand, { sku: primary.sku, name: primary.name });
      }

      onDebug?.({
        position: position ?? 0,
        step: "code_checker",
        data: { sku: primary.sku, checkerOk: ok, altCount: exactMatches.length - 1 },
      });

      if (ok) return primary;
    }
  }

  return null;
}

// ── Layer 3/4: ReAct Agent ────────────────────────────────

const AGENT_SYSTEM_PROMPT = `Jsi expert na vyhledávání a výběr elektroinstalačních produktů z B2B katalogu.

Zákazník poptává konkrétní produkt. Tvůj úkol je najít a vybrat technicky SPRÁVNÝ produkt z katalogu pomocí dostupných nástrojů.

## Jak postupovat

Krok 1: Analyzuj poptávku. Jaký typ produktu, jaké klíčové parametry (průřez, počet žil, proud, počet pólů...) a jestli v textu vidíš nějaký konkrétní kód.

Krok 2: Vyber správný nástroj pro vyhledání:
- **search_fulltext** — použij pro technická označení, typy kabelů, katalogové kódy (např. "1-CXKH-R-J 5x1,5", "PL6-B16", "H07V-K"). Hledá přesné tokeny v názvech produktů, je rychlejší a přesnější pro konkrétní technické výrazy.
- **search_products** — použij pro obecnější nebo popisný dotaz, kde přesný název neznáš (např. "bezhalogenový kabel 5 žilový", "jednopólový jistič charakteristika B"). Využívá sémantické vyhledávání.

Zkus nejdřív přesný název z poptávky. Pokud výsledky nejsou dobré, zkus alternativní formulaci — v katalogu se kabely často značí s prefixem "1-" (například "1-CYKY-J" místo "CYKY-J") a vodiče se označují normou (H07V-K místo CYA).

Krok 3: Z výsledků vyhledávání vyber kandidáty, kteří přesně odpovídají požadovanému typu A všem tvrdým parametrům. Každý produkt ve výsledcích může mít pole "description" — ČTI ho, obsahuje klíčové technické detaily, které v názvu chybí (například přesný typ balení kabelu, IP krytí, výkon, barvu, technický standard).

Krok 4: Pokud obecné vyhledávání vrací příliš mnoho nesouvisejících produktů, použij kategoriový strom.

### Co vidíš ve výsledcích vyhledávání
Každý produkt ve výsledcích má pole: category_main, category_sub, category_line.
Přečti je — řeknou ti, ve které části katalogu se nalezené produkty nacházejí.
Pokud vidíš, že výsledky jsou z různých category_main (míchají se různá odvětví), nebo jsou výsledky nesourodé a category_sub ukazuje špatnou oblast — je čas zúžit vyhledávání přes kategorie.

### Jak funguje kategoriový strom
Katalog má 3 úrovně:
  Úroveň 1 — HLAVNÍ KATEGORIE (nejširší, např. "Kabely a vodiče", "Jistící přístroje", "Svítidla")
  Úroveň 2 — PODKATEGORIE (užší, např. "Silové kabely", "Jističe NN", "Průmyslová svítidla")
  Úroveň 3 — PRODUKTOVÁ ŘADA (nejkonkrétnější)
Každá kategorie má: code (číselný kód), name, level (1/2/3), parent (kód nadřazené).

### Jak kategorii použít — postupuj shora dolů

KROK A: Zavolej 'list_categories' BEZ parent_code → dostaneš všechny level-1 kategorie.
  → Ze znalosti domény a z category_main co jsi viděl ve výsledcích vyber správnou hlavní kategorii.

KROK B: Zavolej 'list_categories' s parent_code = kódem z kroku A → dostaneš podkategorie (level 2).
  → Vyber nejbližší podkategorii.

KROK C (volitelný): Zavolej 'list_categories' s parent_code z kroku B → produktové řady (level 3).

KROK D: Zavolej 'search_by_category(query, code)' s kódem z nejkonkrétnější úrovně.
  → Výsledky budou filtrovány pouze na danou kategorii.

### Kdy to použít
- Výsledky search_products mají různé category_main (různá odvětví se míchají)
- Hledáš produkt snadno zaměnitelný s jiným typem (čidla, detektory, svítidla, spínače)
- Obecný dotaz přináší příliš mnoho nesouvisejících výsledků

Krok 5: Jakmile máš rozhodnutí, odevzdej výsledek přes submit_result.

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

## Kabely, vodiče a trubky — povinné pravidlo pro balení a délku

Kabely, vodiče a trubky MUSÍ mít v názvu nebo popisu EXPLICITNĚ UVEDENÝ typ balení. Bez tohoto označení produkt NEVYBÍREJ — jde o neúplný záznam nebo jiný typ produktu.

Přijatelná označení balení:
- **BUBEN** — kabel na metráž (pro velká množství)
- **KRUH** nebo konkrétní délka v názvu — například "KRUH 50M", "KRUH 100M", "25M", "10 METRO"
- **M** nebo **METRO** na konci názvu — označuje metráž
- Číselná délka za lomítkem nebo v závorce — například "/50M", "(25M)"

### Výběr správného balení podle poptávaného množství

Pokud zákazník poptává v metrech nebo kusech s délkou, postupuj takto:

1. Zjisti dostupné délky KRUHŮ pro daný produkt (typicky 10M, 25M, 35M, 50M, 100M).
2. Najdi **největší délku kruhu**, která dělí poptávané množství BEZE ZBYTKU (tj. poptávané_množství mod délka_kruhu = 0).
   - Příklad: poptávka 200m → 100M: 200/100=2 ✓, 50M: 200/50=4 ✓ → vyber KRUH 100M (největší)
   - Příklad: poptávka 150m → 100M: 150/100=1,5 ✗, 50M: 150/50=3 ✓ → vyber KRUH 50M
   - Příklad: poptávka 62m → 100M ✗, 50M ✗, 25M: 62/25=2,48 ✗ → žádný nevychází → BUBEN
3. Pokud žádná délka kruhu nevychází beze zbytku → vyber **BUBEN**.
4. Pokud poptávané množství přesahuje 300m → **vždy preferuj BUBEN** (objednávat mnoho kruhů je nepraktické).

Produkty bez jakéhokoli označení balení v názvu ani v popisu ZAHRŇ do alternativ jen pokud nemáš nic lepšího, ale RADĚJI VRAŤ not_found než neúplný produkt.

## Barva vodiče — povinné pravidlo

Barevné varianty se týkají pouze **jednožílových vodičů** (CY, CYA, H07V-K, CYME, AYKY a podobné s jednou žílou). Tyto produkty existují v různých barvách: žlutozelená (ZZ), černá, modrá, červená, hnědá, šedá, bílá atd.

**Vícežílové kabely** (CYKY 3x..., CXKH 5x..., datové kabely a podobné) barvu zákazník NESPECIFIKUJE — barvy žil jsou pevně dány normou. U těchto produktů pravidlo barevných variant NEPLATÍ.

Pro jednožílové vodiče:

**Pokud barva NENÍ v poptávce explicitně uvedena** — ani zkratkou (ZZ, CRN, MOD, RUD...) ani slovem (žlutá, zelená, černá, modrá, červená...) — NIKDY nevybírej jednu konkrétní barvu jako primární výsledek. Nastav selectedSku na null, matchType na "multiple" a vrať VŠECHNY dostupné barevné varianty jako alternativy.

**Pokud barva JE specifikována** — vyber produkt té barvy. Ostatní barvy NEZAHRNEJ do alternativ.

## Když najdeš více variant z jiných důvodů

Pokud najdeš více produktů lišící se v jiném nespecifikovaném atributu (např. výrobce, model), nastav matchType na "multiple" a selectedSku na null. V reasoning vysvětli, jaké varianty existují. Vrať je všechny jako alternativy.

## KLÍČOVÉ PRAVIDLO — technická správnost je jediná priorita
IGNORUJ cenu, sklad, dostupnost. Tvůj JEDINÝ úkol je najít technicky správný produkt. Pokud najdeš více technicky správných produktů, vrať je VŠECHNY jako alternativy (max 10).

## Pravidlo pro alternativeSkus — co SMÍŠ a NESMÍŠ zahrnout

alternativeSkus MUSÍ být produkty se STEJNOU technickou specifikací jako poptávaný produkt.

NESMÍŠ zahrnout:
- Nižší standard: Cat5E NENÍ alternativa k Cat6. Cat6 NENÍ alternativa k Cat6A.
- Jiný průřez: 1,5 mm² NENÍ alternativa k 2,5 mm².
- Jiný typ kabelu: UTP NENÍ alternativa k FTP (a naopak).
- Jiný typ balení pokud zákazník specifikuje délku: BUBEN NENÍ alternativa ke KRUHU 100M pokud zákazník chce přesnou délku.

SMÍŠ zahrnout:
- Stejný typ od jiného výrobce (pokud výrobce není specifikován)
- Stejná specifikace, mírně odlišné označení modelu
- Pokud zákazník nespecifikoval délku: jiné délky stejného kabelu (KRUH 50M i KRUH 100M)

Pokud nemáš technicky správné alternativy — nech alternativeSkus prázdné. NIKDY nezahrnuj produkty, u kterých si nejsi 100% jistý technickou shodou.

## Důležitá pravidla
- NIKDY si nevymýšlej SKU. Používej pouze kódy z výsledků vyhledávání.
- Pokud si nejsi jistý, NEBER. Nastav selectedSku na null. Je lepší přiznat neúspěch než vybrat špatný produkt.
- Buď efektivní, obvykle stačí 2 až 4 volání nástrojů.
- VŽDY ukonči práci voláním submit_result.`;

// ── Stock level helpers ────────────────────────────────────

function prefsToStockLevel(prefs?: SearchPreferences): StockLevel {
  if (!prefs || prefs.stockFilter === "any") return "any";
  if (prefs.stockFilter === "in_stock") return "in_stock";
  if (prefs.stockFilter === "stock_items_in_stock") return "stock_item_in_stock";
  if (prefs.branchFilter) return "branch";
  return "stock_item";
}

function stockLevelToOpts(level: StockLevel, branchFilter?: string | null): StockFilterOptions | undefined {
  switch (level) {
    case "branch": return { stockItemOnly: true, branchCodeFilter: branchFilter ?? undefined };
    case "stock_item": return { stockItemOnly: true };
    case "stock_item_in_stock": return { stockItemOnly: true, inStockOnly: true };
    case "in_stock": return { inStockOnly: true };
    case "any": return undefined;
  }
}

function buildTools(): OpenAI.Responses.Tool[] {
  return [
    {
      type: "function",
      strict: true,
      name: "search_products",
      description: "Sémantické vyhledávání produktů — vhodné pro obecnější nebo popisné dotazy kde přesný název neznáš. Vrací až 20 nejrelevantnějších produktů. Pro technická označení a katalogové kódy použij search_fulltext.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Textový dotaz pro vyhledání (název produktu, typ, parametry)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      strict: true,
      name: "search_fulltext",
      description: "Fulltextové vyhledávání produktů podle názvu. Hledá přesné tokeny v názvu produktu — vhodné pro technické označení jako '1-CXKH-R-J 5x1,5', 'PL6-B16', 'H07V-K', nebo přesné katalogové prefisy. Vrací až 40 výsledků seřazených podle textuální relevance.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Textový dotaz — technické označení, typ produktu, katalogový kód" },
        },
        required: ["query"],
        additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
      },
    },
    {
      type: "function",
      strict: true,
      name: "list_categories",
      description: "Vrať kategorie produktů z katalogu. Katalog má 3 úrovně: hlavní kategorie (level 1) → podkategorie (level 2) → produktová řada (level 3). Bez parametru vrátí pouze hlavní kategorie (level 1, ~15 položek). S parametrem parent_code vrátí přímé potomky dané kategorie. Procházej strom shora dolů — nejdřív hlavní kategorie, pak zavolej znovu s kódem vybrané kategorie pro podkategorie.",
      parameters: {
        type: "object",
        properties: {
          parent_code: {
            type: ["string", "null"],
            description: "Kód nadřazené kategorie, jejíž přímé potomky chceš zobrazit. Null nebo vynech pro zobrazení hlavních kategorií (level 1).",
          },
        },
        required: ["parent_code"],
        additionalProperties: false,
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
        required: ["selectedSku", "matchType", "confidence", "reasoning", "alternativeSkus"],
        additionalProperties: false,
      },
    },
  ];
}

// ── Tool handlers ─────────────────────────────────────────

async function handleSearchProducts(
  query: string,
  manufacturerFilter?: string | null,
  stockOpts?: StockFilterOptions,
): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const embedding = await generateQueryEmbeddingLarge(query);

  const semanticResults = await searchProductsQdrant(
    embedding, 40, 0.15, undefined, manufacturerFilter ?? undefined, undefined, stockOpts,
  ).catch(() => [] as SemanticResult[]);

  const combined = semanticResults.slice(0, 40).map((r) => ({
    sku: r.sku, name: r.name, unit: r.unit,
    similarity: Math.round(r.cosine_similarity * 1000) / 1000,
    source: "semantic",
    category_main: r.category_main, category_sub: r.category_sub, category_line: r.category_line,
    supplier_name: r.supplier_name, is_stock_item: r.is_stock_item,
    description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
  }));

  return {
    resultJson: JSON.stringify({ count: combined.length, products: combined }),
    products: combined.map((p) => ({ sku: p.sku, name: p.name })),
  };
}

async function handleSearchFulltext(
  query: string,
  manufacturerFilter?: string | null,
  stockOpts?: StockFilterOptions,
): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const results = await searchProductsAgentFulltext(
    query, 40, undefined, manufacturerFilter ?? undefined, undefined, stockOpts,
  ).catch(() => [] as AgentFulltextResult[]);

  const combined = results.slice(0, 40).map((r) => ({
    sku: r.sku, name: r.name, unit: r.unit,
    rank: Math.round(r.rank * 1000) / 1000,
    source: "fulltext",
    category_main: r.category_main, category_sub: r.category_sub, category_line: r.category_line,
    supplier_name: r.supplier_name, is_stock_item: r.is_stock_item,
    description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
  }));

  return {
    resultJson: JSON.stringify({ count: combined.length, products: combined }),
    products: combined.map((p) => ({ sku: p.sku, name: p.name })),
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
  stockOpts?: StockFilterOptions,
): Promise<{ resultJson: string; products: Array<{ sku: string; name: string }> }> {
  const embedding = await generateQueryEmbeddingLarge(query);

  const semanticResults = await searchProductsQdrant(
    embedding, 40, 0.15, undefined, manufacturerFilter ?? undefined, category, stockOpts,
  ).catch(() => [] as SemanticResult[]);

  const combined = semanticResults.slice(0, 40).map((r) => ({
    sku: r.sku, name: r.name, unit: r.unit,
    category_main: r.category_main, category_sub: r.category_sub, category_line: r.category_line,
    supplier_name: r.supplier_name, is_stock_item: r.is_stock_item,
    description: r.description && r.description.trim().length > 5 ? r.description.slice(0, 300) : null,
  }));

  const top40 = combined.slice(0, 40);
  return {
    resultJson: JSON.stringify({ count: top40.length, products: top40 }),
    products: top40.map((p) => ({ sku: p.sku, name: p.name })),
  };
}

let cachedCategoryTree: CategoryTreeEntry[] | null = null;

async function handleListCategories(parentCode?: string | null): Promise<string> {
  if (!cachedCategoryTree) {
    cachedCategoryTree = await getCategoryTree();
  }

  let filtered: CategoryTreeEntry[];
  if (parentCode) {
    // Return direct children of the given parent code
    filtered = cachedCategoryTree.filter((c) => c.parent_code === parentCode);
  } else {
    // Return only top-level categories (level 1) for a compact overview
    filtered = cachedCategoryTree.filter((c) => c.level === 1);
  }

  const simplified = filtered.map((c) => ({
    code: c.category_code,
    name: c.category_name,
    level: c.level,
    parent: c.parent_code,
  }));
  return JSON.stringify({ count: simplified.length, categories: simplified });
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

const MAX_TOOL_ROUNDS = 20;

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
  stockOpts?: StockFilterOptions,
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
          const searchResult = await handleSearchProducts(args.query, manufacturerFilter, stockOpts);
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
        case "search_fulltext": {
          const ftResult = await handleSearchFulltext(args.query, manufacturerFilter, stockOpts);
          result = ftResult.resultJson;
          for (const p of ftResult.products) {
            if (!allProducts.some((c) => c.sku === p.sku)) {
              allProducts.push(p);
            }
          }
          onDebug?.({
            position: position ?? 0,
            step: "agent_search_fulltext",
            data: { query: args.query, manufacturer: manufacturerFilter, resultCount: ftResult.products.length },
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
          const catResult = await handleSearchByCategory(args.query, args.category, manufacturerFilter, stockOpts);
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
          const lcArgs = args as { parent_code?: string | null };
          result = await handleListCategories(lcArgs.parent_code ?? null);
          break;
        }
        case "submit_result": {
          const altSkus: string[] = (args.alternativeSkus ?? []).slice(0, 10);
          const resolvedMatchType = args.matchType ?? "not_found";
          const agentSelectedSku: string | null = args.selectedSku ?? null;

          // Structural guard: matchType "multiple" means agent found variants but couldn't
          // pick one — selectedSku MUST be null regardless of what the LLM returned.
          const resolvedSelectedSku = resolvedMatchType === "multiple" ? null : agentSelectedSku;


          finalResult = {
            selectedSku: resolvedSelectedSku,
            matchType: resolvedMatchType,
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
    description: p.description ?? null,
    current_price: p.current_price, supplier_name: p.supplier_name,
    category_main: p.category_main, category_sub: p.category_sub,
    category_line: p.category_line, is_stock_item: p.is_stock_item,
    has_stock: p.has_stock, removed_at: p.removed_at,
    status_purchase_code: p.status_purchase_code ?? null,
    status_purchase_text: p.status_purchase_text ?? null,
    status_sales_code: p.status_sales_code ?? null,
    status_sales_text: p.status_sales_text ?? null,
    dispo: p.dispo ?? null,
  };
}

// ── Main Pipeline V2 ──────────────────────────────────────

export async function searchPipelineV2ForItem(
  item: ParsedItem,
  position: number,
  onDebug?: PipelineDebugFn,
  preferences?: SearchPreferences,
  groupContext?: GroupContext,
  stockLevelOverride?: StockLevel,
): Promise<PipelineResultV2> {
  const t0 = Date.now();

  let hadEansOrCodes = false;

  const buildResult = (
    matchType: PipelineResultV2["matchType"],
    confidence: number,
    product: Partial<ProductResult> | null,
    candidates: Array<Partial<ProductResult>>,
    reasoning: string,
    matchMethod: PipelineResultV2["matchMethod"],
    reformulated: string,
    exactFound: boolean,
    stockCtx?: StockContext,
  ): PipelineResultV2 => {
    const sortedCandidates = candidates;

    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType,
      confidence,
      product,
      candidates: sortedCandidates,
      reasoning,
      priceNote: null,
      reformulatedQuery: reformulated,
      pipelineMs: Date.now() - t0,
      exactLookupAttempted: hadEansOrCodes,
      exactLookupFound: exactFound,
      matchMethod,
      stockContext: stockCtx,
    };
  };

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
    hadEansOrCodes = preprocessed.eans.length > 0 || allCodes.length > 0;

    // ── Layer 1: EAN Lookup — 100% match, no checker needed ─
    const eanProduct = await tryEanLookup(preprocessed.eans, onDebug, position);
    if (eanProduct) {
      onDebug?.({ position, step: "ean_match", data: { sku: eanProduct.sku, name: eanProduct.name } });
      const [enriched] = await fetchProductsBySkus([eanProduct.sku]).catch(() => []);
      const finalEan = enriched ?? eanProduct;
      return buildResult(
        "match", 100, slimProduct(finalEan), [],
        `Produkt nalezen přesnou shodou EAN kódu.`,
        "ean", preprocessed.reformulated, true,
      );
    }

    // ── Layer 2: Code Lookup + AI Checker ────────────────
    // tryCodeLookup internally runs the checker — returns null if checker rejects
    const codeProduct = await tryCodeLookup(
      allCodes, item.name, item.unit, item.quantity,
      onDebug, position,
    );
    if (codeProduct) {
      onDebug?.({ position, step: "code_match", data: { sku: codeProduct.sku, name: codeProduct.name } });
      const [enriched] = await fetchProductsBySkus([codeProduct.sku]).catch(() => []);
      const finalCode = enriched ?? codeProduct;
      return buildResult(
        "match", 98, slimProduct(finalCode), [],
        `Produkt nalezen přesnou shodou kódu produktu, ověřeno checkerem.`,
        "code", preprocessed.reformulated, true,
      );
    }

    // ── Layer 3/4: ReAct Agent ────────────────────────────
    const manufacturerFilter = groupContext?.preferredManufacturer ?? null;
    const lineFilter = groupContext?.preferredLine ?? null;
    const requestedLevel = prefsToStockLevel(preferences);
    const effectiveLevel = stockLevelOverride ?? requestedLevel;
    const stockOpts = stockLevelToOpts(effectiveLevel, preferences?.branchFilter);
    const stockCtx: StockContext = {
      requestedLevel,
      effectiveLevel,
      fallbackUsed: effectiveLevel !== requestedLevel,
    };

    onDebug?.({
      position, step: "stock_level",
      data: { requestedLevel, effectiveLevel, fallbackUsed: stockCtx.fallbackUsed },
    });

    const agentResult = await runReactAgent(
      item.name, item.unit, item.quantity,
      preprocessed, manufacturerFilter, lineFilter,
      onDebug, position, undefined, stockOpts,
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
    const toCheckerProduct = (p: ProductResult): ProductForChecker => ({
      sku: p.sku, name: p.name,
      description: p.description ?? null,
      category_main: p.category_main, category_sub: p.category_sub, category_line: p.category_line,
      supplier_name: p.supplier_name,
    });
    const selectedInfo: ProductForChecker | null = selectedProduct ? toCheckerProduct(selectedProduct) : null;
    const alternativeInfos: ProductForChecker[] = agentResult.alternativeSkus.flatMap((sku) => {
      const p = productMap.get(sku);
      return p ? [toCheckerProduct(p)] : [];
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
          "semantic", preprocessed.reformulated, false, stockCtx,
        );
      }

      // Selected FAILED checker — user picks from good alternatives, NEVER auto-pick
      if (okAlternatives.length > 0) {
        return buildResult(
          "multiple", 0, null,
          okAlternatives.map(slimProduct),
          `Checker vyřadil původní výběr (${checkerResult.selectedReason}). Zbývá ${okAlternatives.length} technicky správný kandidát(ů) — uživatel vybírá.`,
          "semantic", preprocessed.reformulated, false, stockCtx,
        );
      }

      // ALL candidates (selected + alternatives) failed checker — RETRY once
      onDebug?.({ position, step: "retry", data: { reason: checkerResult.selectedReason } });

      const retryResult = await runReactAgent(
        item.name, item.unit, item.quantity,
        preprocessed, manufacturerFilter, lineFilter,
        onDebug, position,
        `Vybraný produkt "${selectedInfo?.name ?? "?"}" byl zamítnut: ${checkerResult.selectedReason}. Všechny alternativy byly také špatné.`,
        stockOpts,
      );

      const retrySkus = [
        ...(retryResult.selectedSku ? [retryResult.selectedSku] : []),
        ...retryResult.alternativeSkus,
      ].filter((s, i, arr) => arr.indexOf(s) === i);

      const retryProducts = retrySkus.length > 0 ? await fetchProductsBySkus(retrySkus) : [];
      const retryMap = new Map(retryProducts.map((p) => [p.sku, p]));

      const retrySelected = retryResult.selectedSku ? retryMap.get(retryResult.selectedSku) ?? null : null;
      const retrySelectedInfo: ProductForChecker | null = retrySelected ? toCheckerProduct(retrySelected) : null;
      const retryAlts: ProductForChecker[] = retryResult.alternativeSkus
        .map((sku) => retryMap.get(sku))
        .filter((p): p is ProductResult => p != null)
        .map(toCheckerProduct);

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
            "semantic", preprocessed.reformulated, false, stockCtx,
          );
        }

        // Retry selected failed but alternatives OK — user picks, no auto-pick
        if (retryOk.length > 0) {
          return buildResult(
            "multiple", 0, null,
            retryOk.map(slimProduct),
            `(retry) Checker vyřadil výběr, zbývá ${retryOk.length} technicky správný kandidát(ů) — uživatel vybírá.`,
            "semantic", preprocessed.reformulated, false, stockCtx,
          );
        }
      }

      // Retry also fully failed — not_found
      return buildResult(
        "not_found", 0, null, [],
        `Agent ani po opakovaném pokusu nenašel technicky správný produkt.`,
        "not_found", preprocessed.reformulated, false, stockCtx,
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
      preprocessed.reformulated, false, stockCtx,
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
