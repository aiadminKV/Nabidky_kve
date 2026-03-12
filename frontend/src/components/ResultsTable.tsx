"use client";

import { useMemo, useState } from "react";
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
  onProcessAgain: () => void;
  onAddItem: () => void;
  onDeleteItem: (position: number) => void;
  onSearchItem: (item: OfferItem) => void;
  isSearchingSemantic: boolean;
  isProcessing: boolean;
}

export function ResultsTable({
  items,
  searchingSet,
  changedPositions,
  onItemClick,
  onExport,
  onReset,
  onProcessNotFound,
  onProcessAgain,
  onAddItem,
  onDeleteItem,
  onSearchItem,
  isSearchingSemantic,
  isProcessing,
}: ResultsTableProps) {
  const [showResetModal, setShowResetModal] = useState(false);
  const [showReprocessModal, setShowReprocessModal] = useState(false);

  const matchedCount = items.filter((i) => i.matchType !== "not_found" || i.confirmed).length;
  const doneCount = items.filter((i) => !searchingSet.has(i.position)).length;
  const isSearching = searchingSet.size > 0;
  const notFoundCount = items.filter((i) => i.matchType === "not_found" && !i.confirmed).length;
  const unreviewedCount = items.filter((i) => i.reviewStatus !== "reviewed").length;

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
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar */}
      <div className="border-b border-kv-gray-200 px-5 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-kv-navy">Výsledky</h2>
          <span className="text-xs text-kv-gray-400 tabular-nums">
            {matchedCount}/{items.length} nalezeno
          </span>
          {unreviewedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              {unreviewedCount} ke kontrole
            </span>
          )}
          {unreviewedCount === 0 && items.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Vše zkontrolováno
            </span>
          )}
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
          <button
            onClick={onAddItem}
            className="flex items-center gap-1.5 rounded-lg border border-kv-gray-200 px-3 py-1.5 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Přidat
          </button>
          <button
            onClick={() => setShowReprocessModal(true)}
            disabled={isSearching || isProcessing || items.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-kv-navy/30 bg-kv-navy/5 px-3 py-1.5 text-xs font-medium text-kv-navy transition-colors hover:bg-kv-navy/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
            </svg>
            Zpracovat znovu
          </button>
          <button
            onClick={onProcessNotFound}
            disabled={notFoundCount === 0 || isSearchingSemantic || isSearching}
            className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed"
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
          <button
            onClick={() => setShowResetModal(true)}
            className="rounded-lg border border-kv-gray-200 px-3 py-1.5 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Vymazat vše
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
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto custom-scrollbar">
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
              <th className="px-4 py-2.5 text-right text-xs font-medium text-kv-gray-400 w-36">Stav</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-kv-gray-400 w-20">Akce</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item) => {
              const isCurrentlySearching = searchingSet.has(item.position);
              const justChanged = changedPositions?.has(item.position) ?? false;
              const isReviewed = item.reviewStatus === "reviewed";
              return (
                <tr
                  key={item.position}
                  onClick={() => !isCurrentlySearching && onItemClick(item)}
                  className={`transition-all duration-500 ${
                    isCurrentlySearching
                      ? "bg-kv-gray-50 animate-pulse-subtle"
                      : justChanged
                        ? "bg-green-50/60"
                        : isReviewed
                          ? "bg-emerald-50/40 cursor-pointer hover:bg-emerald-50/70 border-l-2 border-l-emerald-400"
                          : "bg-amber-50/50 cursor-pointer hover:bg-amber-100/60 border-l-2 border-l-amber-400"
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
                    <div className="max-w-[300px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-kv-dark truncate">
                          {item.product?.name ?? (isCurrentlySearching ? "" : "—")}
                        </span>
                        {item.product && !isCurrentlySearching && (
                          <ProductInfoPopover product={item.product} />
                        )}
                      </div>
                      {item.product && !isCurrentlySearching && (
                        <div className="flex items-center gap-2 mt-0.5">
                          {item.product.manufacturer && (
                            <span className="text-xs text-kv-gray-400">{item.product.manufacturer}</span>
                          )}
                          {item.product.sku && (
                            <span className="text-xs font-mono text-kv-gray-400">{item.product.sku}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <StatusBadge
                      type={isCurrentlySearching ? "processing" : item.matchType}
                      confidence={isCurrentlySearching ? undefined : item.confidence}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {!isCurrentlySearching && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSearchItem(item);
                          }}
                          title="Vyhledat znovu"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 transition-all hover:bg-kv-navy/10 hover:text-kv-navy"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteItem(item.position);
                        }}
                        title="Odebrat položku"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 transition-all hover:bg-kv-red-light hover:text-kv-red"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showReprocessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl border border-white/20 p-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
              <svg className="h-6 w-6 text-kv-navy" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-kv-dark">Zpracovat znovu?</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Tato akce spustí kompletně nové vyhledávání pro všechny položky. Stávající výsledky budou přepsány.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowReprocessModal(false)}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={() => {
                  setShowReprocessModal(false);
                  onProcessAgain();
                }}
                className="rounded-xl bg-kv-navy px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-kv-navy/90"
              >
                Spustit vyhledávání
              </button>
            </div>
          </div>
        </div>
      )}

      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl border border-white/20 p-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-kv-dark">Vymazat vše?</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Tato akce smaže všechny položky, historii chatu a vrátí nabídku do výchozího stavu.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowResetModal(false)}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={() => {
                  setShowResetModal(false);
                  onReset();
                }}
                className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-red-600"
              >
                Vymazat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
