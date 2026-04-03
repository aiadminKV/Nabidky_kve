"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { OfferItem, Product, StockContext, StockLevel } from "@/lib/types";
import { useDebouncedValue } from "@/lib/hooks";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover, getStatusVariant, STATUS_LABELS } from "./ProductInfoPopover";
import { ProductThumbnail } from "./ProductThumbnail";
import { StockBadge } from "./StockBadge";

const MATCH_METHOD_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  ean:      { label: "EAN",  icon: "⊟", color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  code:     { label: "Kód",  icon: "⊞", color: "text-blue-600 bg-blue-50 border-blue-200" },
  semantic: { label: "AI",   icon: "◎", color: "text-violet-600 bg-violet-50 border-violet-200" },
};

function MatchMethodBadge({ method }: { method?: string | null }) {
  if (!method || method === "not_found") return null;
  const cfg = MATCH_METHOD_CONFIG[method];
  if (!cfg) return null;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium border ${cfg.color}`} title={`Nalezeno: ${cfg.label}`}>
      <span>{cfg.icon}</span>
      <span>{cfg.label}</span>
    </span>
  );
}

function CopySkuButton({ sku }: { sku: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [sku]);
  return (
    <button
      onClick={copy}
      title={copied ? "Zkopírováno!" : "Kopírovat SKU"}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-kv-gray-300 transition-all hover:bg-kv-gray-100 hover:text-kv-navy"
    >
      {copied ? (
        <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
        </svg>
      )}
    </button>
  );
}

const MIN_SEARCH_LENGTH = 2;
const DEBOUNCE_MS = 300;

interface ReviewModalProps {
  item: OfferItem;
  onConfirm: (item: OfferItem, selectedProduct: Product | null) => void;
  onSkip: (item: OfferItem) => void;
  onClose: () => void;
  onManualSearch: (query: string) => Promise<Product[]>;
  onSearchWithStockLevel?: (item: OfferItem, level: StockLevel) => void;
  token?: string;
}

const STOCK_FALLBACK_OPTIONS: Array<{
  level: StockLevel;
  label: string;
  description: string;
}> = [
  { level: "stock_item", label: "Pouze skladovky", description: "Hledej pouze skladové položky bez ohledu na pobočku" },
  { level: "in_stock",   label: "Skladem kdekoliv", description: "Hledej cokoliv, co je aktuálně skladem" },
  { level: "any",        label: "Celý katalog",     description: "Hledej bez omezení ve všech produktech" },
];

function StockFallbackOptions({
  item,
  stockContext,
  onSearch,
}: {
  item: OfferItem;
  stockContext: StockContext;
  onSearch: (item: OfferItem, level: StockLevel) => void;
}) {
  // The level that was actually used for the last search
  const activeLevel = stockContext.effectiveLevel ?? stockContext.requestedLevel;

  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <p className="mb-2 text-xs font-semibold text-amber-700">
        Hledat znovu s rozsahem skladu:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {STOCK_FALLBACK_OPTIONS.map((opt) => {
          const isActive = opt.level === activeLevel;
          return (
            <button
              key={opt.level}
              onClick={() => onSearch(item, opt.level)}
              title={isActive ? `Aktuálně použito: ${opt.description}` : opt.description}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "border-amber-400 bg-amber-100 text-amber-800 ring-1 ring-amber-400/50"
                  : "border-amber-300 bg-white text-amber-700 hover:bg-amber-100"
              }`}
            >
              {isActive ? (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              ) : (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
              )}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ReviewModal({ item, onConfirm, onSkip, onClose, onManualSearch, onSearchWithStockLevel, token = "" }: ReviewModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [showManualInput, setShowManualInput] = useState(false);
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

  // When searching, show search results. Otherwise, ensure the AI-selected product
  // is always visible at the top even if it's not in the candidates list.
  const displayCandidates = useMemo(() => {
    if (searchResults.length > 0) return searchResults;
    const candidates = item.candidates ?? [];
    if (item.product && !candidates.some((c) => c.sku === item.product!.sku)) {
      return [item.product, ...candidates];
    }
    return candidates;
  }, [searchResults, item.candidates, item.product]);

  const aiPickedSku = item.product?.sku ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl max-h-[93vh] flex flex-col">
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
          {onSearchWithStockLevel && item.stockContext && (
            <StockFallbackOptions item={item} stockContext={item.stockContext} onSearch={onSearchWithStockLevel} />
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
            {searchResults.length > 0
              ? `Výsledky (${searchResults.length})`
              : displayCandidates.length > 0
                ? `Kandidáti (${displayCandidates.length})`
                : "Kandidáti"}
          </p>
          <div className="space-y-1.5">
            {displayCandidates.map((product, idx) => {
              const isAiPick = searchResults.length === 0 && product.sku === aiPickedSku;
              return (
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
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition-all ${
                  selectedProduct?.sku === product.sku
                    ? "border-kv-navy bg-kv-navy/5 ring-1 ring-kv-navy/20"
                    : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <ProductThumbnail sku={product.sku} name={product.name} size="md" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-kv-dark truncate">{product.name}</p>
                      <ProductInfoPopover product={product} size="md" />
                    </div>
                    <p
                      className="h-4 truncate text-[11px] text-kv-gray-400 whitespace-nowrap overflow-hidden"
                      title={product.description ?? undefined}
                    >
                      {product.description ?? ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-kv-gray-400">
                      <span className="flex items-center gap-0.5">
                        <span className="font-mono">{product.sku}</span>
                        <CopySkuButton sku={product.sku} />
                      </span>
                      {product.manufacturer_code && (
                        <span>{product.manufacturer_code}</span>
                      )}
                      {product.manufacturer && (
                        <span>{product.manufacturer}</span>
                      )}
                      {product.current_price != null && (
                        <span className="font-medium text-kv-dark tabular-nums">
                          {new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(product.current_price)}
                          {product.unit && <span className="ml-0.5 font-normal text-kv-gray-400">/{product.unit}</span>}
                        </span>
                      )}
                      <StockBadge product={product} token={token} />
                      {product.status_sales_code && (() => {
                        const code = product.status_sales_code!;
                        const variant = getStatusVariant(code);
                        const variantClass = {
                          green: "border-emerald-200 bg-emerald-50 text-emerald-700",
                          amber: "border-amber-200 bg-amber-50 text-amber-700",
                          red:   "border-red-200 bg-red-50 text-red-600",
                          gray:  "border-kv-gray-200 bg-kv-gray-100 text-kv-gray-500",
                        }[variant];
                        const dotClass = { green: "bg-emerald-500", amber: "bg-amber-400", red: "bg-red-500", gray: "bg-kv-gray-300" }[variant];
                        const label = STATUS_LABELS[code] ?? product.status_sales_text ?? code;
                        return (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${variantClass}`}
                            title={product.status_sales_text ?? code}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                            {label}
                          </span>
                        );
                      })()}
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
                      className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kv-navy text-white transition-colors hover:bg-kv-red"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              );
            })}
            {displayCandidates.length === 0 && (
              <p className="py-6 text-center text-xs text-kv-gray-400">
                {searchQuery.length >= MIN_SEARCH_LENGTH && !isSearching
                  ? "Žádné výsledky. Zkuste jiný dotaz."
                  : "Žádní kandidáti. Začněte psát pro vyhledání."}
              </p>
            )}
          </div>

          {/* Manual SKU — toggle */}
          <div className="mt-3 border-t border-kv-gray-100 pt-3">
            {!showManualInput ? (
              <button
                type="button"
                onClick={() => setShowManualInput(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-kv-gray-200 py-2 text-xs font-medium text-kv-gray-400 transition-colors hover:border-kv-navy/30 hover:bg-kv-gray-50 hover:text-kv-navy"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Zadat vlastní kód
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={manualSku}
                  onChange={(e) => setManualSku(e.target.value)}
                  placeholder="SAP kód produktu…"
                  className="min-w-0 flex-1 rounded-xl border border-kv-navy/30 bg-kv-gray-50 px-3 py-2 font-mono text-sm text-kv-dark outline-none ring-2 ring-kv-navy/10 transition-colors placeholder:text-kv-gray-300 focus:bg-white"
                />
                <button
                  type="button"
                  onClick={() => { setShowManualInput(false); setManualSku(""); }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-kv-gray-400 transition-colors hover:bg-kv-gray-100 hover:text-kv-gray-600"
                  title="Zrušit"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
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
