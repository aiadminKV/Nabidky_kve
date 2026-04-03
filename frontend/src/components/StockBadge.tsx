"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Product } from "@/lib/types";
import { getProductStock, type BranchStock } from "@/lib/api";

interface StockBadgeProps {
  product: Product;
  token: string;
}

const POPUP_WIDTH = 260;
const POPUP_EST_HEIGHT = 240;

export function StockBadge({ product, token }: StockBadgeProps) {
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState<BranchStock[] | null>(null);
  const [totalStock, setTotalStock] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // resolvedHasStock starts from DB value, updates after actual stock fetch
  const [resolvedHasStock, setResolvedHasStock] = useState(product.has_stock === true);
  const btnRef = useRef<HTMLButtonElement>(null);

  const isStockItem = product.is_stock_item === true;
  const hasStock = resolvedHasStock;

  useEffect(() => { setMounted(true); }, []);

  const computePos = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom;
    const spaceRight = window.innerWidth - rect.left;

    let top =
      spaceBelow >= POPUP_EST_HEIGHT
        ? rect.bottom + 6
        : rect.top - POPUP_EST_HEIGHT - 6;
    top = Math.max(8, Math.min(top, vh - POPUP_EST_HEIGHT - 8));

    const left =
      spaceRight >= POPUP_WIDTH + 8
        ? rect.left
        : Math.max(8, rect.right - POPUP_WIDTH);

    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    computePos();

    function handleClose(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
      } else {
        if (!btnRef.current?.contains(e.target as Node)) {
          setOpen(false);
        }
      }
    }

    document.addEventListener("mousedown", handleClose);
    document.addEventListener("keydown", handleClose);
    window.addEventListener("scroll", computePos, true);
    window.addEventListener("resize", computePos);
    return () => {
      document.removeEventListener("mousedown", handleClose);
      document.removeEventListener("keydown", handleClose);
      window.removeEventListener("scroll", computePos, true);
      window.removeEventListener("resize", computePos);
    };
  }, [open, computePos]);

  const handleStockClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (stock === null && !loading) {
      setLoading(true);
      getProductStock(product.sku, token)
        .then((info) => {
          setStock(info.stock);
          setTotalStock(info.totalStock);
          if (info.totalStock > 0) setResolvedHasStock(true);
        })
        .finally(() => setLoading(false));
    }
  };

  // ── Skladovka / Neskladovka badge ────────────────────────
  const stockItemBadge = isStockItem ? (
    <span className="inline-flex min-w-[88px] justify-center items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
      <svg className="h-2.5 w-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
      </svg>
      Skladovka
    </span>
  ) : (
    <span className="inline-flex min-w-[88px] justify-center items-center gap-1 rounded-full border border-kv-gray-200 bg-kv-gray-50 px-2 py-0.5 text-[10px] font-semibold text-kv-gray-400">
      <svg className="h-2.5 w-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
      </svg>
      Neskladovka
    </span>
  );

  // ── Skladem / Není skladem badge (clickable) ────────────
  const availabilityVariant =
    hasStock ? "green" :
    isStockItem ? "amber" :
    "gray";

  const stockLabel = hasStock ? "Skladem" : "Není skladem";

  const availabilityConfig = {
    green: {
      cls: "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100",
      dot: "bg-blue-500",
      label: stockLabel,
    },
    amber: {
      cls: "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100",
      dot: "bg-amber-400",
      label: stockLabel,
    },
    gray: {
      cls: "border-kv-gray-200 bg-kv-gray-50 text-kv-gray-400 hover:bg-kv-gray-100",
      dot: "bg-kv-gray-300",
      label: "Není skladem",
    },
  }[availabilityVariant];

  const popup = open && mounted ? createPortal(
    <div
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPUP_WIDTH, zIndex: 9999 }}
      className="rounded-xl border border-kv-gray-200 bg-white p-3 shadow-2xl shadow-black/8"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-kv-navy">
          Zásoby po pobočkách
        </span>
        {totalStock !== null && (
          <span className={`text-xs font-bold ${totalStock > 0 ? "text-emerald-600" : "text-kv-gray-400"}`}>
            {totalStock > 0 ? `${totalStock} ks celkem` : "0 ks"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-3">
          <svg className="h-4 w-4 animate-spin text-kv-gray-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : stock !== null && stock.length > 0 ? (
        <div className="max-h-[200px] overflow-y-auto custom-scrollbar space-y-1">
          {stock.map((s) => (
            <div
              key={s.branchCode}
              className="flex items-center justify-between rounded-lg bg-kv-gray-50/70 px-2.5 py-1.5"
            >
              <span className="text-xs text-kv-gray-600 truncate mr-2">
                {s.branchName ?? s.branchCode}
              </span>
              <span className="text-xs font-bold tabular-nums text-kv-dark shrink-0">
                {s.qty} ks
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-2 text-center text-xs text-kv-gray-400">
          Žádné zásoby na pobočkách
        </p>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <span className="inline-flex items-center gap-1">
      {stockItemBadge}

      <button
        ref={btnRef}
        type="button"
        onClick={handleStockClick}
        title="Klikněte pro detail zásoby po pobočkách"
        className={`inline-flex min-w-[96px] justify-center items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${availabilityConfig.cls}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${availabilityConfig.dot}`} />
        {availabilityConfig.label}
        {hasStock && (
          <svg className="h-2.5 w-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>

      {popup}
    </span>
  );
}
