import type { RunItem } from "@openai/agents";
import crypto from "crypto";

export interface DebugEntry {
  ts: number;
  type: "prompt" | "tool_call" | "tool_result" | "raw_output" | "parsed_actions" | "error" | "search_trace";
  tool?: string;
  data: unknown;
}

interface ToolCallSummary {
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string;
}

export function generateSessionId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function summarizeToolOutput(output: unknown): string {
  const raw = typeof output === "string" ? output : JSON.stringify(output);
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    if (parsed && typeof parsed === "object") {
      if ("results" in parsed && Array.isArray(parsed.results)) {
        const count = parsed.results.length;
        const hasMore = parsed.has_more ?? false;
        const elapsed = parsed.elapsed_ms ?? "?";
        const top = parsed.results.slice(0, 2).map((r: Record<string, unknown>) => r.name ?? r.sku ?? "?");
        return `${count} results (${elapsed}ms)${hasMore ? " +more" : ""} top: [${top.join(", ")}]`;
      }
      if ("error" in parsed) return `ERROR: ${parsed.error}`;
      if (Array.isArray(parsed)) {
        return `${parsed.length} results`;
      }
    }
  } catch { /* fall through */ }
  return raw.length > 120 ? raw.slice(0, 120) + "..." : raw;
}

function extractToolCalls(newItems: RunItem[]): ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  const outputByCallId = new Map<string, unknown>();

  for (const item of newItems) {
    if (item.type === "tool_call_output_item") {
      const raw = item.rawItem;
      if (raw && "callId" in raw && typeof raw.callId === "string") {
        outputByCallId.set(raw.callId, (item as { output: unknown }).output);
      }
    }
  }

  for (const item of newItems) {
    if (item.type === "tool_call_item") {
      const raw = item.rawItem;
      if (raw && "type" in raw && raw.type === "function_call") {
        const callId = (raw as { callId: string }).callId;
        const name = (raw as { name: string }).name;
        const argsStr = (raw as { arguments: string }).arguments;
        const args = safeParseJson(argsStr) as Record<string, unknown>;
        const output = outputByCallId.get(callId);
        calls.push({
          tool: name,
          args,
          resultPreview: summarizeToolOutput(output),
        });
      }
    }
  }

  return calls;
}

export function extractSearchTrace(
  itemName: string,
  position: number,
  newItems: RunItem[],
  decision: { matchType: string; confidence: number; selectedSku: string | null; reasoning?: string } | null,
  totalMs: number,
): DebugEntry[] {
  const entries: DebugEntry[] = [];
  const ts = Date.now();
  const toolCalls = extractToolCalls(newItems);

  entries.push({
    ts,
    type: "search_trace",
    data: {
      event: "start",
      position,
      itemName,
      toolCalls: toolCalls.length,
    },
  });

  for (const tc of toolCalls) {
    entries.push({
      ts,
      type: "tool_call",
      tool: tc.tool,
      data: {
        position,
        itemName,
        args: tc.args,
        result: tc.resultPreview,
      },
    });
  }

  entries.push({
    ts,
    type: "search_trace",
    data: {
      event: "done",
      position,
      itemName,
      totalMs,
      toolCalls: toolCalls.length,
      decision: decision ?? { matchType: "not_found", confidence: 0 },
    },
  });

  return entries;
}

export function buildBatchSummaryEntry(
  sessionId: string,
  totalItems: number,
  results: Array<{ matchType: string }>,
  totalMs: number,
): DebugEntry {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.matchType] = (counts[r.matchType] ?? 0) + 1;
  }
  return {
    ts: Date.now(),
    type: "search_trace",
    data: {
      event: "batch_done",
      sessionId,
      totalItems,
      totalMs,
      counts,
    },
  };
}
