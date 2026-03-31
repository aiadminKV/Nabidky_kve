"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { searchCustomers, type CustomerSuggestion } from "@/lib/api";

interface CustomerAutocompleteProps {
  value: string;
  onSelect: (name: string, id: string, ico: string) => void;
  onChange: (name: string) => void;
  getToken: () => Promise<string>;
  placeholder?: string;
}

export function CustomerAutocomplete({
  value,
  onSelect,
  onChange,
  getToken,
  placeholder = "Firma s.r.o.",
}: CustomerAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<CustomerSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const insideInput = ref.current?.contains(target);
      const insideList = listRef.current?.contains(target);
      if (!insideInput && !insideList) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open || !inputRef.current) return;

    const updatePosition = () => {
      if (!inputRef.current) return;
      const rect = inputRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const search = useCallback(
    async (q: string) => {
      if (q.length < 2) {
        setSuggestions([]);
        setOpen(false);
        return;
      }

      setIsLoading(true);
      try {
        const token = await getToken();
        const results = await searchCustomers(q, token);
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    },
    [getToken],
  );

  const handleInputChange = (val: string) => {
    setQuery(val);
    onChange(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 350);
  };

  const selectSuggestion = (s: CustomerSuggestion) => {
    setQuery(s.name);
    onSelect(s.name, s.source_kunnr, s.ico ?? "");
    setOpen(false);
    setSuggestions([]);
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
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-kv-gray-300"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          className="w-full rounded-xl border border-kv-gray-200 bg-white pl-8 pr-8 py-2 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
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

      {open && suggestions.length > 0 && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={listRef}
            style={dropdownStyle}
            className="max-h-72 overflow-y-auto rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8"
          >
            {suggestions.map((s, i) => (
              <button
                key={s.source_kunnr}
                type="button"
                onClick={() => selectSuggestion(s)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                  i === activeIndex ? "bg-kv-navy/5" : "hover:bg-kv-gray-50"
                } ${i < suggestions.length - 1 ? "border-b border-kv-gray-100" : ""}`}
              >
                <svg
                  className="mt-0.5 h-4 w-4 shrink-0 text-kv-navy/40"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z"
                  />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-kv-dark truncate">{s.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-kv-gray-400">
                    <span className="tabular-nums">ID {s.source_kunnr}</span>
                    {s.ico && (
                      <>
                        <span className="text-kv-gray-200">·</span>
                        <span className="tabular-nums">IČ {s.ico}</span>
                      </>
                    )}
                    {s.address && (
                      <>
                        <span className="text-kv-gray-200">·</span>
                        <span className="truncate">{s.address}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
