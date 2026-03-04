"use client";

import { useMemo } from "react";
import type { OfferItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover } from "./ProductInfoPopover";

interface ResultsTableProps {
  items: OfferItem[];
  searchingSet: Set<number>;
  onItemClick: (item: OfferItem) => void;
  onExport: () => void;
  onReset: () => void;
  onProcessNotFound: () => void;
  isSearchingSemantic: boolean;
}

export function ResultsTable({
  items,
  searchingSet,
  onItemClick,
  onExport,
  onReset,
  onProcessNotFound,
  isSearchingSemantic,
}: ResultsTableProps) {
  const matchedCount = items.filter((i) => i.matchType !== "not_found" || i.confirmed).length;
  const doneCount = items.filter((i) => !searchingSet.has(i.position)).length;
  const isSearching = searchingSet.size > 0;
  const notFoundCount = items.filter((i) => i.matchType === "not_found" && !i.confirmed).length;

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kv-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-kv-gray-800">Výsledky vyhledávání</h2>
          <div className="flex items-center gap-2 text-xs text-kv-gray-400">
            <span>{matchedCount}/{items.length} nalezeno</span>
            {isSearching && (
              <span className="flex items-center gap-1.5 rounded-full bg-kv-gray-100 px-2.5 py-0.5 text-kv-gray-500">
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {doneCount}/{items.length}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {notFoundCount > 0 && !isSearching && (
            <button
              onClick={onProcessNotFound}
              disabled={isSearchingSemantic}
              className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSearchingSemantic ? (
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
              )}
              {isSearchingSemantic
                ? "Vyhledávám…"
                : `Zpracovat nenalezené (${notFoundCount})`}
            </button>
          )}
          <button
            onClick={onReset}
            className="rounded-lg border border-kv-gray-200 px-3 py-2 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Nová poptávka
          </button>
          <button
            onClick={onExport}
            disabled={isSearching || items.length === 0}
            className="flex items-center gap-2 rounded-lg bg-kv-red px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Stáhnout Excel
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {isSearching && (
        <div className="h-1 bg-kv-gray-100">
          <div
            className="h-full bg-kv-red transition-all duration-300 ease-out"
            style={{ width: `${(doneCount / items.length) * 100}%` }}
          />
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-kv-gray-50 border-b border-kv-gray-200">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-8">#</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Název z poptávky</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-16">Množ.</th>
              {extraColumnKeys.map((key) => (
                <th key={key} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 whitespace-nowrap">
                  {key}
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500">Nalezený produkt</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-28">Kód (SKU)</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-500 w-32">Stav</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item) => {
              const isCurrentlySearching = searchingSet.has(item.position);
              return (
                <tr
                  key={item.position}
                  onClick={() => !isCurrentlySearching && onItemClick(item)}
                  className={`transition-colors ${
                    isCurrentlySearching
                      ? "bg-kv-gray-50 animate-pulse-subtle"
                      : "cursor-pointer hover:bg-kv-gray-50"
                  }`}
                >
                  <td className="px-4 py-3 text-xs text-kv-gray-400">{item.position + 1}</td>
                  <td className="px-4 py-3 text-kv-gray-700 font-medium max-w-[200px] truncate">
                    {item.originalName}
                  </td>
                  <td className="px-4 py-3 text-kv-gray-600 tabular-nums">
                    {item.quantity ?? "—"}
                  </td>
                  {extraColumnKeys.map((key) => (
                    <td key={key} className="px-4 py-3 text-kv-gray-500 max-w-[150px] truncate">
                      {item.extraColumns?.[key] ?? "—"}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-kv-gray-600">
                    <div className="flex items-center gap-1.5 max-w-[220px]">
                      <span className="truncate">
                        {item.product?.name ?? (isCurrentlySearching ? "" : "—")}
                      </span>
                      {item.product && !isCurrentlySearching && (
                        <ProductInfoPopover product={item.product} />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-kv-gray-500">
                    {item.product?.sku ?? (isCurrentlySearching ? "" : "—")}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      type={isCurrentlySearching ? "processing" : item.matchType}
                      confidence={isCurrentlySearching ? undefined : item.confidence}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
