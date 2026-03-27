"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { getProductImageUrl } from "@/lib/types";

interface ProductInfo {
  name: string;
  sku?: string;
  name_secondary?: string | null;
  manufacturer_code?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  unit?: string | null;
  ean?: string | null;
  price?: number | null;
  eshop_url?: string | null;
}

interface ProductInfoPopoverProps {
  product: ProductInfo;
  size?: "sm" | "md";
}

export function ProductInfoPopover({ product, size = "sm" }: ProductInfoPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<"bottom" | "top">("bottom");
  const btnRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    setPosition(spaceBelow < 280 ? "top" : "bottom");
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [isOpen, updatePosition]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  }, []);

  const categoryPath = [product.category, product.subcategory, product.sub_subcategory]
    .filter(Boolean)
    .join(" > ");

  const dim = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const iconDim = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <span className="relative inline-flex">
      <span
        ref={btnRef}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e as unknown as React.MouseEvent); } }}
        className={`${dim} inline-flex cursor-pointer items-center justify-center rounded-full border border-kv-gray-200 text-kv-gray-400 transition-colors hover:border-kv-gray-400 hover:text-kv-gray-600 hover:bg-kv-gray-50`}
        title="Detail produktu"
      >
        <svg className={iconDim} viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
        </svg>
      </span>

      {isOpen && (
        <div
          ref={popoverRef}
          className={`absolute z-50 w-72 rounded-xl border border-kv-gray-200 bg-white shadow-lg ${
            position === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"
          } right-0`}
        >
          <div className="px-4 py-3 border-b border-kv-gray-100">
            {(() => {
              const imgUrl = getProductImageUrl(product.sku, "L");
              return imgUrl ? (
                <div className="mb-3 flex items-center justify-center rounded-lg bg-kv-gray-50 border border-kv-gray-100 overflow-hidden h-32">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imgUrl}
                    alt={product.name}
                    className="max-h-full max-w-full object-contain p-2"
                    onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = "none"; }}
                  />
                </div>
              ) : null;
            })()}
            <p className="text-sm font-semibold text-kv-gray-900 leading-snug">{product.name}</p>
            {product.name_secondary && (
              <p className="mt-0.5 text-xs text-kv-gray-500 leading-snug">{product.name_secondary}</p>
            )}
          </div>

          <div className="px-4 py-2.5 space-y-1.5">
            {product.sku && (
              <InfoRow label="SKU" value={product.sku} mono />
            )}
            {product.manufacturer_code && (
              <InfoRow label="Kód výrobce" value={product.manufacturer_code} mono />
            )}
            {product.manufacturer && (
              <InfoRow label="Výrobce" value={product.manufacturer} />
            )}
            {categoryPath && (
              <InfoRow label="Kategorie" value={categoryPath} />
            )}
            {product.unit && (
              <InfoRow label="Jednotka" value={product.unit} />
            )}
            {product.ean && (
              <InfoRow label="EAN" value={product.ean} mono />
            )}
            {product.price != null && (
              <InfoRow label="Cena" value={`${product.price.toLocaleString("cs")} Kč`} />
            )}
          </div>

          {product.eshop_url && (
            <div className="px-4 py-2.5 border-t border-kv-gray-100">
              <a
                href={product.eshop_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-kv-red hover:text-kv-red-dark transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                Zobrazit v e-shopu
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-kv-gray-400 shrink-0">{label}</span>
      <span className={`text-xs text-kv-gray-700 text-right truncate max-w-[160px] ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}
