"use client";

import { useMemo, useState } from "react";
import type { OfferItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover } from "./ProductInfoPopover";
import { StockBadge } from "./StockBadge";

const UNIT_GROUPS: Record<string, string> = {
  ks: "ks", kus: "ks", kusu: "ks", kusů: "ks", kusov: "ks", pcs: "ks",
  m: "m", metr: "m", metry: "m", metrů: "m", met: "m",
  bal: "bal", balení: "bal", baleni: "bal", pack: "bal",
  kg: "kg", kilogram: "kg",
  sada: "sada", set: "sada", komplet: "sada",
};

function normalizeUnit(u: string): string {
  return UNIT_GROUPS[u.toLowerCase().trim()] ?? u.toLowerCase().trim();
}

function hasUnitMismatch(demandUnit: string | null, productUnit: string | null): boolean {
  if (!demandUnit || !productUnit) return false;
  return normalizeUnit(demandUnit) !== normalizeUnit(productUnit);
}

function unitMismatchLabel(demandUnit: string, productUnit: string): string {
  return `Poptávka: ${demandUnit} → Produkt: ${productUnit}`;
}

interface ResultsTableProps {
  items: OfferItem[];
  searchingSet: Set<number>;
  changedPositions?: Set<number>;
  onItemClick: (item: OfferItem) => void;
  onExport: () => void;
  onReset: () => void;
  onProcessNotFound: () => void;
  onProcessAgain?: () => void;
  onAddItem?: () => void;
  onDeleteItem?: (position: number) => void;
  onSearchItem?: (item: OfferItem) => void;
  isSearchingSemantic: boolean;
  isProcessing?: boolean;
  token?: string;
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
  isProcessing = false,
  token = "",
}: ResultsTableProps) {
  const [showResetModal, setShowResetModal] = useState(false);
  const [showReprocessModal, setShowReprocessModal] = useState(false);
  const neutralButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-kv-gray-200 bg-white px-4 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50 disabled:opacity-40 disabled:cursor-not-allowed";
  const navyButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-kv-navy/20 bg-kv-navy/5 px-4 text-xs font-medium text-kv-navy transition-colors hover:bg-kv-navy/10 disabled:opacity-40 disabled:cursor-not-allowed";
  const amberButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed";
  const primaryButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl bg-kv-red px-4.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed";

  const matchedCount = items.filter((i) => i.matchType !== "not_found" || i.confirmed).length;
  const doneCount = items.filter((i) => !searchingSet.has(i.position)).length;
  const isSearching = searchingSet.size > 0;
  const notFoundCount = items.filter((i) => i.matchType === "not_found" && !i.confirmed).length;
  const unreviewedCount = items.filter((i) => i.reviewStatus !== "reviewed").length;
  const unitMismatchCount = items.filter((i) => i.product && hasUnitMismatch(i.unit, i.product.unit)).length;
  const priceNoteCount = items.filter((i) => i.priceNote).length;
  const uncertainCount = items.filter((i) => i.matchType === "uncertain" || i.matchType === "alternative").length;

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
      <div className="shrink-0 border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">Položky nabídky</h2>
            <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-kv-gray-500">
              {matchedCount}/{items.length} nalezeno
            </span>
            {unreviewedCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {unreviewedCount} ke kontrole
              </span>
            ) : items.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/80 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Vše zkontrolováno
              </span>
            ) : null}
            {uncertainCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50/80 px-2.5 py-1 text-[11px] font-medium text-blue-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
                </svg>
                {uncertainCount} nejisté
              </span>
            )}
            {priceNoteCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                {priceNoteCount} cenové upozornění
              </span>
            )}
            {unitMismatchCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                {unitMismatchCount} nesoulad MJ
              </span>
            )}
            {isSearching && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-kv-red/10 bg-kv-red/5 px-2.5 py-1 text-[11px] font-medium text-kv-red">
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="tabular-nums">{doneCount}/{items.length}</span>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onProcessAgain && (
              <button
                onClick={() => setShowReprocessModal(true)}
                disabled={isSearching || isProcessing || items.length === 0}
                className={navyButtonClass}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
                </svg>
                Zpracovat znovu
              </button>
            )}
            <button
              onClick={onProcessNotFound}
              disabled={notFoundCount === 0 || isSearchingSemantic || isSearching}
              className={amberButtonClass}
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
              {isSearchingSemantic ? "Vyhledávám…" : "Zpracovat nenalezené"}
            </button>
            <button
              onClick={() => setShowResetModal(true)}
              className={neutralButtonClass}
            >
              Vymazat vše
            </button>
            <button
              onClick={onExport}
              disabled={isSearching || items.length === 0}
              className={primaryButtonClass}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export
            </button>
          </div>
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

      {/* Offer summary bar */}
      {!isSearching && items.length > 0 && (
        <div className="shrink-0 border-b border-kv-gray-100 bg-white px-6 py-2.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">{matchedCount}</span>
              <span className="text-kv-gray-500">nalezeno</span>
            </div>
            {notFoundCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{notFoundCount}</span>
                <span className="text-kv-gray-500">nenalezeno</span>
              </div>
            )}
            {uncertainCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">{uncertainCount}</span>
                <span className="text-kv-gray-500">nejisté</span>
              </div>
            )}
            {priceNoteCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">{priceNoteCount}</span>
                <span className="text-kv-gray-500">cenové upozornění</span>
              </div>
            )}
            {(() => {
              const prices = items
                .filter((i) => i.product?.current_price != null)
                .map((i) => (i.product!.current_price! * (i.quantity ?? 1)));
              if (prices.length === 0) return null;
              const total = prices.reduce((a, b) => a + b, 0);
              return (
                <div className="ml-auto flex items-center gap-1.5 font-medium text-kv-dark">
                  <svg className="h-3.5 w-3.5 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                  </svg>
                  <span className="tabular-nums">
                    {new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(total)}
                  </span>
                  <span className="font-normal text-kv-gray-400">odhad bez DPH</span>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {onAddItem && (
          <button
            onClick={onAddItem}
            aria-label="Přidat položku"
            title="Přidat položku"
            className="absolute bottom-4 right-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full bg-kv-red text-white shadow-lg shadow-red-200 transition-all hover:bg-kv-red-dark hover:shadow-xl"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        )}
      <div className="h-full overflow-y-auto overflow-x-auto custom-scrollbar pb-24">
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
                      <div className="flex items-center gap-1">
                        <span>
                          {item.quantity}
                          {item.unit && <span className="ml-1 text-kv-gray-400">{item.unit}</span>}
                        </span>
                        {!isCurrentlySearching && item.product && hasUnitMismatch(item.unit, item.product.unit) && (
                          <span
                            title={unitMismatchLabel(item.unit!, item.product.unit!)}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 cursor-help"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                            </svg>
                          </span>
                        )}
                      </div>
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
                          <StockBadge product={item.product} token={token} />
                        </div>
                      )}
                      {item.reasoning && !isCurrentlySearching && (
                        <p className="mt-0.5 text-[11px] text-kv-gray-400 truncate max-w-[290px]" title={item.reasoning}>
                          {item.reasoning}
                        </p>
                      )}
                      {item.priceNote && !isCurrentlySearching && (
                        <div className="mt-1 flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 border border-amber-200">
                          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                          </svg>
                          <span className="truncate">{item.priceNote}</span>
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
                      {!isCurrentlySearching && onSearchItem && (
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
                      {onDeleteItem && (
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
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>

      {showReprocessModal && onProcessAgain && (
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
