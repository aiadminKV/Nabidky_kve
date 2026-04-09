"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseRawRows,
  autoDetectMapping,
  parsePastedTextWithMapping,
  type ColumnRole,
  type ColumnMapping,
} from "@/lib/parsePaste";
import type { ParsedItem } from "@/lib/types";

const ROLE_OPTIONS: { value: ColumnRole; label: string }[] = [
  { value: "name",     label: "Název poptávky" },
  { value: "unit",     label: "Jednotka" },
  { value: "quantity", label: "Množství" },
  { value: "skip",     label: "Ignorovat" },
];

const ROLE_COLORS: Record<ColumnRole, string> = {
  name:     "bg-kv-blue-50 text-kv-blue-700 border-kv-blue-200",
  unit:     "bg-amber-50 text-amber-700 border-amber-200",
  quantity: "bg-emerald-50 text-emerald-700 border-emerald-200",
  skip:     "bg-kv-gray-100 text-kv-gray-400 border-kv-gray-200",
};

const ROLE_HEADER_COLORS: Record<ColumnRole, string> = {
  name:     "bg-kv-blue-50 border-kv-blue-200",
  unit:     "bg-amber-50 border-amber-200",
  quantity: "bg-emerald-50 border-emerald-200",
  skip:     "bg-kv-gray-50 border-kv-gray-200",
};

const MAX_PREVIEW_ROWS = 5;

// ── Custom role dropdown ────────────────────────────────────────────────────

function RoleDropdown({
  value,
  onChange,
}: {
  value: ColumnRole;
  onChange: (role: ColumnRole) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  const current = ROLE_OPTIONS.find((o) => o.value === value)!;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors ${ROLE_COLORS[value]}`}
      >
        <span>{current.label}</span>
        <svg
          className={`h-3 w-3 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-xl border border-kv-navy/20 bg-white shadow-2xl">
          {ROLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors ${
                opt.value === value
                  ? "bg-kv-navy text-white"
                  : "text-kv-dark hover:bg-kv-gray-50"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  opt.value === "name"     ? "bg-kv-blue-400" :
                  opt.value === "unit"     ? "bg-amber-400" :
                  opt.value === "quantity" ? "bg-emerald-400" :
                                             "bg-kv-gray-300"
                } ${opt.value === value ? "opacity-80" : ""}`}
              />
              {opt.label}
              {opt.value === value && (
                <svg className="ml-auto h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main modal ──────────────────────────────────────────────────────────────

interface ColumnMapperModalProps {
  text: string;
  onImport: (items: ParsedItem[]) => void;
  onSendAsMessage: () => void;
  onCancel: () => void;
}

export function ColumnMapperModal({
  text,
  onImport,
  onSendAsMessage,
  onCancel,
}: ColumnMapperModalProps) {
  const allRows = useMemo(() => parseRawRows(text), [text]);
  const numCols = useMemo(() => Math.max(...allRows.map((r) => r.length), 0), [allRows]);
  const defaultMapping = useMemo(() => autoDetectMapping(allRows), [allRows]);

  const [mapping, setMapping] = useState<ColumnMapping>(defaultMapping);

  const setRole = (colIdx: number, role: ColumnRole) =>
    setMapping((m) => ({ ...m, roles: m.roles.map((r, i) => (i === colIdx ? role : r)) }));

  const dataRows = mapping.skipFirstRow ? allRows.slice(1) : allRows;
  const totalRows = dataRows.length;
  const previewRows = allRows.slice(
    mapping.skipFirstRow ? 1 : 0,
    (mapping.skipFirstRow ? 1 : 0) + MAX_PREVIEW_ROWS,
  );

  const previewItems = useMemo(
    () => parsePastedTextWithMapping(text, mapping).slice(0, MAX_PREVIEW_ROWS),
    [text, mapping],
  );

  const headerRow = mapping.skipFirstRow && allRows.length > 0 ? allRows[0] : null;
  const colLabel = (ci: number) => headerRow?.[ci] ?? `Sloupec ${ci + 1}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-kv-gray-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50">
              <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-kv-gray-800">Mapování sloupců</h3>
              <p className="text-xs text-kv-gray-400">
                {totalRows} {totalRows === 1 ? "řádek" : totalRows < 5 ? "řádky" : "řádků"} · {numCols} {numCols === 1 ? "sloupec" : numCols < 5 ? "sloupce" : "sloupců"}
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="rounded-lg p-1.5 text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-gray-600">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Skip first row toggle */}
          <label className="flex cursor-pointer items-center gap-2.5 text-xs text-kv-gray-600 select-none">
            <input
              type="checkbox"
              checked={mapping.skipFirstRow}
              onChange={(e) => setMapping((m) => ({ ...m, skipFirstRow: e.target.checked }))}
              className="h-3.5 w-3.5 rounded border-kv-gray-300 text-kv-blue-600"
            />
            První řádek je záhlaví (přeskočit)
          </label>

          {/* Column mapping table */}
          <div className="overflow-x-auto rounded-xl border border-kv-gray-200">
            <table className="w-full text-xs" style={{ overflow: "visible" }}>
              <thead>
                <tr>
                  {Array.from({ length: numCols }, (_, ci) => (
                    <th
                      key={ci}
                      className={`border-b border-kv-gray-200 px-3 py-2 text-left font-medium ${ROLE_HEADER_COLORS[mapping.roles[ci] ?? "skip"]}`}
                      style={{ overflow: "visible" }}
                    >
                      <div className="flex flex-col gap-1.5" style={{ overflow: "visible" }}>
                        <span className="truncate text-kv-gray-500 max-w-[140px] text-[11px]">{colLabel(ci)}</span>
                        <RoleDropdown
                          value={mapping.roles[ci] ?? "skip"}
                          onChange={(role) => setRole(ci, role)}
                        />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, ri) => (
                  <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-kv-gray-50"}>
                    {Array.from({ length: numCols }, (_, ci) => {
                      const role = mapping.roles[ci] ?? "skip";
                      return (
                        <td
                          key={ci}
                          className={`px-3 py-1.5 border-b border-kv-gray-100 ${role === "skip" ? "text-kv-gray-300" : "text-kv-gray-700"}`}
                        >
                          <span className={`inline-block max-w-[160px] truncate ${role !== "skip" ? `rounded px-1 ${ROLE_COLORS[role]}` : ""}`}>
                            {row[ci] ?? ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {totalRows > MAX_PREVIEW_ROWS && (
                  <tr>
                    <td colSpan={numCols} className="px-3 py-1.5 text-center text-[11px] italic text-kv-gray-400">
                      … a dalších {totalRows - MAX_PREVIEW_ROWS} řádků
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Preview of parsed items */}
          {previewItems.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-kv-gray-400">Náhled výsledku</p>
              <div className="space-y-1">
                {previewItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg bg-kv-gray-50 px-3 py-1.5">
                    <span className="w-4 shrink-0 text-center text-[11px] text-kv-gray-400">{i + 1}.</span>
                    <span className="flex-1 truncate text-xs font-medium text-kv-gray-800">{item.name}</span>
                    {item.unit && (
                      <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                        {item.unit}
                      </span>
                    )}
                    {item.quantity != null && (
                      <span className="shrink-0 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                        {item.quantity}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {previewItems.length === 0 && (
            <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-500">
              Žádné položky — zkontroluj mapování, musí být alespoň jeden sloupec &quot;Název poptávky&quot;.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 border-t border-kv-gray-200 px-6 py-4">
          <button
            onClick={onCancel}
            className="rounded-lg border border-kv-gray-200 px-3 py-2 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Zrušit
          </button>
          <button
            onClick={onSendAsMessage}
            className="rounded-lg border border-kv-gray-200 px-3 py-2 text-xs font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-50"
          >
            Poslat jako zprávu
          </button>
          <button
            onClick={() => onImport(parsePastedTextWithMapping(text, mapping))}
            disabled={previewItems.length === 0}
            className="flex-1 rounded-lg bg-kv-red px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            Přidat do nabídky ({totalRows})
          </button>
        </div>
      </div>
    </div>
  );
}
