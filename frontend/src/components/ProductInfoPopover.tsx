"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ProductInfo {
  name: string;
  sku?: string;
  name_secondary?: string | null;
  description?: string | null;
  manufacturer_code?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  category_main?: string | null;
  category_sub?: string | null;
  category_line?: string | null;
  unit?: string | null;
  ean?: string | null;
  price?: number | null;
  current_price?: number | null;
  is_stock_item?: boolean | null;
  has_stock?: boolean | null;
  supplier_name?: string | null;
  status_purchase_code?: string | null;
  status_purchase_text?: string | null;
  status_sales_code?: string | null;
  status_sales_text?: string | null;
  dispo?: string | null;
  eshop_url?: string | null;
}

interface ProductInfoPopoverProps {
  product: ProductInfo;
  size?: "sm" | "md";
}

interface PopoverPos {
  top: number;
  left: number;
}

type StatusVariant = "green" | "amber" | "red" | "gray";

export const STATUS_LABELS: Record<string, string> = {
  // Prodej
  ZA: "Aktivní",
  ZK: "Katalog",
  ZN: "Nelze nakoupit",
  ZU: "Ukončena výroba",
  ZX: "Status X",
  ZZ: "Zrušeno",
  // Nákup
  ZP: "Aktivní obaly",
  ZS: "Nově naskladněno",
  ZJ: "Specifické nákup",
  ZB: "B2C objednávka",
  ZC: "Pobočkové",
  ZM: "Sporadické",
  Z5: "Doprodej",
  Z1: "Ležák A",
  Z2: "Ležák B",
  Z3: "Ležák C",
  Z4: "Ležák D",
  Z0: "Ležák vyprodaný",
};

const STATUS_COLOR_MAP: Record<string, StatusVariant> = {
  // Prodej
  ZA: "green",  // KVE AKTIVNÍ
  ZK: "amber",  // KVE KATALOG
  ZN: "red",    // KVE NELZE NAKOUPIT
  ZU: "red",    // KVE UKONČENA VÝROBA
  ZX: "gray",   // KVE STATUS X
  ZZ: "red",    // KVE ZRUŠENO
  // Nákup
  ZP: "green",  // KVE AKTIVNÍ OBALY
  ZS: "green",  // KVE NOVĚ NASKLADNĚNO
  ZJ: "amber",  // KVE SPECIFICKÉ NÁKUP
  ZB: "amber",  // B2C NA OBJEDNÁVKU
  ZC: "amber",  // KVE POBOČKOVĚ SPECIFICKÉ
  ZM: "amber",  // PW SPORADICKE
  Z5: "amber",  // KVE DOPRODEJ
  Z1: "amber",  // KVE LEŽÁK A
  Z2: "amber",  // KVE LEŽÁK B
  Z3: "amber",  // KVE LEŽÁK C
  Z4: "amber",  // KVE LEŽÁK D
  Z0: "red",    // KVE LEŽÁK VYPRODANÝ
};

const STATUS_VARIANT_CLASSES: Record<StatusVariant, string> = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red:   "bg-red-50 text-red-600 border-red-200",
  gray:  "bg-kv-gray-100 text-kv-gray-500 border-kv-gray-200",
};

const STATUS_DOT_CLASSES: Record<StatusVariant, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-400",
  red:   "bg-red-500",
  gray:  "bg-kv-gray-300",
};

export function getStatusVariant(code: string | null | undefined): StatusVariant {
  if (!code) return "gray";
  return STATUS_COLOR_MAP[code] ?? "gray";
}

export function isProductStatusProblematic(
  salesCode: string | null | undefined,
  purchaseCode: string | null | undefined,
): boolean {
  const badSales = ["ZN", "ZU", "ZZ"];
  const badPurchase = ["Z0"];
  return (
    (salesCode != null && badSales.includes(salesCode)) ||
    (purchaseCode != null && badPurchase.includes(purchaseCode))
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-kv-gray-400">{label}</span>
      <span
        className={`min-w-0 break-all text-right text-xs text-kv-gray-700 ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-kv-gray-400">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function StatusRow({
  label,
  code,
  text,
}: {
  label: string;
  code: string;
  text?: string | null;
}) {
  const variant = getStatusVariant(code);
  const shortLabel = STATUS_LABELS[code] ?? text ?? code;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[11px] text-kv-gray-400">{label}</span>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_VARIANT_CLASSES[variant]}`}
        title={text ?? code}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_CLASSES[variant]}`} />
        <span className="font-mono text-[9px] opacity-70">{code}</span>
        <span>{shortLabel}</span>
      </span>
    </div>
  );
}

const POPOVER_WIDTH = 288;
const POPOVER_EST_HEIGHT = 380;

export function ProductInfoPopover({ product, size = "sm" }: ProductInfoPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos>({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const computePos = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom;
    const spaceRight = window.innerWidth - rect.left;
    // Effective height accounts for max-h-[80vh] on the popover itself
    const effectiveH = Math.min(POPOVER_EST_HEIGHT, vh * 0.8);

    let top =
      spaceBelow >= effectiveH
        ? rect.bottom + 6
        : rect.top - effectiveH - 6;
    // Clamp: never go above 8px or below bottom of viewport minus popup height
    top = Math.max(8, Math.min(top, vh - effectiveH - 8));

    const left =
      spaceRight >= POPOVER_WIDTH + 8
        ? rect.left
        : Math.max(8, rect.right - POPOVER_WIDTH);

    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    computePos();

    function handleClose(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setIsOpen(false);
      } else {
        if (!btnRef.current?.contains(e.target as Node)) {
          setIsOpen(false);
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
  }, [isOpen, computePos]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  }, []);

  const dim = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const iconDim = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  // Category path — prefer the detailed fields, fall back to generic ones
  const categoryParts = [
    product.category_main ?? product.category,
    product.category_sub ?? product.subcategory,
    product.category_line ?? product.sub_subcategory,
  ].filter(Boolean) as string[];

  const displayPrice = product.current_price ?? product.price;

  const hasIdentification = product.sku || product.ean || product.manufacturer_code;
  const hasOrigin = product.manufacturer || product.supplier_name;
  const hasProduct = product.unit || displayPrice != null;
  const hasStock = product.is_stock_item != null || product.has_stock != null;
  const hasStatuses =
    product.status_purchase_code ||
    product.status_purchase_text ||
    product.status_sales_code ||
    product.status_sales_text;

  return (
    <span className="relative inline-flex" ref={btnRef}>
      <span
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(e as unknown as React.MouseEvent);
          }
        }}
        className={`${dim} inline-flex cursor-pointer items-center justify-center rounded-full border border-kv-gray-200 text-kv-gray-400 transition-colors hover:border-kv-gray-400 hover:bg-kv-gray-50 hover:text-kv-gray-600 ${isOpen ? "border-kv-navy/40 bg-kv-navy/5 text-kv-navy" : ""}`}
        title="Detail produktu"
      >
        <svg className={iconDim} viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
      </span>

      {isOpen && mounted &&
        createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[9999] w-72 max-h-[80vh] overflow-y-auto rounded-xl border border-kv-gray-200 bg-white shadow-xl custom-scrollbar"
            style={{ top: pos.top, left: pos.left }}
          >
            {/* Header */}
            <div className="border-b border-kv-gray-100 px-4 py-3">
              <p className="text-sm font-semibold leading-snug text-kv-gray-900">{product.name}</p>
              {product.description && (
                <p
                  className="mt-0.5 truncate text-xs leading-snug text-kv-gray-500 whitespace-nowrap overflow-hidden"
                  title={product.description}
                >
                  {product.description.length > 70
                    ? product.description.slice(0, 70) + "…"
                    : product.description}
                </p>
              )}
            </div>

            <div className="space-y-3.5 px-4 py-3">
              {/* Identifikace */}
              {hasIdentification && (
                <Section title="Identifikace">
                  {product.sku && <InfoRow label="SKU" value={product.sku} mono />}
                  {product.ean && <InfoRow label="EAN" value={product.ean} mono />}
                  {product.manufacturer_code && (
                    <InfoRow label="Kód výrobce" value={product.manufacturer_code} mono />
                  )}
                </Section>
              )}

              {/* Výrobce / dodavatel */}
              {hasOrigin && (
                <Section title="Výrobce">
                  {product.manufacturer && <InfoRow label="Výrobce" value={product.manufacturer} />}
                  {product.supplier_name && <InfoRow label="Dodavatel" value={product.supplier_name} />}
                </Section>
              )}

              {/* Kategorie */}
              {categoryParts.length > 0 && (
                <Section title="Kategorie">
                  <div className="flex flex-wrap gap-1">
                    {categoryParts.map((part, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs text-kv-gray-600">
                        {i > 0 && <span className="text-kv-gray-300">›</span>}
                        <span>{part}</span>
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {/* Produkt */}
              {hasProduct && (
                <Section title="Produkt">
                  {product.unit && <InfoRow label="Měrná jednotka" value={product.unit} />}
                  {displayPrice != null && (
                    <InfoRow
                      label="Cena"
                      value={new Intl.NumberFormat("cs-CZ", {
                        style: "currency",
                        currency: "CZK",
                        maximumFractionDigits: 0,
                      }).format(displayPrice)}
                    />
                  )}
                </Section>
              )}

              {/* Dostupnost */}
              {hasStock && (
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-kv-gray-400">
                    Dostupnost
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {product.is_stock_item != null && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                          product.is_stock_item
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-kv-gray-200 bg-kv-gray-100 text-kv-gray-500"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            product.is_stock_item ? "bg-emerald-500" : "bg-kv-gray-300"
                          }`}
                        />
                        {product.is_stock_item ? "Skladovka" : "Není skladovka"}
                      </span>
                    )}
                    {product.has_stock != null && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                          product.has_stock
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-kv-gray-200 bg-kv-gray-100 text-kv-gray-500"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            product.has_stock ? "bg-blue-500" : "bg-kv-gray-300"
                          }`}
                        />
                        {product.has_stock ? "Na skladě" : "Není skladem"}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* SAP statusy */}
              {hasStatuses && (
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-kv-gray-400">
                    SAP statusy
                  </p>
                  <div className="space-y-1.5">
                    {product.status_sales_code && (
                      <StatusRow
                        label="Prodej"
                        code={product.status_sales_code}
                        text={product.status_sales_text}
                      />
                    )}
                    {product.status_purchase_code && (
                      <StatusRow
                        label="Nákup"
                        code={product.status_purchase_code}
                        text={product.status_purchase_text}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* E-shop link */}
            {product.eshop_url && (
              <div className="border-t border-kv-gray-100 px-4 py-2.5">
                <a
                  href={product.eshop_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-kv-red transition-colors hover:text-kv-red-dark"
                  onClick={(e) => e.stopPropagation()}
                >
                  Zobrazit v e-shopu
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                    />
                  </svg>
                </a>
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
