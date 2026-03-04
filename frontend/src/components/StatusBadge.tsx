"use client";

import type { MatchType } from "@/lib/types";

const CONFIG: Record<MatchType | "processing", {
  label: string;
  dotColor: string;
  bgColor: string;
  textColor: string;
}> = {
  match: {
    label: "Shoda",
    dotColor: "bg-status-match",
    bgColor: "bg-status-match-bg",
    textColor: "text-status-match",
  },
  uncertain: {
    label: "Nejistá",
    dotColor: "bg-status-uncertain",
    bgColor: "bg-status-uncertain-bg",
    textColor: "text-status-uncertain",
  },
  multiple: {
    label: "Více možností",
    dotColor: "bg-status-multiple",
    bgColor: "bg-status-multiple-bg",
    textColor: "text-status-multiple",
  },
  alternative: {
    label: "Alternativa",
    dotColor: "bg-status-alternative",
    bgColor: "bg-status-alternative-bg",
    textColor: "text-status-alternative",
  },
  not_found: {
    label: "Nenalezeno",
    dotColor: "bg-status-not-found",
    bgColor: "bg-status-not-found-bg",
    textColor: "text-status-not-found",
  },
  processing: {
    label: "Hledám…",
    dotColor: "bg-status-processing",
    bgColor: "bg-status-processing-bg",
    textColor: "text-status-processing",
  },
};

interface StatusBadgeProps {
  type: MatchType | "processing";
  confidence?: number;
}

export function StatusBadge({ type, confidence }: StatusBadgeProps) {
  const cfg = CONFIG[type];

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.bgColor} ${cfg.textColor}`}>
      {type === "processing" ? (
        <span className={`h-2 w-2 rounded-full ${cfg.dotColor} animate-pulse-subtle`} />
      ) : (
        <span className={`h-2 w-2 rounded-full ${cfg.dotColor}`} />
      )}
      {cfg.label}
      {confidence != null && confidence > 0 && type !== "processing" && (
        <span className="opacity-70">{confidence}%</span>
      )}
    </span>
  );
}
