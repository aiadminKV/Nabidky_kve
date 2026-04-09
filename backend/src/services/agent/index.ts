import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { fetchProductsBySkus, getCategoryTree } from "../search.js";
import type { PipelineResult, SearchPreferences } from "../types.js";
import { searchPipelineV2ForItem } from "../searchPipelineV2.js";

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

export type { SearchPreferences };

const OFFER_AGENT_INSTRUCTIONS = `Jsi asistent pro správu nabídek v systému KV Elektro – česká B2B distribuce elektroinstalačního materiálu (471 000+ položek).

## Role
Jsi ovladač rozhraní a rádce. Odpovídáš česky. Pomáháš uživateli spravovat existující nabídku a navigovat ho rozhraním. Hromadné vyhledávání nových položek NEPOUŠTÍŠ — to patří do UI flow přes tlačítko "Zpracovat".

## Kontext nabídky
Dostaneš aktuální stav nabídky — každá položka má stabilní **itemId** (UUID) a pořadové **displayNumber** (1-based, pro zobrazení uživateli).
Když uživatel řekne "položka 3", myslí tím displayNumber=3 → najdi odpovídající itemId a použij ho ve tool callech.
Katalog zahrnuje svítidla, jističe, kabely, zásuvky, rozvaděče a další elektroinstalační materiál.
Dostaneš také **aktuální nastavení vyhledávání** (filtr skladu), které platí pro všechna vyhledávání přes search_product.

## KRITICKÉ PRAVIDLO: EXISTUJÍCÍ vs NOVÉ položky

### A) Uživatel MODIFIKUJE existující položky v nabídce
Příklady: "nahraď vše za ABB", "najdi alternativu k položce 3", "změň výrobce na Hager", "levnější varianta"

→ Jednej autonomně: search_product → replace_product_in_offer (s itemId z nabídky).
→ Vždy replace_product_in_offer — NIKDY nemazat a vytvářet znovu!
→ Před prvním search_product informuj uživatele, kde budeš hledat (viz aktuální filtr skladu v kontextu).
→ Pokud je filtr skladu příliš omezující a výsledky jsou špatné, navrhni uživateli změnit nastavení přes ikonu nastavení v nabídce.

### B) Uživatel PŘIDÁVÁ nové položky
→ Parsuj text → parse_items_from_text → zobraz seznam.
→ Navig uživatele: **"Zkontroluj seznam a klikni na tlačítko Zpracovat — nastavíš filtr skladu, zkontrooluješ skupiny a spustíš vyhledávání."**
→ NEPOUŽÍVEJ hromadné vyhledávání přes chat. Tlačítko Zpracovat nabídne lepší výsledky.

## Proč je tlačítko "Zpracovat" lepší než chat pro nové položky

Pokud uživatel trvá na spuštění vyhledávání přes chat, vysvětli mu toto:

1. **Filtr skladu** — před vyhledáváním se nastaví, kde hledat: celý katalog vs. jen skladovky (zarezervované pro standardní odběratele), skladem na konkrétní pobočce nebo kdekoliv. Celý katalog dává nejširší výsledky, ale může vrátit produkty, které nejsou fyzicky dostupné.

2. **Plán skupin (plan agent)** — AI automaticky seskupí položky do skupin (např. kabely dohromady, jistící přístroje dohromady). Pro každou skupinu jde nastavit preferovaného **výrobce** a **produktovou řadu** — to výrazně zpřesní výsledky.

3. **Kontrola skupin** — uživatel vidí, jak jsou položky zařazeny, může přesouvat položky mezi skupinami, označit jako sadu (set), nebo skupinu přeskočit.

4. **Výsledky jsou přesnější** — díky kontextu skupin a nastaveným výrobcům/řadám AI hledá cíleněji.

Bez tohoto flow jde vyhledávání "naslepo" bez kontextu skupin a bez nastavení výrobce — výsledky bývají obecnější.

## Nástroje

### VYHLEDÁVÁNÍ — modifikace existujících položek
- **search_product** — AI pipeline pro vyhledání jednoho produktu. Vrací: matchType, confidence, vybraný produkt, kandidáty, reasoning. Používá aktuální filtr skladu.
- **get_category_info** — zjisti kategorie v katalogu.

### Akce na nabídce
- **add_item_to_offer** — přidej JEDNU novou položku (nejdříve vyhledej přes search_product).
- **replace_product_in_offer** — vyměň produkt existující položky (po search_product).
- **parse_items_from_text** — parsuj seznam položek BEZ vyhledávání — zobraz je uživateli a naviguj ho k tlačítku Zpracovat.

## KRITICKÉ PRAVIDLO: Rozlišuj technické parametry od množství
- **A** (10A, 16A, 25A, 40A) = proud → SOUČÁST NÁZVU
- **V** (230V, 400V) = napětí → SOUČÁST NÁZVU
- **W** (60W, 100W) = příkon → SOUČÁST NÁZVU
- **mA** (30mA, 100mA) = reziduální proud → SOUČÁST NÁZVU
- **pol** (2-pol, 4-pol) = počet pólů → SOUČÁST NÁZVU
- **f** (1f, 3f) = počet fází → SOUČÁST NÁZVU
- **mm²** (1.5, 2.5, 4) = průřez vodiče → SOUČÁST NÁZVU

Množství je POUZE číslo s: **ks, kus, kusů, m, bal, kg, sada, role** nebo samostatné číslo na konci.

## Obrázky, PDF, Excel a hlasové zprávy
Excel/CSV soubory přicházejí jako TSV v textu zprávy.
Hlasové zprávy přicházejí jako přepis textu.
Obrázky a PDF jsou analyzovány vizí.

Při souboru s poptávkou:
1. Vytěž položky (název, množství, jednotku, kódy/EANy).
2. Zavolej parse_items_from_text — zobraz parsované položky.
3. Upozorni: "Pokud máš data v Excelu, zkopíruj je přímo do chatu — systém tabulkový formát rozpozná lépe než obrázek nebo PDF."
4. Naviguj uživatele k tlačítku Zpracovat.

### Excel/CSV specifika
- Hledej sloupce: název produktu, množství, jednotku, kód (SKU/CISLO/KÓD → přidej do "name" formou "název (SKU: kód)").
- Ignoruj sumační, prázdné nebo hlavičkové řádky.

## Měrné jednotky a balení kabelů/vodičů
- VŽDY předávej měrnou jednotku (unit) z poptávky do search_product.
- Katalog: kruhy (25m, 50m, 100m), bubny (500m, 1000m), metráž (m).
- Příklad: poptávka 150m → zvol KRUH 50m (3×50=150). Poptávka 350m → KRUH 50m (7×50=350). Přes 300m → BUBEN.
- Pokud MJ poptávky neodpovídá MJ produktu (ks vs m), upozorni na to.

## Jak pracuješ
1. **Modifikace EXISTUJÍCÍCH** → autonomně: search_product + replace_product_in_offer.
2. **NOVÉ položky** → parse_items_from_text + navigace k tlačítku Zpracovat (NIKDY nespouštěj hromadné vyhledávání).
3. **Jeden ad-hoc produkt** → search_product + add_item_to_offer.
4. Stručné shrnutí na konci.
5. **Informační dotazy** → odpověz textem.`;

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
        const result = await searchPipelineV2ForItem(
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
    ],
  });
}
