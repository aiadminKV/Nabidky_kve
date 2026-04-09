"use client";

import { useState, useEffect, useRef } from "react";
import { searchManufacturers } from "@/lib/api";

export function ManufacturerCombobox({
  value,
  onChange,
  token,
  placeholder = "Začněte psát výrobce…",
  label = "Výrobce",
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  token: string;
  placeholder?: string;
  label?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    setOpen(true);
    if (!q.trim()) { onChange(""); setResults([]); setLoading(false); return; }
    if (q.trim().length < 2) { setResults([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      setResults(await searchManufacturers(token, q));
      setLoading(false);
    }, 300);
  };

  const showDropdown = open && query.trim().length >= 2 && (loading || results.length > 0);

  return (
    <div ref={ref} className="relative">
      {label && (
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide opacity-60">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onFocus={() => { if (query.trim().length >= 2) setOpen(true); }}
          onBlur={() => { onChange(query.trim()); setOpen(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onChange(query.trim()); setOpen(false); }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder}
          className={inputClassName ?? "w-full rounded-lg border border-kv-gray-200 bg-white px-2.5 py-1.5 pr-7 text-xs text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"}
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(""); setQuery(""); setResults([]); }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded text-kv-gray-400 hover:text-kv-gray-600"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-[200px] overflow-y-auto rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150">
          {loading && results.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-kv-gray-400">Hledám…</div>
          ) : results.map((m) => (
            <button
              key={m}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(m);
                setQuery(m);
                setResults([]);
                setOpen(false);
              }}
              className={`flex w-full items-center px-2.5 py-1.5 text-xs transition-colors ${
                m === value ? "bg-kv-navy text-white font-medium" : "text-kv-gray-700 hover:bg-kv-gray-50"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
