"use client";

import type { OfferHeader } from "@/lib/types";

interface OfferHeaderSummaryProps {
  header: OfferHeader;
  onEdit: () => void;
  compact?: boolean;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "Nezadáno";
  const [year, month, day] = dateStr.split("-");
  if (!year || !month || !day) return dateStr;
  return `${Number(day)}. ${Number(month)}. ${year}`;
}

function SummaryItem({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-xl border border-kv-gray-200 bg-kv-gray-50/70 ${compact ? "px-3 py-2.5" : "px-3.5 py-3"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-kv-gray-400">
        {label}
      </div>
      <div className={`mt-1 font-medium text-kv-dark ${compact ? "text-xs" : "text-sm"}`}>
        {value.trim() || "Nezadáno"}
      </div>
    </div>
  );
}

export function OfferHeaderSummary({ header, onEdit, compact = false }: OfferHeaderSummaryProps) {
  const filledCount = [
    header.customerId,
    header.customerName,
    header.customerIco,
    header.offerName,
    header.deliveryDate,
    header.deliveryAddress,
  ].filter((value) => value.trim() !== "").length;

  if (compact) {
    return (
      <div className="overflow-hidden rounded-2xl border border-kv-gray-200 bg-white shadow-sm">
        <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">Zákazník</h2>
                <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-kv-gray-500">
                  {filledCount}/6
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onEdit}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-kv-navy/20 bg-kv-navy/5 px-3 text-[11px] font-medium text-kv-navy transition-colors hover:bg-kv-navy/10"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487a2.25 2.25 0 1 1 3.182 3.182L7.5 20.213 3 21l.787-4.5 13.075-12.013Z" />
              </svg>
              Detail
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 px-4 py-3">
          <span className="inline-flex max-w-full items-center rounded-full border border-kv-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-kv-gray-600">
            <span className="mr-2 text-kv-gray-400">Zákazník</span>
            <span className="truncate text-kv-dark">{header.customerName.trim() || "Nezadáno"}</span>
          </span>
          {header.customerId.trim() && (
            <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-kv-gray-600">
              <span className="mr-2 text-kv-gray-400">ID zákazníka</span>
              <span className="text-kv-dark">{header.customerId}</span>
            </span>
          )}
          <span className="inline-flex max-w-full items-center rounded-full border border-kv-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-kv-gray-600">
            <span className="mr-2 text-kv-gray-400">Zakázka</span>
            <span className="truncate text-kv-dark">{header.offerName.trim() || "Nezadáno"}</span>
          </span>
          {header.deliveryDate.trim() && (
            <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-kv-gray-600">
              <span className="mr-2 text-kv-gray-400">Dodání</span>
              <span className="text-kv-dark">{formatDate(header.deliveryDate)}</span>
            </span>
          )}
          {header.customerIco.trim() && (
            <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-3 py-1.5 text-[11px] font-medium text-kv-gray-600">
              <span className="mr-2 text-kv-gray-400">IČ</span>
              <span className="text-kv-dark">{header.customerIco}</span>
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-kv-gray-200 bg-white shadow-sm">
      <div className="border-b border-kv-gray-200 bg-kv-gray-50/70 px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-kv-navy">Zákazník a hlavička nabídky</h2>
              <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-kv-gray-500">
                {filledCount}/6 klíčových údajů
              </span>
            </div>
            <p className="mt-1 text-xs text-kv-gray-400">
              Zkrácený přehled údajů zákazníka a nabídky.
            </p>
          </div>

          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-10 items-center gap-2 self-start rounded-xl border border-kv-navy/20 bg-kv-navy/5 px-3.5 text-xs font-medium text-kv-navy transition-colors hover:bg-kv-navy/10"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487a2.25 2.25 0 1 1 3.182 3.182L7.5 20.213 3 21l.787-4.5 13.075-12.013Z" />
            </svg>
            Upravit detail
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <SummaryItem label="Zákazník" value={header.customerName} />
          <SummaryItem label="ID zákazníka" value={header.customerId} />
          <SummaryItem label="IČ" value={header.customerIco} />
          <SummaryItem label="Zakázka" value={header.offerName} />
          <SummaryItem label="Dodání" value={formatDate(header.deliveryDate)} />
        </div>
      </div>
    </div>
  );
}
