"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/Header";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentDebugPanel } from "@/components/AgentDebugPanel";
import { ColumnMapperModal } from "@/components/ColumnMapperModal";
import { ParsedItemsTable } from "@/components/ParsedItemsTable";
import { ResultsTable } from "@/components/ResultsTable";
import { ReviewModal } from "@/components/ReviewModal";
import { OfferHeaderForm } from "@/components/OfferHeaderForm";
import { createClient } from "@/lib/supabase/client";
import type { ParsedItem } from "@/lib/types";
import { offerChat, searchItems, downloadXlsx, downloadSapXlsx, getSearchPlan, searchItemWithStockLevel, type SearchPlan } from "@/lib/api";
import { SearchPlanPanel } from "@/components/SearchPlanPanel";
import { PreSearchModal } from "@/components/PreSearchModal";
import {
  generateItemId,
  DEFAULT_SEARCH_PREFERENCES,
  type ChatMessage,
  type DebugEntry,
  type FileAttachment,
  type OfferAction,
  type OfferHeader,
  type OfferItem,
  type OfferItemSummary,
  type OfferPhase,
  type ParsedItem,
  type Product,
  type SearchPreferences,
  type StockLevel,
  type ToolCallStatus,
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
  const [searchingSet, setSearchingSet] = useState<Set<string>>(new Set());
  const [reviewItem, setReviewItem] = useState<OfferItem | null>(null);
  const [isParsingChat, setIsParsingChat] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);
  const [offerHeader, setOfferHeader] = useState<OfferHeader>({
    customerId: "",
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
  const [changedPositions, setChangedPositions] = useState<Set<number>>(new Set());
  const [cachedToken, setCachedToken] = useState("");
  const [preSearchOpen, setPreSearchOpen] = useState(false);
  const [preSearchAction, setPreSearchAction] = useState<"full">("full");
  const [searchPlan, setSearchPlan] = useState<SearchPlan | null>(null);
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [searchPreferences, setSearchPreferences] = useState<SearchPreferences>(DEFAULT_SEARCH_PREFERENCES);
  const batchPositionOffset = useRef(0);
  const batchItemIds = useRef<string[]>([]);
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
      const token = data.session?.access_token ?? "";
      if (token) setCachedToken(token);
      return token;
    } catch {
      // Token refresh failed – return empty string; individual API calls will handle the 401
      return "";
    }
  }, [supabase]);

  useEffect(() => { getToken(); }, [getToken]);

  const addMessage = useCallback((role: ChatMessage["role"], text: string, attachments?: FileAttachment[]) => {
    const msg: ChatMessage = {
      id: `msg_${++idCounter.current}`,
      role,
      text,
      timestamp: new Date(),
      attachments,
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const TOOL_LABELS: Record<string, string> = useMemo(() => ({
    search_product: "AI vyhledávání",
    get_category_info: "Zjišťování kategorií",
    add_item_to_offer: "Přidání položky",
    replace_product_in_offer: "Záměna produktu",
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
      itemId: i.itemId,
      displayNumber: i.position + 1,
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
          setOfferItems((prev) => {
            const maxPos = prev.length > 0 ? Math.max(...prev.map((i) => i.position)) : -1;
            const offset = maxPos + 1;
            batchPositionOffset.current = offset;
            const ids: string[] = [];
            const newItems: OfferItem[] = action.items.map((item, i) => {
              const id = generateItemId();
              ids.push(id);
              return {
                itemId: id,
                position: offset + i,
                originalName: item.name,
                unit: item.unit,
                quantity: item.quantity,
                matchType: "not_found" as const,
                confidence: 0,
                product: null,
                candidates: [],
              };
            });
            batchItemIds.current = ids;
            return [...prev, ...newItems];
          });
          setSearchingSet((prev) => {
            const next = new Set(prev);
            for (const id of batchItemIds.current) next.add(id);
            return next;
          });
          if (phase === "idle" || phase === "parsed") setPhase("processing");
          break;
        }
        case "add_item": {
          const product = action.product ?? null;
          const afterId = action.afterItemId ?? null;
          const newItemId = generateItemId();
          setOfferItems((prev) => {
            const newItem: OfferItem = {
              itemId: newItemId,
              position: 0,
              originalName: action.name,
              unit: product?.unit ?? null,
              quantity: action.quantity,
              matchType: action.matchType ?? (product ? "match" : "not_found"),
              confidence: action.confidence ?? (product ? 85 : 0),
              product,
              candidates: (action.candidates ?? []) as Product[],
              reasoning: action.reasoning,
            };
            let insertIdx = prev.length;
            if (afterId) {
              const idx = prev.findIndex((i) => i.itemId === afterId);
              if (idx !== -1) insertIdx = idx + 1;
            }
            const spliced = [
              ...prev.slice(0, insertIdx),
              newItem,
              ...prev.slice(insertIdx),
            ].map((item, idx) => ({ ...item, position: idx }));
            flashPosition(insertIdx);
            return spliced;
          });
          if (phase === "idle" || phase === "parsed") {
            setPhase("review");
          }
          break;
        }
        case "replace_product": {
          const product = action.product ?? null;
          const targetItem = offerItems.find((i) => i.itemId === action.itemId);
          if (targetItem) flashPosition(targetItem.position);
          setOfferItems((prev) =>
            prev.map((i) =>
              i.itemId === action.itemId
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
            ),
          );
          break;
        }
        case "remove_item": {
          setOfferItems((prev) => {
            const filtered = prev.filter((i) => i.itemId !== action.itemId);
            return filtered.map((item, idx) => ({ ...item, position: idx }));
          });
          break;
        }
        case "update_header": {
          setOfferHeader((prev) => ({ ...prev, ...action.fields }));
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
    async (text: string, files?: FileAttachment[]) => {
      addMessage("user", text, files);
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
        const stream = offerChat(text, summary, token, files);

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
          } else if (event.type === "item_searching") {
            const pos = event.data.position as number;
            const id = batchItemIds.current[pos];
            if (id) setSearchingSet((prev) => new Set(prev).add(id));
          } else if (event.type === "item_matched") {
            const data = event.data as unknown as OfferItem;
            const id = batchItemIds.current[data.position];
            if (id) {
              setSearchingSet((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              const adjustedPos = data.position + batchPositionOffset.current;
              flashPosition(adjustedPos);
              setOfferItems((prev) =>
                prev.map((item) =>
                  item.itemId === id
                    ? { ...item, ...data, itemId: id, position: adjustedPos, extraColumns: item.extraColumns }
                    : item,
                ),
              );
            }
          } else if (event.type === "status" && (event.data.phase === "reading_image" || event.data.phase === "transcribing")) {
            const statusPhase = event.data.phase as string;
            const label = statusPhase === "reading_image" ? "Čtu obrázek" : "Přepisuji hlasovku";
            const tcId = `tc_${++toolCallSeq}`;
            const tc: ToolCallStatus = { id: tcId, tool: statusPhase, label, status: "running" };
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingMsgId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), tc] }
                  : m,
              ),
            );
          } else if (event.type === "status" && event.data.phase === "thinking") {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== streamingMsgId) return m;
                const updated = (m.toolCalls ?? []).map((tc) =>
                  (tc.tool === "reading_image" || tc.tool === "transcribing") && tc.status === "running"
                    ? { ...tc, status: "done" as const }
                    : tc,
                );
                return { ...m, toolCalls: updated };
              }),
            );
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
    [addMessage, getToken, buildOfferSummary, processAction, TOOL_LABELS, flashPosition],
  );

  // ──────────────────────────────────────────────────────────
  // TSV paste modal handlers
  // ──────────────────────────────────────────────────────────

  const handlePasteDetected = useCallback((text: string) => {
    setPendingPaste(text);
  }, []);

  const handlePasteImport = useCallback((items: ParsedItem[]) => {
    if (phase === "review" && offerItems.length > 0) {
      const maxPos = Math.max(...offerItems.map((i) => i.position));
      const newOfferItems: OfferItem[] = items.map((item, i) => ({
        itemId: generateItemId(),
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
  }, [phase, offerItems, addMessage]);

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
  // Actual search run (called after planning)
  // ──────────────────────────────────────────────────────────

  const handleRunSearch = useCallback(async (
    items: ParsedItem[],
    prefs: SearchPreferences,
    plan?: SearchPlan,
  ) => {
    // Items marked as skip are excluded from the search batch entirely
    const activeItems = items.filter((i) => !i.skip);
    const activeEnrichedItems = plan ? plan.enrichedItems.filter((ei) => !ei.skip) : null;

    const searchItems_ = activeEnrichedItems
      ? activeEnrichedItems.map((ei) => ({
          name: ei.name, unit: ei.unit, quantity: ei.quantity,
          instruction: ei.instruction,
          isSet: ei.isSet,
          setHint: ei.setHint,
        }))
      : activeItems.map((i) => ({ name: i.name, unit: i.unit, quantity: i.quantity, isSet: i.isSet }));

    // groupContexts: only manufacturer/line set by user in SearchPlanPanel
    const groupContexts: Record<number, { preferredManufacturer: string | null; preferredLine: string | null }> | undefined =
      activeEnrichedItems ? (() => {
        const gc: Record<number, { preferredManufacturer: string | null; preferredLine: string | null }> = {};
        activeEnrichedItems.forEach((ei, i) => {
          const group = plan?.groups[ei.groupIndex];
          if (group?.suggestedManufacturer || group?.suggestedLine) {
            gc[i] = {
              preferredManufacturer: group.suggestedManufacturer ?? null,
              preferredLine: group.suggestedLine ?? null,
            };
          }
        });
        return Object.keys(gc).length > 0 ? gc : undefined;
      })() : undefined;

    const emptyOfferItems: OfferItem[] = activeItems.map((item, i) => ({
      itemId: generateItemId(),
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
    const batchIdMap = emptyOfferItems.map((i) => i.itemId);
    setSearchingSet(new Set(batchIdMap));
    setPhase("processing");
    const skippedCount = items.length - activeItems.length;
    const skippedNote = skippedCount > 0 ? ` (${skippedCount} přeskočeno)` : "";
    addMessage("system", `Vyhledávám ${activeItems.length} položek v katalogu…${skippedNote}`);

    try {
      const token = await getToken();
      const stream = searchItems(
        searchItems_,
        token,
        prefs,
        groupContexts,
      );

      for await (const event of stream) {
        if (event.type === "item_searching") {
          const pos = event.data.position as number;
          const id = batchIdMap[pos];
          if (id) setSearchingSet((prev) => new Set(prev).add(id));
        } else if (event.type === "set_matched") {
          const setData = event.data as unknown as {
            parentPosition: number;
            parentItemId: string;
            originalName: string;
            unit: string | null;
            quantity: number | null;
            components: Array<{
              name: string;
              role: string;
              quantity: number;
              result: OfferItem;
            }>;
          };
          const parentId = batchIdMap[setData.parentPosition];
          if (parentId) {
            setSearchingSet((prev) => { const next = new Set(prev); next.delete(parentId); return next; });
            flashPosition(setData.parentPosition);
            setOfferItems((prev) => {
              const parentIdx = prev.findIndex((item) => item.itemId === parentId);
              if (parentIdx === -1) return prev;

              const parentItem: OfferItem = {
                ...prev[parentIdx]!,
                matchType: "match",
                confidence: 100,
                product: null,
                candidates: [],
                reasoning: `Sada rozložena na ${setData.components.length} komponent`,
              };

              const componentItems: OfferItem[] = setData.components.map((comp) => ({
                itemId: generateItemId(),
                position: setData.parentPosition,
                originalName: comp.name,
                unit: "ks",
                quantity: (setData.quantity ?? 1) * comp.quantity,
                matchType: comp.result.matchType,
                confidence: comp.result.confidence,
                product: comp.result.product,
                candidates: comp.result.candidates ?? [],
                reasoning: comp.result.reasoning,
                priceNote: comp.result.priceNote,
                reformulatedQuery: comp.result.reformulatedQuery,
                pipelineMs: comp.result.pipelineMs,
                parentItemId: parentId,
                componentRole: comp.role,
                reviewStatus: "ai_suggestion" as const,
              }));

              const next = [...prev];
              next.splice(parentIdx, 1, parentItem, ...componentItems);
              return next;
            });
          }
        } else if (event.type === "item_matched") {
          const data = event.data as unknown as OfferItem;
          const id = batchIdMap[data.position];
          if (id) {
            setSearchingSet((prev) => { const next = new Set(prev); next.delete(id); return next; });
            flashPosition(data.position);
            const gc = groupContexts?.[data.position];
            setOfferItems((prev) =>
              prev.map((item) =>
                item.itemId === id
                  ? {
                      ...item, ...data, itemId: id, extraColumns: item.extraColumns,
                      appliedManufacturer: gc?.preferredManufacturer ?? null,
                      appliedLine: gc?.preferredLine ?? null,
                    }
                  : item,
              ),
            );
          }
        } else if (event.type === "debug") {
          setDebugLog((prev) => [...prev, event.data as unknown as DebugEntry]);
        } else if (event.type === "status" && event.data.phase === "review") {
          setSearchingSet(new Set());
          setPhase("review");
          addMessage("system", "Zpracování dokončeno. Zkontrolujte výsledky.");
        } else if (event.type === "error") {
          addMessage("system", `Chyba: ${event.data.message}`);
        }
      }
    } catch (err) {
      addMessage("system", `Chyba: ${err instanceof Error ? err.message : "Nastala chyba"}`);
    } finally {
      setSearchingSet(new Set());
      setPhase((p) => p === "processing" ? "review" : p);
    }
  }, [addMessage, getToken, flashPosition]);

  // ──────────────────────────────────────────────────────────
  // Handler: user clicks "Zpracovat" → open pre-search modal
  // ──────────────────────────────────────────────────────────

  const handleProcess = useCallback(() => {
    const validItems = parsedItems.filter((i) => i.name.trim());
    if (validItems.length === 0) return;
    setPreSearchAction("full");
    setPreSearchOpen(true);
  }, [parsedItems]);

  // Internal: direct search for not-found items with given prefs
  // Called when user confirms settings → planning → search
  const handlePreSearchConfirm = useCallback(async (prefs: SearchPreferences) => {
    setPreSearchOpen(false);
    setSearchPreferences(prefs);

    const validItems = parsedItems.filter((i) => i.name.trim());
    setIsPlanLoading(true);
    setPhase("planning");
    addMessage("system", `Analyzuji ${validItems.length} položek a připravuji plán vyhledávání…`);

    try {
      const token = await getToken();
      const plan = await getSearchPlan(
        validItems.map((i) => ({ name: i.name, unit: i.unit, quantity: i.quantity })),
        token,
        prefs,
      );
      setSearchPlan(plan);
      addMessage("system", `Plán připraven: ${plan.groups.length} ${plan.groups.length === 1 ? "skupina" : "skupin"}. Zkontrolujte a spusťte vyhledávání.`);
    } catch (err) {
      addMessage("system", `Chyba plánování: ${err instanceof Error ? err.message : "Selhalo"}. Spouštím bez plánu.`);
      handleRunSearch(validItems, prefs);
    } finally {
      setIsPlanLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedItems, addMessage, getToken, handleRunSearch]);

  // ──────────────────────────────────────────────────────────
  // Review handlers
  // ──────────────────────────────────────────────────────────

  const handleItemClick = useCallback((item: OfferItem) => {
    setReviewItem(item);
  }, []);

  const handleConfirm = useCallback((item: OfferItem, selectedProduct: Product | null) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.itemId === item.itemId
          ? {
              ...i,
              product: selectedProduct,
              candidates: (i.candidates ?? []).filter((c) => c.sku !== selectedProduct?.sku),
              confirmed: true,
              matchType: "match" as const,
              confidence: 100,
            }
          : i,
      ),
    );
    setReviewItem(null);
  }, []);

  const handleSkip = useCallback((item: OfferItem) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.itemId === item.itemId
          ? { ...i, originalName: item.originalName, quantity: item.quantity, unit: item.unit, confirmed: true }
          : i,
      ),
    );
    setReviewItem(null);
  }, []);

  const handleSearchWithStockLevel = useCallback(
    async (item: OfferItem, level: StockLevel, opts?: { manufacturer?: string; branchCode?: string }) => {
      setReviewItem(null);
      setSearchingSet((prev) => new Set(prev).add(item.itemId));

      const prefs = opts?.branchCode
        ? { ...searchPreferences, branchFilter: opts.branchCode }
        : searchPreferences;
      const groupContext = opts?.manufacturer
        ? { preferredManufacturer: opts.manufacturer, preferredLine: null }
        : undefined;

      try {
        const sse = searchItemWithStockLevel(
          { name: item.originalName, unit: item.unit, quantity: item.quantity },
          cachedToken,
          prefs,
          groupContext,
          level,
        );
        for await (const event of sse) {
          if (event.type === "item_matched") {
            const data = event.data as unknown as OfferItem;
            setOfferItems((prev) =>
              prev.map((i) =>
                i.itemId === item.itemId
                  ? { ...i, ...data, itemId: item.itemId, extraColumns: i.extraColumns, reviewStatus: "ai_suggestion" as const }
                  : i,
              ),
            );
          }
        }
      } finally {
        setSearchingSet((prev) => {
          const next = new Set(prev);
          next.delete(item.itemId);
          return next;
        });
      }
    },
    [cachedToken, searchPreferences],
  );

  const handleSaveEdits = useCallback((item: OfferItem) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.itemId === item.itemId
          ? { ...i, originalName: item.originalName, quantity: item.quantity, unit: item.unit }
          : i,
      ),
    );
  }, []);

  const handleQuickConfirm = useCallback((itemId: string) => {
    setOfferItems((prev) =>
      prev.map((i) =>
        i.itemId === itemId
          ? { ...i, confirmed: true, reviewStatus: "reviewed" as const, matchType: "match" as const, confidence: 100 }
          : i,
      ),
    );
  }, []);

  // ──────────────────────────────────────────────────────────
  // Export & reset
  // ──────────────────────────────────────────────────────────

  const buildExportItems = useCallback(() =>
    offerItems.map((item) => ({
      originalName: item.originalName,
      quantity: item.quantity,
      unit: item.unit,
      sku: item.product?.sku ?? null,
      productName: item.product?.name ?? null,
      manufacturerCode: item.product?.manufacturer_code ?? null,
      manufacturer: item.product?.manufacturer ?? null,
      matchType: item.matchType,
      confidence: item.confidence,
    })),
  [offerItems]);

  const handleExport = useCallback(async () => {
    try {
      const token = await getToken();
      const blob = await downloadXlsx(buildExportItems(), offerHeader, token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kv-nabidka-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      addMessage("system", "Export se nezdařil.");
    }
  }, [buildExportItems, offerHeader, getToken, addMessage]);

  const handleExportSap = useCallback(async () => {
    try {
      const token = await getToken();
      const blob = await downloadSapXlsx(buildExportItems(), offerHeader, token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kv-sap-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      addMessage("system", "Export SAP se nezdařil.");
    }
  }, [buildExportItems, offerHeader, getToken, addMessage]);

  const handleReset = useCallback(() => {
    setPhase("idle");
    setParsedItems([]);
    setOfferItems([]);
    setSearchingSet(new Set());
    setReviewItem(null);
    setMessages([]);
    setDebugLog([]);
    setSearchPlan(null);
  }, []);

  const handleAddItem = useCallback(() => {
    const newItem: OfferItem = {
      itemId: generateItemId(),
      position: offerItems.length,
      originalName: "",
      unit: null,
      quantity: null,
      matchType: "not_found" as const,
      confidence: 0,
      product: null,
      candidates: [],
    };
    setOfferItems((prev) => [...prev, newItem]);
    if (phase === "idle" || phase === "parsed") setPhase("review");
  }, [offerItems.length, phase]);

  const handleClearDebug = useCallback(() => {
    setDebugLog([]);
  }, []);


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
            isProcessing={isPlanLoading}
          />
        );

      case "planning":
        return (
          <SearchPlanPanel
            plan={searchPlan!}
            token={cachedToken}
            onApprove={(plan) => {
              const validItems = parsedItems.filter((i) => i.name.trim());
              handleRunSearch(validItems, searchPreferences, plan);
            }}
            onSkip={() => {
              const validItems = parsedItems.filter((i) => i.name.trim());
              handleRunSearch(validItems, searchPreferences);
            }}
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
            onSendSap={() => {}}
            onReset={handleReset}
            onAddItem={handleAddItem}
            onQuickConfirm={handleQuickConfirm}
            token={cachedToken}
          />
        );
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel – Chat + Debug */}
        <div className="relative flex w-[420px] shrink-0 flex-col border-r border-kv-gray-200 bg-white">
          <ChatPanel
            messages={messages}
            isProcessing={isParsingChat}
            onSendMessage={handleSendMessage}
            onPasteDetected={handlePasteDetected}
            debugSlot={
              <AgentDebugPanel entries={debugLog} onClear={handleClearDebug} />
            }
          />
        </div>

        {/* Right panel – Context-dependent */}
        <div className="flex flex-1 flex-col bg-white">
          <OfferHeaderForm header={offerHeader} onChange={setOfferHeader} getToken={getToken} />
          {renderRightPanel()}
        </div>
      </div>

      {/* Pre-search settings modal */}
      {preSearchOpen && (
        <PreSearchModal
          token={cachedToken}
          itemCount={parsedItems.filter((i) => i.name.trim()).length}
          onConfirm={handlePreSearchConfirm}
          onCancel={() => setPreSearchOpen(false)}
        />
      )}

      {/* Review modal */}
      {reviewItem && (
        <ReviewModal
          item={reviewItem}
          onConfirm={handleConfirm}
          onSkip={handleSkip}
          onClose={() => setReviewItem(null)}
          onSaveEdits={handleSaveEdits}
          onSearchWithStockLevel={handleSearchWithStockLevel}
          token={cachedToken}
        />
      )}

      {/* TSV paste confirmation modal */}
      {pendingPaste && (
        <ColumnMapperModal
          text={pendingPaste}
          onImport={handlePasteImport}
          onSendAsMessage={handlePasteSendAsMessage}
          onCancel={handlePasteCancel}
        />
      )}
    </div>
  );
}
