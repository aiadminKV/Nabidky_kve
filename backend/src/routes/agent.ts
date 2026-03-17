import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { run, user } from "@openai/agents";
import { authMiddleware } from "../middleware/auth.js";
import { parserAgent, createOfferAgentStreaming } from "../services/agent/index.js";
import { searchProductsFulltext } from "../services/search.js";
import { searchPipelineForItem, type PipelineResult, type PipelineDebugFn } from "../services/searchPipeline.js";
import { buildBatchSummaryEntry, generateSessionId } from "../services/searchLogger.js";
import { parseExcelForChat, parseCsvForChat, spreadsheetToText } from "../services/excelChat.js";
import { transcribeAudio } from "../services/audioTranscribe.js";
import { extractTextFromImage } from "../services/imageOcr.js";

const agent = new Hono();

interface ParsedItem {
  name: string;
  unit: string | null;
  quantity: number | null;
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
    const sessionId = generateSessionId();
    const batchT0 = Date.now();
    const matchResults: PipelineResult[] = [];

    const makePipelineDebug = (): PipelineDebugFn => {
      return ({ position, step, data }) => {
        stream
          .write(
            sseEvent("debug", {
              ts: Date.now(),
              type: "search_trace",
              data: { event: step, position, ...(data as object) },
            }),
          )
          .catch(() => {});
      };
    };

    try {
      await stream.write(sseEvent("status", { phase: "searching", total: items.length }));
      stream
        .write(
          sseEvent("debug", {
            ts: Date.now(),
            type: "search_trace",
            data: { event: "batch_start", sessionId, totalItems: items.length, mode: "pipeline" },
          }),
        )
        .catch(() => {});

      for (let i = 0; i < items.length; i++) {
        await stream.write(sseEvent("item_searching", { position: i, name: items[i].name }));
      }

      let cursor = 0;
      const onDebug = makePipelineDebug();

      const runNext = async (): Promise<void> => {
        const idx = cursor++;
        if (idx >= items.length) return;

        const item = items[idx];
        try {
          const result = await searchPipelineForItem(item, idx, onDebug);
          matchResults.push(result);
          await stream.write(sseEvent("item_matched", result));
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
          await stream.write(sseEvent("item_matched", failResult));
        }

        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, items.length) },
        () => runNext(),
      );
      await Promise.all(workers);

      stream
        .write(
          sseEvent("debug", buildBatchSummaryEntry(sessionId, items.length, matchResults, Date.now() - batchT0)),
        )
        .catch(() => {});
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
      id: r.id,
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

// Old agent-based search functions removed.
// Batch search now uses the deterministic pipeline (searchPipelineForItem)
// which handles reformulation, dual semantic search, merge, AI evaluation,
// and refinement in a single pass per item.

/**
 * POST /agent/search-semantic
 * Re-runs the full search pipeline for not_found items (backward compat).
 * The pipeline already includes semantic search, so this is equivalent to /agent/search.
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
    const sessionId = generateSessionId();
    const batchT0 = Date.now();
    const matchResults: PipelineResult[] = [];

    const onDebug: PipelineDebugFn = ({ position, step, data }) => {
      stream
        .write(
          sseEvent("debug", {
            ts: Date.now(),
            type: "search_trace",
            data: { event: step, position, ...(data as object) },
          }),
        )
        .catch(() => {});
    };

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
          const result = await searchPipelineForItem(item, item.position, onDebug);
          matchResults.push(result);
          await stream.write(sseEvent("item_matched", result));
        } catch {
          const failResult: PipelineResult = {
            position: item.position,
            originalName: item.name,
            unit: item.unit,
            quantity: item.quantity,
            matchType: "not_found",
            confidence: 0,
            product: null,
            candidates: [],
            reasoning: "Pipeline failed.",
            reformulatedQuery: "",
            pipelineMs: 0,
          };
          matchResults.push(failResult);
          await stream.write(sseEvent("item_matched", failResult));
        }

        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(CONCURRENCY, items.length) },
        () => runNext(),
      );
      await Promise.all(workers);

      stream
        .write(
          sseEvent("debug", buildBatchSummaryEntry(sessionId, items.length, matchResults, Date.now() - batchT0)),
        )
        .catch(() => {});
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

interface FileAttachmentInput {
  type: "image" | "pdf" | "excel" | "audio";
  filename: string;
  mimeType: string;
  base64: string;
}

const ACTION_TOOL_NAMES = new Set([
  "add_item_to_offer",
  "replace_product_in_offer",
  "parse_items_from_text",
  "process_items",
  "update_offer_header",
]);

/**
 * POST /agent/offer-chat
 * Streaming offer assistant – streams text deltas and tool calls via SSE.
 * Uses gpt-5-mini with tool-call architecture.
 */
agent.post("/agent/offer-chat", authMiddleware, async (c) => {
  const { message, offerItems, files } = await c.req.json<{
    message: string;
    offerItems?: OfferItemSummary[];
    files?: FileAttachmentInput[];
  }>();

  if (!message?.trim() && !files?.length) {
    return c.json({ error: "Message or files required" }, 400);
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
      const promptText = `${offerContext}\n\n---\n\nZpráva uživatele:\n"${message}"`;

      await safeWrite(sseEvent("debug", { ts: Date.now(), type: "prompt", data: promptText }));

      const offerAgent = createOfferAgentStreaming(async (entry) => {
        if (entry.type === "action") {
          await safeWrite(sseEvent("action", entry.data));
        } else if (entry.type === "tool_activity") {
          await safeWrite(sseEvent("tool_activity", { tool: entry.tool, ...(entry.data as object) }));
        } else if (entry.type === "item_searching") {
          await safeWrite(sseEvent("item_searching", entry.data));
        } else if (entry.type === "item_matched") {
          await safeWrite(sseEvent("item_matched", entry.data));
        } else if (entry.type === "status") {
          await safeWrite(sseEvent("status", entry.data));
        } else {
          await safeWrite(sseEvent("debug", { ts: Date.now(), ...entry }));
        }
      });

      // Pre-process Excel/CSV files into text, keep images/PDFs as multimodal parts
      type ContentPart =
        | { type: "input_text"; text: string }
        | { type: "input_image"; image: string; detail?: string }
        | { type: "input_file"; file: string; filename: string };

      const textParts: string[] = [];
      const multimodalFiles: FileAttachmentInput[] = [];

      if (files?.length) {
        for (const f of files) {
          if (f.type === "excel") {
            try {
              const isCsv = f.mimeType === "text/csv" || f.mimeType === "application/csv"
                || f.filename.toLowerCase().endsWith(".csv");
              const sheets = isCsv
                ? parseCsvForChat(f.base64)
                : await parseExcelForChat(f.base64);
              textParts.push(spreadsheetToText(sheets, f.filename));
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Parse error";
              textParts.push(`Chyba při čtení souboru "${f.filename}": ${msg}`);
            }
          } else if (f.type === "audio") {
            try {
              await safeWrite(sseEvent("status", { phase: "transcribing" }));
              const transcript = await transcribeAudio(f.base64, f.mimeType, f.filename);
              textParts.push(`Přepis hlasové zprávy "${f.filename}":\n"${transcript}"`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Transcription error";
              textParts.push(`Chyba při přepisu hlasové zprávy "${f.filename}": ${msg}`);
            }
          } else if (f.type === "image") {
            try {
              await safeWrite(sseEvent("status", { phase: "reading_image" }));
              const extracted = await extractTextFromImage(f.base64, f.mimeType);
              textParts.push(`Obsah obrázku "${f.filename}":\n${extracted}`);
            } catch {
              multimodalFiles.push(f);
            }
          } else {
            multimodalFiles.push(f);
          }
        }
      }

      if (textParts.length > 0) {
        await safeWrite(sseEvent("status", { phase: "thinking" }));
      }

      const fullPrompt = textParts.length > 0
        ? `${promptText}\n\n---\n\n${textParts.join("\n\n---\n\n")}`
        : promptText;

      let agentInput: string | ReturnType<typeof user>[];

      if (multimodalFiles.length > 0) {
        const parts: ContentPart[] = [{ type: "input_text", text: fullPrompt }];
        for (const f of multimodalFiles) {
          if (f.type === "image") {
            parts.push({
              type: "input_image",
              image: `data:${f.mimeType};base64,${f.base64}`,
              detail: "auto",
            });
          } else {
            parts.push({
              type: "input_file",
              file: `data:${f.mimeType};base64,${f.base64}`,
              filename: f.filename,
            });
          }
        }
        agentInput = [user(parts)];
      } else {
        agentInput = fullPrompt;
      }

      const result = await run(offerAgent, agentInput, { stream: true, maxTurns: Infinity });

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
