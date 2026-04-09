"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { StatusBadge } from "@/components/StatusBadge";
import { StockBadge } from "@/components/StockBadge";
import { ProductInfoPopover } from "@/components/ProductInfoPopover";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { createClient } from "@/lib/supabase/client";
import {
  standaloneSearch,
  listOffers,
  createOffer,
  type OfferSummary,
} from "@/lib/api";
import type { OfferItem, SearchPreferences, Product } from "@/lib/types";
import { DEFAULT_SEARCH_PREFERENCES } from "@/lib/types";

interface SearchClientProps {
  email: string;
  isAdmin?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Kopírovat SKU"
      className="flex h-5 w-5 items-center justify-center rounded text-kv-gray-300 hover:text-kv-navy transition-colors"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
        </svg>
      )}
    </button>
  );
}

interface AddToOfferModalProps {
  product: Product;
  onClose: () => void;
  token: string;
}

function AddToOfferModal({ product, onClose, token }: AddToOfferModalProps) {
  const router = useRouter();
  const [offers, setOffers] = useState<OfferSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newOfferTitle, setNewOfferTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadOffers = useCallback(async () => {
    try {
      const { offers: list } = await listOffers(token, { limit: 20, offset: 0 });
      setOffers(list);
    } finally {
      setLoading(false);
    }
  }, [token]);

  const handleOpen = useCallback(() => {
    loadOffers();
  }, [loadOffers]);

  useEffect(() => {
    handleOpen();
  }, [handleOpen]);

  const handleSelectOffer = useCallback((offerId: string) => {
    // Navigate to the offer — the user can then add the item via chat or manually
    const sku = product.sku;
    router.push(`/offers/${offerId}?addSku=${encodeURIComponent(sku)}&addName=${encodeURIComponent(product.name)}`);
  }, [router, product]);

  const handleCreate = useCallback(async () => {
    if (!newOfferTitle.trim()) return;
    setCreating(true);
    try {
      const offer = await createOffer(newOfferTitle.trim(), token);
      router.push(`/offers/${offer.id}?addSku=${encodeURIComponent(product.sku)}&addName=${encodeURIComponent(product.name)}`);
    } finally {
      setCreating(false);
    }
  }, [newOfferTitle, token, product, router]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl border border-white/20"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-kv-gray-100 px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-kv-dark">Přidat do nabídky</h3>
              <p className="mt-0.5 text-xs text-kv-gray-400 truncate max-w-[300px]">{product.name}</p>
            </div>
            <button onClick={onClose} className="shrink-0 rounded-lg p-1 text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-dark">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 max-h-80 overflow-y-auto custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <svg className="h-5 w-5 animate-spin text-kv-gray-300" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : !offers?.length ? (
            <p className="py-6 text-center text-sm text-kv-gray-400">Žádné nabídky. Vytvořte novou.</p>
          ) : (
            <div className="space-y-1">
              {offers.map((offer) => (
                <button
                  key={offer.id}
                  onClick={() => handleSelectOffer(offer.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-kv-gray-50"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kv-navy/5">
                    <svg className="h-4 w-4 text-kv-navy" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-kv-dark truncate">{offer.title}</p>
                    <p className="text-xs text-kv-gray-400">{new Date(offer.updated_at).toLocaleDateString("cs-CZ")}</p>
                  </div>
                  <svg className="ml-auto h-4 w-4 shrink-0 text-kv-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Create new offer */}
        <div className="border-t border-kv-gray-100 px-6 py-4">
          {showCreate ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={newOfferTitle}
                onChange={(e) => setNewOfferTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Název nabídky…"
                className="flex-1 rounded-xl border border-kv-gray-200 px-3 py-2 text-sm focus:border-kv-navy focus:outline-none"
              />
              <button
                onClick={handleCreate}
                disabled={!newOfferTitle.trim() || creating}
                className="inline-flex items-center gap-1.5 rounded-xl bg-kv-red px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
              >
                {creating ? "Vytváří…" : "Vytvořit"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-kv-gray-200 py-2.5 text-xs font-medium text-kv-gray-500 hover:border-kv-navy hover:text-kv-navy transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Nová nabídka
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SearchClient({ email, isAdmin }: SearchClientProps) {
  const supabase = createClient();
  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState<SearchPreferences>(DEFAULT_SEARCH_PREFERENCES);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<OfferItem | null>(null);
  const [addToOfferProduct, setAddToOfferProduct] = useState<Product | null>(null);
  const [token, setToken] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const getToken = useCallback(async () => {
    if (token) return token;
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token ?? "";
    setToken(t);
    return t;
  }, [supabase, token]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searching) return;

    setSearching(true);
    setResult(null);

    try {
      const t = await getToken();
      const stream = standaloneSearch(q, t, preferences);

      for await (const event of stream) {
        if (event.type === "item_matched") {
          setResult(event.data as unknown as OfferItem);
        }
      }
    } catch (err) {
      console.error("Search error:", err);
    } finally {
      setSearching(false);
    }
  }, [query, searching, getToken, preferences]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  }, [handleSearch]);

  const stockFilterOptions: Array<{ value: SearchPreferences["stockFilter"]; label: string }> = [
    { value: "any", label: "Vše" },
    { value: "in_stock", label: "Skladem" },
    { value: "stock_items_only", label: "Skladovky" },
    { value: "stock_items_in_stock", label: "Skladovky skladem" },
  ];

  return (
    <div className="flex h-screen flex-col bg-kv-gray-50">
      <Header email={email} isAdmin={isAdmin} />

      <main className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-12">
        <div className="w-full max-w-2xl">
          {/* Title */}
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-black tracking-tight text-kv-dark">Vyhledávání produktů</h1>
            <p className="mt-2 text-sm text-kv-gray-400">Hledejte v katalogu KV Elektro — plný pipeline s AI evaluací</p>
          </div>

          {/* Search input */}
          <div className="rounded-2xl bg-white shadow-sm border border-kv-gray-200 p-4">
            <div className="flex gap-3">
              <div className="relative flex-1">
                <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                  <svg className="h-4 w-4 text-kv-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                  </svg>
                </div>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Název produktu, kód, EAN…"
                  className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 py-3 pl-9 pr-4 text-sm text-kv-dark placeholder-kv-gray-300 focus:border-kv-navy focus:bg-white focus:outline-none transition-colors"
                  autoFocus
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={!query.trim() || searching}
                className="inline-flex items-center gap-2 rounded-xl bg-kv-red px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {searching ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                  </svg>
                )}
                {searching ? "Hledám…" : "Hledat"}
              </button>
            </div>

            {/* Preferences */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-kv-gray-100 pt-3">
              <span className="text-[11px] font-medium text-kv-gray-400 uppercase tracking-wider">Sklad:</span>
              {stockFilterOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPreferences((p) => ({ ...p, stockFilter: opt.value }))}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    preferences.stockFilter === opt.value
                      ? "border-kv-navy bg-kv-navy text-white"
                      : "border-kv-gray-200 bg-white text-kv-gray-600 hover:border-kv-navy/40"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Result */}
          {searching && (
            <div className="mt-6 flex flex-col items-center gap-3 py-12 text-kv-gray-400">
              <svg className="h-8 w-8 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm">Prohledávám katalog…</p>
            </div>
          )}

          {result && !searching && (
            <div className="mt-6 space-y-3">
              {/* Main result card */}
              <div className={`rounded-2xl border bg-white shadow-sm transition-all ${
                result.matchType === "match"
                  ? "border-emerald-200"
                  : result.matchType === "not_found"
                    ? "border-red-200"
                    : "border-amber-200"
              }`}>
                {/* Result header */}
                <div className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-xs text-kv-gray-400 mb-1">Poptávka: <span className="font-medium text-kv-gray-600">{query}</span></p>
                    {result.reformulatedQuery && result.reformulatedQuery !== query && (
                      <p className="text-xs text-kv-gray-400 mb-2">Přeformulováno: <span className="font-medium text-kv-gray-600">{result.reformulatedQuery}</span></p>
                    )}
                    {result.product ? (
                      <div className="flex items-start gap-4">
                        <ProductThumbnail sku={result.product.sku} name={result.product.name} size="lg" />
                        <div className="min-w-0">
                          <h2 className="text-base font-bold text-kv-dark">{result.product.name}</h2>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            {result.product.manufacturer && (
                              <span className="text-xs text-kv-gray-400">{result.product.manufacturer}</span>
                            )}
                            {result.product.sku && (
                              <span className="flex items-center gap-1">
                                <span className="font-mono text-xs text-kv-gray-500">{result.product.sku}</span>
                                <CopyButton text={result.product.sku} />
                              </span>
                            )}
                            <StockBadge product={result.product} token={token} />
                            <ProductInfoPopover product={result.product} />
                          </div>
                          {result.product.current_price != null && (
                            <p className="mt-2 text-lg font-black text-kv-dark">
                              {new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(result.product.current_price)}
                              <span className="ml-1.5 text-xs font-normal text-kv-gray-400">bez DPH</span>
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm font-medium text-kv-gray-500">Produkt nenalezen v katalogu</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <StatusBadge type={result.matchType} confidence={result.confidence} />
                    {result.product && (
                      <button
                        onClick={() => setAddToOfferProduct(result.product)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-kv-navy px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-kv-navy/90 transition-colors"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        Do nabídky
                      </button>
                    )}
                  </div>
                </div>

                {/* Reasoning */}
                {result.reasoning && (
                  <div className="border-t border-kv-gray-100 px-5 py-3">
                    <p className="text-xs font-medium text-kv-gray-400 mb-1">Rozhodování AI</p>
                    <p className="text-xs text-kv-gray-600">{result.reasoning}</p>
                    {result.priceNote && (
                      <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 border border-amber-200">
                        <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                        {result.priceNote}
                      </div>
                    )}
                  </div>
                )}

                {/* Pipeline timing */}
                {result.pipelineMs != null && (
                  <div className="border-t border-kv-gray-100 px-5 py-2">
                    <span className="text-[11px] text-kv-gray-300">{result.pipelineMs}ms</span>
                  </div>
                )}
              </div>

              {/* Alternative candidates */}
              {result.candidates.length > 0 && (
                <div className="rounded-2xl border border-kv-gray-200 bg-white shadow-sm">
                  <div className="border-b border-kv-gray-100 px-5 py-3">
                    <p className="text-xs font-semibold text-kv-gray-500 uppercase tracking-wider">Alternativy ({result.candidates.length})</p>
                  </div>
                  <div className="divide-y divide-kv-gray-100">
                    {result.candidates.map((cand) => (
                      <div key={cand.sku} className="flex items-center gap-4 px-5 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-kv-dark truncate">{cand.name}</p>
                          <div className="mt-0.5 flex items-center gap-2">
                            {cand.manufacturer && <span className="text-xs text-kv-gray-400">{cand.manufacturer}</span>}
                            {cand.sku && (
                              <span className="flex items-center gap-1">
                                <span className="font-mono text-xs text-kv-gray-400">{cand.sku}</span>
                                <CopyButton text={cand.sku} />
                              </span>
                            )}
                          </div>
                        </div>
                        {cand.current_price != null && (
                          <span className="shrink-0 text-sm font-bold text-kv-dark tabular-nums">
                            {new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(cand.current_price)}
                          </span>
                        )}
                        <button
                          onClick={() => setAddToOfferProduct(cand)}
                          className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-kv-gray-200 px-2.5 py-1.5 text-xs font-medium text-kv-gray-600 hover:border-kv-navy hover:text-kv-navy transition-colors"
                        >
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                          </svg>
                          Do nabídky
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Search again hint */}
              <p className="text-center text-xs text-kv-gray-400">
                Stiskněte <kbd className="rounded border border-kv-gray-200 bg-kv-gray-50 px-1 py-0.5 font-mono text-[10px]">Enter</kbd> pro nové hledání
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Add to offer modal */}
      {addToOfferProduct && (
        <AddToOfferModal
          product={addToOfferProduct}
          token={token}
          onClose={() => setAddToOfferProduct(null)}
        />
      )}
    </div>
  );
}
