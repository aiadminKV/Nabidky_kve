"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { SearchPlan, SearchPlanGroup } from "@/lib/api";
import { getManufacturers } from "@/lib/api";

interface SearchPlanPanelProps {
  plan: SearchPlan;
  onApprove: (plan: SearchPlan) => void;
  onSkip: () => void;
  token: string;
}

const GROUP_COLORS = [
  "bg-blue-50 border-blue-200 text-blue-800",
  "bg-emerald-50 border-emerald-200 text-emerald-800",
  "bg-amber-50 border-amber-200 text-amber-800",
  "bg-purple-50 border-purple-200 text-purple-800",
  "bg-rose-50 border-rose-200 text-rose-800",
  "bg-cyan-50 border-cyan-200 text-cyan-800",
  "bg-orange-50 border-orange-200 text-orange-800",
  "bg-indigo-50 border-indigo-200 text-indigo-800",
];

function ManufacturerCombobox({
  value,
  onChange,
  manufacturers,
}: {
  value: string;
  onChange: (v: string) => void;
  manufacturers: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = query.trim()
    ? manufacturers.filter((m) => m.toLowerCase().includes(query.toLowerCase())).slice(0, 12)
    : manufacturers.slice(0, 12);

  return (
    <div ref={ref} className="relative">
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
        Výrobce
      </label>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (!e.target.value.trim()) onChange("");
          }}
          onFocus={() => setOpen(true)}
          placeholder="Vyberte výrobce…"
          className="w-full rounded-lg border border-white/50 bg-white/70 px-2.5 py-1.5 pr-7 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(""); setQuery(""); }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded text-kv-gray-400 hover:text-kv-gray-600"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-[180px] overflow-y-auto overflow-hidden rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150">
          {filtered.map((m) => {
            const isActive = m === value;
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onChange(m);
                  setQuery(m);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-xs transition-colors ${
                  isActive
                    ? "bg-kv-navy text-white font-medium"
                    : "text-kv-gray-700 hover:bg-kv-gray-50"
                }`}
              >
                {isActive && (
                  <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
                <span className={isActive ? "" : "pl-[18px]"}>{m}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupCard({
  group,
  groupIndex,
  items,
  manufacturers,
  onManufacturerChange,
  onLineChange,
}: {
  group: SearchPlanGroup;
  groupIndex: number;
  items: SearchPlan["enrichedItems"];
  manufacturers: string[];
  onManufacturerChange: (groupIndex: number, value: string) => void;
  onLineChange: (groupIndex: number, value: string) => void;
}) {
  const colorClass = GROUP_COLORS[groupIndex % GROUP_COLORS.length];
  const groupItems = items.filter((it) => it.groupIndex === groupIndex);

  return (
    <div className={`rounded-xl border ${colorClass} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold">{group.groupName}</span>
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold tabular-nums">
            {groupItems.length} {groupItems.length === 1 ? "položka" : groupItems.length < 5 ? "položky" : "položek"}
          </span>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <ManufacturerCombobox
          value={group.suggestedManufacturer ?? ""}
          onChange={(v) => onManufacturerChange(groupIndex, v)}
          manufacturers={manufacturers}
        />
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
            Řada / Model
          </label>
          <input
            value={group.suggestedLine ?? ""}
            onChange={(e) => onLineChange(groupIndex, e.target.value)}
            placeholder="Automaticky"
            className="w-full rounded-lg border border-white/50 bg-white/70 px-2.5 py-1.5 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
          />
        </div>
      </div>

      {group.notes && (
        <p className="mb-2 text-[11px] italic opacity-70">{group.notes}</p>
      )}

      <div className="space-y-1">
        {groupItems.map((item, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded-lg bg-white/50 px-2.5 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1 truncate text-kv-dark">{item.name}</span>
            {item.quantity != null && (
              <span className="shrink-0 tabular-nums text-kv-gray-500">
                {item.quantity} {item.unit ?? ""}
              </span>
            )}
            {item.instruction && (
              <span className="shrink-0 rounded bg-kv-navy/10 px-1.5 py-0.5 text-[10px] text-kv-navy max-w-[200px] truncate">
                {item.instruction}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SearchPlanPanel({ plan, onApprove, onSkip, token }: SearchPlanPanelProps) {
  const [editedPlan, setEditedPlan] = useState<SearchPlan>(plan);
  const [manufacturers, setManufacturers] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getManufacturers(token).then((m) => {
      if (!cancelled) setManufacturers(m);
    });
    return () => { cancelled = true; };
  }, [token]);

  const handleManufacturerChange = useCallback((groupIndex: number, value: string) => {
    setEditedPlan((prev) => {
      const groups = prev.groups.map((g, i) =>
        i === groupIndex ? { ...g, suggestedManufacturer: value || null } : g,
      );
      const enrichedItems = prev.enrichedItems.map((item) => {
        if (item.groupIndex !== groupIndex) return item;
        const grp = groups[groupIndex];
        const parts: string[] = [];
        if (grp.suggestedManufacturer) parts.push(`Preferuj výrobce: ${grp.suggestedManufacturer}`);
        if (grp.suggestedLine) parts.push(`řada: ${grp.suggestedLine}`);
        return { ...item, instruction: parts.length > 0 ? parts.join(", ") : null };
      });
      return { groups, enrichedItems };
    });
  }, []);

  const handleLineChange = useCallback((groupIndex: number, value: string) => {
    setEditedPlan((prev) => {
      const groups = prev.groups.map((g, i) =>
        i === groupIndex ? { ...g, suggestedLine: value || null } : g,
      );
      const enrichedItems = prev.enrichedItems.map((item) => {
        if (item.groupIndex !== groupIndex) return item;
        const grp = groups[groupIndex];
        const parts: string[] = [];
        if (grp.suggestedManufacturer) parts.push(`Preferuj výrobce: ${grp.suggestedManufacturer}`);
        if (grp.suggestedLine) parts.push(`řada: ${grp.suggestedLine}`);
        return { ...item, instruction: parts.length > 0 ? parts.join(", ") : null };
      });
      return { groups, enrichedItems };
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">
              Plán vyhledávání
            </h2>
            <p className="mt-1 text-xs text-kv-gray-400">
              AI seskupila položky dle kategorie. Upravte výrobce/řadu a potvrďte.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onSkip}
              className="rounded-xl border border-kv-gray-200 px-4 py-2 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
            >
              Přeskočit
            </button>
            <button
              onClick={() => onApprove(editedPlan)}
              className="rounded-xl bg-kv-red px-5 py-2 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark"
            >
              Spustit vyhledávání
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="grid gap-4 md:grid-cols-2">
          {editedPlan.groups.map((group, i) => (
            <GroupCard
              key={i}
              group={group}
              groupIndex={i}
              items={editedPlan.enrichedItems}
              manufacturers={manufacturers}
              onManufacturerChange={handleManufacturerChange}
              onLineChange={handleLineChange}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
