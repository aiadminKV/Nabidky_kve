"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { SearchPlan, SearchPlanGroup, CategoryEntry } from "@/lib/api";
import { getCategories } from "@/lib/api";
import { ManufacturerCombobox } from "./ManufacturerCombobox";

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

// ── CategoryDropdown — level-1 only, used as card title ─────────────────────

function CategoryDropdown({ value, onChange, categories }: {
  value: string | null;
  onChange: (code: string | null) => void;
  categories: CategoryEntry[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const mainCategories = categories.filter((c) => c.level === 1);
  const selected = mainCategories.find((c) => c.category_code === value);

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-bold leading-tight hover:opacity-70 transition-opacity"
      >
        <span className="truncate">{selected?.category_name ?? "Vyberte kategorii…"}</span>
        <svg className="h-3.5 w-3.5 shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1.5 min-w-[260px] max-h-[280px] overflow-y-auto rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150">
          {mainCategories.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-kv-gray-400">Načítám…</div>
          ) : mainCategories.map((c) => {
            const isActive = c.category_code === value;
            return (
              <button
                key={c.category_code}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange(c.category_code); setOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors ${
                  isActive ? "bg-kv-navy text-white font-medium" : "text-kv-gray-700 hover:bg-kv-gray-50"
                }`}
              >
                {isActive ? (
                  <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                ) : <span className="h-3 w-3 shrink-0" />}
                <span className="flex-1 text-left">{c.category_name}</span>
                <span className={`tabular-nums text-[10px] shrink-0 ${isActive ? "opacity-60" : "text-kv-gray-400"}`}>
                  {c.category_code}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── GroupPicker — app-styled dropdown for selecting a target group ────────────

function GroupPicker({ groups, currentGroupIndex, value, onChange, categories }: {
  groups: SearchPlanGroup[];
  currentGroupIndex: number;
  value: string; // target group index as string, "new", or ""
  onChange: (v: string) => void;
  categories: CategoryEntry[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const otherGroups = groups
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => i !== currentGroupIndex);

  const label = value === "new"
    ? "Nová skupina"
    : value !== ""
    ? groups[parseInt(value)]?.groupName ?? ""
    : "Vyberte skupinu…";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          value ? "border-kv-navy/30 bg-kv-navy/5 text-kv-navy" : "border-kv-gray-200 bg-white text-kv-gray-500 hover:bg-kv-gray-50"
        }`}
      >
        <span>{label}</span>
        <svg className="h-3 w-3 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[220px] rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-150">
          {otherGroups.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">Existující skupiny</div>
              {otherGroups.map(({ g, i }) => {
                const catName = categories.find((c) => c.category_code === g.category)?.category_name;
                return (
                  <button key={i} type="button"
                    onClick={() => { onChange(String(i)); setOpen(false); }}
                    className={`flex w-full flex-col items-start px-3 py-1.5 text-xs transition-colors hover:bg-kv-gray-50 ${value === String(i) ? "text-kv-navy font-medium" : "text-kv-gray-700"}`}>
                    <span>{g.groupName}</span>
                    {catName && <span className="text-[10px] text-kv-gray-400">{catName}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className={`py-1 ${otherGroups.length > 0 ? "border-t border-kv-gray-100" : ""}`}>
            <button type="button"
              onClick={() => { onChange("new"); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-kv-navy/5 ${value === "new" ? "text-kv-navy" : "text-kv-navy/70"}`}>
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Nová skupina
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── GroupCard ────────────────────────────────────────────────────────────────

function GroupCard({
  group, groupIndex, allGroups, items, token, categories,
  selectedIndices, isEditing,
  onManufacturerChange, onLineChange, onCategoryChange,
  onToggleItem, onStartEdit, onCancelEdit, onMoveItems, onTreatAsSetChange,
  onSkipGroupChange, onSkipItemChange,
}: {
  group: SearchPlanGroup;
  groupIndex: number;
  allGroups: SearchPlanGroup[];
  items: SearchPlan["enrichedItems"];
  token: string;
  categories: CategoryEntry[];
  selectedIndices: Set<number>;
  isEditing: boolean;
  onManufacturerChange: (groupIndex: number, value: string) => void;
  onLineChange: (groupIndex: number, value: string) => void;
  onCategoryChange: (groupIndex: number, code: string | null) => void;
  onToggleItem: (globalIdx: number) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onMoveItems: (targetGroupIndex: number | "new", newGroupData?: { name: string; category: string | null }) => void;
  onTreatAsSetChange: (groupIndex: number, value: boolean) => void;
  onSkipGroupChange: (groupIndex: number, value: boolean) => void;
  onSkipItemChange: (globalIdx: number, value: boolean) => void;
}) {
  const colorClass = GROUP_COLORS[groupIndex % GROUP_COLORS.length];
  const groupItems = items
    .map((item, globalIdx) => ({ item, globalIdx }))
    .filter(({ item }) => item.groupIndex === groupIndex);

  const selectedInGroup = groupItems.filter(({ globalIdx }) => selectedIndices.has(globalIdx)).length;

  // Move form state (local to card)
  const [targetGroup, setTargetGroup] = useState("");
  const [newGroupCategory, setNewGroupCategory] = useState<string | null>(null);

  const resetMoveForm = () => {
    setTargetGroup("");
    setNewGroupCategory(null);
  };

  const handleConfirm = () => {
    if (targetGroup === "new") {
      // Group name = category name (or fallback if none selected)
      const catName = categories.find((c) => c.category_code === newGroupCategory)?.category_name ?? "Nová skupina";
      onMoveItems("new", { name: catName, category: newGroupCategory });
    } else if (targetGroup !== "") {
      onMoveItems(parseInt(targetGroup, 10));
    }
    resetMoveForm();
  };

  const handleCancelEdit = () => {
    resetMoveForm();
    onCancelEdit();
  };

  // Reset move form when editing mode ends
  useEffect(() => {
    if (!isEditing) resetMoveForm();
  }, [isEditing]);

  return (
    <div className={`rounded-xl border ${colorClass} ${isEditing ? "ring-2 ring-kv-navy/20" : ""} p-4 transition-shadow ${group.skip ? "opacity-60" : ""}`}>
      {/* Header — category IS the card title */}
      <div className="mb-3">
        <div className="flex items-start justify-between gap-2">
          <CategoryDropdown
            value={group.category}
            onChange={(code) => onCategoryChange(groupIndex, code)}
            categories={categories}
          />
          <div className="shrink-0">
            {isEditing ? (
              <button onClick={handleCancelEdit}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-kv-gray-500 transition-colors hover:bg-black/5">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                Zrušit
              </button>
            ) : (
              <button onClick={onStartEdit}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-kv-gray-500 transition-colors hover:bg-black/5 whitespace-nowrap">
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L16.5 3 21 7.5 7.5 21zM3 16.5h4.5V21" />
                </svg>
                Rozdělit / Přesunout položky
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold tabular-nums">
            {groupItems.length} {groupItems.length === 1 ? "položka" : groupItems.length < 5 ? "položky" : "položek"}
          </span>
          {isEditing && selectedInGroup > 0 && (
            <span className="rounded-full bg-kv-navy/15 px-2 py-0.5 text-[10px] font-semibold text-kv-navy tabular-nums">
              {selectedInGroup} vybrán{selectedInGroup === 1 ? "a" : "o"}
            </span>
          )}
        </div>
      </div>

      {/* Manufacturer + Line */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <ManufacturerCombobox
          value={group.suggestedManufacturer ?? ""}
          onChange={(v) => onManufacturerChange(groupIndex, v)}
          token={token}
          inputClassName="w-full rounded-lg border border-white/50 bg-white/70 px-2.5 py-1.5 pr-7 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
        />
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide opacity-60">Řada / Model</label>
          <input value={group.suggestedLine ?? ""} onChange={(e) => onLineChange(groupIndex, e.target.value)}
            placeholder="Automaticky"
            className="w-full rounded-lg border border-white/50 bg-white/70 px-2.5 py-1.5 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
          />
        </div>
      </div>

      {group.notes && <p className="mb-2 text-[11px] italic opacity-70">{group.notes}</p>}

      {/* Treat as set + Skip toggles */}
      <div className="mb-3 space-y-1.5">
        {/* Zpracovat jako sady — hidden when group is skipped */}
        {!group.skip && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-white/50 bg-white/60 px-3 py-2 transition-colors hover:bg-white/80">
            <div className="relative shrink-0">
              <input
                type="checkbox"
                checked={group.treatAsSet ?? false}
                onChange={(e) => onTreatAsSetChange(groupIndex, e.target.checked)}
                className="peer sr-only"
              />
              <div className={`h-4 w-7 rounded-full transition-colors ${group.treatAsSet ? "bg-violet-500" : "bg-kv-gray-300"}`} />
              <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${group.treatAsSet ? "translate-x-3.5" : "translate-x-0.5"}`} />
            </div>
            <div className="min-w-0 flex-1">
              <span className={`text-xs font-semibold ${group.treatAsSet ? "text-violet-700" : "text-kv-gray-600"}`}>
                Zpracovat jako sady
              </span>
              {group.treatAsSet && (
                <p className="text-[10px] text-violet-500 leading-tight mt-0.5">
                  Každá položka bude rozložena na strojek, kryt a rámeček
                </p>
              )}
            </div>
            {group.treatAsSet && (
              <span className="shrink-0 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
                SADA
              </span>
            )}
          </label>
        )}

        {/* Nezpracovávat skupinu */}
        <label className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
          group.skip
            ? "border-red-200 bg-red-50/80 hover:bg-red-50"
            : "border-white/50 bg-white/60 hover:bg-white/80"
        }`}>
          <div className="relative shrink-0">
            <input
              type="checkbox"
              checked={group.skip ?? false}
              onChange={(e) => onSkipGroupChange(groupIndex, e.target.checked)}
              className="peer sr-only"
            />
            <div className={`h-4 w-7 rounded-full transition-colors ${group.skip ? "bg-red-400" : "bg-kv-gray-300"}`} />
            <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${group.skip ? "translate-x-3.5" : "translate-x-0.5"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <span className={`text-xs font-semibold ${group.skip ? "text-red-600" : "text-kv-gray-600"}`}>
              Nezpracovávat skupinu
            </span>
            {group.skip && (
              <p className="text-[10px] text-red-400 leading-tight mt-0.5">
                Všechny položky budou přeskočeny
              </p>
            )}
          </div>
          {group.skip && (
            <svg className="h-3.5 w-3.5 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          )}
        </label>
      </div>

      {/* Items */}
      <div className="space-y-1">
        {groupItems.map(({ item, globalIdx }) => {
          const isSelected = selectedIndices.has(globalIdx);
          const isItemSkipped = item.skip ?? false;
          return (
            <div key={globalIdx}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                isEditing ? "" : ""
              } ${isSelected ? "bg-kv-navy/10 ring-1 ring-kv-navy/20" : "bg-white/50 hover:bg-white/80"} ${isItemSkipped ? "opacity-45" : ""}`}>
              {isEditing && (
                <input type="checkbox" checked={isSelected} onChange={() => onToggleItem(globalIdx)}
                  className="h-3.5 w-3.5 shrink-0 accent-kv-navy" />
              )}
              <span className={`min-w-0 flex-1 truncate ${isItemSkipped ? "line-through text-kv-gray-400" : "text-kv-dark"}`}>{item.name}</span>
              {item.quantity != null && (
                <span className="shrink-0 tabular-nums text-kv-gray-500">{item.quantity} {item.unit ?? ""}</span>
              )}
              {/* Per-item skip toggle — always visible */}
              {!group.skip && (
                <button
                  type="button"
                  onClick={() => onSkipItemChange(globalIdx, !isItemSkipped)}
                  title={isItemSkipped ? "Obnovit — bude vyhledáno" : "Přeskočit tuto položku"}
                  className={`ml-1 shrink-0 rounded p-0.5 transition-colors ${
                    isItemSkipped
                      ? "text-red-400 hover:bg-red-50"
                      : "text-kv-gray-300 hover:bg-kv-gray-100 hover:text-red-400"
                  }`}
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Inline move action — visible only when editing */}
      {isEditing && (
        <div className="mt-3 rounded-xl border border-kv-navy/20 bg-kv-navy/5 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-medium text-kv-navy shrink-0">
              {selectedInGroup > 0 ? `${selectedInGroup} vybraných` : "Vyberte položky"} → přesunout do:
            </span>
            <GroupPicker
              groups={allGroups}
              currentGroupIndex={groupIndex}
              value={targetGroup}
              onChange={(v) => setTargetGroup(v)}
              categories={categories}
            />
            {targetGroup !== "" && targetGroup !== "new" && selectedInGroup > 0 && (
              <button onClick={handleConfirm}
                className="rounded-lg bg-kv-navy px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kv-navy/80">
                Přesunout
              </button>
            )}
          </div>

          {/* New group form — category only, name derived from it */}
          {targetGroup === "new" && (
            <div className="mt-3 flex items-end gap-2 border-t border-kv-navy/10 pt-3">
              <div className="flex-1">
                <CategoryDropdown value={newGroupCategory} onChange={setNewGroupCategory} categories={categories} />
              </div>
              <button onClick={() => setTargetGroup("")}
                className="shrink-0 rounded-lg border border-kv-gray-200 bg-white px-3 py-1.5 text-xs text-kv-gray-500 transition-colors hover:bg-kv-gray-50">
                Zpět
              </button>
              <button onClick={handleConfirm} disabled={selectedInGroup === 0 || !newGroupCategory}
                className="shrink-0 rounded-lg bg-kv-navy px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kv-navy/80 disabled:opacity-40">
                Vytvořit a přesunout
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SearchPlanPanel ──────────────────────────────────────────────────────────

export function SearchPlanPanel({ plan, onApprove, onSkip, token }: SearchPlanPanelProps) {
  const [editedPlan, setEditedPlan] = useState<SearchPlan>(plan);
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  const [editingGroupIndex, setEditingGroupIndex] = useState<number | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getCategories(token).then((cats) => { if (!cancelled) setCategories(cats); });
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

  const handleCategoryChange = useCallback((groupIndex: number, code: string | null) => {
    setEditedPlan((prev) => ({
      ...prev,
      groups: prev.groups.map((g, i) => i === groupIndex ? { ...g, category: code } : g),
    }));
  }, []);

  const handleSkipGroupChange = useCallback((groupIndex: number, value: boolean) => {
    setEditedPlan((prev) => {
      const groups = prev.groups.map((g, i) =>
        i === groupIndex ? { ...g, skip: value, treatAsSet: value ? false : g.treatAsSet } : g,
      );
      const enrichedItems = prev.enrichedItems.map((item) => {
        if (item.groupIndex !== groupIndex) return item;
        return value
          ? { ...item, skip: true, isSet: undefined, setHint: undefined }
          : { ...item, skip: undefined };
      });
      return { groups, enrichedItems };
    });
  }, []);

  const handleSkipItemChange = useCallback((globalIdx: number, value: boolean) => {
    setEditedPlan((prev) => ({
      ...prev,
      enrichedItems: prev.enrichedItems.map((item, i) =>
        i === globalIdx
          ? { ...item, skip: value || undefined, isSet: value ? undefined : item.isSet, setHint: value ? undefined : item.setHint }
          : item,
      ),
    }));
  }, []);

  const handleTreatAsSetChange = useCallback((groupIndex: number, value: boolean) => {
    setEditedPlan((prev) => {
      const groups = prev.groups.map((g, i) =>
        i === groupIndex ? { ...g, treatAsSet: value } : g,
      );
      const group = groups[groupIndex];
      const hint = [group?.suggestedManufacturer, group?.suggestedLine].filter(Boolean).join(" ") || null;
      const enrichedItems = prev.enrichedItems.map((item) => {
        if (item.groupIndex !== groupIndex) return item;
        return value
          ? { ...item, isSet: true, setHint: hint }
          : { ...item, isSet: undefined, setHint: undefined };
      });
      return { groups, enrichedItems };
    });
  }, []);

  const handleToggleItem = useCallback((globalIdx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(globalIdx)) next.delete(globalIdx); else next.add(globalIdx);
      return next;
    });
  }, []);

  const handleStartEdit = useCallback((groupIndex: number) => {
    setEditingGroupIndex(groupIndex);
    setSelectedIndices(new Set());
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingGroupIndex(null);
    setSelectedIndices(new Set());
  }, []);

  const handleMoveItems = useCallback((
    targetGroupIndex: number | "new",
    newGroupData?: { name: string; category: string | null },
  ) => {
    setEditedPlan((prev) => {
      let groups = [...prev.groups];
      let enrichedItems = [...prev.enrichedItems];

      let targetIdx: number;
      if (targetGroupIndex === "new") {
        groups = [...groups, {
          groupName: newGroupData?.name ?? "Nová skupina",
          category: newGroupData?.category ?? null,
          suggestedManufacturer: null,
          suggestedLine: null,
          notes: null,
          itemIndices: [],
        }];
        targetIdx = groups.length - 1;
      } else {
        targetIdx = targetGroupIndex;
      }

      enrichedItems = enrichedItems.map((item, i) =>
        selectedIndices.has(i) ? { ...item, groupIndex: targetIdx } : item,
      );

      groups = groups.map((g, gIdx) => ({
        ...g,
        itemIndices: enrichedItems.map((_, i) => i).filter((i) => enrichedItems[i].groupIndex === gIdx),
      }));

      const nonEmptyGroups = groups.filter((g) => g.itemIndices.length > 0);
      const oldToNew = new Map<number, number>();
      groups.forEach((g, oldIdx) => {
        const newIdx = nonEmptyGroups.indexOf(g);
        if (newIdx >= 0) oldToNew.set(oldIdx, newIdx);
      });

      enrichedItems = enrichedItems.map((item) => ({
        ...item,
        groupIndex: oldToNew.get(item.groupIndex) ?? item.groupIndex,
      }));

      return { groups: nonEmptyGroups, enrichedItems };
    });

    setEditingGroupIndex(null);
    setSelectedIndices(new Set());
  }, [selectedIndices]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">Plán vyhledávání</h2>
            <p className="mt-1 text-xs text-kv-gray-400">
              AI seskupila položky. Upravte kategorii, výrobce/řadu nebo přesuňte položky mezi skupinami.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onSkip}
              className="rounded-xl border border-kv-gray-200 px-4 py-2 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50">
              Přeskočit
            </button>
            <button onClick={() => onApprove(editedPlan)}
              className="rounded-xl bg-kv-red px-5 py-2 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark">
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
              allGroups={editedPlan.groups}
              items={editedPlan.enrichedItems}
              token={token}
              categories={categories}
              selectedIndices={selectedIndices}
              isEditing={editingGroupIndex === i}
              onManufacturerChange={handleManufacturerChange}
              onLineChange={handleLineChange}
              onCategoryChange={handleCategoryChange}
              onToggleItem={handleToggleItem}
              onStartEdit={() => handleStartEdit(i)}
              onCancelEdit={handleCancelEdit}
              onMoveItems={handleMoveItems}
              onTreatAsSetChange={handleTreatAsSetChange}
              onSkipGroupChange={handleSkipGroupChange}
              onSkipItemChange={handleSkipItemChange}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
