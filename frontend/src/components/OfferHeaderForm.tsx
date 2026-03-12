"use client";

import { useState } from "react";
import type { OfferHeader } from "@/lib/types";
import { DatePicker } from "./DatePicker";
import { AddressAutocomplete } from "./AddressAutocomplete";

interface OfferHeaderFormProps {
  header: OfferHeader;
  onChange: (header: OfferHeader) => void;
}

const PRIMARY_TEXT_FIELDS: Array<{
  key: keyof OfferHeader;
  label: string;
  placeholder: string;
  grow?: boolean;
}> = [
  { key: "customerIco", label: "IČ", placeholder: "12345678" },
  { key: "customerName", label: "Zákazník", placeholder: "Firma s.r.o.", grow: true },
  { key: "offerName", label: "Zakázka", placeholder: "RD Kocourkov", grow: true },
];

const SECONDARY_TEXT_FIELDS: Array<{
  key: keyof OfferHeader;
  label: string;
  placeholder: string;
  grow?: boolean;
}> = [
  { key: "phone", label: "Telefon", placeholder: "777 999 777" },
  { key: "email", label: "Email", placeholder: "info@firma.cz" },
  { key: "specialAction", label: "Spec. akce", placeholder: "Kód akce" },
  { key: "branch", label: "Pobočka", placeholder: "Smíchov" },
];

export function OfferHeaderForm({ header, onChange }: OfferHeaderFormProps) {
  const [expanded, setExpanded] = useState(false);

  const secondaryHasValues = [
    header.phone, header.email, header.specialAction,
    header.branch, header.deliveryAddress,
  ].filter((v) => v.trim() !== "").length;

  const update = (key: keyof OfferHeader, value: string) => {
    onChange({ ...header, [key]: value });
  };

  return (
    <div className="shrink-0 border-b border-kv-gray-200">
      {/* Primary row */}
      <div className="flex items-end gap-3 bg-white px-5 py-3">
        {PRIMARY_TEXT_FIELDS.map((f) => (
          <label key={f.key} className={`block ${f.grow ? "flex-1 min-w-0" : "w-32"}`}>
            <span className="mb-1 block text-xs font-semibold text-kv-navy">{f.label}</span>
            <input
              type="text"
              value={header[f.key]}
              onChange={(e) => update(f.key, e.target.value)}
              placeholder={f.placeholder}
              className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-3 py-2 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
            />
          </label>
        ))}

        {/* Date picker for delivery date */}
        <label className="block w-44">
          <span className="mb-1 block text-xs font-semibold text-kv-navy">Dodání</span>
          <DatePicker
            value={header.deliveryDate}
            onChange={(v) => update("deliveryDate", v)}
            placeholder="Vyberte datum"
          />
        </label>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex h-[38px] items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors shrink-0 ${
            expanded
              ? "border-kv-navy/20 bg-kv-navy/5 text-kv-navy"
              : "border-kv-gray-200 bg-kv-gray-50 text-kv-gray-500 hover:bg-kv-gray-100 hover:text-kv-gray-700"
          }`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
          </svg>
          Více
          {secondaryHasValues > 0 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-kv-navy text-[10px] font-semibold text-white">
              {secondaryHasValues}
            </span>
          )}
        </button>
      </div>

      {/* Secondary row */}
      {expanded && (
        <div className="flex items-end gap-3 border-t border-kv-gray-100 bg-kv-gray-50 px-5 py-3">
          {SECONDARY_TEXT_FIELDS.map((f) => (
            <label key={f.key} className={`block ${f.grow ? "flex-1 min-w-0" : "w-36"}`}>
              <span className="mb-1 block text-xs font-semibold text-kv-navy">{f.label}</span>
              <input
                type="text"
                value={header[f.key]}
                onChange={(e) => update(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="w-full rounded-xl border border-kv-gray-200 bg-white px-3 py-2 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
              />
            </label>
          ))}

          {/* Address autocomplete */}
          <label className="block flex-1 min-w-0">
            <span className="mb-1 block text-xs font-semibold text-kv-navy">Adresa dodání</span>
            <AddressAutocomplete
              value={header.deliveryAddress}
              onChange={(v) => update("deliveryAddress", v)}
              placeholder="Ulice 15, Město, 67120"
            />
          </label>
        </div>
      )}
    </div>
  );
}
