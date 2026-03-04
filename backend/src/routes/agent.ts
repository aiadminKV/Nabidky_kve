import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { run } from "@openai/agents";
import { authMiddleware } from "../middleware/auth.js";
import { searchAgent, semanticSearchAgent, parserAgent, createOfferAgentStreaming } from "../services/agent/index.js";
import { searchProductsFulltext, type ProductResult } from "../services/search.js";
import { fetchProductsBySkus, slim } from "./agentHelpers.js";

const SEARCH_ITEM_PROMPT = `Najdi v katalogu produkt odpovídající tomuto názvu z poptávky:

"{ITEM_NAME}"

Použij search_products a vrať JSON výsledek.`;

const agent = new Hono();

interface ParsedItem {
  name: string;
  unit: string | null;
  quantity: number | null;
}

interface AgentSearchResult {
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  selectedSku: string | null;
  candidates: string[];
  reasoning: string;
}

interface MatchResult {
  position: number;
  originalName: string;
  unit: string | null;
  quantity: number | null;
  matchType: "match" | "uncertain" | "multiple" | "alternative" | "not_found";
  confidence: number;
  product: Partial<ProductResult> | null;
  candidates: Array<Partial<ProductResult>>;
}

function sseEvent(type: string, data: unknown): string {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

/**
 * POST /agent/chat
 * Direct chat with the agent (Context B – unstructured text).
 * AI parses unstructured text into items, then returns them.
 */
agent.post("/agent/chat", authMiddleware, async (c) => {
  const { message } = await c.req.json<{ message: string }>();

  if (!message?.trim()) {
    return c.json({ error: "Message is required" }, 400);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamText(c, async (stream) => {
    try {
      await stream.write(sseEvent("status", { phase: "parsing" }));

      const parseResult = await run(parserAgent, message);
      const items: ParsedItem[] = JSON.parse(parseResult.finalOutput ?? "[]");

      await stream.write(sseEvent("items_parsed", { items }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

/**
 * POST /agent/search
 * Takes already-parsed items and searches for each one.
 * Streams results via SSE as they're found.
 */
agent.post("/agent/search", authMiddleware, async (c) => {
  const { items } = await c.req.json<{ items: ParsedItem[] }>();

  if (!items?.length) {
    return c.json({ error: "Items array is required" }, 400);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const CONCURRENCY = 30;

  return streamText(c, async (stream) => {
    try {
      await stream.write(sseEvent("status", { phase: "searching", total: items.length }));

      // Signal all items as "searching" upfront
      for (let i = 0; i < items.length; i++) {
        await stream.write(sseEvent("item_searching", { position: i, name: items[i].name }));
      }

      // Process in parallel with controlled concurrency
      let cursor = 0;
      const runNext = async (): Promise<void> => {
        const idx = cursor++;
        if (idx >= items.length) return;

        const item = items[idx];
        try {
          const matchResult = await searchAndMatch(item, idx);
          await stream.write(sseEvent("item_matched", matchResult));
        } catch {
          await stream.write(
            sseEvent("item_matched", {
              position: idx,
              originalName: item.name,
              unit: item.unit,
              quantity: item.quantity,
              matchType: "not_found",
              confidence: 0,
              product: null,
              candidates: [],
            }),
          );
        }

        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, items.length) },
        () => runNext(),
      );
      await Promise.all(workers);

      await stream.write(sseEvent("status", { phase: "review" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

/**
 * POST /agent/product-search
 * Manual single-product search for the review modal.
 */
agent.post("/agent/product-search", authMiddleware, async (c) => {
  const { query, maxResults = 10 } = await c.req.json<{
    query: string;
    maxResults?: number;
  }>();

  if (!query?.trim()) {
    return c.json({ error: "Query is required" }, 400);
  }

  try {
    const results = await searchProductsFulltext(query, maxResults);
    const slim = results.map((r) => ({
      sku: r.sku,
      name: r.name,
      manufacturer_code: r.manufacturer_code,
      manufacturer: r.manufacturer,
      category: r.category,
      unit: r.unit,
      ean: r.ean,
      name_secondary: r.name_secondary,
      price: r.price,
      subcategory: r.subcategory,
      sub_subcategory: r.sub_subcategory,
      eshop_url: r.eshop_url,
    }));
    return c.json({ results: slim });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Search failed";
    return c.json({ error: msg }, 500);
  }
});

/**
 * Search for a single product using the AI search agent.
 * The agent understands electrical terminology, reformulates queries,
 * and evaluates candidates from the DB search results.
 */
const SEMANTIC_SEARCH_PROMPT = `Najdi v katalogu alternativní produkt k tomuto názvu z poptávky:

"{ITEM_NAME}"

Fulltext vyhledávání nenašlo přesnou shodu. Použij semantic_search k nalezení alternativy a vrať JSON výsledek.`;

function parseAgentOutput(raw: string): AgentSearchResult | null {
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}


function buildMatchResult(
  item: ParsedItem,
  position: number,
  agentResult: AgentSearchResult,
  products: ProductResult[],
): MatchResult {
  const selectedProduct = agentResult.selectedSku
    ? products.find((p) => p.sku === agentResult.selectedSku)
    : null;

  return {
    position,
    originalName: item.name,
    unit: item.unit,
    quantity: item.quantity,
    matchType: agentResult.matchType ?? "not_found",
    confidence: Math.min(100, Math.max(0, agentResult.confidence ?? 0)),
    product: selectedProduct ? slim(selectedProduct) : null,
    candidates: products.slice(0, 5).map(slim),
  };
}

/**
 * Fulltext-only product search (Phase 1).
 * Semantic search is triggered separately by the user via /agent/search-semantic.
 */
async function searchAndMatch(
  item: ParsedItem,
  position: number,
): Promise<MatchResult> {
  const fulltextPrompt = SEARCH_ITEM_PROMPT.replace("{ITEM_NAME}", item.name);
  const fulltextResult = await run(searchAgent, fulltextPrompt);
  const fulltextParsed = parseAgentOutput(fulltextResult.finalOutput ?? "");

  if (!fulltextParsed || fulltextParsed.matchType === "not_found" || fulltextParsed.confidence === 0) {
    return {
      position,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: "not_found",
      confidence: 0,
      product: null,
      candidates: [],
    };
  }

  const allSkus = [...new Set([
    ...(fulltextParsed.selectedSku ? [fulltextParsed.selectedSku] : []),
    ...(fulltextParsed.candidates ?? []),
  ])];
  const products = await fetchProductsBySkus(allSkus);
  return buildMatchResult(item, position, fulltextParsed, products);
}

/**
 * Semantic-only product search (Phase 2).
 * Called on demand for items that fulltext couldn't match.
 */
async function searchAndMatchSemantic(
  item: ParsedItem,
  position: number,
): Promise<MatchResult> {
  try {
    const semanticPrompt = SEMANTIC_SEARCH_PROMPT.replace("{ITEM_NAME}", item.name);
    const semanticResult = await run(semanticSearchAgent, semanticPrompt);
    const semanticParsed = parseAgentOutput(semanticResult.finalOutput ?? "");

    if (semanticParsed && semanticParsed.matchType !== "not_found") {
      const allSkus = [...new Set([
        ...(semanticParsed.selectedSku ? [semanticParsed.selectedSku] : []),
        ...(semanticParsed.candidates ?? []),
      ])];
      const products = await fetchProductsBySkus(allSkus);
      return buildMatchResult(item, position, semanticParsed, products);
    }
  } catch {
    // Semantic search failed
  }

  return {
    position,
    originalName: item.name,
    unit: item.unit,
    quantity: item.quantity,
    matchType: "not_found",
    confidence: 0,
    product: null,
    candidates: [],
  };
}

/**
 * POST /agent/search-semantic
 * User-triggered Phase 2: semantic search for not_found items only.
 * Streams results via SSE as they're found.
 */
agent.post("/agent/search-semantic", authMiddleware, async (c) => {
  const { items } = await c.req.json<{ items: Array<ParsedItem & { position: number }> }>();

  if (!items?.length) {
    return c.json({ error: "Items array is required" }, 400);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const CONCURRENCY = 30;

  return streamText(c, async (stream) => {
    try {
      await stream.write(sseEvent("status", { phase: "searching_semantic", total: items.length }));

      for (const item of items) {
        await stream.write(sseEvent("item_searching", { position: item.position, name: item.name }));
      }

      let cursor = 0;
      const runNext = async (): Promise<void> => {
        const idx = cursor++;
        if (idx >= items.length) return;

        const item = items[idx];
        try {
          const matchResult = await searchAndMatchSemantic(item, item.position);
          await stream.write(sseEvent("item_matched", matchResult));
        } catch {
          await stream.write(
            sseEvent("item_matched", {
              position: item.position,
              originalName: item.name,
              unit: item.unit,
              quantity: item.quantity,
              matchType: "not_found",
              confidence: 0,
              product: null,
              candidates: [],
            }),
          );
        }

        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, items.length) },
        () => runNext(),
      );
      await Promise.all(workers);

      await stream.write(sseEvent("status", { phase: "review" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await stream.write(sseEvent("error", { message: msg }));
    }

    await stream.write("data: [DONE]\n\n");
  });
});

interface OfferItemSummary {
  position: number;
  name: string;
  sku: string | null;
  manufacturer: string | null;
  category: string | null;
  matchType: string;
}

function buildOfferContext(items: OfferItemSummary[]): string {
  if (items.length === 0) return "Nabídka je prázdná – žádné položky.";

  const header = "Pozice | Název | Výrobce | SKU | Stav";
  const divider = "---|---|---|---|---";
  const rows = items.map(
    (i) =>
      `${i.position} | ${i.name} | ${i.manufacturer ?? "–"} | ${i.sku ?? "–"} | ${i.matchType}`,
  );
  return `Aktuální nabídka (${items.length} položek):\n${header}\n${divider}\n${rows.join("\n")}`;
}

const ACTION_TOOL_NAMES = new Set([
  "add_item_to_offer",
  "replace_product_in_offer",
  "remove_item_from_offer",
  "parse_items_from_text",
]);

/**
 * POST /agent/offer-chat
 * Streaming offer assistant – streams text deltas and tool calls via SSE.
 * Uses gpt-5-mini with tool-call architecture.
 */
agent.post("/agent/offer-chat", authMiddleware, async (c) => {
  const { message, offerItems } = await c.req.json<{
    message: string;
    offerItems?: OfferItemSummary[];
  }>();

  if (!message?.trim()) {
    return c.json({ error: "Message is required" }, 400);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamText(c, async (stream) => {
    let streamOpen = true;

    const safeWrite = async (data: string) => {
      if (!streamOpen) return;
      try {
        await stream.write(data);
      } catch {
        streamOpen = false;
      }
    };

    try {
      await safeWrite(sseEvent("status", { phase: "thinking" }));

      const offerContext = buildOfferContext(offerItems ?? []);
      const prompt = `${offerContext}\n\n---\n\nZpráva uživatele:\n"${message}"`;

      await safeWrite(sseEvent("debug", { ts: Date.now(), type: "prompt", data: prompt }));

      const offerAgent = createOfferAgentStreaming(async (entry) => {
        if (entry.type === "action") {
          await safeWrite(sseEvent("action", entry.data));
        } else if (entry.type === "tool_activity") {
          await safeWrite(sseEvent("tool_activity", { tool: entry.tool, ...(entry.data as object) }));
        } else {
          await safeWrite(sseEvent("debug", { ts: Date.now(), ...entry }));
        }
      });

      const result = await run(offerAgent, prompt, { stream: true });

      for await (const event of result) {
        if (event.type === "raw_model_stream_event") {
          const data = event.data as Record<string, unknown>;
          if (data.type === "output_text_delta") {
            await safeWrite(sseEvent("text_delta", { delta: data.delta }));
          }
        } else if (event.type === "run_item_stream_event") {
          const evt = event as unknown as { name: string; item: { name?: string } };
          if (evt.name === "tool_called") {
            const toolName = evt.item?.name ?? "";
            if (ACTION_TOOL_NAMES.has(toolName)) {
              await safeWrite(sseEvent("debug", {
                ts: Date.now(),
                type: "tool_call",
                tool: toolName,
                data: "Action tool invoked",
              }));
            }
          }
        }
      }

      await result.completed;

      await safeWrite(sseEvent("text_done", {}));

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await safeWrite(sseEvent("debug", { ts: Date.now(), type: "error", data: msg }));
      await safeWrite(sseEvent("error", { message: msg }));
    }

    await safeWrite("data: [DONE]\n\n");
  });
});

export { agent as agentRoutes };
