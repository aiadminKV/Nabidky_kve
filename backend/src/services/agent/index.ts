import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { searchProductsFulltext, searchProductsSemantic, fetchProductsBySkus } from "../search.js";
import { generateQueryEmbedding } from "../embedding.js";

const SEARCH_TOOL_DESCRIPTION =
  "Search the KV Elektro product catalog by keywords, product name, manufacturer code, SKU, or EAN. " +
  "Returns ranked results. Always returns candidates (even approximate). " +
  "Tips: use short focused queries (3-5 keywords). Avoid long descriptive queries. " +
  "If searching for abbreviations like B3x16, also try expanded form '3P B16'.";

const searchTool = tool({
  name: "search_products",
  description: SEARCH_TOOL_DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Search query – short, focused keywords"),
    max_results: z.number().optional().default(10).describe("Max results (default 10)"),
  }),
  async execute({ query, max_results }) {
    const results = await searchProductsFulltext(query, max_results);
    return JSON.stringify(
      results.map((r) => ({
        sku: r.sku,
        name: r.name,
        manufacturer_code: r.manufacturer_code,
        manufacturer: r.manufacturer,
        category: [r.category, r.subcategory, r.sub_subcategory].filter(Boolean).join(" > "),
        unit: r.unit,
        ean: r.ean,
        relevance: Math.round((r.rank + r.similarity_score) * 100) / 100,
      })),
    );
  },
});

export const searchAgent = new Agent({
  name: "KV Search Agent",
  instructions: `Jsi vyhledávací agent pro KV Elektro – českou B2B distribuci elektroinstalačního materiálu (471 000+ položek v katalogu).

## Tvůj úkol
Dostaneš název produktu z poptávky zákazníka. Použij nástroj search_products, abys ho našel v katalogu.
Výsledek vrať VÝHRADNĚ jako JSON objekt (bez dalšího textu).

## Doménová znalost – elektrotechnika

Zákazníci používají zkratky. Před vyhledáváním je rozviň:

### Jističe
- B3x16 = 3-pólový jistič, char. B, 16A → hledej "jistič 3P B16" nebo "3P B16"
- C1x25 = 1-pólový jistič, char. C, 25A → hledej "jistič 1P C25"
- Char.: B (nízký záběr), C (střední), D (motory)

### Chrániče a kombinace
- FI 2P 25A 30mA → proudový chránič 2P 25A 30mA
- FID / RCBO → kombinovaný jistič + chránič

### Kabely
- CYKY 3x2,5 → kabel CYKY 3 žíly 2,5mm²
- CYKY-J = s ochranným vodičem, CYKY-O = bez

### Svítidla
- čtvercové/hranaté → v katalogu jako "SQ" nebo "SQUARE"
- kulaté/kruhové → v katalogu jako "ROUND" nebo "CIRCLE"
- přisazené → "PRISAZENY", zapuštěné → "ZAPUSTNE"

### Obecné
- IP44/IP65 = stupeň krytí (v katalogu jako "IP44", "IP65" – jedno slovo)
- W = watty, lm = lumeny, A = ampéry, P = póly
- Číselné parametry (watty, lumeny) nemusí být v názvu produktu

## Strategie vyhledávání

1. **První pokus**: Odstraň zbytečné číselné parametry (watty, lumeny), rozviň zkratky, hledej klíčové identifikátory
2. **Pokud málo relevantní**: Zkus alternativní termíny (české ↔ anglické, zkratka ↔ plný název)
3. **Pokud máš kód výrobce** (např. "5SL6316-7"): Hledej přímo ten kód
4. **Maximálně 3 pokusy** – neplýtvej dotazy

## Formát odpovědi

Vrať VÝHRADNĚ tento JSON (bez markdown, bez vysvětlení):
{
  "matchType": "match" | "uncertain" | "multiple" | "alternative" | "not_found",
  "confidence": 0-100,
  "selectedSku": "SKU vybraného produktu nebo null",
  "candidates": ["SKU1", "SKU2", ...],
  "reasoning": "Stručné zdůvodnění (1 věta česky)"
}

### matchType pravidla:
- **match**: Jsem si jistý, že to je správný produkt (confidence 85-100)
- **uncertain**: Pravděpodobně správný, ale ne 100% (confidence 60-84)
- **multiple**: Více rovnocenných kandidátů, uživatel musí vybrat (confidence 50-75)
- **alternative**: Není přesná shoda, ale nabízím alternativu (confidence 30-59)
- **not_found**: Nic odpovídajícího v katalogu (confidence 0)

### candidates: Vždy uveď SKU kódy top kandidátů (max 5), i když vybereme jednoho.`,
  model: "gpt-4.1-mini",
  tools: [searchTool],
});

const SEMANTIC_TOOL_DESCRIPTION =
  "Search the KV Elektro product catalog using semantic similarity (vector embeddings). " +
  "Use this to find products by meaning, not exact keywords. " +
  "Best for: finding alternatives from different manufacturers, " +
  "searching by product function/type when exact name is unknown, " +
  "or when fulltext search returned no useful results. " +
  "Query should describe what the product does or its technical characteristics.";

const semanticSearchTool = tool({
  name: "semantic_search",
  description: SEMANTIC_TOOL_DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Natural language description of the product or its function"),
    max_results: z.number().optional().default(10).describe("Max results (default 10)"),
    threshold: z.number().optional().default(0.45).describe("Minimum similarity score 0-1 (default 0.45)"),
  }),
  async execute({ query, max_results, threshold }) {
    const embedding = await generateQueryEmbedding(query);
    const results = await searchProductsSemantic(embedding, max_results, threshold);
    return JSON.stringify(
      results.map((r) => ({
        sku: r.sku,
        name: r.name,
        manufacturer_code: r.manufacturer_code,
        manufacturer: r.manufacturer,
        category: [r.category, r.subcategory, r.sub_subcategory].filter(Boolean).join(" > "),
        unit: r.unit,
        ean: r.ean,
        similarity: Math.round(r.cosine_similarity * 100) / 100,
      })),
    );
  },
});

export const semanticSearchAgent = new Agent({
  name: "KV Semantic Search Agent",
  instructions: `Jsi agent pro sémantické vyhledávání alternativních produktů v katalogu KV Elektro – české B2B distribuce elektroinstalačního materiálu (471 000+ položek).

## Tvůj úkol
Dostaneš název produktu nebo jeho technický popis. Použij nástroj semantic_search k nalezení sémanticky podobných produktů – zejména alternativ od jiných výrobců nebo ekvivalentních produktů.

## Kdy tě volají
Jsi volaný jako druhá fáze vyhledávání – poté, co fulltext search (klíčová slova) nenašel přesnou shodu. Tvým cílem je najít ALTERNATIVY, ne přesné shody.

## Strategie
1. Přeformuluj vstup do přirozeného technického popisu (ne klíčová slova, ale popis funkce/typu produktu)
2. Pokud vstup obsahuje kód výrobce, rozšiř ho o obecný popis produktu
3. Zaměř se na: typ produktu, technické parametry, oblast použití
4. Maximálně 2 pokusy s různými formulacemi

## Příklady přeformulování
- "B3x16" → "Třípólový jistič charakteristiky B s jmenovitým proudem 16A pro jištění elektrických obvodů"
- "CYKY 3x2,5" → "Silový kabel s měděnými jádry 3 žíly průřez 2,5mm² s PVC izolací"
- "XS618B1NBM12" → "Indukční snímač válcový M12 pro detekci kovových předmětů"

## Formát odpovědi
Vrať VÝHRADNĚ tento JSON (bez markdown, bez vysvětlení):
{
  "matchType": "alternative" | "not_found",
  "confidence": 0-100,
  "selectedSku": "SKU nejlepší alternativy nebo null",
  "candidates": ["SKU1", "SKU2", ...],
  "reasoning": "Stručné zdůvodnění (1 věta česky)"
}

### matchType pravidla:
- **alternative**: Nalezena sémanticky podobná alternativa (confidence 30-70)
- **not_found**: Ani sémanticky se nenašlo nic relevantního (confidence 0)

### candidates: Uveď SKU kódy top alternativ (max 5).`,
  model: "gpt-4.1-mini",
  tools: [semanticSearchTool],
});

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
  type: "debug" | "action" | "tool_activity";
  tool?: string;
  data: unknown;
}) => Promise<void> | void;

const OFFER_AGENT_INSTRUCTIONS = `Jsi autonomní asistent pro správu nabídek v systému KV Elektro – česká B2B distribuce elektroinstalačního materiálu (471 000+ položek).

## Role
Pracuješ s nabídkou SAMOSTATNĚ a PROAKTIVNĚ. Odpovídáš česky a okamžitě provádíš akce. NIKDY se neptej uživatele na potvrzení – sám vyhodnoť nejlepší variantu a rovnou ji aplikuj.

## Kontext
Dostaneš aktuální stav nabídky (tabulka s pozicemi, názvy, výrobci, SKU kódy) a zprávu uživatele.

## Klíčové pravidlo: BUĎ AUTONOMNÍ

- **NIKDY se neptej** "Chcete tento produkt?" nebo "Mám pokračovat?" – prostě to udělej.
- **Vždy vyber nejlepší shodu** z výsledků vyhledávání a rovnou ji přiřaď. Nejlepší shoda = nejvyšší relevance + odpovídající parametry (póly, ampéráž, typ, výrobce).
- **Při více kandidátech** vyber ten s nejlepší relevancí, správnou kategorií a odpovídajícími technickými parametry.
- **Pokud uživatel řekne "přidej 3x vypínače od ABB"**, vyhledej, vyber 3 nejlepší různé vypínače od ABB a přidej je. Neptej se které.
- **Po dokončení** stručně shrň co jsi udělal (jaké produkty jsi přidal/vyměnil, jejich SKU).
- **Ptej se POUZE pokud** je požadavek fundamentálně nejednoznačný (např. "přidej něco" bez jakéhokoli upřesnění).

## Doménová znalost – elektrotechnika

Zákazníci používají zkratky. Před vyhledáváním je rozviň:
- B3x16 = 3-pólový jistič, char. B, 16A → hledej "jistič 3P B16"
- C1x25 = 1-pólový jistič, char. C, 25A → hledej "jistič 1P C25"
- FI 2P 25A 30mA → proudový chránič 2P 25A 30mA
- FID / RCBO → kombinovaný jistič + chránič
- CYKY 3x2,5 → kabel CYKY 3 žíly 2,5mm²
- IP44/IP65 = stupeň krytí
- W = watty, lm = lumeny, A = ampéry, P = póly

## Nástroje

Máš 6 nástrojů. Používej je OKAMŽITĚ, nečekej na souhlas:

### Vyhledávání
- **search_products** – fulltext vyhledávání (klíčová slova, kódy, SKU). Použij \`manufacturer\` pro filtrování dle výrobce.
- **semantic_search** – sémantické vyhledávání (alternativy, jiný výrobce). Použij \`manufacturer\` pro filtrování dle výrobce.

### Akce na nabídce
- **add_item_to_offer** – přidej položku. Nejdříve vyhledej produkt přes search_products, vyber nejlepší výsledek a rovnou zavolej s jeho SKU.
- **replace_product_in_offer** – vyměň produkt na dané pozici. Vyhledej náhradu, vyber nejlepší a rovnou vyměň.
- **remove_item_from_offer** – odstraň položku z nabídky dle pozice.
- **parse_items_from_text** – parsuj seznam položek z nestrukturovaného textu/e-mailu.

## Jak pracuješ

1. **Jednej okamžitě** – jakmile pochopíš záměr, začni vyhledávat a přiřazovat. Nečekej.
2. **Vyber nejlepší produkt automaticky** – z výsledků hledání vždy vyber ten s nejlepší shodou parametrů a nejvyšší relevancí.
3. **Hromadné operace** – při "vyměň všechny jističe na Eaton" projdi nabídku, pro KAŽDÝ jistič zavolej search_products(manufacturer: "Eaton") se správnými parametry a pak replace_product_in_offer.
4. **Parsování seznamů** – při dlouhém seznamu položek (e-mail, tabulka) zavolej parse_items_from_text.
5. **Stručné shrnutí na konci** – po provedení akcí napiš krátké shrnutí co jsi udělal.
6. **Informační dotazy** – odpověz jen textem bez volání tools.

## Strategie vyhledávání
- Použij \`manufacturer\` parametr při hledání produktů konkrétního výrobce
- Při výměně výrobce: search_products s manufacturer filtrem + typ produktu
- Maximálně 3 pokusy na položku, pak označ jako nenalezené
- search_products pro přesné dotazy, semantic_search pro alternativy
- Výsledek s nejvyšší relevancí a správnými parametry = nejlepší volba`;

/**
 * Creates a streaming offer agent with debug + action callbacks.
 * Uses gpt-5-mini with minimal reasoning effort.
 * All UI actions are implemented as tools the agent calls.
 */
export function createOfferAgentStreaming(onEvent: AgentEventCallback): Agent {
  // ── Search tools (with debug + manufacturer filter) ──

  const streamingSearchTool = tool({
    name: "search_products",
    description:
      SEARCH_TOOL_DESCRIPTION +
      " Use the optional 'manufacturer' parameter to filter results by a specific manufacturer.",
    parameters: z.object({
      query: z.string().describe("Search query – short, focused keywords"),
      max_results: z.number().default(10).describe("Max results (default 10)"),
      manufacturer: z.string().nullable().default(null).describe("Filter by manufacturer name (e.g. 'Eaton', 'ABB', 'OEZ'), or null for no filter"),
    }),
    async execute({ query, max_results, manufacturer }) {
      const mfr = manufacturer ?? undefined;
      await onEvent({ type: "tool_activity", tool: "search_products", data: { status: "start", query, manufacturer: mfr } });
      await onEvent({ type: "debug", tool: "search_products", data: { query, max_results, manufacturer: mfr } });
      try {
        const results = await searchProductsFulltext(query, max_results, undefined, mfr);
        const mapped = results.map((r) => ({
          sku: r.sku,
          name: r.name,
          manufacturer_code: r.manufacturer_code,
          manufacturer: r.manufacturer,
          category: [r.category, r.subcategory, r.sub_subcategory].filter(Boolean).join(" > "),
          unit: r.unit,
          ean: r.ean,
          relevance: Math.round((r.rank + r.similarity_score) * 100) / 100,
        }));
        await onEvent({ type: "debug", tool: "search_products", data: { type: "result", count: mapped.length, top3: mapped.slice(0, 3) } });
        await onEvent({ type: "tool_activity", tool: "search_products", data: { status: "end" } });
        return JSON.stringify(mapped);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown search error";
        console.error("[search_products] Error:", msg);
        await onEvent({ type: "debug", tool: "search_products", data: { type: "error", error: msg } });
        await onEvent({ type: "tool_activity", tool: "search_products", data: { status: "end" } });
        return JSON.stringify({ error: msg, results: [] });
      }
    },
  });

  const streamingSemanticTool = tool({
    name: "semantic_search",
    description:
      SEMANTIC_TOOL_DESCRIPTION +
      " Use the optional 'manufacturer' parameter to filter results by a specific manufacturer.",
    parameters: z.object({
      query: z.string().describe("Natural language description of the product or its function"),
      max_results: z.number().default(10).describe("Max results (default 10)"),
      threshold: z.number().default(0.45).describe("Minimum similarity score 0-1 (default 0.45)"),
      manufacturer: z.string().nullable().default(null).describe("Filter by manufacturer name, or null for no filter"),
    }),
    async execute({ query, max_results, threshold, manufacturer }) {
      const mfr = manufacturer ?? undefined;
      await onEvent({ type: "tool_activity", tool: "semantic_search", data: { status: "start", query, manufacturer: mfr } });
      await onEvent({ type: "debug", tool: "semantic_search", data: { query, max_results, threshold, manufacturer: mfr } });
      try {
        const embedding = await generateQueryEmbedding(query);
        const results = await searchProductsSemantic(embedding, max_results, threshold, undefined, mfr);
        const mapped = results.map((r) => ({
          sku: r.sku,
          name: r.name,
          manufacturer_code: r.manufacturer_code,
          manufacturer: r.manufacturer,
          category: [r.category, r.subcategory, r.sub_subcategory].filter(Boolean).join(" > "),
          unit: r.unit,
          ean: r.ean,
          similarity: Math.round(r.cosine_similarity * 100) / 100,
        }));
        await onEvent({ type: "debug", tool: "semantic_search", data: { type: "result", count: mapped.length, top3: mapped.slice(0, 3) } });
        await onEvent({ type: "tool_activity", tool: "semantic_search", data: { status: "end" } });
        return JSON.stringify(mapped);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown search error";
        console.error("[semantic_search] Error:", msg);
        await onEvent({ type: "debug", tool: "semantic_search", data: { type: "error", error: msg } });
        await onEvent({ type: "tool_activity", tool: "semantic_search", data: { status: "end" } });
        return JSON.stringify({ error: msg, results: [] });
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
        await onEvent({
          type: "action",
          data: { type: "add_item", name, quantity, selectedSku, product },
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
        await onEvent({
          type: "action",
          data: { type: "replace_product", position, selectedSku, reasoning, product },
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

  return new Agent({
    name: "KV Offer Assistant",
    instructions: OFFER_AGENT_INSTRUCTIONS,
    model: "gpt-5-mini",
    modelSettings: {
      reasoning: { effort: "low" },
    },
    tools: [
      streamingSearchTool,
      streamingSemanticTool,
      addItemTool,
      replaceProductTool,
      removeItemTool,
      parseItemsTool,
    ],
  });
}
