"use client";

import { useMemo, useState, useCallback } from "react";
import type { OfferItem } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { ProductInfoPopover } from "./ProductInfoPopover";
import { ProductThumbnail } from "./ProductThumbnail";
import { StockBadge } from "./StockBadge";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const MATCH_TYPE_LABELS: Record<string, string> = {
  match: "Přesná shoda",
  uncertain: "Nejistá shoda",
  multiple: "Více shod",
  alternative: "Alternativa",
  not_found: "Nenalezeno",
  processing: "Zpracovávám…",
};

const COMPONENT_ROLE_LABELS: Record<string, string> = {
  mechanism: "Strojek",
  cover: "Kryt",
  frame: "Rámeček",
  module: "Modul",
  socket: "Zásuvka",
  other: "Díl",
};

function ReasoningPopover({ item }: { item: OfferItem }) {
  const [open, setOpen] = useState(false);
  if (!item.reasoning && !item.reformulatedQuery) return null;
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Zobrazit rozhodování AI"
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition-all ${open ? "bg-kv-navy/10 text-kv-navy" : "text-kv-gray-300 hover:bg-kv-navy/10 hover:text-kv-navy"}`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-40 w-80 rounded-xl border border-kv-gray-200 bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <svg className="h-4 w-4 text-kv-navy" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
              </svg>
              <span className="text-xs font-semibold text-kv-navy">Rozhodování AI</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="w-24 shrink-0 text-kv-gray-400">Shoda</span>
                <span className="font-medium text-kv-dark">{MATCH_TYPE_LABELS[item.matchType] ?? item.matchType} ({item.confidence}%)</span>
              </div>
              {item.pipelineMs != null && (
                <div className="flex gap-2">
                  <span className="w-24 shrink-0 text-kv-gray-400">Čas</span>
                  <span className="text-kv-gray-600">{(item.pipelineMs / 1000).toFixed(1)} s</span>
                </div>
              )}
              {item.reformulatedQuery && (
                <div className="flex gap-2">
                  <span className="w-24 shrink-0 text-kv-gray-400">Dotaz AI</span>
                  <span className="text-kv-gray-600 break-all">{item.reformulatedQuery}</span>
                </div>
              )}
              {item.reasoning && (
                <div className="mt-2 rounded-lg bg-kv-gray-50 p-2.5 text-kv-gray-700 leading-relaxed">
                  {item.reasoning}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CopySkuButton({ sku }: { sku: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [sku]);
  return (
    <button
      onClick={copy}
      title={copied ? "Zkopírováno!" : "Kopírovat SKU"}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-kv-gray-300 transition-all hover:bg-kv-gray-100 hover:text-kv-navy"
    >
      {copied ? (
        <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
        </svg>
      )}
    </button>
  );
}

const UNIT_GROUPS: Record<string, string> = {
  // KS — kusy (dominantní v katalogu)
  ks: "ks", kus: "ks", kusu: "ks", kusů: "ks", kusov: "ks", pcs: "ks", piece: "ks",
  // M — metry (kabely, vodiče)
  m: "m", metr: "m", metry: "m", metrů: "m", met: "m", bm: "m",
  // BAL — balení
  bal: "bal", balení: "bal", baleni: "bal", pack: "bal", pkg: "bal",
  // KG — kilogramy
  kg: "kg", kilogram: "kg",
  // SET/SADA
  set: "set", sada: "set", komplet: "set",
  // PÁR
  pár: "pár", par: "pár", pair: "pár",
  // ROL — role (katalogová hodnota pro kabely v rolích/kotoučích)
  rol: "rol", role: "rol", rola: "rol", roll: "rol", kruh: "rol", kotouč: "rol",
  // BUBEN — buben je v názvu produktu, ne jako MJ (MJ bývá KS nebo M)
  buben: "ks", drum: "ks",
};

function normalizeUnit(u: string): string {
  return UNIT_GROUPS[u.toLowerCase().trim()] ?? u.toLowerCase().trim();
}

function hasUnitMismatch(demandUnit: string | null, productUnit: string | null): boolean {
  if (!demandUnit || !productUnit) return false;
  return normalizeUnit(demandUnit) !== normalizeUnit(productUnit);
}

function unitMismatchLabel(demandUnit: string, productUnit: string): string {
  return `Poptávka: ${demandUnit} → Produkt: ${productUnit}`;
}

interface SortableRowProps {
  item: OfferItem;
  isCurrentlySearching: boolean;
  justChanged: boolean;
  isReviewed: boolean;
  isDragDisabled: boolean;
  onInsertAt?: (afterPosition: number) => void;
  isLastRow: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function SortableRow({
  item,
  isCurrentlySearching,
  justChanged,
  isReviewed,
  isDragDisabled,
  onInsertAt,
  isLastRow,
  onClick,
  children,
}: SortableRowProps) {
  const [showInsert, setShowInsert] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.itemId,
    disabled: isDragDisabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
  };

  return (
    <>
      <tr
        ref={setNodeRef}
        style={style}
        onClick={onClick}
        onMouseEnter={() => onInsertAt && setShowInsert(true)}
        onMouseLeave={() => setShowInsert(false)}
        className={`group/row transition-all duration-500 ${
          isCurrentlySearching
            ? "bg-kv-gray-50 animate-pulse-subtle"
            : justChanged
              ? "bg-green-50/60"
              : isReviewed
                ? "bg-emerald-50/40 cursor-pointer hover:bg-emerald-50/70 border-l-2 border-l-emerald-400"
                : "bg-amber-50/50 cursor-pointer hover:bg-amber-100/60 border-l-2 border-l-amber-400"
        }`}
      >
        {/* Drag handle as first cell */}
        <td className="w-6 pl-1 pr-0 py-2.5">
          {!isDragDisabled && (
            <button
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
              className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-kv-gray-200 opacity-0 transition-all group-hover/row:opacity-100 hover:text-kv-gray-400 active:cursor-grabbing"
              title="Přetáhnout"
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
              </svg>
            </button>
          )}
        </td>
        {children}
      </tr>
      {/* Insert between rows */}
      {onInsertAt && (showInsert || isLastRow) && (
        <tr
          onMouseEnter={() => setShowInsert(true)}
          onMouseLeave={() => setShowInsert(false)}
          className="h-0"
        >
          <td colSpan={99} className="p-0">
            <div className={`flex items-center transition-all duration-150 ${showInsert ? "h-5 opacity-100" : "h-0 opacity-0"}`}>
              <div className="flex-1 border-t border-dashed border-kv-gray-200" />
              <button
                onClick={(e) => { e.stopPropagation(); onInsertAt(item.position); }}
                className="mx-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-kv-gray-300 bg-white text-kv-gray-400 hover:border-kv-navy hover:text-kv-navy"
                title="Přidat položku zde"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
              <div className="flex-1 border-t border-dashed border-kv-gray-200" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface ResultsTableProps {
  items: OfferItem[];
  searchingSet: Set<string>;
  changedPositions?: Set<number>;
  onItemClick: (item: OfferItem) => void;
  onExport: () => void;
  onExportSap: () => void;
  onReset: () => void;
  onProcessNotFound: () => void;
  onProcessAgain?: () => void;
  onAddItem?: () => void;
  onDeleteItem?: (itemId: string) => void;
  onSearchItem?: (item: OfferItem) => void;
  onReorder?: (reorderedItems: OfferItem[]) => void;
  onInsertAt?: (afterPosition: number) => void;
  isSearchingSemantic: boolean;
  isProcessing?: boolean;
  token?: string;
}

export function ResultsTable({
  items,
  searchingSet,
  changedPositions,
  onItemClick,
  onExport,
  onExportSap,
  onReset,
  onProcessNotFound,
  onProcessAgain,
  onAddItem,
  onDeleteItem,
  onSearchItem,
  onReorder,
  onInsertAt,
  isSearchingSemantic,
  isProcessing = false,
  token = "",
}: ResultsTableProps) {
  const [showResetModal, setShowResetModal] = useState(false);
  const [showReprocessModal, setShowReprocessModal] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !onReorder) return;
    const oldIndex = items.findIndex((i) => i.itemId === active.id);
    const newIndex = items.findIndex((i) => i.itemId === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(items, oldIndex, newIndex).map((item, idx) => ({
      ...item,
      position: idx,
    }));
    onReorder(reordered);
  }, [items, onReorder]);
  const neutralButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-kv-gray-200 bg-white px-4 text-xs font-medium text-kv-gray-600 transition-colors hover:bg-kv-gray-50 disabled:opacity-40 disabled:cursor-not-allowed";
  const navyButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-kv-navy/20 bg-kv-navy/5 px-4 text-xs font-medium text-kv-navy transition-colors hover:bg-kv-navy/10 disabled:opacity-40 disabled:cursor-not-allowed";
  const amberButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed";
  const primaryButtonClass = "inline-flex h-11 items-center gap-1.5 rounded-2xl bg-kv-red px-4.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-kv-red-dark disabled:opacity-40 disabled:cursor-not-allowed";

  const topLevelItems = items.filter((i) => !i.parentItemId);
  const matchedCount = topLevelItems.filter((i) => i.matchType !== "not_found" || i.confirmed).length;
  const doneCount = items.filter((i) => !searchingSet.has(i.itemId)).length;
  const isSearching = searchingSet.size > 0;
  const notFoundCount = topLevelItems.filter((i) => i.matchType === "not_found" && !i.confirmed).length;
  const unreviewedCount = items.filter((i) => i.reviewStatus !== "reviewed" && !i.parentItemId).length;
  const unitMismatchCount = items.filter((i) => i.product && hasUnitMismatch(i.unit, i.product.unit)).length;
  const priceNoteCount = items.filter((i) => i.priceNote).length;
  const uncertainCount = items.filter((i) => (i.matchType === "uncertain" || i.matchType === "alternative") && !i.parentItemId).length;

  const extraColumnKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      if (item.extraColumns) {
        for (const key of Object.keys(item.extraColumns)) {
          keys.add(key);
        }
      }
    }
    return Array.from(keys);
  }, [items]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar */}
      <div className="shrink-0 border-b border-kv-gray-200 bg-kv-gray-50/70 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-kv-navy">Položky nabídky</h2>
            <span className="inline-flex items-center rounded-full border border-kv-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-kv-gray-500">
              {matchedCount}/{topLevelItems.length} nalezeno
            </span>
            {unreviewedCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {unreviewedCount} ke kontrole
              </span>
            ) : items.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/80 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Vše zkontrolováno
              </span>
            ) : null}
            {uncertainCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50/80 px-2.5 py-1 text-[11px] font-medium text-blue-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
                </svg>
                {uncertainCount} nejisté
              </span>
            )}
            {priceNoteCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                {priceNoteCount} cenové upozornění
              </span>
            )}
            {unitMismatchCount > 0 && !isSearching && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                {unitMismatchCount} nesoulad MJ
              </span>
            )}
            {isSearching && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-kv-red/10 bg-kv-red/5 px-2.5 py-1 text-[11px] font-medium text-kv-red">
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="tabular-nums">{doneCount}/{items.length}</span>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onProcessAgain && (
              <button
                onClick={() => setShowReprocessModal(true)}
                disabled={isSearching || isProcessing || items.length === 0}
                className={navyButtonClass}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
                </svg>
                Zpracovat znovu
              </button>
            )}
            <button
              onClick={onProcessNotFound}
              disabled={notFoundCount === 0 || isSearchingSemantic || isSearching}
              className={amberButtonClass}
            >
              {isSearchingSemantic ? (
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
              )}
              {isSearchingSemantic ? "Vyhledávám…" : "Zpracovat nenalezené"}
            </button>
            <button
              onClick={() => setShowResetModal(true)}
              className={neutralButtonClass}
            >
              Vymazat vše
            </button>
            <button
              onClick={onExport}
              disabled={isSearching || items.length === 0}
              className={primaryButtonClass}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export
            </button>
            <button
              onClick={onExportSap}
              disabled={isSearching || items.length === 0}
              className={primaryButtonClass}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export SAP
            </button>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {isSearching && (
        <div className="h-1 bg-kv-gray-100">
          <div
            className="h-full bg-kv-red transition-all duration-300 ease-out"
            style={{ width: `${(doneCount / items.length) * 100}%` }}
          />
        </div>
      )}

      {/* Offer summary bar */}
      {!isSearching && items.length > 0 && (
        <div className="shrink-0 border-b border-kv-gray-100 bg-white px-6 py-2.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">{matchedCount}</span>
              <span className="text-kv-gray-500">nalezeno</span>
            </div>
            {notFoundCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{notFoundCount}</span>
                <span className="text-kv-gray-500">nenalezeno</span>
              </div>
            )}
            {uncertainCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">{uncertainCount}</span>
                <span className="text-kv-gray-500">nejisté</span>
              </div>
            )}
            {priceNoteCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">{priceNoteCount}</span>
                <span className="text-kv-gray-500">cenové upozornění</span>
              </div>
            )}
            {(() => {
              const prices = items
                .filter((i) => i.product?.current_price != null)
                .map((i) => (i.product!.current_price! * (i.quantity ?? 1)));
              if (prices.length === 0) return null;
              const total = prices.reduce((a, b) => a + b, 0);
              return (
                <div className="ml-auto flex items-center gap-1.5 font-medium text-kv-dark">
                  <svg className="h-3.5 w-3.5 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                  </svg>
                  <span className="tabular-nums">
                    {new Intl.NumberFormat("cs-CZ", { style: "currency", currency: "CZK", maximumFractionDigits: 0 }).format(total)}
                  </span>
                  <span className="font-normal text-kv-gray-400">odhad bez DPH</span>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {onAddItem && (
          <button
            onClick={onAddItem}
            aria-label="Přidat položku"
            title="Přidat položku"
            className="absolute bottom-4 right-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full bg-kv-red text-white shadow-lg shadow-red-200 transition-all hover:bg-kv-red-dark hover:shadow-xl"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        )}
      <div className="h-full overflow-y-auto overflow-x-auto custom-scrollbar pb-24">
        <table className="w-full">
          <thead className="sticky top-0 z-10 bg-kv-gray-50 border-b border-kv-gray-200">
            <tr>
              <th className="w-6 pl-1 pr-0" />
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 w-10">#</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400">Poptávka</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 w-20">Množ.</th>
              {extraColumnKeys.map((key) => (
                <th key={key} className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400 whitespace-nowrap">
                  {key}
                </th>
              ))}
              <th className="px-4 py-2.5 text-left text-xs font-medium text-kv-gray-400">Nalezený produkt</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-kv-gray-400 w-36">Stav</th>
              <th className="px-4 py-2.5 text-center text-xs font-medium text-kv-gray-400 w-20">Akce</th>
            </tr>
          </thead>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((i) => i.itemId)} strategy={verticalListSortingStrategy}>
          <tbody className="divide-y divide-kv-gray-100">
            {items.map((item, idx) => {
              const isCurrentlySearching = searchingSet.has(item.itemId);
              const justChanged = changedPositions?.has(item.position) ?? false;
              const isReviewed = item.reviewStatus === "reviewed";
              const isComponent = !!item.parentItemId;
              const isSetParent = !isComponent && items.some((i) => i.parentItemId === item.itemId);
              return (
                <SortableRow
                  key={item.itemId}
                  item={item}
                  isCurrentlySearching={isCurrentlySearching}
                  justChanged={justChanged}
                  isReviewed={isReviewed}
                  isDragDisabled={isProcessing || isCurrentlySearching || isComponent}
                  onInsertAt={isComponent ? undefined : onInsertAt}
                  isLastRow={idx === items.length - 1}
                  onClick={() => !isCurrentlySearching && !isSetParent && onItemClick(item)}
                >
                  <td className="px-4 py-2.5 text-sm tabular-nums text-kv-gray-400">
                    {isComponent ? "" : item.position + 1}
                  </td>
                  <td className={`px-4 py-2.5 text-sm text-kv-dark ${isComponent ? "pl-10" : ""}`}>
                    {isComponent && (
                      <span className="mr-1.5 inline-flex items-center rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 border border-indigo-200">
                        {COMPONENT_ROLE_LABELS[item.componentRole ?? ""] ?? item.componentRole ?? "?"}
                      </span>
                    )}
                    {isSetParent && (
                      <span className="mr-1.5 inline-flex items-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 border border-violet-200">
                        SADA
                      </span>
                    )}
                    {item.originalName}
                  </td>
                  <td className="px-4 py-2.5 text-sm tabular-nums text-kv-dark">
                    {item.quantity != null ? (
                      <div className="flex items-center gap-1">
                        <span>
                          {item.quantity}
                          {item.unit && <span className="ml-1 text-kv-gray-400">{item.unit}</span>}
                        </span>
                        {!isCurrentlySearching && item.product && hasUnitMismatch(item.unit, item.product.unit) && (
                          <span
                            title={unitMismatchLabel(item.unit!, item.product.unit!)}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 cursor-help"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                            </svg>
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-kv-gray-300">—</span>
                    )}
                  </td>
                  {extraColumnKeys.map((key) => (
                    <td key={key} className="px-4 py-2.5 text-sm text-kv-dark max-w-[150px] truncate">
                      {item.extraColumns?.[key] ?? "—"}
                    </td>
                  ))}
                  <td className="px-4 py-2.5">
                    <div className="max-w-[300px]">
                      <div className="flex items-center gap-2">
                        {item.product && !isCurrentlySearching && (
                          <ProductThumbnail sku={item.product.sku} name={item.product.name} size="sm" />
                        )}
                        <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                        <span className="text-sm text-kv-dark truncate">
                          {item.product?.name ?? (isCurrentlySearching ? "" : "—")}
                        </span>
                        {item.product && !isCurrentlySearching && (
                          <ProductInfoPopover product={item.product} />
                        )}
                        </div>
                      {item.product && !isCurrentlySearching && (
                        <div className="flex items-center gap-2 mt-0.5">
                          {item.product.manufacturer && (
                            <span className="text-xs text-kv-gray-400">{item.product.manufacturer}</span>
                          )}
                          {item.product.sku && (
                            <span className="flex items-center gap-0.5">
                              <span className="text-xs font-mono text-kv-gray-400">{item.product.sku}</span>
                              <CopySkuButton sku={item.product.sku} />
                            </span>
                          )}
                          <StockBadge product={item.product} token={token} />
                        </div>
                      )}
                      {item.priceNote && !isCurrentlySearching && (
                        <div className="mt-1 flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 border border-amber-200">
                          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                          </svg>
                          <span className="truncate">{item.priceNote}</span>
                        </div>
                      )}
                      {!isCurrentlySearching && item.exactLookupAttempted && !item.exactLookupFound && item.matchType === "not_found" && (
                        <div className="mt-1 flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-[11px] text-red-600 border border-red-200">
                          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
                          </svg>
                          <span>EAN/kód nenalezen v katalogu</span>
                        </div>
                      )}
                        </div>{/* end min-w-0 */}
                      </div>{/* end flex items-center gap-2 */}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <StatusBadge
                      type={isCurrentlySearching ? "processing" : item.matchType}
                      confidence={isCurrentlySearching ? undefined : item.confidence}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {!isCurrentlySearching && (
                        <ReasoningPopover item={item} />
                      )}
                      {!isCurrentlySearching && onSearchItem && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSearchItem(item);
                          }}
                          title="Vyhledat znovu"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 transition-all hover:bg-kv-navy/10 hover:text-kv-navy"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
                          </svg>
                        </button>
                      )}
                      {onDeleteItem && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteItem(item.itemId);
                          }}
                          title="Odebrat položku"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 transition-all hover:bg-kv-red-light hover:text-kv-red"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </SortableRow>
              );
            })}
          </tbody>
            </SortableContext>
          </DndContext>
        </table>
      </div>
      </div>

      {showReprocessModal && onProcessAgain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl border border-white/20 p-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
              <svg className="h-6 w-6 text-kv-navy" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182M2.985 19.644l3.181-3.183" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-kv-dark">Zpracovat znovu?</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Tato akce spustí kompletně nové vyhledávání pro všechny položky. Stávající výsledky budou přepsány.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowReprocessModal(false)}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={() => {
                  setShowReprocessModal(false);
                  onProcessAgain();
                }}
                className="rounded-xl bg-kv-navy px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-kv-navy/90"
              >
                Spustit vyhledávání
              </button>
            </div>
          </div>
        </div>
      )}

      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl border border-white/20 p-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-kv-dark">Vymazat vše?</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Tato akce smaže všechny položky, historii chatu a vrátí nabídku do výchozího stavu.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowResetModal(false)}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={() => {
                  setShowResetModal(false);
                  onReset();
                }}
                className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-red-600"
              >
                Vymazat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
