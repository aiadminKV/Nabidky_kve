"use client";

import { useEffect, useState } from "react";
import type { SearchPreferences } from "@/lib/types";
import { getBranches, type Branch } from "@/lib/api";
import { CustomSelect } from "./CustomSelect";

interface SearchPreferencesBarProps {
  prefs: SearchPreferences;
  onChange: (prefs: SearchPreferences) => void;
  token: string;
}

const OFFER_TYPE_OPTIONS = [
  { value: "realizace", label: "Realizace" },
  { value: "vyberko", label: "Výběrko" },
];

const STOCK_FILTER_OPTIONS = [
  { value: "any", label: "Bez omezení" },
  { value: "in_stock", label: "Pouze skladem" },
  { value: "stock_items_only", label: "Jen skladové položky" },
];

const PRICE_STRATEGY_OPTIONS = [
  { value: "standard", label: "Standardní" },
  { value: "lowest", label: "Nejnižší cena" },
];

export function SearchPreferencesBar({ prefs, onChange, token }: SearchPreferencesBarProps) {
  const [branches, setBranches] = useState<Branch[]>([]);

  useEffect(() => {
    let cancelled = false;
    getBranches(token).then((b) => {
      if (!cancelled) setBranches(b);
    });
    return () => { cancelled = true; };
  }, [token]);

  const branchOptions = [
    { value: "", label: "Všechny pobočky" },
    ...branches.map((b) => ({
      value: b.code,
      label: b.name ? `${b.code} — ${b.name}` : b.code,
    })),
  ];

  return (
    <div className="relative z-20 rounded-2xl border border-kv-gray-200 bg-white shadow-sm">
      <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">Parametry hledání</h2>
      </div>

      <div className="grid grid-cols-4 gap-3 px-4 py-3">
        <CustomSelect
          label="Typ nabídky"
          value={prefs.offerType}
          options={OFFER_TYPE_OPTIONS}
          onChange={(v) => onChange({ ...prefs, offerType: v as SearchPreferences["offerType"] })}
        />
        <CustomSelect
          label="Dostupnost"
          value={prefs.stockFilter}
          options={STOCK_FILTER_OPTIONS}
          onChange={(v) => onChange({ ...prefs, stockFilter: v as SearchPreferences["stockFilter"] })}
        />
        <CustomSelect
          label="Cenová strategie"
          value={prefs.priceStrategy}
          options={PRICE_STRATEGY_OPTIONS}
          onChange={(v) => onChange({ ...prefs, priceStrategy: v as SearchPreferences["priceStrategy"] })}
        />
        <CustomSelect
          label="Pobočka"
          value={prefs.branchFilter ?? ""}
          options={branchOptions}
          onChange={(v) => onChange({ ...prefs, branchFilter: v || null })}
          placeholder="Všechny pobočky"
        />
      </div>
    </div>
  );
}

