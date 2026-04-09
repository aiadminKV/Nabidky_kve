"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SearchPreferences } from "@/lib/types";
import { getBranches, type Branch } from "@/lib/api";

interface PreSearchModalProps {
  token: string;
  itemCount: number;
  onConfirm: (prefs: SearchPreferences) => void;
  onCancel: () => void;
}

type Scope = "stock_items_only" | "any";
/** "in_stock_anywhere" = Skladem kdekoliv, "branch" = Skladem na pobočce, "none" = Bez filtru */
type Availability = "in_stock_anywhere" | "branch" | "none";

function mapToPrefs(scope: Scope, availability: Availability, branch: string): SearchPreferences {
  if (scope === "stock_items_only") {
    if (availability === "branch") return { stockFilter: "stock_items_only", branchFilter: branch || null };
    if (availability === "none") return { stockFilter: "stock_items_only", branchFilter: null };
    // "in_stock_anywhere" = skladovky + aktuálně skladem
    return { stockFilter: "stock_items_in_stock", branchFilter: null };
  }
  // scope === "any" (Celý katalog)
  if (availability === "in_stock_anywhere") return { stockFilter: "in_stock", branchFilter: null };
  if (availability === "branch") return { stockFilter: "any", branchFilter: branch || null };
  return { stockFilter: "any", branchFilter: null };
}

function branchLabel(b: Branch): string {
  if (b.name && b.name !== b.code) return `${b.code} — ${b.name}`;
  return b.code;
}

export function PreSearchModal({ token, itemCount, onConfirm, onCancel }: PreSearchModalProps) {
  const [scope, setScope] = useState<Scope>("stock_items_only");
  const [availability, setAvailability] = useState<Availability>("none");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const branchTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLoadingBranches(true);
    getBranches(token)
      .then(setBranches)
      .finally(() => setLoadingBranches(false));
  }, [token]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchTriggerRef.current && !branchTriggerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const openDropdown = () => {
    if (!branchTriggerRef.current) return;
    const rect = branchTriggerRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setDropdownOpen(true);
  };

  const handleScopeChange = (s: Scope) => {
    setScope(s);
    setBranch("");
  };

  const showWarning = scope === "any" && availability === "none";
  const canConfirm = availability !== "branch" || branch.trim() !== "";

  const handleConfirm = () => onConfirm(mapToPrefs(scope, availability, branch));

  const pluralItems = itemCount === 1 ? "položka" : itemCount < 5 ? "položky" : "položek";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-kv-navy/50 backdrop-blur-sm p-4 sm:items-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl flex flex-col"
        style={{ height: "640px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-kv-gray-100 px-6 py-5">
          <h2 className="text-base font-semibold text-kv-navy">Nastavení vyhledávání</h2>
          <p className="mt-0.5 text-xs text-kv-gray-400">
            {itemCount} {pluralItems} — zvolte rozsah před spuštěním
          </p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Scope */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-kv-gray-400">Rozsah produktů</p>
            <div className="grid grid-cols-2 gap-3">
              <ScopeCard
                active={scope === "stock_items_only"}
                onClick={() => handleScopeChange("stock_items_only")}
                icon={<IconBox />}
                label="Pouze skladovky"
                description="Jen produkty označené jako skladová položka"
              />
              <ScopeCard
                active={scope === "any"}
                onClick={() => handleScopeChange("any")}
                icon={<IconCatalog />}
                label="Celý katalog"
                description="Vyhledávání ve všech produktech"
              />
            </div>
          </div>

          {/* Availability */}
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-kv-gray-400">Dostupnost</p>
            <div className="space-y-2">
              <RadioOption
                checked={availability === "in_stock_anywhere"}
                onChange={() => { setAvailability("in_stock_anywhere"); setBranch(""); }}
                label="Skladem kdekoliv"
                description="Musí být aktuálně na skladě"
              />

              {/* Skladem na pobočce — branch picker via portal dropdown */}
              <div className={`rounded-xl border transition-all ${
                availability === "branch"
                  ? "border-kv-navy/30 bg-kv-navy/5"
                  : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
              }`}>
                <button
                  type="button"
                  onClick={() => {
                    if (availability !== "branch") {
                      setAvailability("branch");
                    }
                    openDropdown();
                  }}
                  ref={branchTriggerRef}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                    availability === "branch" ? "border-kv-navy bg-kv-navy" : "border-kv-gray-300"
                  }`}>
                    {availability === "branch" && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-kv-dark">Skladem na pobočce</span>
                    <span className="block text-[11px] text-kv-gray-400">
                      {availability === "branch" && branch
                        ? branchLabel(branches.find((b) => b.code === branch) ?? { code: branch, name: null })
                        : "Jen zásoby z vybrané pobočky"}
                    </span>
                  </span>
                  {availability === "branch" && (
                    <svg className={`h-4 w-4 shrink-0 text-kv-gray-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Portal dropdown — rendered into body, above everything */}
              {dropdownOpen && availability === "branch" && typeof document !== "undefined" && createPortal(
                <div
                  style={{ position: "fixed", top: dropdownPos.top, left: dropdownPos.left + dropdownPos.width * 0.2, width: dropdownPos.width * 0.8, zIndex: 9999 }}
                  className="rounded-xl border border-kv-navy/20 bg-white shadow-2xl"
                >
                  {loadingBranches ? (
                    <div className="px-4 py-3 text-center text-xs text-kv-gray-400">Načítám pobočky…</div>
                  ) : branches.length === 0 ? (
                    <div className="px-4 py-3 text-center text-xs text-kv-gray-400">Žádné pobočky</div>
                  ) : (
                    <div className="max-h-56 overflow-y-auto py-1">
                      {branches.map((b) => (
                        <button
                          key={b.code}
                          type="button"
                          onClick={() => { setBranch(b.code); setDropdownOpen(false); }}
                          className={`flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors ${
                            branch === b.code ? "bg-kv-navy text-white" : "hover:bg-kv-gray-50 text-kv-dark"
                          }`}
                        >
                          <span className={`font-mono text-xs w-16 shrink-0 ${branch === b.code ? "text-white/70" : "text-kv-gray-400"}`}>
                            {b.code}
                          </span>
                          {b.name && b.name !== b.code && (
                            <span className="truncate">{b.name}</span>
                          )}
                          {branch === b.code && (
                            <svg className="ml-auto h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>,
                document.body,
              )}

              <RadioOption
                checked={availability === "none"}
                onChange={() => { setAvailability("none"); setBranch(""); }}
                label="Bez filtru dostupnosti"
                description="Bez ohledu na aktuální dostupnost"
              />
            </div>
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
        <div className="shrink-0 flex items-center justify-between border-t border-kv-gray-100 px-6 py-4">
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

// ── Sub-components ──────────────────────────────────────────

function ScopeCard({
  active,
  disabled,
  onClick,
  icon,
  label,
  description,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative flex flex-col items-start gap-2 rounded-xl border-2 px-4 py-3.5 text-left transition-all ${
        disabled
          ? "border-kv-gray-200 bg-kv-gray-50 opacity-40 cursor-not-allowed"
          : active
            ? "border-kv-navy bg-kv-navy/5"
            : "border-kv-gray-200 hover:border-kv-gray-300 hover:bg-kv-gray-50"
      }`}
    >
      {active && !disabled && (
        <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-kv-navy">
          <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
        </span>
      )}
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active && !disabled ? "bg-kv-navy/10 text-kv-navy" : "bg-kv-gray-100 text-kv-gray-500"}`}>
        {icon}
      </span>
      <span className="text-sm font-semibold text-kv-dark">{label}</span>
      <span className="text-[11px] leading-snug text-kv-gray-400">{description}</span>
    </button>
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

function IconBox() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
    </svg>
  );
}

function IconCatalog() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
    </svg>
  );
}
