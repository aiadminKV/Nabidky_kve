"use client";

import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  icon?: React.ReactNode;
}

export function CustomSelect({
  value,
  options,
  onChange,
  placeholder = "Vyberte…",
  label,
  icon,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      {label && (
        <span className="mb-1.5 block text-xs font-semibold text-kv-navy">{label}</span>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 rounded-xl border border-kv-gray-200 bg-white px-3 py-2 text-sm text-left outline-none transition-colors hover:border-kv-gray-300 focus:border-kv-navy/30 focus:ring-2 focus:ring-kv-navy/10"
      >
        {icon && <span className="shrink-0 text-kv-gray-400">{icon}</span>}
        <span className={selectedOption ? "text-kv-dark font-medium" : "text-kv-gray-300"}>
          {selectedOption?.label ?? placeholder}
        </span>
        <svg
          className={`ml-auto h-4 w-4 shrink-0 text-kv-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-kv-gray-200 bg-white shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150">
          {options.map((option, idx) => {
            const isActive = option.value === value;
            const isFirst = idx === 0;
            const isLast = idx === options.length - 1;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  isFirst ? "rounded-t-[11px]" : ""
                } ${isLast ? "rounded-b-[11px]" : ""} ${
                  isActive
                    ? "bg-kv-navy text-white font-medium"
                    : "text-kv-gray-700 hover:bg-kv-gray-50"
                }`}
              >
                {isActive && (
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
                <span className={isActive ? "" : "pl-[22px]"}>{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
