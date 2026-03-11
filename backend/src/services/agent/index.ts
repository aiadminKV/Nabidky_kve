import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { fetchProductsBySkus, getCategoryInfo } from "../search.js";
import { searchPipelineForItem, type PipelineResult } from "../searchPipeline.js";
import { generateSessionId, buildBatchSummaryEntry } from "../searchLogger.js";

export const parserAgent = new Agent({
  name: "Inquiry Parser",
  instructions: `Jsi agent pro extrakci strukturovaných dat z textu poptávek pro KV Elektro – B2B distributora elektroinstalačního materiálu.

Tvůj úkol: Parsuj vstupní text a vrať JSON pole položek.
Formát každé položky: {"name": string, "quantity": number | null}
Vrať POUZE JSON pole, bez vysvětlování.

## Formáty vstupu
- Prostý text nebo číslované seznamy
- TSV/CSV zkopírované z Excelu (tabulátor nebo středník jako oddělovač)
- Smíšené formáty s různými jednotkami (ks, m, bal, kus, kusů)
- Množství může být před i za názvem produktu ("5x jistič" nebo "jistič 5 ks")

## Elektrotechnické zkratky – zachovej je přesně jak jsou
Zákazníci používají zkratky jako B3x16, FI 2P 30mA, CYKY 3x2,5 – tyto zkratky NEROZPISUJ, zachovej je v poli "name" přesně jak jsou zapsány. Vyhledávací agent je rozepíše sám.

## Příklady
Vstup:
  Jistič B3x16 - 5ks
  Kabel CYKY 3x2,5 - 100m
  FI 2P 25A 30mA	3

Výstup:
[
  {"name": "Jistič B3x16", "quantity": 5},
  {"name": "Kabel CYKY 3x2,5", "quantity": 100},
  {"name": "FI 2P 25A 30mA", "quantity": 3}
]`,
  model: "gpt-4.1-mini",
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
Dostaneš aktuální stav nabídky (tabulka s pozicemi, názvy, výrobci, SKU kódy) a zprávu uživatele.
Katalog zahrnuje svítidla, jističe, kabely, zásuvky, rozvaděče a další elektroinstalační materiál.

## KRITICKÉ PRAVIDLO: EXISTUJÍCÍ vs NOVÉ položky

Uživatel se PRIMÁRNĚ odkazuje na položky, které UŽ JSOU v nabídce (vidí je v tabulce).
Rozlišuj dva zásadně odlišné scénáře:

### A) Uživatel MODIFIKUJE existující položky v nabídce
Příklady: "nahraď vše za ABB", "najdi alternativu k položce 3", "změň výrobce na Hager",
"zkus najít levnější varianty", "přehoď na jiný typ"

→ Pro KAŽDOU dotčenou pozici: search_product (s instrukcí) → replace_product_in_offer
→ NIKDY nemazat + vytvářet znovu! Vždy replace_product_in_offer na dané pozici.
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
- **replace_product_in_offer** — vyměň produkt na existující pozici.
  Použij po search_product pro nahrazení produktu na dané pozici.
- **remove_item_from_offer** — odstraň položku z nabídky.
- **parse_items_from_text** — pouze parsuj seznam položek BEZ vyhledávání.
  Použij jen když uživatel výslovně říká "jen je vypiš" nebo "neprohledávej".

### Hlavička nabídky
- **update_offer_header** — vyplň nebo aktualizuj údaje zákazníka (IČ, jméno, termín dodání, název zakázky, telefon, email, pobočka, adresa dodání, spec. akce). Zavolej VŽDY, když ze vstupu dokážeš vyextrahovat jakákoliv zákaznická data.

## Jak pracuješ
1. Jednej okamžitě — jakmile pochopíš záměr, začni.
2. NOVÉ položky z externího vstupu → process_items.
3. Modifikace EXISTUJÍCÍCH položek → search_product + replace_product_in_offer pro každou pozici.
4. Jednotlivý ad-hoc dotaz → search_product + add_item_to_offer.
5. Stručné shrnutí na konci — napiš co jsi udělal.
6. Informační dotazy — odpověz jen textem.
7. Pokud vstup obsahuje zákaznická data (IČ, jméno, adresa, datum...), vyplň hlavičku přes update_offer_header.
8. Pokud vstup obsahuje seznam položek I zákaznická data, zavolej OBOJÍ: update_offer_header + process_items.`;

/**
 * Creates a streaming offer agent with debug + action callbacks.
 * Uses gpt-5-mini with minimal reasoning effort.
 * All UI actions are implemented as tools the agent calls.
 */
export function createOfferAgentStreaming(onEvent: AgentEventCallback): Agent {
  // Cache last search results so add_item / replace_product can include candidates
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
    }),
    async execute({ query }) {
      await onEvent({ type: "tool_activity", tool: "search_product", data: { status: "start", query } });
      await onEvent({ type: "debug", tool: "search_product", data: { query } });
      try {
        const result = await searchPipelineForItem(
          { name: query, unit: null, quantity: null },
          0,
          (entry) => {
            void Promise.resolve(onEvent({ type: "debug", tool: "search_product", data: entry })).catch(() => {});
          },
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
                manufacturer: result.product.manufacturer,
                manufacturer_code: result.product.manufacturer_code,
                category: result.product.category,
                subcategory: result.product.subcategory,
                unit: result.product.unit,
                ean: result.product.ean,
              }
            : null,
          candidates: result.candidates.map((c) => ({
            sku: c.sku,
            name: c.name,
            manufacturer: c.manufacturer,
            category: c.category,
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
      "Get details about product categories. Without arguments: returns top-level categories with counts. " +
      "With category name: returns subcategories and top manufacturers for that category. " +
      "Use this to discover the right category/manufacturer filter before searching.",
    parameters: z.object({
      category: z.string().nullable().default(null).describe("Category name to drill into, or null for top-level list"),
    }),
    async execute({ category }) {
      const cat = category ?? undefined;
      await onEvent({ type: "tool_activity", tool: "get_category_info", data: { status: "start", category: cat } });
      try {
        const info = await getCategoryInfo(cat);
        await onEvent({ type: "debug", tool: "get_category_info", data: { type: "result", info } });
        await onEvent({ type: "tool_activity", tool: "get_category_info", data: { status: "end" } });
        return JSON.stringify(info);
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
      "If no product was found, pass selectedSku as null.",
    parameters: z.object({
      name: z.string().describe("Product name as entered by the user"),
      quantity: z.number().nullable().describe("Quantity (null if not specified)"),
      selectedSku: z.string().nullable().describe("SKU from search_products result, or null if not found"),
    }),
    async execute({ name, quantity, selectedSku }) {
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
      "Replace the product at a specific position in the offer with a different product. " +
      "Call search_products FIRST to find the replacement SKU.",
    parameters: z.object({
      position: z.number().describe("Position (0-based index) of the item to replace"),
      selectedSku: z.string().describe("SKU of the replacement product from search results"),
      reasoning: z.string().describe("Brief reason for the replacement (in Czech)"),
    }),
    async execute({ position, selectedSku, reasoning }) {
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
            type: "replace_product", position, selectedSku, reasoning, product,
            candidates, matchType, confidence,
          },
        });
        await onEvent({ type: "tool_activity", tool: "replace_product_in_offer", data: { status: "end" } });
        return product
          ? `Pozice ${position} vyměněna na "${product.name}" (${product.sku}).`
          : `Produkt se SKU "${selectedSku}" nebyl nalezen v katalogu.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[replace_product_in_offer] Error:", msg);
        await onEvent({ type: "tool_activity", tool: "replace_product_in_offer", data: { status: "end" } });
        return `Chyba při záměně produktu na pozici ${position}: ${msg}`;
      }
    },
  });

  const removeItemTool = tool({
    name: "remove_item_from_offer",
    description: "Remove an item from the offer by its position (0-based index).",
    parameters: z.object({
      position: z.number().describe("Position (0-based index) of the item to remove"),
    }),
    async execute({ position }) {
      await onEvent({ type: "tool_activity", tool: "remove_item_from_offer", data: { status: "start" } });
      await onEvent({
        type: "action",
        data: { type: "remove_item", position },
      });
      await onEvent({ type: "tool_activity", tool: "remove_item_from_offer", data: { status: "end" } });
      return `Položka na pozici ${position} odstraněna z nabídky.`;
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
            reformulatedQuery: "",
            pipelineMs: 0,
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

  const updateHeaderTool = tool({
    name: "update_offer_header",
    description:
      "Update customer/offer header fields. Only provide fields you want to change — " +
      "omitted or null fields are left unchanged. Use this to fill in customer data extracted from text input " +
      "(email, pasted order, etc.).",
    parameters: z.object({
      customerIco: z.string().nullable().default(null).describe("Customer ID / IČ"),
      customerName: z.string().nullable().default(null).describe("Customer name"),
      deliveryDate: z.string().nullable().default(null).describe("Delivery date (YYYY-MM-DD or locale format)"),
      offerName: z.string().nullable().default(null).describe("Offer name / order reference"),
      phone: z.string().nullable().default(null).describe("Contact phone number"),
      email: z.string().nullable().default(null).describe("Contact email"),
      specialAction: z.string().nullable().default(null).describe("Special action code"),
      branch: z.string().nullable().default(null).describe("Branch / pickup location"),
      deliveryAddress: z.string().nullable().default(null).describe("Delivery address"),
    }),
    async execute(fields) {
      await onEvent({ type: "tool_activity", tool: "update_offer_header", data: { status: "start" } });

      const updates: Record<string, string> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value != null && value !== "") {
          updates[key] = value;
        }
      }

      await onEvent({
        type: "action",
        data: { type: "update_header", fields: updates },
      });
      await onEvent({ type: "tool_activity", tool: "update_offer_header", data: { status: "end" } });

      const filled = Object.keys(updates);
      return filled.length > 0
        ? `Hlavička aktualizována: ${filled.join(", ")}.`
        : "Žádná pole k aktualizaci.";
    },
  });

  return new Agent({
    name: "KV Offer Assistant",
    instructions: OFFER_AGENT_INSTRUCTIONS,
    model: "gpt-5-mini",
    modelSettings: {
      reasoning: { effort: "low" },
    },
    tools: [
      streamingSearchProductTool,
      streamingCategoryInfoTool,
      addItemTool,
      replaceProductTool,
      removeItemTool,
      parseItemsTool,
      processItemsTool,
      updateHeaderTool,
    ],
  });
}
