"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";
import { useDebouncedValue } from "@/lib/hooks";
import {
  uploadPricelist,
  previewColumns,
  analyzePricelist,
  applyPricelist,
  getPricelistHistory,
  getProductsPreview,
  getPricelistStats,
  type ProductsPreviewResponse,
  type PricelistStats,
  type ColumnPreviewResponse,
} from "@/lib/api";
import { ProductInfoPopover } from "@/components/ProductInfoPopover";
import type { DiffSummary, PricelistPhase, PricelistUpload } from "@/lib/types";

interface PricelistClientProps {
  email: string;
  isAdmin?: boolean;
}

interface ProgressInfo {
  message: string;
  percent: number;
}

type Tab = "preview" | "upload";

export function PricelistClient({ email, isAdmin }: PricelistClientProps) {
  const [activeTab, setActiveTab] = useState<Tab>("preview");

  // Upload state
  const [phase, setPhase] = useState<PricelistPhase>("idle");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [progress, setProgress] = useState<ProgressInfo>({ message: "", percent: 0 });
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PricelistUpload[]>([]);
  const [applyResult, setApplyResult] = useState<{
    upserted: number;
    removed: number;
    errors: number;
  } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Column mapping state
  const [columnPreview, setColumnPreview] = useState<ColumnPreviewResponse | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});

  // Preview state
  const [previewData, setPreviewData] = useState<ProductsPreviewResponse | null>(null);
  const [stats, setStats] = useState<PricelistStats | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const getToken = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const token = await getToken();
      const uploads = await getPricelistHistory(token);
      setHistory(uploads);
    } catch {
      // silent
    }
  }, [getToken]);

  const loadPreview = useCallback(
    async (page = 0, search = "") => {
      setPreviewLoading(true);
      try {
        const token = await getToken();
        const data = await getProductsPreview(token, { page, pageSize: 50, search });
        setPreviewData(data);
      } catch {
        // silent
      } finally {
        setPreviewLoading(false);
      }
    },
    [getToken],
  );

  const loadStats = useCallback(async () => {
    try {
      const token = await getToken();
      const data = await getPricelistStats(token);
      setStats(data);
    } catch {
      // silent
    }
  }, [getToken]);

  useEffect(() => {
    loadHistory();
    loadStats();
  }, [loadHistory, loadStats]);

  useEffect(() => {
    loadPreview(previewPage, debouncedSearch);
  }, [previewPage, debouncedSearch, loadPreview]);

  useEffect(() => {
    setPreviewPage(0);
  }, [debouncedSearch]);

  const handleReset = useCallback(() => {
    setPhase("idle");
    setUploadId(null);
    setFilename(null);
    setDiff(null);
    setProgress({ message: "", percent: 0 });
    setError(null);
    setApplyResult(null);
    setColumnPreview(null);
    setColumnMapping({});
  }, []);

  const handleFileSelect = useCallback(
    async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!ext || !["xlsx", "xls", "csv"].includes(ext)) {
        setError("Podporované formáty: .xlsx, .xls, .csv");
        return;
      }

      setError(null);
      setPhase("uploading");
      setFilename(file.name);
      setProgress({ message: "Nahrávání souboru…", percent: 0 });

      try {
        const token = await getToken();
        const result = await uploadPricelist(file, token);
        setUploadId(result.uploadId);

        setProgress({ message: "Načítání sloupců…", percent: 50 });

        const preview = await previewColumns(result.uploadId, token);
        setColumnPreview(preview);
        setColumnMapping(preview.suggestedMapping);
        setPhase("mapping");
        setProgress({ message: "Zkontrolujte mapování sloupců", percent: 100 });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Nahrávání selhalo");
        setPhase("failed");
      }
    },
    [getToken],
  );

  const handleConfirmMapping = useCallback(async () => {
    if (!uploadId) return;

    const hasSkuMapping = Object.values(columnMapping).includes("sku");
    if (!hasSkuMapping) {
      setError("Sloupec SKU (identifikátor produktu) musí být namapován");
      return;
    }

    setError(null);
    setPhase("analyzing");
    setProgress({ message: "Parsování souboru…", percent: 10 });

    try {
      const token = await getToken();
      const stream = analyzePricelist(uploadId, token, columnMapping);

      for await (const event of stream) {
        switch (event.type) {
          case "status":
            setProgress((p) => ({
              ...p,
              message: (event.data as { message?: string }).message ?? p.message,
            }));
            break;
          case "parse_complete":
            setProgress({ message: "Soubor naparsován, načítám DB…", percent: 40 });
            break;
          case "db_loading":
            setProgress((p) => ({
              ...p,
              message: `Načteno ${(event.data as { loaded: number }).loaded} produktů z DB…`,
              percent: 50,
            }));
            break;
          case "analysis_complete": {
            const summary = event.data as unknown as DiffSummary;
            setDiff(summary);
            setPhase("analyzed");
            setProgress({ message: "Analýza dokončena", percent: 100 });
            break;
          }
          case "error":
            setError((event.data as { message: string }).message);
            setPhase("failed");
            break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analýza selhala");
      setPhase("failed");
    }
  }, [uploadId, columnMapping, getToken]);

  const handleApply = useCallback(async () => {
    if (!uploadId) return;

    setPhase("applying");
    setProgress({ message: "Aplikuji změny…", percent: 0 });
    setError(null);

    try {
      const token = await getToken();
      const stream = applyPricelist(uploadId, token);

      for await (const event of stream) {
        switch (event.type) {
          case "status":
            setProgress((p) => ({
              ...p,
              message: (event.data as { message?: string }).message ?? p.message,
            }));
            break;
          case "upsert_progress": {
            const d = event.data as { percent: number; upserted: number; total: number };
            setProgress({
              message: `Upsert: ${d.upserted.toLocaleString("cs")} / ${d.total.toLocaleString("cs")}`,
              percent: Math.round(d.percent * 0.8),
            });
            break;
          }
          case "delete_progress": {
            const d = event.data as { percent: number; removed: number; total: number };
            setProgress({
              message: `Mazání: ${d.removed.toLocaleString("cs")} / ${d.total.toLocaleString("cs")}`,
              percent: 80 + Math.round(d.percent * 0.2),
            });
            break;
          }
          case "apply_complete": {
            const result = event.data as { upserted: number; removed: number; errors: number };
            setApplyResult(result);
            setPhase("completed");
            setProgress({ message: "Hotovo!", percent: 100 });
            loadHistory();
            loadPreview(0, "");
            loadStats();
            break;
          }
          case "error":
            setError((event.data as { message: string }).message);
            setPhase("failed");
            break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Aplikování změn selhalo");
      setPhase("failed");
    }
  }, [uploadId, getToken, loadHistory, loadPreview, loadStats]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-kv-gray-50">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto max-w-6xl px-6 py-8">
          {/* Page header + tabs */}
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h2 className="text-xl font-bold text-kv-dark">Správa ceníku</h2>
              <p className="mt-1 text-sm text-kv-gray-500">
                Prohlížejte aktuální katalog produktů nebo nahrajte nový ceník.
              </p>
            </div>

            {stats && (
              <div className="flex items-center gap-2 rounded-xl bg-white border border-kv-gray-200 px-4 py-2">
                <span className="text-xs text-kv-gray-500">Produktů v DB:</span>
                <span className="text-sm font-bold text-kv-dark tabular-nums">
                  {stats.totalProducts.toLocaleString("cs")}
                </span>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="mb-6 flex gap-1 rounded-xl bg-kv-gray-100 p-1 w-fit">
            <button
              onClick={() => setActiveTab("preview")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === "preview"
                  ? "bg-white text-kv-dark shadow-sm"
                  : "text-kv-gray-500 hover:text-kv-gray-700"
              }`}
            >
              Náhled ceníku
            </button>
            <button
              onClick={() => setActiveTab("upload")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === "upload"
                  ? "bg-white text-kv-dark shadow-sm"
                  : "text-kv-gray-500 hover:text-kv-gray-700"
              }`}
            >
              Nahrát nový ceník
            </button>
          </div>

          {/* ──── Preview Tab ──── */}
          {activeTab === "preview" && (
            <div className="space-y-4">
              {/* Search bar */}
              <div className="relative">
                <svg
                  className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-kv-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
                <input
                  type="text"
                  placeholder="Hledat podle SKU, názvu nebo kódu výrobce…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="w-full rounded-xl border border-kv-gray-200 bg-white py-2.5 pl-10 pr-10 text-sm text-kv-dark placeholder:text-kv-gray-400 focus:border-kv-red focus:outline-none focus:ring-1 focus:ring-kv-red"
                />
                {previewLoading && searchInput && (
                  <div className="absolute right-10 top-1/2 -translate-y-1/2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-kv-gray-300 border-t-kv-red" />
                  </div>
                )}
                {searchInput && (
                  <button
                    onClick={() => setSearchInput("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-kv-gray-400 hover:text-kv-gray-600"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Products table */}
              <div className="overflow-hidden rounded-xl border border-kv-gray-200 bg-white">
                {previewLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-kv-gray-300 border-t-kv-red" />
                    <span className="ml-3 text-sm text-kv-gray-500">Načítání…</span>
                  </div>
                ) : previewData && previewData.products.length > 0 ? (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-kv-gray-100 bg-kv-gray-50">
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500 whitespace-nowrap">SKU</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500">Název</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500 whitespace-nowrap">Kód výrobce</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500">Výrobce</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500">Kategorie</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500 whitespace-nowrap">MJ</th>
                            <th className="px-3 py-2.5 font-medium text-kv-gray-500 text-right whitespace-nowrap">Cena</th>
                            <th className="px-2 py-2.5 w-8" />
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.products.map((p) => (
                            <tr key={p.sku} className="border-b border-kv-gray-100 last:border-b-0 hover:bg-kv-gray-50">
                              <td className="px-3 py-2 font-mono text-kv-gray-700 whitespace-nowrap">{p.sku}</td>
                              <td className="px-3 py-2 text-kv-gray-800 max-w-[300px] truncate" title={p.name}>
                                {p.name}
                              </td>
                              <td className="px-3 py-2 font-mono text-kv-gray-600 whitespace-nowrap">{p.manufacturer_code ?? "–"}</td>
                              <td className="px-3 py-2 text-kv-gray-600 whitespace-nowrap">{p.manufacturer ?? "–"}</td>
                              <td className="px-3 py-2 text-kv-gray-500 max-w-[180px] truncate" title={[p.category, p.subcategory].filter(Boolean).join(" > ")}>
                                {p.category ?? "–"}
                              </td>
                              <td className="px-3 py-2 text-kv-gray-500 whitespace-nowrap">{p.unit ?? "–"}</td>
                              <td className="px-3 py-2 text-right text-kv-gray-700 tabular-nums whitespace-nowrap">
                                {p.price != null ? `${p.price.toLocaleString("cs")} Kč` : "–"}
                              </td>
                              <td className="px-2 py-2">
                                <ProductInfoPopover product={p} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    <div className="flex items-center justify-between border-t border-kv-gray-100 px-4 py-3">
                      <p className="text-xs text-kv-gray-500">
                        {debouncedSearch && <span className="font-medium">Filtrováno: </span>}
                        {previewData.total.toLocaleString("cs")} produktů
                        {previewData.totalPages > 1 && (
                          <>, stránka {previewData.page + 1} z {previewData.totalPages}</>
                        )}
                      </p>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                          disabled={previewPage === 0}
                          className="rounded-lg border border-kv-gray-200 px-3 py-1.5 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Předchozí
                        </button>
                        <button
                          onClick={() => setPreviewPage((p) => p + 1)}
                          disabled={previewPage >= (previewData?.totalPages ?? 1) - 1}
                          className="rounded-lg border border-kv-gray-200 px-3 py-1.5 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Další
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-kv-gray-400">
                    <svg className="mb-2 h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                    </svg>
                    <p className="text-sm">
                      {debouncedSearch ? "Žádné produkty neodpovídají hledání" : "Katalog je prázdný"}
                    </p>
                  </div>
                )}
              </div>

              {/* Category stats */}
              {stats && stats.categories.length > 0 && (
                <div className="rounded-xl border border-kv-gray-200 bg-white p-4">
                  <h3 className="text-xs font-bold text-kv-gray-500 uppercase tracking-wider mb-3">Kategorie</h3>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
                    {stats.categories.map((cat) => (
                      <div key={cat.category} className="flex items-center justify-between py-1">
                        <span className="text-xs text-kv-gray-600 truncate max-w-[150px]" title={cat.category}>
                          {cat.category}
                        </span>
                        <span className="ml-2 text-xs font-medium text-kv-gray-400 tabular-nums">
                          {cat.count.toLocaleString("cs")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ──── Upload Tab ──── */}
          {activeTab === "upload" && (
            <div className="space-y-6">
              {/* Upload area */}
              {(phase === "idle" || phase === "failed") && (
                <div
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  className={`
                    relative rounded-2xl border-2 border-dashed p-12 text-center transition-colors cursor-pointer
                    ${isDragOver
                      ? "border-kv-red bg-kv-red-light/30"
                      : "border-kv-gray-300 bg-white hover:border-kv-gray-400 hover:bg-kv-gray-50"
                    }
                  `}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFileSelect(file);
                      e.target.value = "";
                    }}
                  />

                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-kv-gray-100">
                    <svg className="h-7 w-7 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>

                  <p className="text-sm font-medium text-kv-gray-700">
                    Přetáhněte Excel soubor sem nebo klikněte pro výběr
                  </p>
                  <p className="mt-1 text-xs text-kv-gray-400">
                    Podporované formáty: .xlsx, .xls, .csv &middot; Nový soubor se stane zdrojem pravdy
                  </p>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="rounded-xl border border-status-not-found/20 bg-status-not-found-bg p-4">
                  <div className="flex items-start gap-3">
                    <svg className="mt-0.5 h-5 w-5 shrink-0 text-status-not-found" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                    </svg>
                    <div>
                      <p className="text-sm font-medium text-status-not-found">Chyba</p>
                      <p className="mt-0.5 text-sm text-kv-gray-600">{error}</p>
                    </div>
                  </div>
                  {phase === "failed" && (
                    <button
                      onClick={handleReset}
                      className="mt-3 rounded-lg bg-kv-gray-100 px-4 py-2 text-xs font-medium text-kv-gray-700 hover:bg-kv-gray-200 transition-colors"
                    >
                      Zkusit znovu
                    </button>
                  )}
                </div>
              )}

              {/* Progress */}
              {(phase === "uploading" || phase === "analyzing" || phase === "applying") && (
                <div className="rounded-2xl border border-kv-gray-200 bg-white p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-kv-gray-300 border-t-kv-red" />
                    <div>
                      <p className="text-sm font-medium text-kv-dark">
                        {phase === "uploading" && "Nahrávání souboru…"}
                        {phase === "analyzing" && "Analýza ceníku…"}
                        {phase === "applying" && "Aplikování změn…"}
                      </p>
                      {filename && <p className="text-xs text-kv-gray-400">{filename}</p>}
                    </div>
                  </div>

                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-kv-gray-100">
                    <div
                      className="absolute left-0 top-0 h-full rounded-full bg-kv-red transition-all duration-500"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-kv-gray-500">{progress.message}</p>
                </div>
              )}

              {/* Column mapping */}
              {phase === "mapping" && columnPreview && (
                <div className="rounded-2xl border border-kv-gray-200 bg-white p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-bold text-kv-dark">Mapování sloupců</h3>
                      <p className="mt-0.5 text-xs text-kv-gray-500">
                        Zkontrolujte a upravte přiřazení sloupců. Soubor obsahuje {columnPreview.totalRows.toLocaleString("cs")} řádků.
                      </p>
                    </div>
                    {filename && (
                      <span className="rounded-lg bg-kv-gray-100 px-3 py-1.5 text-xs font-medium text-kv-gray-600">
                        {filename}
                      </span>
                    )}
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-kv-gray-200">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-kv-gray-100 bg-kv-gray-50">
                          <th className="px-3 py-2.5 text-left font-medium text-kv-gray-500 whitespace-nowrap w-[180px]">Sloupec v souboru</th>
                          <th className="px-3 py-2.5 text-left font-medium text-kv-gray-500 whitespace-nowrap w-[200px]">Mapovat na</th>
                          <th className="px-3 py-2.5 text-left font-medium text-kv-gray-500">Ukázka dat</th>
                        </tr>
                      </thead>
                      <tbody>
                        {columnPreview.headers.map((header, idx) => {
                          const mappedField = columnMapping[String(idx)] ?? "";
                          const isSkuMapped = mappedField === "sku";
                          return (
                            <tr
                              key={idx}
                              className={`border-b border-kv-gray-100 last:border-b-0 ${
                                isSkuMapped ? "bg-green-50" : mappedField ? "bg-white" : "bg-kv-gray-50/50"
                              }`}
                            >
                              <td className="px-3 py-2 font-mono text-kv-gray-700 whitespace-nowrap">
                                {header || <span className="text-kv-gray-300 italic">prázdný</span>}
                              </td>
                              <td className="px-3 py-2">
                                <select
                                  value={mappedField}
                                  onChange={(e) => {
                                    const newValue = e.target.value;
                                    setColumnMapping((prev) => {
                                      const next = { ...prev };
                                      if (newValue) {
                                        for (const [k, v] of Object.entries(next)) {
                                          if (v === newValue) delete next[k];
                                        }
                                        next[String(idx)] = newValue;
                                      } else {
                                        delete next[String(idx)];
                                      }
                                      return next;
                                    });
                                  }}
                                  className={`w-full rounded-lg border px-2 py-1.5 text-xs outline-none transition-colors ${
                                    isSkuMapped
                                      ? "border-green-300 bg-green-50 text-green-800 font-semibold"
                                      : mappedField
                                        ? "border-kv-gray-200 bg-white text-kv-gray-700"
                                        : "border-kv-gray-200 bg-kv-gray-50 text-kv-gray-400"
                                  } focus:border-kv-red/30 focus:ring-1 focus:ring-kv-red/10`}
                                >
                                  <option value="">— přeskočit —</option>
                                  {columnPreview.productFields.map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}{f.required ? " *" : ""}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-3 py-2 text-kv-gray-500 max-w-[300px]">
                                <div className="flex gap-2 overflow-hidden">
                                  {columnPreview.sampleRows.slice(0, 3).map((row, ri) => (
                                    <span key={ri} className="truncate rounded bg-kv-gray-100 px-1.5 py-0.5 text-[11px]" title={row[idx] ?? ""}>
                                      {row[idx]?.slice(0, 30) || "–"}
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {!Object.values(columnMapping).includes("sku") && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
                      <p className="text-xs font-medium text-amber-800">
                        Sloupec SKU (identifikátor produktu) musí být namapován pro pokračování.
                      </p>
                    </div>
                  )}

                  <div className="mt-5 flex gap-3">
                    <button
                      onClick={handleConfirmMapping}
                      disabled={!Object.values(columnMapping).includes("sku")}
                      className="rounded-xl bg-kv-red px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Potvrdit mapování a analyzovat
                    </button>
                    <button
                      onClick={handleReset}
                      className="rounded-xl border border-kv-gray-200 px-6 py-2.5 text-sm font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50"
                    >
                      Zrušit
                    </button>
                  </div>
                </div>
              )}

              {/* Diff summary */}
              {phase === "analyzed" && diff && (
                <div className="rounded-2xl border border-kv-gray-200 bg-white p-6">
                  <h3 className="text-sm font-bold text-kv-dark mb-4">Přehled změn</h3>

                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <StatCard label="V souboru" value={diff.totalInFile} color="text-kv-gray-700" bg="bg-kv-gray-50" />
                    <StatCard label="Aktuálně v DB" value={diff.totalInDb} color="text-kv-gray-700" bg="bg-kv-gray-50" />
                    <StatCard label="Nové produkty" value={diff.toAdd} color="text-status-match" bg="bg-status-match-bg" />
                    <StatCard label="K odebrání" value={diff.toRemove} color="text-status-not-found" bg="bg-status-not-found-bg" />
                  </div>

                  <div className="mt-4 rounded-xl bg-kv-gray-50 p-4">
                    <p className="text-xs text-kv-gray-600">
                      <strong>{diff.toUpdate.toLocaleString("cs")}</strong> existujících produktů bude aktualizováno.
                      Embeddingy budou vymazány a bude potřeba je přegenerovat.
                    </p>
                    {diff.sampleNew.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-kv-gray-500">Ukázka nových SKU:</p>
                        <p className="text-xs font-mono text-kv-gray-600">{diff.sampleNew.join(", ")}</p>
                      </div>
                    )}
                    {diff.sampleRemove.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-kv-gray-500">Ukázka odebíraných SKU:</p>
                        <p className="text-xs font-mono text-kv-gray-600">{diff.sampleRemove.join(", ")}</p>
                      </div>
                    )}
                  </div>

                  <div className="mt-6 flex gap-3">
                    <button
                      onClick={handleApply}
                      className="rounded-xl bg-kv-red px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-kv-red-dark"
                    >
                      Potvrdit a aplikovat změny
                    </button>
                    <button
                      onClick={handleReset}
                      className="rounded-xl border border-kv-gray-200 px-6 py-2.5 text-sm font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50"
                    >
                      Zrušit
                    </button>
                  </div>
                </div>
              )}

              {/* Completion */}
              {phase === "completed" && applyResult && (
                <div className="rounded-2xl border border-status-match/20 bg-status-match-bg p-6">
                  <div className="flex items-start gap-3 mb-4">
                    <svg className="mt-0.5 h-6 w-6 shrink-0 text-status-match" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                    </svg>
                    <div>
                      <p className="text-sm font-bold text-status-match">Ceník úspěšně aktualizován</p>
                      <p className="mt-1 text-sm text-kv-gray-600">
                        Upsertováno: <strong>{applyResult.upserted.toLocaleString("cs")}</strong>,
                        Odebráno: <strong>{applyResult.removed.toLocaleString("cs")}</strong>
                        {applyResult.errors > 0 && (
                          <>, Chyby: <strong className="text-status-not-found">{applyResult.errors}</strong></>
                        )}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      handleReset();
                      setActiveTab("preview");
                    }}
                    className="rounded-xl bg-white border border-kv-gray-200 px-6 py-2.5 text-sm font-medium text-kv-gray-700 transition-colors hover:bg-kv-gray-50"
                  >
                    Zobrazit aktuální ceník
                  </button>
                </div>
              )}

              {/* Upload history */}
              {history.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-kv-dark mb-3">Historie nahrávání</h3>
                  <div className="overflow-hidden rounded-xl border border-kv-gray-200 bg-white">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-kv-gray-100 bg-kv-gray-50">
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500">Soubor</th>
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500">Stav</th>
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500 text-right">V souboru</th>
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500 text-right">Přidáno</th>
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500 text-right">Odebráno</th>
                          <th className="px-4 py-2.5 font-medium text-kv-gray-500">Datum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((upload) => (
                          <tr key={upload.id} className="border-b border-kv-gray-100 last:border-b-0">
                            <td className="px-4 py-2.5 font-medium text-kv-gray-700 truncate max-w-[200px]">
                              {upload.filename}
                            </td>
                            <td className="px-4 py-2.5">
                              <UploadStatusBadge status={upload.status} />
                            </td>
                            <td className="px-4 py-2.5 text-right text-kv-gray-600 tabular-nums">
                              {upload.total_in_file?.toLocaleString("cs") ?? "–"}
                            </td>
                            <td className="px-4 py-2.5 text-right text-status-match tabular-nums">
                              {upload.items_added != null ? `+${upload.items_added.toLocaleString("cs")}` : "–"}
                            </td>
                            <td className="px-4 py-2.5 text-right text-status-not-found tabular-nums">
                              {upload.items_removed != null ? `-${upload.items_removed.toLocaleString("cs")}` : "–"}
                            </td>
                            <td className="px-4 py-2.5 text-kv-gray-500">
                              {new Date(upload.created_at).toLocaleString("cs")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  return (
    <div className={`rounded-xl ${bg} p-4`}>
      <p className="text-xs text-kv-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color}`}>
        {value.toLocaleString("cs")}
      </p>
    </div>
  );
}

function UploadStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    pending: { label: "Čeká", className: "bg-kv-gray-100 text-kv-gray-500" },
    analyzing: { label: "Analyzuje se", className: "bg-status-uncertain-bg text-status-uncertain" },
    analyzed: { label: "Analyzováno", className: "bg-status-multiple-bg text-status-multiple" },
    applying: { label: "Aplikuje se", className: "bg-status-uncertain-bg text-status-uncertain" },
    completed: { label: "Dokončeno", className: "bg-status-match-bg text-status-match" },
    failed: { label: "Chyba", className: "bg-status-not-found-bg text-status-not-found" },
  };

  const { label, className } = config[status] ?? config.pending;

  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${className}`}>
      {label}
    </span>
  );
}
