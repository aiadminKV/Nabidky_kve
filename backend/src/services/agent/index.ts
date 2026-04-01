import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { fetchProductsBySkus, getCategoryTree } from "../search.js";
import { searchPipelineForItem, type PipelineResult, type SearchPreferences } from "../searchPipeline.js";
import { generateSessionId, buildBatchSummaryEntry } from "../searchLogger.js";

export const parserAgent = new Agent({
  name: "Inquiry Parser",
  instructions: `Jsi agent pro extrakci strukturovaných dat z textu poptávek pro KV Elektro – B2B distributora elektroinstalačního materiálu.

Tvůj úkol: Parsuj vstupní text a vrať JSON pole položek.
Formát každé položky: {"name": string, "quantity": number | null, "unit": string | null}
Vrať POUZE JSON pole, bez vysvětlování.

## Formáty vstupu
- Prostý text nebo číslované seznamy
- TSV/CSV zkopírované z Excelu (tabulátor nebo středník jako oddělovač)
- Smíšené formáty s různými jednotkami (ks, m, bal, kus, kusů)
- Množství může být před i za názvem produktu ("5x jistič" nebo "jistič 5 ks")

## KRITICKÉ PRAVIDLO: Rozlišuj technické parametry od množství

Elektrotechnické produkty obsahují čísla, která jsou SOUČÁSTÍ NÁZVU/SPECIFIKACE, NE množstvím:
- **A** (ampéry): 10A, 16A, 25A, 40A, 63A → parametr produktu (jmenovitý proud)
- **V** (volty): 230V, 400V → parametr produktu (napětí)
- **W** (watty): 60W, 100W → parametr produktu (příkon)
- **mA** (miliampéry): 30mA, 100mA → parametr produktu (reziduální proud)
- **pol** (póly): 2-pol, 4-pol, 3-pol → parametr produktu (počet pólů)
- **f** (fáze): 1f, 3f → parametr produktu (počet fází)
- **mm²**: 1.5, 2.5, 4, 6 → parametr produktu (průřez vodiče)
- **IP** + číslo: IP44, IP65 → parametr produktu (krytí)

Množství je POUZE číslo s jednotkou množství: **ks, kus, kusů, m, metr, bal, balení, kg, sada, set, role**
Nebo samostatné číslo na konci řádku / za tabulátorem bez technické jednotky.

## Elektrotechnické zkratky – zachovej je přesně jak jsou
Zákazníci používají zkratky jako B3x16, FI 2P 30mA, CYKY 3x2,5 – tyto zkratky NEROZPISUJ, zachovej je v poli "name" přesně jak jsou zapsány. Vyhledávací agent je rozepíše sám.

## Příklady

Vstup:
  Jistič B3x16 - 5ks
  Kabel CYKY 3x2,5 - 100m
  FI 2P 25A 30mA	3

Výstup:
[
  {"name": "Jistič B3x16", "quantity": 5, "unit": "ks"},
  {"name": "Kabel CYKY 3x2,5", "quantity": 100, "unit": "m"},
  {"name": "FI 2P 25A 30mA", "quantity": 3, "unit": null}
]

Vstup:
  Jističochranic 10A  12ks
  Přepěťová ochrana B+C 4-pol  24ks
  Vypínač 3f 40A 24ks
  Proudový chránič 40A 4-pol 25ks
  Jistič 3f 16A 48ks

Výstup:
[
  {"name": "Jističochranic 10A", "quantity": 12, "unit": "ks"},
  {"name": "Přepěťová ochrana B+C 4-pol", "quantity": 24, "unit": "ks"},
  {"name": "Vypínač 3f 40A", "quantity": 24, "unit": "ks"},
  {"name": "Proudový chránič 40A 4-pol", "quantity": 25, "unit": "ks"},
  {"name": "Jistič 3f 16A", "quantity": 48, "unit": "ks"}
]`,
  model: "gpt-5.4-mini",
  tools: [],
});

// ──────────────────────────────────────────────────────────
// Offer Agent – streaming tool-call architecture
// ──────────────────────────────────────────────────────────

export type AgentEventCallback = (entry: {
  type: "debug" | "action" | "tool_activity" | "item_searching" | "item_matched" | "status";
  tool?: string;
  data: unknown;
}) => Promise<void> | void;

const OFFER_AGENT_INSTRUCTIONS = `Jsi autonomní asistent pro správu nabídek v systému KV Elektro – česká B2B distribuce elektroinstalačního materiálu (471 000+ položek).

## Role
Pracuješ s nabídkou SAMOSTATNĚ a PROAKTIVNĚ. Odpovídáš česky a okamžitě provádíš akce.
NIKDY se neptej uživatele na potvrzení – sám vyhodnoť nejlepší variantu a rovnou ji aplikuj.

## Kontext
Dostaneš aktuální stav nabídky — každá položka má stabilní **itemId** (UUID) a pořadové **displayNumber** (1-based, pro zobrazení uživateli).
Když uživatel řekne "položka 3", myslí tím displayNumber=3 → najdi odpovídající itemId a použij ho ve tool callech.
Katalog zahrnuje svítidla, jističe, kabely, zásuvky, rozvaděče a další elektroinstalační materiál.

## KRITICKÉ PRAVIDLO: EXISTUJÍCÍ vs NOVÉ položky

Uživatel se PRIMÁRNĚ odkazuje na položky, které UŽ JSOU v nabídce (vidí je v tabulce).
Rozlišuj dva zásadně odlišné scénáře:

### A) Uživatel MODIFIKUJE existující položky v nabídce
Příklady: "nahraď vše za ABB", "najdi alternativu k položce 3", "změň výrobce na Hager",
"zkus najít levnější varianty", "přehoď na jiný typ"

→ Pro KAŽDOU dotčenou položku: search_product (s instrukcí) → replace_product_in_offer (s itemId z nabídky)
→ NIKDY nemazat + vytvářet znovu! Vždy replace_product_in_offer na dané položce.
→ NIKDY nepoužívat process_items — ten je JEN pro nové položky z externího vstupu.

### B) Uživatel PŘIDÁVÁ nové položky z externího vstupu
Příklady: "zpracuj tento mail", "přidej tyto položky", vložený seznam z Excelu,
text poptávky, "založ mi: jistič B16, kabel CYKY 3x2,5..."

→ Použij process_items — deleguje celý balík na search pipeline.

PRAVIDLO: Pokud nabídka už obsahuje položky a uživatel nemluví o přidávání nových,
vždy pracuj s EXISTUJÍCÍMI pozicemi. Neutvářej duplicity.

## Klíčové pravidlo: BUĎ AUTONOMNÍ
- NIKDY se neptej "Chcete tento produkt?" — prostě to udělej.
- Vždy vyber nejlepší shodu z výsledků a rovnou ji přiřaď.
- Při více kandidátech vyber s nejlepší relevancí a technickými parametry.
- Po dokončení stručně shrň co jsi udělal.
- Ptej se POUZE pokud je požadavek fundamentálně nejednoznačný.

## Nástroje

### HROMADNÉ ZPRACOVÁNÍ — NOVÉ položky z externího vstupu
- **process_items** — Deleguje seznam NOVÝCH položek na search pipeline.
  Vytvoří položky v nabídce a pro KAŽDOU automaticky spustí AI vyhledávání (paralelně).
  Ke každé položce můžeš přidat instrukci (např. "hledej od ABB").
  Použij POUZE pro NOVÉ položky z externího vstupu (mail, tabulka, výpis, seznam).
  NIKDY nepoužívej pro modifikaci existujících položek v nabídce!

### VYHLEDÁVÁNÍ (pro modifikaci existujících položek nebo ad-hoc dotazy)
- **search_product** — AI pipeline pro vyhledání jednoho produktu.
  Použij pro: hledání alternativy k existující položce, nahrazení výrobce,
  ad-hoc dotaz v chatu. Vrací: matchType, confidence, vybraný produkt, kandidáty, reasoning.
- **get_category_info** — zjisti kategorie a výrobce v katalogu.

### Akce na nabídce
- **add_item_to_offer** — přidej JEDNU novou položku (nejdříve vyhledej SKU).
  Parametr afterItemId = itemId položky, ZA kterou se má vložit (ze summary). Null = na konec.
- **replace_product_in_offer** — vyměň produkt existující položky.
  Parametr itemId = stabilní UUID položky ze summary.
  Použij po search_product pro nahrazení produktu na dané položce.
- **parse_items_from_text** — pouze parsuj seznam položek BEZ vyhledávání.
  Použij jen když uživatel výslovně říká "jen je vypiš" nebo "neprohledávej".

## KRITICKÉ PRAVIDLO: Rozlišuj technické parametry od množství
Při extrakci položek z textu NIKDY nezaměňuj technické specifikace produktu za množství:
- **A** (10A, 16A, 25A, 40A) = jmenovitý proud → SOUČÁST NÁZVU
- **V** (230V, 400V) = napětí → SOUČÁST NÁZVU
- **W** (60W, 100W) = příkon → SOUČÁST NÁZVU
- **mA** (30mA, 100mA) = reziduální proud → SOUČÁST NÁZVU
- **pol** (2-pol, 4-pol) = počet pólů → SOUČÁST NÁZVU
- **f** (1f, 3f) = počet fází → SOUČÁST NÁZVU
- **mm²** (1.5, 2.5, 4) = průřez vodiče → SOUČÁST NÁZVU

Množství je POUZE číslo s: **ks, kus, kusů, m, bal, kg, sada, role** nebo samostatné číslo na konci.
Příklad: "Jistič 3f 16A 48ks" → name: "Jistič 3f 16A", quantity: 48, unit: "ks"

## Obrázky, PDF, Excel a hlasové zprávy
Umíš analyzovat obrázky (fotky poptávek, tabulky, screenshoty) a PDF soubory přiložené k zprávě.
Excel/CSV soubory jsou automaticky rozparsovány a obsah ti přijde jako TSV tabulka v textu zprávy.
Hlasové zprávy jsou automaticky přepisovány do textu a přepis ti přijde v textu zprávy.

Pokud uživatel přiloží soubor (obrázek, PDF, Excel) nebo hlasovou zprávu s poptávkou/objednávkou:
1. Přečti a vytěž všechny položky (názvy produktů, množství, jednotky).
2. Pokud obrázek/PDF obsahuje tabulku se sloupcem pro objednací kód nebo číslo (např. "Objednací č.", "Kód", "SKU", "Art.č.", "Obj.č.", EAN):
   - Tento kód přidej do pole "name" ve formátu "název (SKU: kód)" — stejně jako u Excelu.
   - Příklad: "ABB PRAKTIK zás.1x šedá (SKU: 5518-2929S)", qty: 10, unit: "ks"
   - Kód bude použit pro přesné vyhledání produktu v katalogu (nejvyšší priorita).
3. Zavolej parse_items_from_text — pouze zobraz parsované položky, NESPOUŠTĚJ vyhledávání.
4. Zeptej se uživatele co dál: "Mám spustit vyhledávání?" nebo podobně.
5. Teprve po potvrzení uživatele zavolej process_items.
6. Pokud je obsah nečitelný nebo nejednoznačný, popiš co vidíš/čteš a zeptej se na upřesnění.

VÝJIMKA z pravidla "jednej okamžitě": při přiložení souboru/obrázku VŽDY čekej na pokyn uživatele před spuštěním vyhledávání.

### Hlasové zprávy
- Přepis hlasové zprávy přichází jako text v uvozovkách.
- Uživatel může mluvit neformálně, s překlepy nebo hovorově — extrahuj záměr a položky co nejlépe.
- Pokud je přepis nejednoznačný, zeptej se na upřesnění.

### Excel/CSV specifika
- Data z Excelu přicházejí jako TSV (tabulátory oddělené hodnoty) s hlavičkami.
- Sloupce mohou mít různé názvy — hledej sloupce obsahující název produktu, množství, jednotku, kód.
- Sloupce jako "CISLO", "SKU", "KÓD" = kód produktu; "NAZEV", "NÁZEV" = název; "MJ", "JEDNOTKA" = jednotka; "MNOŽSTVÍ", "KS", "POČET" = množství.
- Pokud je v tabulce sloupec s kódem produktu (SKU), použij ho v poli "name" formou "název (SKU: kód)".
- Ignoruj řádky, které jsou zjevně sumační, prázdné nebo hlavičkové.

## Měrné jednotky a balení kabelů/vodičů
- VŽDY předávej měrnou jednotku (unit) z poptávky do process_items / search_product.
- Katalog obsahuje kabely v různých baleních: kruhy (25m, 50m, 100m), bubny (500m, 1000m), metráž (m).
- Při poptávce kabelů/vodičů v metrech zvol variantu, jejíž násobky sedí na poptávané množství:
  - Poptávka "CYKY 3x1,5 350m" → zvol kruh 50m (7×50=350), NE buben 500m.
  - Poptávka "CYKY 3x2,5 100m" → zvol kruh 100m (1×100=100).
  - Poptávka "CYKY 3x1,5 80m" → zvol kruh 100m nebo 2×50m — vyber ekonomičtější variantu.
- Pokud MJ poptávky neodpovídá MJ produktu (např. "ks" vs "m"), upozorni na to ve shrnutí.

## Jak pracuješ
1. Jednej okamžitě — jakmile pochopíš záměr, začni.
2. NOVÉ položky z externího vstupu → process_items.
3. Modifikace EXISTUJÍCÍCH položek → search_product + replace_product_in_offer pro každou položku (identifikuj přes itemId).
4. Jednotlivý ad-hoc dotaz → search_product + add_item_to_offer.
5. Stručné shrnutí na konci — napiš co jsi udělal. Pokud u některých položek nesedí MJ, upozorni na to.
6. Informační dotazy — odpověz jen textem.`;

/**
 * Creates a streaming offer agent with debug + action callbacks.
 * Uses gpt-5-mini with minimal reasoning effort.
 * All UI actions are implemented as tools the agent calls.
 */
export function createOfferAgentStreaming(onEvent: AgentEventCallback, searchPreferences?: SearchPreferences): Agent {
  const searchResultCache = new Map<string, PipelineResult>();

  // ── Search tool (delegates to AI pipeline) ──

  const streamingSearchProductTool = tool({
    name: "search_product",
    description:
      "Search for a product in the KV Elektro catalog using the AI search pipeline. " +
      "The pipeline automatically reformulates the query, runs dual semantic + fulltext search, " +
      "merges results, and evaluates with AI. " +
      "Returns: matchType, confidence (0-100), selected product, up to 5 candidates, and reasoning. " +
      "You do NOT need to iterate or reformulate — the pipeline does it for you.",
    parameters: z.object({
      query: z.string().describe("Product name or description to search for"),
      unit: z.string().nullable().default(null).describe("Demand unit (ks, m, bal…) for unit-aware matching"),
      quantity: z.number().nullable().default(null).describe("Demand quantity for packaging optimization"),
    }),
    async execute({ query, unit, quantity }) {
      await onEvent({ type: "tool_activity", tool: "search_product", data: { status: "start", query } });
      await onEvent({ type: "debug", tool: "search_product", data: { query, unit, quantity } });
      try {
        const result = await searchPipelineForItem(
          { name: query, unit, quantity },
          0,
          (entry) => {
            void Promise.resolve(onEvent({ type: "debug", tool: "search_product", data: entry })).catch(() => {});
          },
          searchPreferences,
        );
        await onEvent({
          type: "debug",
          tool: "search_product",
          data: {
            type: "result",
            matchType: result.matchType,
            confidence: result.confidence,
            selectedSku: result.product?.sku ?? null,
            candidateCount: result.candidates.length,
            pipelineMs: result.pipelineMs,
          },
        });
        await onEvent({ type: "tool_activity", tool: "search_product", data: { status: "end" } });

        if (result.product?.sku) {
          searchResultCache.set(result.product.sku, result);
        }

        return JSON.stringify({
          matchType: result.matchType,
          confidence: result.confidence,
          selectedSku: result.product?.sku ?? null,
          selectedProduct: result.product
            ? {
                sku: result.product.sku,
                name: result.product.name,
                supplier_name: result.product.supplier_name,
                category_main: result.product.category_main,
                category_sub: result.product.category_sub,
                unit: result.product.unit,
                current_price: result.product.current_price,
              }
            : null,
          candidates: result.candidates.map((c) => ({
            sku: c.sku,
            name: c.name,
            supplier_name: c.supplier_name,
            category_main: c.category_main,
          })),
          reasoning: result.reasoning,
          reformulatedQuery: result.reformulatedQuery,
          pipelineMs: result.pipelineMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Search failed";
        console.error("[search_product] Error:", msg);
        await onEvent({ type: "debug", tool: "search_product", data: { type: "error", error: msg } });
        await onEvent({ type: "tool_activity", tool: "search_product", data: { status: "end" } });
        return JSON.stringify({ error: msg, matchType: "not_found", confidence: 0 });
      }
    },
  });

  const streamingCategoryInfoTool = tool({
    name: "get_category_info",
    description:
      "Get the product category tree. Returns hierarchical categories (code, name, level, parent). " +
      "Use this to discover category codes for filtering searches.",
    parameters: z.object({
      category: z.string().nullable().default(null).describe("Unused, kept for backward compat"),
    }),
    async execute() {
      await onEvent({ type: "tool_activity", tool: "get_category_info", data: { status: "start" } });
      try {
        const tree = await getCategoryTree();
        await onEvent({ type: "debug", tool: "get_category_info", data: { type: "result", count: tree.length } });
        await onEvent({ type: "tool_activity", tool: "get_category_info", data: { status: "end" } });
        return JSON.stringify(tree);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[get_category_info] Error:", msg);
        await onEvent({ type: "tool_activity", tool: "get_category_info", data: { status: "end" } });
        return JSON.stringify({ error: msg });
      }
    },
  });

  // ── Action tools (streamed to frontend as side effects) ──

  const addItemTool = tool({
    name: "add_item_to_offer",
    description:
      "Add a product to the offer. Call search_products FIRST to find the SKU, then call this tool with the result. " +
      "If no product was found, pass selectedSku as null. " +
      "Use afterItemId to insert after a specific item (e.g. 'přidej za položku X' → afterItemId: '<itemId of X>').",
    parameters: z.object({
      name: z.string().describe("Product name as entered by the user"),
      quantity: z.number().nullable().describe("Quantity (null if not specified)"),
      selectedSku: z.string().nullable().describe("SKU from search_products result, or null if not found"),
      afterItemId: z.string().nullable().optional().describe("Insert after item with this ID (from offer summary). Null = append at end."),
    }),
    async execute({ name, quantity, selectedSku, afterItemId }) {
      await onEvent({ type: "tool_activity", tool: "add_item_to_offer", data: { status: "start", name } });
      try {
        let product = null;
        if (selectedSku) {
          const products = await fetchProductsBySkus([selectedSku]);
          product = products[0] ?? null;
        }

        const cached = selectedSku ? searchResultCache.get(selectedSku) : undefined;
        const candidates = cached?.candidates ?? [];
        const matchType = cached?.matchType ?? (product ? "match" : "not_found");
        const confidence = cached?.confidence ?? (product ? 85 : 0);
        const reasoning = cached?.reasoning ?? undefined;

        await onEvent({
          type: "action",
          data: {
            type: "add_item", name, quantity, selectedSku, product,
            candidates, matchType, confidence, reasoning,
            afterItemId: afterItemId ?? null,
          },
        });
        await onEvent({ type: "tool_activity", tool: "add_item_to_offer", data: { status: "end" } });
        return product
          ? `Položka "${product.name}" (SKU: ${product.sku}) přidána do nabídky.`
          : `Položka "${name}" přidána bez přiřazeného produktu.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[add_item_to_offer] Error:", msg);
        await onEvent({ type: "tool_activity", tool: "add_item_to_offer", data: { status: "end" } });
        return `Chyba při přidávání položky "${name}": ${msg}`;
      }
    },
  });

  const replaceProductTool = tool({
    name: "replace_product_in_offer",
    description:
      "Replace the product of a specific item in the offer with a different product. " +
      "Call search_products FIRST to find the replacement SKU. " +
      "Use the itemId from the offer summary to identify which item to replace.",
    parameters: z.object({
      itemId: z.string().describe("Stable item ID (UUID) of the item to replace — from the offer summary"),
      selectedSku: z.string().describe("SKU of the replacement product from search results"),
      reasoning: z.string().describe("Brief reason for the replacement (in Czech)"),
    }),
    async execute({ itemId, selectedSku, reasoning }) {
      await onEvent({ type: "tool_activity", tool: "replace_product_in_offer", data: { status: "start" } });
      try {
        let product = null;
        const products = await fetchProductsBySkus([selectedSku]);
        product = products[0] ?? null;

        const cached = searchResultCache.get(selectedSku);
        const candidates = cached?.candidates ?? [];
        const matchType = cached?.matchType ?? (product ? "match" : "not_found");
        const confidence = cached?.confidence ?? (product ? 100 : 0);

        await onEvent({
          type: "action",
          data: {
            type: "replace_product", itemId, selectedSku, reasoning, product,
            candidates, matchType, confidence,
          },
        });
        await onEvent({ type: "tool_activity", tool: "replace_product_in_offer", data: { status: "end" } });
        return product
          ? `Položka ${itemId} vyměněna na "${product.name}" (${product.sku}).`
          : `Produkt se SKU "${selectedSku}" nebyl nalezen v katalogu.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[replace_product_in_offer] Error:", msg);
        await onEvent({ type: "tool_activity", tool: "replace_product_in_offer", data: { status: "end" } });
        return `Chyba při záměně produktu: ${msg}`;
      }
    },
  });

  const parseItemsTool = tool({
    name: "parse_items_from_text",
    description:
      "Parse a list of product items from unstructured text (email, pasted list, etc.). " +
      "Extract product names and quantities. Use this for lists of 4+ items.",
    parameters: z.object({
      items: z.array(z.object({
        name: z.string().describe("Product name exactly as written"),
        quantity: z.number().nullable().describe("Quantity or null"),
      })).describe("Extracted items"),
    }),
    async execute({ items }) {
      await onEvent({ type: "tool_activity", tool: "parse_items_from_text", data: { status: "start", count: items.length } });
      await onEvent({
        type: "action",
        data: { type: "parse_items", items },
      });
      await onEvent({ type: "tool_activity", tool: "parse_items_from_text", data: { status: "end" } });
      return `Parsováno ${items.length} položek a odesláno ke zpracování.`;
    },
  });

  // ── Batch delegation tool ──

  const BATCH_CONCURRENCY = 30;

  const processItemsTool = tool({
    name: "process_items",
    description:
      "Deleguj seznam položek ke zpracování — vytvoří položky v nabídce a AUTOMATICKY pro každou spustí AI search pipeline. " +
      "Výsledky se streamují průběžně. Použij pro seznamy 2+ položek (mail, seznam, poptávka). " +
      "NEMUSÍŠ volat search_product ani add_item_to_offer — pipeline vše vyřeší. " +
      "Vrací shrnutí výsledků.",
    parameters: z.object({
      items: z.array(z.object({
        name: z.string().describe("Product name exactly as written"),
        quantity: z.number().nullable().describe("Quantity or null"),
        unit: z.string().nullable().describe("Unit (ks, m, etc.) or null"),
        instruction: z.string().nullable().describe("Optional extra context for this item search (e.g. 'hledej od ABB', 'jde o kabel')"),
      })).describe("Items to process"),
    }),
    async execute({ items }) {
      await onEvent({ type: "tool_activity", tool: "process_items", data: { status: "start", count: items.length } });

      await onEvent({
        type: "action",
        data: {
          type: "process_items",
          items: items.map((it) => ({
            name: it.name,
            quantity: it.quantity,
            unit: it.unit,
          })),
        },
      });

      const sessionId = generateSessionId();
      const batchT0 = Date.now();
      const matchResults: PipelineResult[] = [];

      for (let i = 0; i < items.length; i++) {
        void Promise.resolve(
          onEvent({ type: "item_searching", data: { position: i, name: items[i].name } }),
        ).catch(() => {});
      }

      let cursor = 0;
      const runNext = async (): Promise<void> => {
        const idx = cursor++;
        if (idx >= items.length) return;

        const item = items[idx];
        try {
          const result = await searchPipelineForItem(
            { name: item.name, unit: item.unit, quantity: item.quantity, instruction: item.instruction },
            idx,
            (entry) => {
              void Promise.resolve(
                onEvent({ type: "debug", tool: "process_items", data: entry }),
              ).catch(() => {});
            },
            searchPreferences,
          );
          matchResults.push(result);
          void Promise.resolve(
            onEvent({ type: "item_matched", data: result }),
          ).catch(() => {});
        } catch {
          const failResult: PipelineResult = {
            position: idx,
            originalName: item.name,
            unit: item.unit,
            quantity: item.quantity,
            matchType: "not_found",
            confidence: 0,
            product: null,
            candidates: [],
            reasoning: "Pipeline unexpectedly failed.",
            priceNote: null,
            reformulatedQuery: "",
            pipelineMs: 0,
            exactLookupAttempted: false,
            exactLookupFound: false,
          };
          matchResults.push(failResult);
          void Promise.resolve(
            onEvent({ type: "item_matched", data: failResult }),
          ).catch(() => {});
        }

        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(BATCH_CONCURRENCY, items.length) },
        () => runNext(),
      );
      await Promise.all(workers);

      void Promise.resolve(
        onEvent({ type: "debug", tool: "process_items", data: buildBatchSummaryEntry(sessionId, items.length, matchResults, Date.now() - batchT0) }),
      ).catch(() => {});

      void Promise.resolve(
        onEvent({ type: "status", data: { phase: "review" } }),
      ).catch(() => {});

      await onEvent({ type: "tool_activity", tool: "process_items", data: { status: "end" } });

      const matched = matchResults.filter((r) => r.matchType === "match" || r.matchType === "uncertain" || r.matchType === "multiple").length;
      const notFound = matchResults.filter((r) => r.matchType === "not_found").length;
      const alternative = matchResults.filter((r) => r.matchType === "alternative").length;
      const totalMs = Date.now() - batchT0;

      return `Zpracováno ${items.length} položek (${totalMs}ms). Nalezeno: ${matched}, alternativa: ${alternative}, nenalezeno: ${notFound}.`;
    },
  });

  return new Agent({
    name: "KV Offer Assistant",
    instructions: OFFER_AGENT_INSTRUCTIONS,
    model: "gpt-5.4",
    modelSettings: {
      reasoning: { effort: "low" },
    },
    tools: [
      streamingSearchProductTool,
      streamingCategoryInfoTool,
      addItemTool,
      replaceProductTool,
      parseItemsTool,
      processItemsTool,
    ],
  });
}
