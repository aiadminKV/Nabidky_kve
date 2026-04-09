"use client";

import type { MatchType } from "@/lib/types";

const CONFIG: Record<MatchType | "processing", {
  label: string;
  dotColor: string;
  bgColor: string;
  borderColor: string;
  textColor: string;
}> = {
  match: {
    label: "Shoda",
    dotColor: "bg-emerald-600",
    bgColor: "bg-emerald-100",
    borderColor: "border-emerald-200",
    textColor: "text-emerald-800",
  },
  uncertain: {
    label: "Nejistá",
    dotColor: "bg-amber-600",
    bgColor: "bg-amber-100",
    borderColor: "border-amber-200",
    textColor: "text-amber-800",
  },
  multiple: {
    label: "Možnosti",
    dotColor: "bg-blue-600",
    bgColor: "bg-blue-100",
    borderColor: "border-blue-200",
    textColor: "text-blue-800",
  },
  alternative: {
    label: "Alternativa",
    dotColor: "bg-violet-600",
    bgColor: "bg-violet-100",
    borderColor: "border-violet-200",
    textColor: "text-violet-800",
  },
  not_found: {
    label: "Nenalezeno",
    dotColor: "bg-rose-600",
    bgColor: "bg-rose-100",
    borderColor: "border-rose-200",
    textColor: "text-rose-800",
  },
  processing: {
    label: "Hledám…",
    dotColor: "bg-slate-500",
    bgColor: "bg-slate-100",
    borderColor: "border-slate-200",
    textColor: "text-slate-700",
  },
};

const CONFIRMED_CONFIG = {
  label: "Potvrzeno",
  dotColor: "bg-white/90",
  bgColor: "bg-emerald-600",
  borderColor: "border-emerald-700",
  textColor: "text-white",
} as const;

interface StatusBadgeProps {
  type: MatchType | "processing";
  confidence?: number;
  confirmed?: boolean;
}

export function StatusBadge({ type, confirmed = false }: StatusBadgeProps) {
  const cfg = confirmed && type === "match" ? CONFIRMED_CONFIG : CONFIG[type];

  return (
    <span className={`inline-flex min-w-[120px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold shadow-sm ${cfg.bgColor} ${cfg.borderColor} ${cfg.textColor}`}>
      {type === "processing" ? (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.dotColor} animate-pulse-subtle`} />
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.dotColor}`} />
      )}
      {cfg.label}
    </span>
  );
}
