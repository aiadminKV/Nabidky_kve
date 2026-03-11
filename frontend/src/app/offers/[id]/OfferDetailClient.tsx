"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentDebugPanel } from "@/components/AgentDebugPanel";
import { PasteConfirmModal } from "@/components/PasteConfirmModal";
import { ParsedItemsTable } from "@/components/ParsedItemsTable";
import { ResultsTable } from "@/components/ResultsTable";
import { ReviewModal } from "@/components/ReviewModal";
import { OfferHeaderForm } from "@/components/OfferHeaderForm";
import { createClient } from "@/lib/supabase/client";
import { parsePastedText } from "@/lib/parsePaste";
import {
  offerChat, searchItems, searchItemsSemantic, searchProducts, downloadXlsx,
  getOffer, saveOfferMessages, saveOfferItems,
  type ChatMessageDTO, type SaveOfferItemInput,
} from "@/lib/api";
import type {
  ChatMessage,
  DebugEntry,
  OfferAction,
  OfferHeader,
  OfferItem,
  OfferItemSummary,
  OfferPhase,
  ParsedItem,
  Product,
  ToolCallStatus,
} from "@/lib/types";

interface OfferDetailClientProps {
  offerId: string;
  email: string;
  isAdmin?: boolean;
}

export function OfferDetailClient({ offerId, email, isAdmin }: OfferDetailClientProps) {
  const router = useRouter();
  const [offerTitle, setOfferTitle] = useState("");
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
  const [changedPositions, setChangedPositions] = useState<Set<number>>(new Set());
  const [offerHeader, setOfferHeader] = useState<OfferHeader>({
    customerIco: "",
    customerName: "",
    deliveryDate: "",
    offerName: "",
    phone: "",
    email: "",
    specialAction: "",
    branch: "",
    deliveryAddress: "",
  });
  const [loadingOffer, setLoadingOffer] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const idCounter = useRef(0);
  const changedTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveItemsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const supabase = useMemo(() => createClient(), []);

  const getToken = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return data.session?.access_token ?? "";
    } catch {
      return "";
    }
  }, [supabase]);

  // ──────────────────────────────────────────────────────────
  // Load offer from DB on mount
  // ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const token = await getToken();
        const { offer, items } = await getOffer(offerId, token);

        if (cancelled) return;

        setOfferTitle(offer.title);

        if (offer.messages && offer.messages.length > 0) {
          const restored: ChatMessage[] = offer.messages.map((m: ChatMessageDTO) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            timestamp: new Date(m.timestamp),
          }));
          setMessages(restored);
          const maxId = restored.reduce((max, m) => {
            const num = parseInt(m.id.replace("msg_", ""), 10);
            return isNaN(num) ? max : Math.max(max, num);
          }, 0);
          idCounter.current = maxId;
        }

        if (items && items.length > 0) {
          const restored: OfferItem[] = items.map((item) => ({
            position: item.position,
            originalName: item.originalName,
            unit: item.unit,
            quantity: item.quantity,
            matchType: (item.matchType as OfferItem["matchType"]) ?? "not_found",
            confidence: item.confidence ?? 0,
            product: item.product,
            candidates: item.candidates ?? [],
            confirmed: item.confirmed,
            extraColumns: item.extraColumns && Object.keys(item.extraColumns).length > 0
              ? item.extraColumns
              : undefined,
          }));
          setOfferItems(restored);
          setPhase("review");
        }
      } catch {
        if (!cancelled) setLoadError("Nabídku se nepodařilo načíst.");
      } finally {
        if (!cancelled) setLoadingOffer(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [offerId, getToken]);

  // ──────────────────────────────────────────────────────────
  // Auto-save messages (debounced)
  // ──────────────────────────────────────────────────────────

  const persistMessages = useCallback(async (msgs: ChatMessage[]) => {
    try {
      const token = await getToken();
      const dtos: ChatMessageDTO[] = msgs
        .filter((m) => !m.isStreaming)
        .map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp.toISOString(),
        }));
      await saveOfferMessages(offerId, dtos, token);
    } catch {
      // silent
    }
  }, [offerId, getToken]);

  const debouncedSaveMessages = useCallback((msgs: ChatMessage[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistMessages(msgs);
    }, 1500);
  }, [persistMessages]);

  // ──────────────────────────────────────────────────────────
  // Auto-save offer items (debounced)
  // ──────────────────────────────────────────────────────────

  const persistItems = useCallback(async (items: OfferItem[]) => {
    try {
      const token = await getToken();
      const dtos: SaveOfferItemInput[] = items.map((i) => ({
        position: i.position,
        originalName: i.originalName,
        unit: i.unit,
        quantity: i.quantity,
        matchType: i.matchType,
        confidence: i.confidence,
        productId: i.product?.id ?? null,
        confirmed: i.confirmed,
        candidates: i.candidates ?? [],
        extraColumns: i.extraColumns,
      }));
      await saveOfferItems(offerId, dtos, token);
    } catch {
      // silent
    }
  }, [offerId, getToken]);

  const debouncedSaveItems = useCallback((items: OfferItem[]) => {
    if (saveItemsTimerRef.current) clearTimeout(saveItemsTimerRef.current);
    saveItemsTimerRef.current = setTimeout(() => {
      persistItems(items);
    }, 2000);
  }, [persistItems]);

  const addMessage = useCallback((role: ChatMessage["role"], text: string) => {
    const msg: ChatMessage = {
      id: `msg_${++idCounter.current}`,
      role,
      text,
      timestamp: new Date(),
    };
    setMessages((prev) => {
      const next = [...prev, msg];
      debouncedSaveMessages(next);
      return next;
    });
    return msg;
  }, [debouncedSaveMessages]);

  const TOOL_LABELS: Record<string, string> = useMemo(() => ({
    search_product: "AI vyhledávání",
    get_category_info: "Zjišťování kategorií",
    add_item_to_offer: "Přidání položky",
    replace_product_in_offer: "Záměna produktu",
    remove_item_from_offer: "Odstranění položky",
    parse_items_from_text: "Zpracování položek",
    process_items: "Hromadné zpracování",
    update_offer_header: "Aktualizace hlavičky",
  }), []);

  // ──────────────────────────────────────────────────────────
  // TSV parsing (fixed format: Název \t MJ \t Množství)
  // ──────────────────────────────────────────────────────────

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
        case "process_items": {
          const emptyItems: OfferItem[] = action.items.map((item, i) => ({
            position: i,
            originalName: item.name,
            unit: item.unit,
            quantity: item.quantity,
            matchType: "not_found" as const,
            confidence: 0,
            product: null,
            candidates: [],
          }));
          setOfferItems(emptyItems);
          setSearchingSet(new Set(action.items.map((_, i) => i)));
          setPhase("processing");
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
              matchType: action.matchType ?? (product ? "match" : "not_found"),
              confidence: action.confidence ?? (product ? 85 : 0),
              product,
              candidates: (action.candidates ?? []) as Product[],
              reasoning: action.reasoning,
            };
            const next = [...prev, newItem];
            debouncedSaveItems(next);
            return next;
          });
          if (phase === "idle" || phase === "parsed") {
            setPhase("review");
          }
          break;
        }
        case "replace_product": {
          const product = action.product ?? null;
          flashPosition(action.position);
          setOfferItems((prev) => {
            const next = prev.map((i) =>
              i.position === action.position
                ? {
                    ...i,
                    product,
                    candidates: (action.candidates as Product[] | undefined)?.length
                      ? (action.candidates as Product[])
                      : i.candidates,
                    matchType: action.matchType ?? (product ? ("match" as const) : i.matchType),
                    confidence: action.confidence ?? (product ? 100 : i.confidence),
                  }
                : i,
            );
            debouncedSaveItems(next);
            return next;
          });
          break;
        }
        case "remove_item": {
          setOfferItems((prev) => {
            const filtered = prev.filter((i) => i.position !== action.position);
            const next = filtered.map((item, idx) => ({ ...item, position: idx }));
            debouncedSaveItems(next);
            return next;
          });
          break;
        }
        case "update_header": {
          setOfferHeader((prev) => ({ ...prev, ...action.fields }));
          break;
        }
      }
    },
    [phase, flashPosition, debouncedSaveItems],
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
            setMessages((prev) => {
              const next = prev.map((m) =>
                m.id === streamingMsgId ? { ...m, isStreaming: false } : m,
              );
              debouncedSaveMessages(next);
              return next;
            });
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
          } else if (event.type === "item_searching") {
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
            setOfferItems((prev) => {
              const next = prev.map((item) =>
                item.position === data.position
                  ? { ...item, ...data, extraColumns: item.extraColumns }
                  : item,
              );
              debouncedSaveItems(next);
              return next;
            });
          } else if (event.type === "status" && event.data.phase === "review") {
            setSearchingSet(new Set());
            setPhase("review");
          } else if (event.type === "error") {
            addMessage("system", `Chyba: ${event.data.message}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Nastala chyba";
        addMessage("system", `Chyba: ${msg}`);
      } finally {
        setIsParsingChat(false);
        setMessages((prev) => {
          let next = prev.map((m) =>
            m.id === streamingMsgId && m.isStreaming
              ? { ...m, isStreaming: false, toolCalls: (m.toolCalls ?? []).map((tc) => ({ ...tc, status: "done" as const })) }
              : m,
          );
          next = next.filter((m) => !(m.id === streamingMsgId && !m.text.trim() && !(m.toolCalls?.length)));
          debouncedSaveMessages(next);
          return next;
        });
      }
    },
    [addMessage, getToken, buildOfferSummary, processAction, TOOL_LABELS, debouncedSaveMessages, flashPosition, debouncedSaveItems],
  );

  // ──────────────────────────────────────────────────────────
  // TSV paste modal handlers
  // ──────────────────────────────────────────────────────────

  const handlePasteDetected = useCallback((text: string) => {
    setPendingPaste(text);
  }, []);

  const handlePasteImport = useCallback(() => {
    if (!pendingPaste) return;
    const items = parsePastedText(pendingPaste);
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
      setOfferItems((prev) => {
        const next = [...prev, ...newOfferItems];
        debouncedSaveItems(next);
        return next;
      });
      addMessage("system", `Přidáno ${items.length} položek do nabídky.`);
    } else {
      setParsedItems(items);
      setPhase("parsed");
      addMessage("system", `Rozpoznáno ${items.length} položek z tabulky. Zkontrolujte a klikněte Zpracovat.`);
    }
    setPendingPaste(null);
  }, [pendingPaste, phase, offerItems, addMessage, debouncedSaveItems]);

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
  // Handler: user clicks "Zpracovat" -> search phase
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
          setOfferItems((prev) => {
            const next = prev.map((item) =>
              item.position === data.position
                ? { ...item, ...data, extraColumns: item.extraColumns }
                : item,
            );
            debouncedSaveItems(next);
            return next;
          });
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
  }, [parsedItems, addMessage, getToken, phase, flashPosition, debouncedSaveItems]);

  // ──────────────────────────────────────────────────────────
  // Handler: user clicks "Zpracovat nenalezené" -> semantic search
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
          setOfferItems((prev) => {
            const next = prev.map((item) =>
              item.position === data.position
                ? { ...item, ...data, extraColumns: item.extraColumns }
                : item,
            );
            debouncedSaveItems(next);
            return next;
          });
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
  }, [offerItems, addMessage, getToken, debouncedSaveItems]);

  // ──────────────────────────────────────────────────────────
  // Review handlers
  // ──────────────────────────────────────────────────────────

  const handleItemClick = useCallback((item: OfferItem) => {
    setReviewItem(item);
  }, []);

  const handleConfirm = useCallback((item: OfferItem, selectedProduct: Product | null) => {
    setOfferItems((prev) => {
      const next = prev.map((i) =>
        i.position === item.position
          ? { ...i, product: selectedProduct, confirmed: true, matchType: "match" as const, confidence: 100 }
          : i,
      );
      debouncedSaveItems(next);
      return next;
    });
    setReviewItem(null);
  }, [debouncedSaveItems]);

  const handleSkip = useCallback((item: OfferItem) => {
    setOfferItems((prev) => {
      const next = prev.map((i) =>
        i.position === item.position ? { ...i, confirmed: true } : i,
      );
      debouncedSaveItems(next);
      return next;
    });
    setReviewItem(null);
  }, [debouncedSaveItems]);

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
        unit: item.unit,
        sku: item.product?.sku ?? null,
        productName: item.product?.name ?? null,
        manufacturerCode: item.product?.manufacturer_code ?? null,
        manufacturer: item.product?.manufacturer ?? null,
        matchType: item.matchType,
        confidence: item.confidence,
      }));

      const blob = await downloadXlsx(exportItems, offerHeader, token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kv-nabidka-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      addMessage("system", "Export se nezdařil.");
    }
  }, [offerItems, offerHeader, getToken, addMessage]);

  const handleReset = useCallback(async () => {
    setPhase("idle");
    setParsedItems([]);
    setOfferItems([]);
    setSearchingSet(new Set());
    setReviewItem(null);
    setMessages([]);
    setDebugLog([]);

    try {
      const token = await getToken();
      await saveOfferMessages(offerId, [], token);
      await saveOfferItems(offerId, [], token);
    } catch {
      // silent
    }
  }, [offerId, getToken]);

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
  // Loading / error states
  // ──────────────────────────────────────────────────────────

  if (loadingOffer) {
    return (
      <div className="flex h-screen flex-col">
        <Header email={email} isAdmin={isAdmin} />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-kv-gray-400">
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Načítám nabídku…</span>
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-screen flex-col">
        <Header email={email} isAdmin={isAdmin} />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-red-500">{loadError}</p>
            <button
              onClick={() => router.push("/offers")}
              className="mt-4 rounded-lg bg-kv-red px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-red-100"
            >
              Zpět na nabídky
            </button>
          </div>
        </div>
      </div>
    );
  }

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
    <div className="flex h-screen flex-col">
      <Header email={email} isAdmin={isAdmin} offerTitle={offerTitle} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel – Chat + Debug */}
        <div className="relative flex w-[420px] shrink-0 flex-col border-r border-kv-gray-200 bg-white">
          <ChatPanel
            messages={messages}
            isProcessing={isParsingChat}
            onSendMessage={handleSendMessage}
            onFileUpload={handleFileUpload}
            onPasteDetected={handlePasteDetected}
            debugSlot={
              <AgentDebugPanel entries={debugLog} onClear={handleClearDebug} />
            }
          />
        </div>

        {/* Right panel – Context-dependent */}
        <div className="flex flex-1 flex-col bg-white">
          <OfferHeaderForm header={offerHeader} onChange={setOfferHeader} />
          {renderRightPanel()}
        </div>
      </div>

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
