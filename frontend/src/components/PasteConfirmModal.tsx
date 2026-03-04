"use client";

import { useMemo } from "react";

interface PasteConfirmModalProps {
  text: string;
  onImport: () => void;
  onSendAsMessage: () => void;
  onCancel: () => void;
}

export function PasteConfirmModal({
  text,
  onImport,
  onSendAsMessage,
  onCancel,
}: PasteConfirmModalProps) {
  const preview = useMemo(() => {
    const lines = text.split("\n").filter((l) => l.trim());
    const rowCount = lines.length;
    const sampleNames = lines.slice(0, 5).map((l) => {
      const cols = l.split("\t");
      return cols[0]?.trim() || l.trim();
    });
    return { rowCount, sampleNames, hasMore: rowCount > 5 };
  }, [text]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="border-b border-kv-gray-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50">
              <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M20.625 12c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5M12 14.625v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 14.625c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m0 0v.375" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-kv-gray-800">Rozpoznána tabulka</h3>
              <p className="text-xs text-kv-gray-400">
                {preview.rowCount} {preview.rowCount === 1 ? "řádek" : preview.rowCount < 5 ? "řádky" : "řádků"}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-4">
          <p className="mb-3 text-xs text-kv-gray-500">Náhled položek:</p>
          <div className="space-y-1.5">
            {preview.sampleNames.map((name, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-kv-gray-50 px-3 py-1.5">
                <span className="text-xs text-kv-gray-400">{i + 1}.</span>
                <span className="truncate text-xs text-kv-gray-700">{name}</span>
              </div>
            ))}
            {preview.hasMore && (
              <p className="px-3 text-xs italic text-kv-gray-400">
                … a dalších {preview.rowCount - 5}
              </p>
            )}
          </div>
        </div>

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
            onClick={onImport}
            className="flex-1 rounded-lg bg-kv-red px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-kv-red-dark"
          >
            Přidat do nabídky
          </button>
        </div>
      </div>
    </div>
  );
}
