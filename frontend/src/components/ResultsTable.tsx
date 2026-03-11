"use client";

import { useMemo } from "react";
import type { OfferItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover } from "./ProductInfoPopover";

interface ResultsTableProps {
  items: OfferItem[];
  searchingSet: Set<number>;
  changedPositions?: Set<number>;
  onItemClick: (item: OfferItem) => void;
  onExport: () => void;
  onReset: () => void;
  onProcessNotFound: () => void;
  isSearchingSemantic: boolean;
}

export function ResultsTable({
  items,
  searchingSet,
  changedPositions,
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
      {/* Header bar */}
      <div className="border-b border-kv-gray-200 px-5 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-kv-navy">Výsledky</h2>
          <span className="text-xs text-kv-gray-400 tabular-nums">
            {matchedCount}/{items.length} nalezeno
          </span>
          {isSearching && (
            <span className="flex items-center gap-1.5 text-xs text-kv-gray-400">
              <svg className="h-3.5 w-3.5 animate-spin text-kv-red" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="tabular-nums">{doneCount}/{items.length}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {notFoundCount > 0 && !isSearching && (
            <button
              onClick={onProcessNotFound}
              disabled={isSearchingSemantic}
              className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
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
                : `Nenalezené (${notFoundCount})`}
            </button>
          )}
          <button
            onClick={onReset}
            className="rounded-lg border border-kv-gray-200 px-3 py-1.5 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Nová poptávka
          </button>
          <button
            onClick={onExport}
            disabled={isSearching || items.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-kv-red px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export
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
        <table className="w-full">
          <thead className="sticky top-0 z-10 bg-kv-gray-50 border-b border-kv-gray-200">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 w-10">#</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400">Poptávka</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 w-20">Množ.</th>
              {extraColumnKeys.map((key) => (
                <th key={key} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 whitespace-nowrap">
                  {key}
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400">Nalezený produkt</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 w-32">Kód</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-kv-gray-400 w-36">Stav</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item) => {
              const isCurrentlySearching = searchingSet.has(item.position);
              const justChanged = changedPositions?.has(item.position) ?? false;
              return (
                <tr
                  key={item.position}
                  onClick={() => !isCurrentlySearching && onItemClick(item)}
                  className={`transition-all duration-500 ${
                    isCurrentlySearching
                      ? "bg-kv-gray-50 animate-pulse-subtle"
                      : justChanged
                        ? "bg-green-50/60"
                        : "cursor-pointer hover:bg-kv-gray-50/60"
                  }`}
                >
                  <td className="px-4 py-2.5 text-sm tabular-nums text-kv-gray-400">{item.position + 1}</td>
                  <td className="px-4 py-2.5 text-sm text-kv-dark">
                    {item.originalName}
                  </td>
                  <td className="px-4 py-2.5 text-sm tabular-nums text-kv-dark">
                    {item.quantity != null ? (
                      <>
                        {item.quantity}
                        {item.unit && <span className="ml-1 text-kv-gray-400">{item.unit}</span>}
                      </>
                    ) : (
                      <span className="text-kv-gray-300">—</span>
                    )}
                  </td>
                  {extraColumnKeys.map((key) => (
                    <td key={key} className="px-4 py-2.5 text-sm text-kv-dark max-w-[150px] truncate">
                      {item.extraColumns?.[key] ?? "—"}
                    </td>
                  ))}
                  <td className="px-4 py-2.5">
                    <div className="max-w-[260px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-kv-dark truncate">
                          {item.product?.name ?? (isCurrentlySearching ? "" : "—")}
                        </span>
                        {item.product && !isCurrentlySearching && (
                          <ProductInfoPopover product={item.product} />
                        )}
                      </div>
                      {item.product?.manufacturer && !isCurrentlySearching && (
                        <span className="text-xs text-kv-gray-400">{item.product.manufacturer}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-sm font-mono text-kv-gray-500">
                    {item.product?.sku && !isCurrentlySearching
                      ? item.product.sku
                      : !isCurrentlySearching
                        ? <span className="text-kv-gray-300">—</span>
                        : null}
                  </td>
                  <td className="px-4 py-2.5 text-right">
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
