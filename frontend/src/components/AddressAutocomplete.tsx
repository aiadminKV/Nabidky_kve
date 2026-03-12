"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  address: {
    road?: string;
    house_number?: string;
    city?: string;
    town?: string;
    village?: string;
    suburb?: string;
    postcode?: string;
    country?: string;
  };
}

function formatAddress(result: NominatimResult): string {
  const a = result.address;
  const parts: string[] = [];

  if (a.road) {
    parts.push(a.house_number ? `${a.road} ${a.house_number}` : a.road);
  }

  const city = a.city ?? a.town ?? a.village;
  if (city) parts.push(city);
  if (a.postcode) parts.push(a.postcode);

  return parts.length > 0 ? parts.join(", ") : result.display_name;
}

function formatSuggestionParts(result: NominatimResult): { primary: string; secondary: string } {
  const a = result.address;
  const street = a.road
    ? a.house_number ? `${a.road} ${a.house_number}` : a.road
    : "";
  const city = a.city ?? a.town ?? a.village ?? "";
  const postcode = a.postcode ?? "";

  const primary = street || city || result.display_name;
  const secondaryParts = [street ? city : "", postcode].filter(Boolean);
  const secondary = secondaryParts.join(", ");

  return { primary, secondary };
}

export function AddressAutocomplete({
  value,
  onChange,
  placeholder = "Začněte psát adresu…",
}: AddressAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const abortRef = useRef<AbortController>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const search = useCallback(async (q: string) => {
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        format: "json",
        addressdetails: "1",
        limit: "5",
        countrycodes: "cz",
        "accept-language": "cs",
      });
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {
          signal: controller.signal,
          headers: { "User-Agent": "KV-Offer-Manager/1.0" },
        },
      );
      const data: NominatimResult[] = await res.json();
      setSuggestions(data);
      setOpen(data.length > 0);
      setActiveIndex(-1);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInputChange = (val: string) => {
    setQuery(val);
    onChange(val);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 400);
  };

  const selectSuggestion = (suggestion: NominatimResult) => {
    const formatted = formatAddress(suggestion);
    setQuery(formatted);
    onChange(formatted);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kv-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
          />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          className="w-full rounded-xl border border-kv-gray-200 bg-white pl-9 pr-8 py-2 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
        />
        {isLoading && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <svg className="h-4 w-4 animate-spin text-kv-gray-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
        {!isLoading && query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              onChange("");
              setSuggestions([]);
              setOpen(false);
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-kv-gray-300 hover:bg-kv-gray-100 hover:text-kv-gray-500 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute top-full left-0 z-50 mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8">
          {suggestions.map((s, i) => {
            const { primary, secondary } = formatSuggestionParts(s);
            return (
              <button
                key={s.place_id}
                type="button"
                onClick={() => selectSuggestion(s)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  i === activeIndex
                    ? "bg-kv-navy/5"
                    : "hover:bg-kv-gray-50"
                } ${i < suggestions.length - 1 ? "border-b border-kv-gray-100" : ""}`}
              >
                <svg
                  className="mt-0.5 h-4 w-4 shrink-0 text-kv-red/60"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                </svg>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-kv-dark truncate">{primary}</div>
                  {secondary && (
                    <div className="text-xs text-kv-gray-400 truncate">{secondary}</div>
                  )}
                </div>
              </button>
            );
          })}
          <div className="flex items-center justify-end gap-1 px-3 py-1.5 text-[10px] text-kv-gray-300 border-t border-kv-gray-50">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
            OpenStreetMap
          </div>
        </div>
      )}
    </div>
  );
}
