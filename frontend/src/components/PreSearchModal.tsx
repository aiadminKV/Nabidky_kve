"use client";

import { useEffect, useState } from "react";
import type { SearchPreferences } from "@/lib/types";
import { getBranches, type Branch } from "@/lib/api";

interface PreSearchModalProps {
  token: string;
  itemCount: number;
  onConfirm: (prefs: SearchPreferences) => void;
  onCancel: () => void;
}

type Scope = "stock_items_only" | "any";
type Availability = "anywhere" | "in_stock_anywhere" | "branch" | "none";

function mapToPrefs(scope: Scope, availability: Availability, branch: string): SearchPreferences {
  if (scope === "stock_items_only") {
    return {
      stockFilter: "stock_items_only",
      branchFilter: availability === "branch" && branch ? branch : null,
    };
  }
  // scope === "any" (Celý katalog)
  if (availability === "in_stock_anywhere") {
    return { stockFilter: "in_stock", branchFilter: null };
  }
  if (availability === "branch") {
    return { stockFilter: "any", branchFilter: branch || null };
  }
  // none — no availability filter
  return { stockFilter: "any", branchFilter: null };
}

export function PreSearchModal({ token, itemCount, onConfirm, onCancel }: PreSearchModalProps) {
  const [scope, setScope] = useState<Scope>("stock_items_only");
  const [availability, setAvailability] = useState<Availability>("anywhere");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    setLoadingBranches(true);
    getBranches(token)
      .then(setBranches)
      .finally(() => setLoadingBranches(false));
  }, [token]);

  // When scope changes, reset availability to a sensible default
  const handleScopeChange = (s: Scope) => {
    setScope(s);
    if (s === "stock_items_only") setAvailability("anywhere");
    else setAvailability("in_stock_anywhere");
  };

  const showWarning = scope === "any" && availability === "none";
  const canConfirm = availability !== "branch" || branch.trim() !== "";

  const handleConfirm = () => {
    const prefs = mapToPrefs(scope, availability, branch);
    onConfirm(prefs);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-kv-navy/50 backdrop-blur-sm p-4 sm:items-center">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="border-b border-kv-gray-100 px-6 py-5">
          <h2 className="text-base font-semibold text-kv-navy">Nastavení vyhledávání</h2>
          <p className="mt-0.5 text-xs text-kv-gray-400">
            {itemCount} {itemCount === 1 ? "položka" : itemCount < 5 ? "položky" : "položek"} — zvolte rozsah před spuštěním
          </p>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Scope */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-kv-gray-400">Rozsah produktů</p>
            <div className="grid grid-cols-2 gap-3">
              {/* Pouze skladovky */}
              <button
                type="button"
                onClick={() => handleScopeChange("stock_items_only")}
                className={`relative flex flex-col items-start gap-1.5 rounded-xl border-2 px-4 py-3.5 text-left transition-all ${
                  scope === "stock_items_only"
                    ? "border-kv-navy bg-kv-navy/5"
                    : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
                }`}
              >
                {scope === "stock_items_only" && (
                  <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-kv-navy">
                    <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  </span>
                )}
                <span className="text-lg">📦</span>
                <span className="text-sm font-semibold text-kv-dark">Pouze skladovky</span>
                <span className="text-[11px] leading-snug text-kv-gray-400">Jen produkty označené jako skladová položka</span>
              </button>

              {/* Celý katalog */}
              <button
                type="button"
                onClick={() => handleScopeChange("any")}
                className={`relative flex flex-col items-start gap-1.5 rounded-xl border-2 px-4 py-3.5 text-left transition-all ${
                  scope === "any"
                    ? "border-kv-navy bg-kv-navy/5"
                    : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
                }`}
              >
                {scope === "any" && (
                  <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-kv-navy">
                    <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  </span>
                )}
                <span className="text-lg">📋</span>
                <span className="text-sm font-semibold text-kv-dark">Celý katalog</span>
                <span className="text-[11px] leading-snug text-kv-gray-400">Vyhledávání ve všech produktech</span>
              </button>
            </div>
          </div>

          {/* Availability */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-kv-gray-400">Dostupnost</p>
            <div className="space-y-2">
              {scope === "stock_items_only" ? (
                <>
                  <RadioOption
                    checked={availability === "anywhere"}
                    onChange={() => setAvailability("anywhere")}
                    label="Kdekoliv"
                    description="Bez omezení pobočky"
                  />
                  <RadioOption
                    checked={availability === "branch"}
                    onChange={() => setAvailability("branch")}
                    label="Na konkrétní pobočce"
                    description="Jen zásoby z vybrané pobočky"
                  />
                </>
              ) : (
                <>
                  <RadioOption
                    checked={availability === "in_stock_anywhere"}
                    onChange={() => setAvailability("in_stock_anywhere")}
                    label="Skladem kdekoliv"
                    description="Musí být aktuálně na skladě"
                  />
                  <RadioOption
                    checked={availability === "branch"}
                    onChange={() => setAvailability("branch")}
                    label="Na konkrétní pobočce"
                    description="Jen zásoby z vybrané pobočky"
                  />
                  <RadioOption
                    checked={availability === "none"}
                    onChange={() => setAvailability("none")}
                    label="Bez filtru dostupnosti"
                    description="Vyhledá i produkty momentálně nedostupné"
                  />
                </>
              )}
            </div>

            {/* Branch dropdown */}
            {availability === "branch" && (
              <div className="mt-3">
                <select
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-3 py-2 text-sm text-kv-dark outline-none transition-colors focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
                >
                  <option value="">— Vyberte pobočku —</option>
                  {loadingBranches ? (
                    <option disabled>Načítám pobočky…</option>
                  ) : (
                    branches.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.code}{b.name ? ` — ${b.name}` : ""}
                      </option>
                    ))
                  )}
                </select>
              </div>
            )}
          </div>

          {/* Warning */}
          {showWarning && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <svg className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <p className="text-xs leading-relaxed text-amber-700">
                Vyhledávání bez omezení dostupnosti v celém katalogu může vrátit velké množství variant a prodloužit dobu vyhledávání. Doporučujeme upřesnit dostupnost.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-kv-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-kv-gray-200 px-4 py-2 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Zpět
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="inline-flex items-center gap-2 rounded-xl bg-kv-navy px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-kv-navy/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Spustit vyhledávání
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioOption({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all ${
        checked
          ? "border-kv-navy/30 bg-kv-navy/5"
          : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
        checked ? "border-kv-navy bg-kv-navy" : "border-kv-gray-300"
      }`}>
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-kv-dark">{label}</span>
        <span className="block text-[11px] text-kv-gray-400">{description}</span>
      </span>
    </button>
  );
}
