"use client";

import { useEffect, useRef, useState } from "react";

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const MONTHS_CS = [
  "Leden", "Únor", "Březen", "Duben", "Květen", "Červen",
  "Červenec", "Srpen", "Září", "Říjen", "Listopad", "Prosinec",
];

const DAYS_CS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

function formatDateCS(dateStr: string): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${parseInt(d)}. ${parseInt(m)}. ${y}`;
}

function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function DatePicker({ value, onChange, placeholder = "Vyberte datum" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const today = new Date();
  const selectedDate = value ? new Date(value) : null;

  const [viewYear, setViewYear] = useState(selectedDate?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(selectedDate?.getMonth() ?? today.getMonth());

  useEffect(() => {
    if (value) {
      const d = new Date(value);
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
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

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const selectDate = (day: number) => {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  };

  const selectPreset = (daysFromNow: number) => {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    onChange(toISODate(date));
    setOpen(false);
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);
  const todayISO = toISODate(today);

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const isPast = (day: number): boolean => {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return dateStr < todayISO;
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-3 py-2 text-sm text-left outline-none transition-colors hover:border-kv-gray-300 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10"
      >
        <svg className="h-4 w-4 shrink-0 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
        </svg>
        <span className={value ? "text-kv-dark font-medium" : "text-kv-gray-300"}>
          {value ? formatDateCS(value) : placeholder}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onChange("");
              }
            }}
            className="ml-auto rounded-md p-0.5 text-kv-gray-300 hover:bg-kv-gray-100 hover:text-kv-gray-500 transition-colors cursor-pointer"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1.5 w-[280px] rounded-2xl border border-kv-gray-200 bg-white p-4 shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* Quick presets */}
          <div className="mb-3 flex gap-1.5">
            {[
              { label: "Dnes", days: 0 },
              { label: "+7 dní", days: 7 },
              { label: "+14 dní", days: 14 },
              { label: "+30 dní", days: 30 },
            ].map((preset) => (
              <button
                key={preset.days}
                type="button"
                onClick={() => selectPreset(preset.days)}
                className="flex-1 rounded-lg border border-kv-gray-150 px-2 py-1.5 text-[11px] font-medium text-kv-gray-600 transition-all hover:bg-kv-navy/5 hover:border-kv-navy/20 hover:text-kv-navy active:scale-95"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="h-px bg-kv-gray-100 mb-3" />

          {/* Month navigation */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              className="rounded-lg p-1.5 text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-gray-700 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
            <span className="text-sm font-bold text-kv-navy tracking-wide">
              {MONTHS_CS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              className="rounded-lg p-1.5 text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-gray-700 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAYS_CS.map((d) => (
              <div key={d} className="flex h-8 items-center justify-center text-[10px] font-bold text-kv-gray-400 uppercase tracking-wider">
                {d}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((day, i) => {
              if (day === null) return <div key={`empty-${i}`} className="h-8" />;
              const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const isToday = dateStr === todayISO;
              const isSelected = dateStr === value;
              const past = isPast(day);

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => selectDate(day)}
                  className={`flex h-8 w-full items-center justify-center rounded-lg text-xs font-medium transition-all ${
                    isSelected
                      ? "bg-kv-navy text-white shadow-md shadow-kv-navy/25"
                      : isToday
                        ? "bg-kv-red/10 text-kv-red font-bold ring-1 ring-inset ring-kv-red/20"
                        : past
                          ? "text-kv-gray-300"
                          : "text-kv-gray-700 hover:bg-kv-gray-100 active:scale-90"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
