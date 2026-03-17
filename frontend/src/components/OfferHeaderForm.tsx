"use client";

import { useState } from "react";
import type { OfferHeader } from "@/lib/types";
import { DatePicker } from "./DatePicker";
import { AddressAutocomplete } from "./AddressAutocomplete";

interface OfferHeaderFormProps {
  header: OfferHeader;
  onChange: (header: OfferHeader) => void;
  forceExpanded?: boolean;
}

const PRIMARY_TEXT_FIELDS: Array<{
  key: keyof OfferHeader;
  label: string;
  placeholder: string;
  grow?: boolean;
}> = [
  { key: "customerId", label: "ID zákazníka", placeholder: "123456" },
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

const INPUT_CLASS =
  "w-full rounded-xl border border-kv-gray-200 bg-white px-3 py-2 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10";

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-kv-navy">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </label>
  );
}

export function OfferHeaderForm({ header, onChange, forceExpanded = false }: OfferHeaderFormProps) {
  const [expanded, setExpanded] = useState(false);

  const update = (key: keyof OfferHeader, value: string) => {
    onChange({ ...header, [key]: value });
  };
  const showExpanded = forceExpanded || expanded;

  return (
    <div className="shrink-0">
      {!forceExpanded && (
        <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`inline-flex h-10 items-center gap-2 self-start rounded-xl border px-3.5 text-xs font-medium transition-colors ${
                expanded
                  ? "border-kv-navy/20 bg-kv-navy/5 text-kv-navy"
                  : "border-kv-gray-200 bg-white text-kv-gray-500 hover:bg-kv-gray-50 hover:text-kv-gray-700"
              }`}
            >
              <svg className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
              </svg>
              {expanded ? "Skrýt doplňující údaje" : "Zobrazit doplňující údaje"}
            </button>
          </div>
        </div>
      )}

      <div className="px-6 py-5">
        {forceExpanded ? (
          <div className="grid gap-4">
            <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
              <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                <div className="grid gap-3">
                  <TextField
                    label="Zákazník"
                    value={header.customerName}
                    placeholder="Firma s.r.o."
                    onChange={(value) => update("customerName", value)}
                  />
                  <div className="grid gap-3 md:grid-cols-[120px_140px_minmax(0,1fr)]">
                    <TextField
                      label="ID zákazníka"
                      value={header.customerId}
                      placeholder="123456"
                      onChange={(value) => update("customerId", value)}
                    />
                    <TextField
                      label="IČ"
                      value={header.customerIco}
                      placeholder="12345678"
                      onChange={(value) => update("customerIco", value)}
                    />
                    <TextField
                      label="Zakázka"
                      value={header.offerName}
                      placeholder="RD Kocourkov"
                      onChange={(value) => update("offerName", value)}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                <div className="grid gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-kv-navy">Datum dodání</span>
                    <DatePicker
                      value={header.deliveryDate}
                      onChange={(v) => update("deliveryDate", v)}
                      placeholder="Vyberte datum"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-kv-navy">Adresa dodání</span>
                    <AddressAutocomplete
                      value={header.deliveryAddress}
                      onChange={(v) => update("deliveryAddress", v)}
                      placeholder="Ulice 15, Město, 67120"
                    />
                  </label>
                </div>
              </section>
            </div>

            <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {SECONDARY_TEXT_FIELDS.map((f) => (
                  <TextField
                    key={f.key}
                    label={f.label}
                    value={header[f.key]}
                    placeholder={f.placeholder}
                    onChange={(value) => update(f.key, value)}
                  />
                ))}
              </div>
            </section>
          </div>
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-[1.3fr_1.2fr_1fr]">
              <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                <div className="grid gap-3">
                  <TextField
                    label="Zákazník"
                    value={header.customerName}
                    placeholder="Firma s.r.o."
                    onChange={(value) => update("customerName", value)}
                  />
                  <div className="grid gap-3 grid-cols-2">
                    <TextField
                      label="ID zákazníka"
                      value={header.customerId}
                      placeholder="123456"
                      onChange={(value) => update("customerId", value)}
                    />
                    <TextField
                      label="IČ"
                      value={header.customerIco}
                      placeholder="12345678"
                      onChange={(value) => update("customerIco", value)}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                <TextField
                  label="Zakázka"
                  value={header.offerName}
                  placeholder="RD Kocourkov"
                  onChange={(value) => update("offerName", value)}
                />
              </section>

              <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-kv-navy">Datum dodání</span>
                  <DatePicker
                    value={header.deliveryDate}
                    onChange={(v) => update("deliveryDate", v)}
                    placeholder="Vyberte datum"
                  />
                </label>
              </section>
            </div>

            {showExpanded && (
              <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1.6fr]">
                <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    {SECONDARY_TEXT_FIELDS.map((f) => (
                      <TextField
                        key={f.key}
                        label={f.label}
                        value={header[f.key]}
                        placeholder={f.placeholder}
                        onChange={(value) => update(f.key, value)}
                      />
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 p-4">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold text-kv-navy">Adresa dodání</span>
                    <AddressAutocomplete
                      value={header.deliveryAddress}
                      onChange={(v) => update("deliveryAddress", v)}
                      placeholder="Ulice 15, Město, 67120"
                    />
                  </label>
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
