"use client";

import { useState, useCallback, useEffect } from "react";
import type { OfferItem, Product } from "@/lib/types";
import { useDebouncedValue } from "@/lib/hooks";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover } from "./ProductInfoPopover";
import { StockBadge } from "./StockBadge";

const MIN_SEARCH_LENGTH = 2;
const DEBOUNCE_MS = 300;

interface ReviewModalProps {
  item: OfferItem;
  onConfirm: (item: OfferItem, selectedProduct: Product | null) => void;
  onSkip: (item: OfferItem) => void;
  onClose: () => void;
  onManualSearch: (query: string) => Promise<Product[]>;
  token?: string;
}

export function ReviewModal({ item, onConfirm, onSkip, onClose, onManualSearch, token = "" }: ReviewModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(item.product);
  const [wasDeselected, setWasDeselected] = useState(false);

  const [editedName, setEditedName] = useState(item.originalName);
  const [editedQuantity, setEditedQuantity] = useState<string>(
    item.quantity != null ? String(item.quantity) : "",
  );
  const [editedUnit, setEditedUnit] = useState(item.unit ?? "");

  const buildEditedItem = useCallback((): OfferItem => ({
    ...item,
    originalName: editedName.trim() || item.originalName,
    quantity: editedQuantity.trim() ? Number(editedQuantity) : item.quantity,
    unit: editedUnit.trim() || item.unit,
  }), [item, editedName, editedQuantity, editedUnit]);

  const debouncedQuery = useDebouncedValue(searchQuery, DEBOUNCE_MS);

  useEffect(() => {
    if (debouncedQuery.trim().length < MIN_SEARCH_LENGTH) {
      if (searchResults.length > 0 && !searchQuery.trim()) {
        setSearchResults([]);
      }
      return;
    }

    let cancelled = false;

    async function search() {
      setIsSearching(true);
      try {
        const results = await onManualSearch(debouncedQuery);
        if (!cancelled) setSearchResults(results);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }

    search();
    return () => { cancelled = true; };
  }, [debouncedQuery, onManualSearch]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
  }, []);

  const displayCandidates = searchResults.length > 0 ? searchResults : item.candidates;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-kv-gray-200 px-6 py-4">
          <div>
            <h3 className="text-sm font-semibold text-kv-navy">Detail položky</h3>
            <p className="mt-0.5 text-xs text-kv-gray-400">
              Vyberte správný produkt nebo vyhledejte jiný
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-kv-gray-400 transition-colors hover:bg-kv-gray-100 hover:text-kv-gray-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Editable original item info */}
        <div className="border-b border-kv-gray-100 bg-kv-gray-50 px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-kv-navy">Z poptávky</span>
            <input
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              placeholder="Název položky"
              className="min-w-0 flex-1 rounded-lg border border-kv-gray-200 bg-white px-2 py-1 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
            />
            <input
              value={editedQuantity}
              onChange={(e) => setEditedQuantity(e.target.value)}
              type="number"
              min={0}
              step="any"
              placeholder="Množ."
              className="w-16 shrink-0 rounded-lg border border-kv-gray-200 bg-white px-2 py-1 text-xs text-kv-dark tabular-nums outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
            />
            <input
              value={editedUnit}
              onChange={(e) => setEditedUnit(e.target.value)}
              placeholder="MJ"
              className="w-14 shrink-0 rounded-lg border border-kv-gray-200 bg-white px-2 py-1 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
            />
            <StatusBadge type={item.matchType} confidence={item.confidence} />
          </div>
          {item.reasoning && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-kv-gray-50 px-3 py-1.5 text-xs text-kv-gray-600 border border-kv-gray-200">
              <svg className="h-3.5 w-3.5 shrink-0 mt-0.5 text-kv-navy" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
              </svg>
              <span>{item.reasoning}</span>
            </div>
          )}
          {item.priceNote && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700 border border-amber-200">
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
              <span>{item.priceNote}</span>
            </div>
          )}
        </div>

        {/* Search bar */}
        <div className="border-b border-kv-gray-100 px-6 py-3">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kv-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Začněte psát pro vyhledání produktu…"
              className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 py-2 pl-10 pr-10 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
            />
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-lg text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-gray-600"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {isSearching && (
              <div className="absolute right-10 top-1/2 -translate-y-1/2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-kv-gray-300 border-t-kv-red" />
              </div>
            )}
          </div>
          {searchQuery.length > 0 && searchQuery.length < MIN_SEARCH_LENGTH && (
            <p className="mt-1 text-xs text-kv-gray-400">
              Zadejte alespoň {MIN_SEARCH_LENGTH} znaky
            </p>
          )}
        </div>

        {/* Candidates list */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-3">
          <p className="mb-2 text-xs font-semibold text-kv-navy">
            {searchResults.length > 0 ? `Výsledky (${searchResults.length})` : "Kandidáti"}
          </p>
          <div className="space-y-1.5">
            {displayCandidates.map((product, idx) => (
              <div
                key={product.sku + idx}
                role="button"
                tabIndex={0}
                aria-pressed={selectedProduct?.sku === product.sku}
                onClick={() => { setSelectedProduct(product); setWasDeselected(false); }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedProduct(product);
                    setWasDeselected(false);
                  }
                }}
                className={`w-full rounded-xl border px-4 py-3 text-left transition-all ${
                  selectedProduct?.sku === product.sku
                    ? "border-kv-navy bg-kv-navy/5 ring-1 ring-kv-navy/20"
                    : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm text-kv-dark truncate">{product.name}</p>
                      <ProductInfoPopover product={product} size="md" />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-kv-gray-400">
                      <span className="font-mono">{product.sku}</span>
                      {product.manufacturer_code && (
                        <span>{product.manufacturer_code}</span>
                      )}
                      {product.manufacturer && (
                        <span>{product.manufacturer}</span>
                      )}
                      <StockBadge product={product} token={token} />
                    </div>
                  </div>
                  {selectedProduct?.sku === product.sku && (
                    <button
                      type="button"
                      title="Zrušit výběr"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedProduct(null);
                        setWasDeselected(true);
                      }}
                      className="ml-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kv-navy text-white transition-colors hover:bg-kv-red"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
            {displayCandidates.length === 0 && (
              <p className="py-6 text-center text-xs text-kv-gray-400">
                {searchQuery.length >= MIN_SEARCH_LENGTH && !isSearching
                  ? "Žádné výsledky. Zkuste jiný dotaz."
                  : "Žádní kandidáti. Začněte psát pro vyhledání."}
              </p>
            )}
          </div>

          {/* Manual SKU input */}
          <div className="mt-4 border-t border-kv-gray-100 pt-4">
            <p className="mb-2 text-xs font-semibold text-kv-navy">
              Ruční zadání kódu
            </p>
            <input
              value={manualSku}
              onChange={(e) => setManualSku(e.target.value)}
              placeholder="Zadejte SAP kód produktu…"
              className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-3 py-2 font-mono text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-kv-gray-200 px-6 py-4">
          <button
            onClick={() => onSkip(buildEditedItem())}
            className="rounded-xl border border-kv-gray-200 px-4 py-2 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Přeskočit
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-kv-gray-200 px-4 py-2 text-sm font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50"
            >
              Zrušit
            </button>
            <button
              onClick={() => {
                const edited = buildEditedItem();
                if (manualSku.trim()) {
                  onConfirm(edited, { sku: manualSku.trim(), name: manualSku.trim(), manufacturer_code: null, manufacturer: null, category: null, unit: null, ean: null });
                } else {
                  onConfirm(edited, selectedProduct);
                }
              }}
              disabled={!selectedProduct && !manualSku.trim() && !wasDeselected}
              className="rounded-xl bg-kv-red px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Potvrdit výběr
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
