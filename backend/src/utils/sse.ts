import type { Context } from "hono";
import { stream } from "hono/streaming";

export type SSEEventType =
  | "chat_delta"
  | "chat_done"
  | "items_parsed"
  | "item_searching"
  | "item_matched"
  | "item_error"
  | "offer_status"
  | "error"
  | "done";

export interface SSEPayload {
  type: SSEEventType;
  data: unknown;
}

/**
 * Creates an SSE stream and returns a writer for pushing events.
 * Use with Hono's streaming API.
 */
export function createSSEStream(c: Context) {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  let streamWriter: {
    write: (event: SSEPayload) => Promise<void>;
    close: () => Promise<void>;
  };

  const response = stream(c, async (s) => {
    const encoder = new TextEncoder();

    streamWriter = {
      async write(event: SSEPayload) {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        await s.write(encoder.encode(payload));
      },
      async close() {
        await s.write(encoder.encode("data: [DONE]\n\n"));
        await s.close();
      },
    };

    // Keep the stream open until externally closed
    await new Promise<void>((resolve) => {
      streamWriter.close = async () => {
        await s.write(encoder.encode("data: [DONE]\n\n"));
        resolve();
      };
    });
  });

  return { response, getWriter: () => streamWriter! };
}

/** Helper to send a chat text delta event */
export function chatDelta(text: string): SSEPayload {
  return { type: "chat_delta", data: { text } };
}

/** Helper to send parsed items list for user validation */
export function itemsParsed(items: Array<{ name: string; quantity: number | null }>): SSEPayload {
  return { type: "items_parsed", data: { items } };
}

/** Helper to send item search status update */
export function itemSearching(position: number, name: string): SSEPayload {
  return { type: "item_searching", data: { position, name } };
}

/** Helper to send item match result */
export function itemMatched(
  position: number,
  result: {
    matchType: string;
    confidence: number;
    product: Record<string, unknown> | null;
    candidates: Array<Record<string, unknown>>;
  },
): SSEPayload {
  return { type: "item_matched", data: { position, ...result } };
}
