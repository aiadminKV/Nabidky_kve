"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentDebugPanel } from "@/components/AgentDebugPanel";
import { PasteConfirmModal } from "@/components/PasteConfirmModal";
import { ParsedItemsTable } from "@/components/ParsedItemsTable";
import { ResultsTable } from "@/components/ResultsTable";
import { ReviewModal } from "@/components/ReviewModal";
import { createClient } from "@/lib/supabase/client";
import { offerChat, searchItems, searchItemsSemantic, searchProducts, downloadXlsx } from "@/lib/api";
import type {
  ChatMessage,
  DebugEntry,
  OfferAction,
  OfferItem,
  OfferItemSummary,
  OfferPhase,
  ParsedItem,
  Product,
  ToolCallStatus,
} from "@/lib/types";

interface DashboardClientProps {
  email: string;
  isAdmin?: boolean;
}

export function DashboardClient({ email, isAdmin }: DashboardClientProps) {
  const [phase, setPhase] = useState<OfferPhase>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [offerItems, setOfferItems] = useState<OfferItem[]>([]);
  const [searchingSet, setSearchingSet] = useState<Set<number>>(new Set());
  const [reviewItem, setReviewItem] = useState<OfferItem | null>(null);
  const [isParsingChat, setIsParsingChat] = useState(false);
  const [isSearchingSemantic, setIsSearchingSemantic] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [changedPositions, setChangedPositions] = useState<Set<number>>(new Set());
  const idCounter = useRef(0);
  const changedTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const flashPosition = useCallback((pos: number) => {
    setChangedPositions((prev) => new Set(prev).add(pos));
    const existing = changedTimers.current.get(pos);
    if (existing) clearTimeout(existing);
    changedTimers.current.set(
      pos,
      setTimeout(() => {
        setChangedPositions((prev) => {
          const next = new Set(prev);
          next.delete(pos);
          return next;
        });
        changedTimers.current.delete(pos);
      }, 2000),
    );
  }, []);

  // Stable singleton client – avoid creating a new instance on every getToken() call
  const supabase = useMemo(() => createClient(), []);

  const getToken = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return data.session?.access_token ?? "";
    } catch {
      // Token refresh failed – return empty string; individual API calls will handle the 401
      return "";
    }
  }, [supabase]);

  const addMessage = useCallback((role: ChatMessage["role"], text: string) => {
    const msg: ChatMessage = {
      id: `msg_${++idCounter.current}`,
      role,
      text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const TOOL_LABELS: Record<string, string> = useMemo(() => ({
    search_products: "Hledání produktů",
    semantic_search: "Sémantické vyhledávání",
    add_item_to_offer: "Přidání položky",
    replace_product_in_offer: "Záměna produktu",
    remove_item_from_offer: "Odstranění položky",
    parse_items_from_text: "Zpracování položek",
  }), []);

  // ──────────────────────────────────────────────────────────
  // TSV parsing utilities
  // ──────────────────────────────────────────────────────────

  const detectHeader = useCallback((firstRow: string[]): string[] | null => {
    const KNOWN_HEADERS = new Set([
      "název", "nazev", "name", "položka", "polozka", "popis", "produkt", "materiál", "material",
      "množství", "mnozstvi", "množstvo", "mnozstvo", "qty", "quantity", "počet", "pocet", "ks",
      "jednotka", "mj", "unit", "j.",
      "sku", "kód", "kod", "code", "číslo", "cislo", "artikl",
      "cena", "price", "cena/ks", "cena/mj",
      "výrobce", "vyrobce", "manufacturer", "brand", "značka", "znacka",
      "kategorie", "category", "skupina",
      "poznámka", "poznamka", "note", "notes", "komentář", "komentar",
      "objednávka", "objednavka", "typ", "type",
      "ean", "katalog", "catalog", "obj. č.", "obj. c.", "obj.č.", "obj.c.",
    ]);

    const lowerCols = firstRow.map((c) => c.toLowerCase().trim());
    const matchCount = lowerCols.filter((c) => KNOWN_HEADERS.has(c)).length;
    const numericCount = firstRow.filter((c) => /^\d+([.,]\d+)?$/.test(c.trim())).length;

    if (matchCount >= 1 && numericCount <= 1) return firstRow;
    if (matchCount >= 2) return firstRow;
    return null;
  }, []);

  const classifyColumns = useCallback((headers: string[]): {
    nameIdx: number;
    unitIdx: number | null;
    quantityIdx: number | null;
    extraIdxMap: Array<{ idx: number; label: string }>;
  } => {
    const NAME_PATTERNS = /^(název|nazev|name|položka|polozka|popis|produkt|materiál|material)$/i;
    const UNIT_PATTERNS = /^(jednotka|mj|unit|j\.)$/i;
    const QTY_PATTERNS = /^(množství|mnozstvi|množstvo|mnozstvo|qty|quantity|počet|pocet|ks)$/i;

    let nameIdx = -1;
    let unitIdx: number | null = null;
    let quantityIdx: number | null = null;
    const extraIdxMap: Array<{ idx: number; label: string }> = [];

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].trim();
      const lower = h.toLowerCase();
      if (nameIdx === -1 && NAME_PATTERNS.test(lower)) {
        nameIdx = i;
      } else if (unitIdx === null && UNIT_PATTERNS.test(lower)) {
        unitIdx = i;
      } else if (quantityIdx === null && QTY_PATTERNS.test(lower)) {
        quantityIdx = i;
      } else if (h) {
        extraIdxMap.push({ idx: i, label: h });
      }
    }

    if (nameIdx === -1) {
      nameIdx = 0;
      const dupIdx = extraIdxMap.findIndex((e) => e.idx === 0);
      if (dupIdx !== -1) extraIdxMap.splice(dupIdx, 1);
    }

    return { nameIdx, unitIdx, quantityIdx, extraIdxMap };
  }, []);

  const parseTSVLocally = useCallback((text: string): ParsedItem[] => {
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return [];

    const items: ParsedItem[] = [];
    const firstRowCols = lines[0].split("\t").map((c) => c.trim());
    const headers = detectHeader(firstRowCols);

    if (headers) {
      const { nameIdx, unitIdx, quantityIdx, extraIdxMap } = classifyColumns(headers);
      const dataLines = lines.slice(1);

      for (const line of dataLines) {
        const cols = line.split("\t").map((c) => c.trim());
        const name = cols[nameIdx] ?? "";
        if (!name.trim()) continue;

        const unitVal = unitIdx !== null ? (cols[unitIdx] || null) : null;
        let quantityVal: number | null = null;
        if (quantityIdx !== null && cols[quantityIdx]) {
          const num = parseFloat(cols[quantityIdx].replace(",", "."));
          quantityVal = isNaN(num) ? null : num;
        }

        const extra: Record<string, string> = {};
        for (const { idx, label } of extraIdxMap) {
          const val = cols[idx]?.trim();
          if (val) extra[label] = val;
        }

        items.push({
          id: `item_${++idCounter.current}`,
          name: name.trim(),
          unit: unitVal,
          quantity: quantityVal,
          ...(Object.keys(extra).length > 0 ? { extraColumns: extra } : {}),
        });
      }
    } else {
      for (const line of lines) {
        const cols = line.split("\t").map((c) => c.trim());
        if (cols.length === 0 || !cols[0]) continue;

        let name = cols[0];
        let unit: string | null = null;
        let quantity: number | null = null;

        if (cols.length >= 3) {
          name = cols[0];
          unit = cols[1] || null;
          const num = parseFloat(cols[2].replace(",", "."));
          quantity = isNaN(num) ? null : num;

          const extra: Record<string, string> = {};
          for (let i = 3; i < cols.length; i++) {
            const val = cols[i]?.trim();
            if (val) extra[`Sloupec ${i + 1}`] = val;
          }

          if (name.trim()) {
            items.push({
              id: `item_${++idCounter.current}`,
              name: name.trim(),
              unit,
              quantity,
              ...(Object.keys(extra).length > 0 ? { extraColumns: extra } : {}),
            });
            continue;
          }
        } else if (cols.length === 2) {
          const num = parseFloat(cols[1].replace(",", "."));
          if (!isNaN(num)) {
            quantity = num;
          } else {
            unit = cols[1];
          }
        }

        const firstNum = parseFloat(cols[0].replace(",", "."));
        if (!isNaN(firstNum) && cols.length > 1 && isNaN(parseFloat(cols[1].replace(",", ".")))) {
          quantity = firstNum;
          name = cols[1];
          if (cols.length >= 3) unit = cols[2] || null;
        }

        if (name.trim()) {
          items.push({
            id: `item_${++idCounter.current}`,
            name: name.trim(),
            unit,
            quantity,
          });
        }
      }
    }

    return items;
  }, [detectHeader, classifyColumns]);

  // ──────────────────────────────────────────────────────────
  // Build compact offer context for the agent
  // ──────────────────────────────────────────────────────────

  const buildOfferSummary = useCallback((): OfferItemSummary[] => {
    return offerItems.map((i) => ({
      position: i.position,
      name: i.originalName,
      sku: i.product?.sku ?? null,
      manufacturer: i.product?.manufacturer ?? null,
      category: i.product?.category ?? null,
      matchType: i.matchType,
    }));
  }, [offerItems]);

  // ──────────────────────────────────────────────────────────
  // Process actions returned by the offer agent
  // ──────────────────────────────────────────────────────────

  const processAction = useCallback(
    (action: OfferAction) => {
      switch (action.type) {
        case "parse_items": {
          const items: ParsedItem[] = action.items.map((r) => ({
            id: `item_${++idCounter.current}`,
            name: r.name,
            unit: null,
            quantity: r.quantity ?? null,
          }));
          setParsedItems(items);
          setPhase("parsed");
          break;
        }
        case "add_item": {
          const product = action.product ?? null;
          setOfferItems((prev) => {
            const maxPos = prev.length > 0 ? Math.max(...prev.map((i) => i.position)) : -1;
            const newPos = maxPos + 1;
            flashPosition(newPos);
            const newItem: OfferItem = {
              position: newPos,
              originalName: action.name,
              unit: product?.unit ?? null,
              quantity: action.quantity,
              matchType: product ? "match" : "not_found",
              confidence: product ? 85 : 0,
              product,
              candidates: [],
            };
            return [...prev, newItem];
          });
          if (phase === "idle" || phase === "parsed") {
            setPhase("review");
          }
          break;
        }
        case "replace_product": {
          const product = action.product ?? null;
          flashPosition(action.position);
          setOfferItems((prev) =>
            prev.map((i) =>
              i.position === action.position
                ? {
                    ...i,
                    product,
                    matchType: product ? ("match" as const) : i.matchType,
                    confidence: product ? 100 : i.confidence,
                  }
                : i,
            ),
          );
          break;
        }
        case "remove_item": {
          setOfferItems((prev) => {
            const filtered = prev.filter((i) => i.position !== action.position);
            return filtered.map((item, idx) => ({ ...item, position: idx }));
          });
          break;
        }
      }
    },
    [phase, flashPosition],
  );

  // ──────────────────────────────────────────────────────────
  // Handler: user sends input (route to offer agent)
  // ──────────────────────────────────────────────────────────

  const handleSendMessage = useCallback(
    async (text: string) => {
      addMessage("user", text);
      setIsParsingChat(true);

      const streamingMsgId = `msg_${++idCounter.current}`;
      let toolCallSeq = 0;
      const streamingMsg: ChatMessage = {
        id: streamingMsgId,
        role: "assistant",
        text: "",
        timestamp: new Date(),
        isStreaming: true,
        toolCalls: [],
      };
      setMessages((prev) => [...prev, streamingMsg]);

      try {
        const token = await getToken();
        const summary = buildOfferSummary();
        const stream = offerChat(text, summary, token);

        for await (const event of stream) {
          if (event.type === "text_delta") {
            const delta = (event.data as { delta: string }).delta;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMsgId ? { ...m, text: m.text + delta } : m,
              ),
            );
          } else if (event.type === "text_done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMsgId ? { ...m, isStreaming: false } : m,
              ),
            );
          } else if (event.type === "tool_activity") {
            const { tool, status } = event.data as { tool: string; status: "start" | "end" };
            if (status === "start") {
              const tcId = `tc_${++toolCallSeq}`;
              const label = TOOL_LABELS[tool] ?? tool;
              const tc: ToolCallStatus = { id: tcId, tool, label, status: "running" };
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingMsgId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                    : m,
                ),
              );
            } else {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== streamingMsgId) return m;
                  const updated = (m.toolCalls ?? []).map((tc) =>
                    tc.tool === tool && tc.status === "running"
                      ? { ...tc, status: "done" as const }
                      : tc,
                  );
                  return { ...m, toolCalls: updated };
                }),
              );
            }
          } else if (event.type === "debug") {
            const d = event.data as unknown as DebugEntry;
            setDebugLog((prev) => [...prev, d]);
          } else if (event.type === "action") {
            processAction(event.data as unknown as OfferAction);
          } else if (event.type === "error") {
            addMessage("system", `Chyba: ${event.data.message}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Nastala chyba";
        addMessage("system", `Chyba: ${msg}`);
      } finally {
        setIsParsingChat(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingMsgId && m.isStreaming
              ? { ...m, isStreaming: false, toolCalls: (m.toolCalls ?? []).map((tc) => ({ ...tc, status: "done" as const })) }
              : m,
          ),
        );
        setMessages((prev) =>
          prev.filter((m) => !(m.id === streamingMsgId && !m.text.trim() && !(m.toolCalls?.length))),
        );
      }
    },
    [addMessage, getToken, buildOfferSummary, processAction, TOOL_LABELS],
  );

  // ──────────────────────────────────────────────────────────
  // TSV paste modal handlers
  // ──────────────────────────────────────────────────────────

  const handlePasteDetected = useCallback((text: string) => {
    setPendingPaste(text);
  }, []);

  const handlePasteImport = useCallback(() => {
    if (!pendingPaste) return;
    const items = parseTSVLocally(pendingPaste);
    if (phase === "review" && offerItems.length > 0) {
      const maxPos = Math.max(...offerItems.map((i) => i.position));
      const newOfferItems: OfferItem[] = items.map((item, i) => ({
        position: maxPos + 1 + i,
        originalName: item.name,
        unit: item.unit,
        quantity: item.quantity,
        matchType: "not_found" as const,
        confidence: 0,
        product: null,
        candidates: [],
        ...(item.extraColumns && Object.keys(item.extraColumns).length > 0
          ? { extraColumns: item.extraColumns }
          : {}),
      }));
      setOfferItems((prev) => [...prev, ...newOfferItems]);
      addMessage("system", `Přidáno ${items.length} položek do nabídky.`);
    } else {
      setParsedItems(items);
      setPhase("parsed");
      addMessage("system", `Rozpoznáno ${items.length} položek z tabulky. Zkontrolujte a klikněte Zpracovat.`);
    }
    setPendingPaste(null);
  }, [pendingPaste, parseTSVLocally, phase, offerItems, addMessage]);

  const handlePasteSendAsMessage = useCallback(() => {
    if (!pendingPaste) return;
    const text = pendingPaste;
    setPendingPaste(null);
    handleSendMessage(text);
  }, [pendingPaste, handleSendMessage]);

  const handlePasteCancel = useCallback(() => {
    setPendingPaste(null);
  }, []);

  // ──────────────────────────────────────────────────────────
  // Handler: user clicks "Zpracovat" → search phase
  // ──────────────────────────────────────────────────────────

  const handleProcess = useCallback(async () => {
    const validItems = parsedItems.filter((i) => i.name.trim());
    if (validItems.length === 0) return;

    setPhase("processing");
    addMessage("system", `Vyhledávám ${validItems.length} položek v katalogu…`);

    const emptyOfferItems: OfferItem[] = validItems.map((item, i) => ({
      position: i,
      originalName: item.name,
      unit: item.unit,
      quantity: item.quantity,
      matchType: "not_found" as const,
      confidence: 0,
      product: null,
      candidates: [],
      ...(item.extraColumns && Object.keys(item.extraColumns).length > 0
        ? { extraColumns: item.extraColumns }
        : {}),
    }));
    setOfferItems(emptyOfferItems);
    setSearchingSet(new Set(validItems.map((_, i) => i)));

    try {
      const token = await getToken();
      const stream = searchItems(
        validItems.map((i) => ({ name: i.name, unit: i.unit, quantity: i.quantity })),
        token,
      );

      for await (const event of stream) {
        if (event.type === "item_searching") {
          const pos = event.data.position as number;
          setSearchingSet((prev) => new Set(prev).add(pos));
        } else if (event.type === "item_matched") {
          const data = event.data as unknown as OfferItem;
          setSearchingSet((prev) => {
            const next = new Set(prev);
            next.delete(data.position);
            return next;
          });
          flashPosition(data.position);
          setOfferItems((prev) =>
            prev.map((item) =>
              item.position === data.position
                ? { ...item, ...data, extraColumns: item.extraColumns }
                : item,
            ),
          );
        } else if (event.type === "status" && event.data.phase === "review") {
          setSearchingSet(new Set());
          setPhase("review");
          addMessage("system", "Zpracování dokončeno. Zkontrolujte výsledky a stáhněte Excel.");
        } else if (event.type === "error") {
          addMessage("system", `Chyba: ${event.data.message}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Nastala chyba";
      addMessage("system", `Chyba: ${msg}`);
    } finally {
      setSearchingSet(new Set());
      if (phase === "processing") setPhase("review");
    }
  }, [parsedItems, addMessage, getToken, phase]);

  // ──────────────────────────────────────────────────────────
  // Handler: user clicks "Zpracovat nenalezené" → semantic search
  // ──────────────────────────────────────────────────────────

  const handleProcessNotFound = useCallback(async () => {
    const notFoundItems = offerItems.filter(
      (i) => i.matchType === "not_found" && !i.confirmed,
    );
    if (notFoundItems.length === 0) return;

    setIsSearchingSemantic(true);
    setSearchingSet(new Set(notFoundItems.map((i) => i.position)));
    addMessage("system", `Spouštím sémantické vyhledávání pro ${notFoundItems.length} nenalezených položek…`);

    try {
      const token = await getToken();
      const stream = searchItemsSemantic(
        notFoundItems.map((i) => ({
          name: i.originalName,
          unit: i.unit,
          quantity: i.quantity,
          position: i.position,
        })),
        token,
      );

      for await (const event of stream) {
        if (event.type === "item_matched") {
          const data = event.data as unknown as OfferItem;
          setSearchingSet((prev) => {
            const next = new Set(prev);
            next.delete(data.position);
            return next;
          });
          setOfferItems((prev) =>
            prev.map((item) =>
              item.position === data.position
                ? { ...item, ...data, extraColumns: item.extraColumns }
                : item,
            ),
          );
        } else if (event.type === "status" && event.data.phase === "review") {
          setSearchingSet(new Set());
          addMessage("system", "Sémantické vyhledávání dokončeno.");
        } else if (event.type === "error") {
          addMessage("system", `Chyba: ${event.data.message}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Nastala chyba";
      addMessage("system", `Chyba: ${msg}`);
    } finally {
      setSearchingSet(new Set());
      setIsSearchingSemantic(false);
    }
  }, [offerItems, addMessage, getToken]);

  // ──────────────────────────────────────────────────────────
  // Review handlers
  // ──────────────────────────────────────────────────────────

  const handleItemClick = useCallback((item: OfferItem) => {
    setReviewItem(item);
  }, []);

  const handleConfirm = useCallback((item: OfferItem, selectedProduct: Product | null) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.position === item.position
          ? { ...i, product: selectedProduct, confirmed: true, matchType: "match" as const, confidence: 100 }
          : i,
      ),
    );
    setReviewItem(null);
  }, []);

  const handleSkip = useCallback((item: OfferItem) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.position === item.position ? { ...i, confirmed: true } : i,
      ),
    );
    setReviewItem(null);
  }, []);

  const handleManualSearch = useCallback(
    async (query: string): Promise<Product[]> => {
      const token = await getToken();
      return searchProducts(query, token);
    },
    [getToken],
  );

  // ──────────────────────────────────────────────────────────
  // Export & reset
  // ──────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    try {
      const token = await getToken();
      const exportItems = offerItems.map((item) => ({
        originalName: item.originalName,
        quantity: item.quantity,
        sku: item.product?.sku ?? null,
        productName: item.product?.name ?? null,
        manufacturerCode: item.product?.manufacturer_code ?? null,
        manufacturer: item.product?.manufacturer ?? null,
        matchType: item.matchType,
        confidence: item.confidence,
        ...(item.extraColumns && Object.keys(item.extraColumns).length > 0
          ? { extraColumns: item.extraColumns }
          : {}),
      }));

      const blob = await downloadXlsx(exportItems, token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kv-nabidka-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      addMessage("system", "Export se nezdařil.");
    }
  }, [offerItems, getToken, addMessage]);

  const handleReset = useCallback(() => {
    setPhase("idle");
    setParsedItems([]);
    setOfferItems([]);
    setSearchingSet(new Set());
    setReviewItem(null);
    setMessages([]);
    setDebugLog([]);
  }, []);

  const handleClearDebug = useCallback(() => {
    setDebugLog([]);
  }, []);

  const handleFileUpload = useCallback(
    (_file: File) => {
      addMessage("system", "Zpracování souborů bude implementováno v další fázi.");
    },
    [addMessage],
  );

  // ──────────────────────────────────────────────────────────
  // Right panel content depends on the phase
  // ──────────────────────────────────────────────────────────

  function renderRightPanel() {
    switch (phase) {
      case "idle":
      case "parsing":
        return (
          <div className="flex h-full items-center justify-center">
            <div className="text-center px-8">
              <div className="mb-3 mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-kv-gray-100">
                <svg className="h-5 w-5 text-kv-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M20.625 12c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5M12 14.625v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 14.625c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m0 0v.375" />
                </svg>
              </div>
              <p className="text-sm font-medium text-kv-gray-500">
                {isParsingChat ? "AI zpracovává požadavek…" : "Vložte poptávku vlevo"}
              </p>
              <p className="mt-1 text-xs text-kv-gray-400">
                Tabulka se naplní po vložení dat
              </p>
            </div>
          </div>
        );

      case "parsed":
        return (
          <ParsedItemsTable
            items={parsedItems}
            onItemsChange={setParsedItems}
            onProcess={handleProcess}
            isProcessing={false}
          />
        );

      case "processing":
      case "review":
        return (
          <ResultsTable
            items={offerItems}
            searchingSet={searchingSet}
            changedPositions={changedPositions}
            onItemClick={handleItemClick}
            onExport={handleExport}
            onReset={handleReset}
            onProcessNotFound={handleProcessNotFound}
            isSearchingSemantic={isSearchingSemantic}
          />
        );
    }
  }

  return (
    <div className="flex h-screen flex-col bg-kv-gray-50">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel – Chat/Input */}
        <div className="relative flex w-[420px] shrink-0 flex-col border-r border-kv-gray-200 bg-white">
          <ChatPanel
            messages={messages}
            isProcessing={isParsingChat}
            onSendMessage={handleSendMessage}
            onFileUpload={handleFileUpload}
            onPasteDetected={handlePasteDetected}
          />
        </div>

        {/* Right panel – Context-dependent */}
        <div className="flex flex-1 flex-col bg-white">
          {renderRightPanel()}
        </div>
      </div>

      {/* Agent Debug Panel (bottom drawer) */}
      {showDebug && (
        <AgentDebugPanel entries={debugLog} onClear={handleClearDebug} />
      )}

      {/* Debug toggle button */}
      <button
        onClick={() => setShowDebug((v) => !v)}
        className={`fixed bottom-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono shadow-lg transition-all ${
          showDebug
            ? "bg-green-500 text-black hover:bg-green-400"
            : "bg-[#161b22] text-green-400 border border-[#30363d] hover:bg-[#1c2128]"
        }`}
        title={showDebug ? "Skrýt debug panel" : "Zobrazit debug panel"}
      >
        <span className="text-[10px]">{showDebug ? "▼" : "▲"}</span>
        <span>DEBUG</span>
        {debugLog.length > 0 && (
          <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${
            showDebug ? "bg-black/20 text-black" : "bg-green-400/20 text-green-400"
          }`}>
            {debugLog.length}
          </span>
        )}
      </button>

      {/* Review modal */}
      {reviewItem && (
        <ReviewModal
          item={reviewItem}
          onConfirm={handleConfirm}
          onSkip={handleSkip}
          onClose={() => setReviewItem(null)}
          onManualSearch={handleManualSearch}
        />
      )}

      {/* TSV paste confirmation modal */}
      {pendingPaste && (
        <PasteConfirmModal
          text={pendingPaste}
          onImport={handlePasteImport}
          onSendAsMessage={handlePasteSendAsMessage}
          onCancel={handlePasteCancel}
        />
      )}
    </div>
  );
}
