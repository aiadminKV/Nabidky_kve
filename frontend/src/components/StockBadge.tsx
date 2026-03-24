"use client";

import { useEffect, useRef, useState } from "react";
import type { Product } from "@/lib/types";
import { getProductStock, type BranchStock } from "@/lib/api";

interface StockBadgeProps {
  product: Product;
  token: string;
}

export function StockBadge({ product, token }: StockBadgeProps) {
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState<BranchStock[] | null>(null);
  const [totalStock, setTotalStock] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
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

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (stock === null && !loading) {
      setLoading(true);
      getProductStock(product.sku, token)
        .then((info) => {
          setStock(info.stock);
          setTotalStock(info.totalStock);
        })
        .finally(() => setLoading(false));
    }
  };

  const hasStock = product.has_stock === true;
  const isStockItem = product.is_stock_item === true;

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={handleClick}
        title={
          hasStock
            ? "Skladem"
            : isStockItem
              ? "Skladová položka (momentálně nedostupné)"
              : "Neskladová položka"
        }
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
          hasStock
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            : isStockItem
              ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
              : "border-kv-gray-200 bg-kv-gray-50 text-kv-gray-400 hover:bg-kv-gray-100"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${
          hasStock ? "bg-emerald-500" : isStockItem ? "bg-amber-400" : "bg-kv-gray-300"
        }`} />
        {hasStock ? "Skladem" : isStockItem ? "DISPO" : "Ne-sklad"}
      </button>

      {open && (
        <div
          className="absolute top-full right-0 z-50 mt-1.5 w-[260px] rounded-xl border border-kv-gray-200 bg-white p-3 shadow-2xl shadow-black/8 animate-in fade-in slide-in-from-top-1 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-kv-navy">Skladová dostupnost</span>
            {totalStock !== null && (
              <span className={`text-xs font-bold ${totalStock > 0 ? "text-emerald-600" : "text-kv-gray-400"}`}>
                {totalStock > 0 ? `${totalStock} celkem` : "0"}
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
                    {s.qty}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-2 text-center text-xs text-kv-gray-400">
              Žádné zásoby na pobočkách
            </p>
          )}
        </div>
      )}
    </div>
  );
}
