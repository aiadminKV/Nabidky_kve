"use client";

import { useCallback, useMemo } from "react";
import type { ParsedItem } from "@/lib/types";

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
    (id: string, field: keyof ParsedItem, value: string | number | null) => {
      onItemsChange(
        items.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
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
      <div className="flex items-center justify-between border-b border-kv-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-kv-gray-800">Rozpoznané položky</h2>
          <span className="rounded-full bg-kv-gray-100 px-2.5 py-0.5 text-xs font-medium text-kv-gray-500">
            {items.length}
          </span>
          {extraColumnKeys.length > 0 && (
            <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600">
              +{extraColumnKeys.length} sloupců
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={addItem}
            className="flex items-center gap-1.5 rounded-lg border border-kv-gray-200 px-3 py-2 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Přidat
          </button>
          <button
            onClick={onProcess}
            disabled={items.length === 0 || items.every((i) => !i.name.trim()) || isProcessing}
            className="flex items-center gap-2 rounded-lg bg-kv-red px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
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

      {/* Editable table */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto custom-scrollbar">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-kv-gray-50 border-b border-kv-gray-200">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-10">#</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Název položky</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-20">MJ</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-24">Množství</th>
              {extraColumnKeys.map((key) => (
                <th key={key} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 whitespace-nowrap">
                  {key}
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item, idx) => (
              <tr key={item.id} className="group">
                <td className="px-4 py-2 text-xs text-kv-gray-400">{idx + 1}</td>
                <td className="px-4 py-1.5">
                  <input
                    value={item.name}
                    onChange={(e) => updateItem(item.id, "name", e.target.value)}
                    placeholder="Název produktu…"
                    className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                  />
                </td>
                <td className="px-4 py-1.5">
                  <input
                    value={item.unit ?? ""}
                    onChange={(e) => updateItem(item.id, "unit", e.target.value || null)}
                    placeholder="ks"
                    className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-600 outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                  />
                </td>
                <td className="px-4 py-1.5">
                  <input
                    type="number"
                    value={item.quantity ?? ""}
                    onChange={(e) =>
                      updateItem(item.id, "quantity", e.target.value ? Number(e.target.value) : null)
                    }
                    placeholder="0"
                    className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-600 tabular-nums outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                  />
                </td>
                {extraColumnKeys.map((key) => (
                  <td key={key} className="px-4 py-1.5">
                    <input
                      value={item.extraColumns?.[key] ?? ""}
                      onChange={(e) => updateExtraColumn(item.id, key, e.target.value)}
                      className="w-full min-w-[80px] rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm text-kv-gray-600 outline-none transition-colors placeholder:text-kv-gray-300 hover:border-kv-gray-200 focus:border-kv-red/30 focus:bg-white focus:ring-1 focus:ring-kv-red/10"
                    />
                  </td>
                ))}
                <td className="px-4 py-1.5">
                  <button
                    onClick={() => removeItem(item.id)}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-kv-red-light hover:text-kv-red"
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
