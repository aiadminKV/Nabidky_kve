"use client";

import { useEffect, useRef, useState } from "react";
import type { DebugEntry } from "@/lib/types";

interface AgentDebugPanelProps {
  entries: DebugEntry[];
  onClear: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  prompt: "text-cyan-400",
  tool_call: "text-yellow-300",
  tool_result: "text-lime-400",
  raw_output: "text-emerald-300",
  parsed_actions: "text-blue-400",
  error: "text-red-400",
  search_trace: "text-violet-400",
};

const TYPE_LABELS: Record<string, string> = {
  prompt: "PROMPT",
  tool_call: "TOOL CALL",
  tool_result: "TOOL RESULT",
  raw_output: "RAW OUTPUT",
  parsed_actions: "ACTIONS",
  error: "ERROR",
  search_trace: "SEARCH",
};

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function AgentDebugPanel({ entries, onClear }: AgentDebugPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const toggleCollapse = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="shrink-0 mx-3 mb-2">
      {/* Toggle bar - always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center justify-between px-3 py-2 bg-[#1f2937] transition-colors hover:bg-[#283548] ${
          expanded ? "rounded-t-lg" : "rounded-lg"
        }`}
      >
        <div className="flex items-center gap-2">
          <svg
            className={`h-3 w-3 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
            Raw JSON Output
          </span>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <span className="text-[9px] font-mono text-emerald-500/70">
              {entries.length} events
            </span>
          )}
          {expanded && entries.length > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="px-1.5 py-0.5 text-[9px] text-slate-500 hover:text-white hover:bg-slate-600 rounded transition-colors uppercase tracking-wider font-bold cursor-pointer"
            >
              Clear
            </span>
          )}
        </div>
      </button>

      {/* Content - only when expanded */}
      {expanded && (
        <div className="bg-[#111827] rounded-b-lg overflow-hidden shadow-inner border-t border-slate-800">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="overflow-y-auto overflow-x-hidden p-3 space-y-1 dark-scrollbar"
            style={{ maxHeight: "220px" }}
          >
            {entries.length === 0 && (
              <pre className="text-emerald-500/60 font-mono text-[11px] whitespace-pre select-none text-center py-4">
                Awaiting agent activity...
              </pre>
            )}

            {entries.map((entry, idx) => {
              const isCollapsed = collapsed.has(idx);
              const color = TYPE_COLORS[entry.type] ?? "text-emerald-400";
              const label = TYPE_LABELS[entry.type] ?? entry.type.toUpperCase();
              const formatted = formatData(entry.data);
              const isLong = formatted.length > 200;
              const toolTag = entry.tool ? ` [${entry.tool}]` : "";

              return (
                <div key={idx} className="group font-mono text-[11px]">
                  <div
                    className="flex items-start gap-2 cursor-pointer hover:bg-white/5 rounded px-1 py-0.5"
                    onClick={() => isLong && toggleCollapse(idx)}
                  >
                    <span className="text-slate-600 whitespace-nowrap shrink-0">
                      {formatTs(entry.ts)}
                    </span>
                    <span className={`font-bold whitespace-nowrap shrink-0 ${color}`}>
                      {label}{toolTag}
                    </span>
                    {isLong && (
                      <span className="text-slate-600 shrink-0 select-none">
                        {isCollapsed ? "▶" : "▼"}
                      </span>
                    )}
                  </div>
                  {(!isLong || !isCollapsed) && (
                    <pre className="text-emerald-500/80 whitespace-pre-wrap break-all pl-[72px] leading-relaxed">
                      {formatted}
                    </pre>
                  )}
                  {isLong && isCollapsed && (
                    <div className="text-slate-600 pl-[72px] truncate">
                      {formatted.slice(0, 120)}...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
