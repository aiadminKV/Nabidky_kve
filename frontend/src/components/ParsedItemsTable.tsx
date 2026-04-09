"use client";

import { useCallback, useMemo } from "react";
import type { ParsedItem } from "@/lib/types";

// Values matching actual catalog units (KS, M, BAL, KG, SET, PÁR, ROL)
const UNIT_OPTIONS = ["ks", "m", "bal", "kg", "set", "pár", "rol"] as const;

function UnitCell({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const isKnown = value == null || UNIT_OPTIONS.includes(value as typeof UNIT_OPTIONS[number]);
  return (
    <div className="relative">
      <select
        value={isKnown ? (value ?? "") : "__custom__"}
        onChange={(e) => {
          if (e.target.value === "__custom__") return;
          onChange(e.target.value || null);
        }}
        className="w-full appearance-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 pr-6 text-sm text-kv-gray-600 outline-none transition-colors hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
      >
        <option value="">—</option>
        {UNIT_OPTIONS.map((u) => (
          <option key={u} value={u}>{u}</option>
        ))}
        {!isKnown && <option value="__custom__">{value}</option>}
      </select>
      <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-kv-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
      </svg>
    </div>
  );
}

interface ParsedItemsTableProps {
  items: ParsedItem[];
  onItemsChange: (items: ParsedItem[]) => void;
  onProcess: () => void;
  isProcessing: boolean;
}

export function ParsedItemsTable({
  items,
  onItemsChange,
  onProcess,
  isProcessing,
}: ParsedItemsTableProps) {
  const neutralButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-kv-gray-200 bg-white px-4 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50 disabled:opacity-40 disabled:cursor-not-allowed";
  const primaryButtonClass = "inline-flex h-11 items-center gap-2 rounded-2xl bg-kv-red px-5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed";
  const extraColumnKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      if (item.extraColumns) {
        for (const key of Object.keys(item.extraColumns)) {
          keys.add(key);
        }
      }
    }
    return Array.from(keys);
  }, [items]);

  const updateItem = useCallback(
    (id: string, field: keyof ParsedItem, value: string | number | boolean | null) => {
      onItemsChange(
        items.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
      );
    },
    [items, onItemsChange],
  );

  const cycleItemState = useCallback(
    (id: string) => {
      onItemsChange(
        items.map((item) => {
          if (item.id !== id) return item;
          if (!item.isSet && !item.skip) return { ...item, isSet: true, skip: false };
          if (item.isSet) return { ...item, isSet: false, skip: true };
          return { ...item, isSet: false, skip: false };
        }),
      );
    },
    [items, onItemsChange],
  );

  const updateExtraColumn = useCallback(
    (id: string, columnKey: string, value: string) => {
      onItemsChange(
        items.map((item) => {
          if (item.id !== id) return item;
          const extra = { ...(item.extraColumns ?? {}) };
          if (value) {
            extra[columnKey] = value;
          } else {
            delete extra[columnKey];
          }
          return { ...item, extraColumns: Object.keys(extra).length > 0 ? extra : undefined };
        }),
      );
    },
    [items, onItemsChange],
  );

  const removeItem = useCallback(
    (id: string) => {
      onItemsChange(items.filter((item) => item.id !== id));
    },
    [items, onItemsChange],
  );

  const addItem = useCallback(() => {
    onItemsChange([
      ...items,
      { id: `manual_${Date.now()}`, name: "", unit: null, quantity: null },
    ]);
  }, [items, onItemsChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar */}
      <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-kv-navy">Rozpoznané položky</h2>
              <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-kv-gray-500">
                {items.length} položek
              </span>
              {extraColumnKeys.length > 0 && (
                <span className="inline-flex items-center rounded-full border border-kv-navy/10 bg-kv-navy/5 px-2.5 py-1 text-[11px] font-medium text-kv-navy">
                  +{extraColumnKeys.length} sloupců
                </span>
              )}
            </div>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-kv-gray-400">
              Zkontrolujte rozpoznané řádky před spuštěním vyhledávání.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={addItem}
              className={neutralButtonClass}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat
            </button>
            <button
              onClick={onProcess}
              disabled={items.length === 0 || items.every((i) => !i.name.trim()) || isProcessing}
              className={primaryButtonClass}
            >
              {isProcessing ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Zpracovávám…
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                  </svg>
                  Zpracovat
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Editable table */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto custom-scrollbar">
        <table className="w-full text-sm" style={{ minWidth: 988 }}>
          <thead className="sticky top-0 z-10 bg-kv-gray-50 border-b border-kv-gray-200">
            <tr>
              <th style={{ width: "2%" }} className="pl-1 pr-0" />
              <th style={{ width: "3%" }} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">#</th>
              <th style={{ width: "20%" }} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Poptávka</th>
              <th style={{ width: "11%" }} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Množ.</th>
              {extraColumnKeys.map((key) => (
                <th key={key} style={{ width: "8%" }} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 whitespace-nowrap">
                  {key}
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Nalezený produkt</th>
              <th style={{ width: "9%" }} className="border-l border-kv-gray-100 px-5 py-2.5 text-right text-xs font-medium text-kv-gray-500 whitespace-nowrap">Stav</th>
              <th style={{ width: "7%" }} className="border-l border-kv-gray-100 px-5 py-2.5 text-center text-xs font-medium text-kv-gray-500 whitespace-nowrap">Akce</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item, idx) => (
              <tr key={item.id} className={`group transition-opacity ${item.skip ? "opacity-40" : ""}`}>
                <td className="w-6 pl-1 pr-0 py-2.5" />
                <td className="px-4 py-2.5 text-xs text-kv-gray-400 align-top pt-3">{idx + 1}</td>
                <td className="px-4 py-2.5 align-top">
                  <input
                    value={item.name}
                    onChange={(e) => updateItem(item.id, "name", e.target.value)}
                    placeholder="Název produktu…"
                    className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                  />
                </td>
                <td className="px-4 py-2.5 align-top">
                  <div className="flex items-start gap-2 pt-0.5 whitespace-nowrap">
                    <input
                      type="number"
                      value={item.quantity ?? ""}
                      onChange={(e) =>
                        updateItem(item.id, "quantity", e.target.value ? Number(e.target.value) : null)
                      }
                      placeholder="0"
                      className="w-20 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-600 tabular-nums outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                    />
                    <div className="w-14 shrink-0">
                      <UnitCell
                        value={item.unit}
                        onChange={(v) => updateItem(item.id, "unit", v)}
                      />
                    </div>
                  </div>
                </td>
                {extraColumnKeys.map((key) => (
                  <td key={key} className="px-4 py-2.5 align-top">
                    <input
                      value={item.extraColumns?.[key] ?? ""}
                      onChange={(e) => updateExtraColumn(item.id, key, e.target.value)}
                      className="w-full min-w-[80px] rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-600 outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                    />
                  </td>
                ))}
                <td className="px-4 py-2.5 align-top">
                  <div className="flex items-start gap-2 opacity-60">
                    <div className="h-8 w-8 shrink-0 rounded bg-kv-gray-100" />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="h-4 rounded bg-kv-gray-100" />
                      <div className="mt-1 h-4 rounded bg-kv-gray-50" />
                      <div className="mt-1.5 h-10 rounded bg-kv-gray-50/70" />
                    </div>
                  </div>
                </td>
                <td className="border-l border-kv-gray-100 px-5 py-2.5 text-right align-top pt-3">
                  <button
                    type="button"
                    onClick={() => cycleItemState(item.id)}
                    title={
                      item.skip ? "Přeskočit — kliknutím vrátíte do fronty" :
                      item.isSet ? "Sada — kliknutím označíte jako přeskočit" :
                      "Čeká — kliknutím označíte jako sadu"
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      item.skip
                        ? "border-red-200 bg-red-50 text-red-500 hover:bg-red-100"
                        : item.isSet
                        ? "border-violet-300 bg-violet-100 text-violet-700 hover:bg-violet-200"
                        : "border-kv-gray-200 bg-kv-gray-50 text-kv-gray-400 hover:border-kv-gray-300 hover:bg-kv-gray-100 hover:text-kv-gray-600"
                    }`}
                  >
                    {item.skip ? (
                      <>
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                        Přeskočit
                      </>
                    ) : item.isSet ? (
                      <>
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z" />
                        </svg>
                        Sada
                      </>
                    ) : "Čeká"}
                  </button>
                </td>
                <td className="border-l border-kv-gray-100 px-5 py-2.5 text-center align-top pt-2">
                  <button
                    onClick={() => removeItem(item.id)}
                    className="mx-auto flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-kv-red-light hover:text-kv-red"
                    title="Odebrat"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {items.length === 0 && (
          <div className="flex h-full items-center justify-center py-16">
            <p className="text-xs text-kv-gray-400">Žádné položky k zobrazení</p>
          </div>
        )}
      </div>
    </div>
  );
}
