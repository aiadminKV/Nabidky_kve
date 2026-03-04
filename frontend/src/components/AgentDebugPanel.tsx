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
};

const TYPE_LABELS: Record<string, string> = {
  prompt: "PROMPT",
  tool_call: "TOOL CALL",
  tool_result: "TOOL RESULT",
  raw_output: "RAW OUTPUT",
  parsed_actions: "ACTIONS",
  error: "ERROR",
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
    <div className="flex flex-col bg-[#0d1117] border-t border-[#30363d] font-mono text-xs">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <span className="text-green-400 font-bold text-[11px] tracking-wider">
            AGENT DEBUG
          </span>
          <span className="text-[#484f58] text-[10px]">
            {entries.length} events
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClear}
            className="px-2 py-0.5 text-[10px] text-[#8b949e] hover:text-white hover:bg-[#30363d] rounded transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto overflow-x-hidden px-3 py-2 space-y-1"
        style={{ maxHeight: "320px", minHeight: "160px" }}
      >
        {entries.length === 0 && (
          <div className="text-[#484f58] text-center py-6 select-none">
            Waiting for agent activity...
          </div>
        )}

        {entries.map((entry, idx) => {
          const isCollapsed = collapsed.has(idx);
          const color = TYPE_COLORS[entry.type] ?? "text-green-400";
          const label = TYPE_LABELS[entry.type] ?? entry.type.toUpperCase();
          const formatted = formatData(entry.data);
          const isLong = formatted.length > 200;
          const toolTag = entry.tool ? ` [${entry.tool}]` : "";

          return (
            <div key={idx} className="group">
              <div
                className="flex items-start gap-2 cursor-pointer hover:bg-[#161b22] rounded px-1 py-0.5"
                onClick={() => isLong && toggleCollapse(idx)}
              >
                <span className="text-[#484f58] whitespace-nowrap shrink-0">
                  {formatTs(entry.ts)}
                </span>
                <span className={`font-bold whitespace-nowrap shrink-0 ${color}`}>
                  {label}{toolTag}
                </span>
                {isLong && (
                  <span className="text-[#484f58] shrink-0 select-none">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                )}
              </div>
              {(!isLong || !isCollapsed) && (
                <pre className="text-green-400/80 whitespace-pre-wrap break-all pl-[72px] leading-relaxed">
                  {formatted}
                </pre>
              )}
              {isLong && isCollapsed && (
                <div className="text-[#484f58] pl-[72px] truncate">
                  {formatted.slice(0, 120)}...
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
