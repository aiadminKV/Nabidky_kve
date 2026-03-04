"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type DragEvent, type ClipboardEvent } from "react";
import type { ChatMessage, ToolCallStatus } from "@/lib/types";

const TOOL_ICONS: Record<string, string> = {
  search_products: "🔍",
  semantic_search: "🧠",
  add_item_to_offer: "➕",
  replace_product_in_offer: "🔄",
  remove_item_from_offer: "🗑",
  parse_items_from_text: "📋",
};

function ToolCallChip({ tc }: { tc: ToolCallStatus }) {
  const icon = TOOL_ICONS[tc.tool] ?? "⚙️";
  const isRunning = tc.status === "running";

  return (
    <div className="flex items-center gap-1.5 text-xs text-kv-gray-500">
      <span>{icon}</span>
      <span className={isRunning ? "animate-pulse" : ""}>{tc.label}</span>
      {isRunning ? (
        <svg className="h-3 w-3 animate-spin text-kv-gray-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="h-3 w-3 text-green-500" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      )}
    </div>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  onSendMessage: (text: string) => void;
  onFileUpload: (file: File) => void;
  onPasteDetected?: (text: string) => void;
}

export function ChatPanel({ messages, isProcessing, onSendMessage, onFileUpload, onPasteDetected }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || isProcessing) return;
      onSendMessage(trimmed);
      setInput("");
    },
    [input, isProcessing, onSendMessage],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) onFileUpload(file);
    },
    [onFileUpload],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileUpload(file);
    },
    [onFileUpload],
  );

  const isTSV = useCallback((text: string): boolean => {
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return false;
    const tabLines = lines.filter((l) => l.includes("\t"));
    return tabLines.length > lines.length * 0.5;
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteDetected) return;
      const text = e.clipboardData.getData("text/plain");
      if (text && isTSV(text)) {
        e.preventDefault();
        onPasteDetected(text);
      }
    },
    [onPasteDetected, isTSV],
  );

  const hasStreaming = messages.some((m) => m.isStreaming);
  const hasActiveToolCalls = messages.some(
    (m) => m.toolCalls?.some((tc) => tc.status === "running"),
  );
  useEffect(() => {
    if (hasStreaming || hasActiveToolCalls || messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, hasStreaming, hasActiveToolCalls]);

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center px-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-kv-red/10">
              <svg className="h-6 w-6 text-kv-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-kv-gray-800">Vložte poptávku</h3>
            <p className="mt-1.5 text-xs text-kv-gray-400 max-w-[260px] leading-relaxed">
              Zkopírujte text z e-mailu, vložte tabulku z Excelu, nebo přetáhněte obrázek či PDF.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-kv-red text-white rounded-br-md"
                  : msg.role === "system"
                    ? "bg-kv-gray-100 text-kv-gray-500 italic text-xs"
                    : "bg-kv-gray-100 text-kv-gray-800 rounded-bl-md"
              }`}
            >
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className={`flex flex-col gap-1 ${msg.text ? "mb-2" : ""}`}>
                  {msg.toolCalls.map((tc) => (
                    <ToolCallChip key={tc.id} tc={tc} />
                  ))}
                </div>
              )}
              {msg.text}
              {msg.isStreaming && (
                <span className="inline-block w-[2px] h-[14px] ml-0.5 bg-kv-gray-800 align-text-bottom animate-pulse" />
              )}
            </div>
          </div>
        ))}

        {isProcessing && !hasStreaming && (
          <div className="flex justify-start">
            <div className="bg-kv-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-kv-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="h-2 w-2 rounded-full bg-kv-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="h-2 w-2 rounded-full bg-kv-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-kv-red/5 border-2 border-dashed border-kv-red/30 rounded-lg m-2">
          <p className="text-sm font-medium text-kv-red">Přetáhněte soubor sem</p>
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-kv-gray-200 p-3">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          {/* File upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-kv-gray-400 transition-colors hover:bg-kv-gray-100 hover:text-kv-gray-600 disabled:opacity-40"
            title="Nahrát soubor (obrázek, PDF)"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Text input */}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            disabled={isProcessing}
            placeholder="Vložte poptávku nebo napište dotaz…"
            rows={1}
            className="min-h-[40px] max-h-[120px] flex-1 resize-none rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-2.5 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-400 focus:border-kv-red/30 focus:bg-white focus:ring-2 focus:ring-kv-red/10 disabled:opacity-50"
          />

          {/* Send button */}
          <button
            type="submit"
            disabled={isProcessing || !input.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kv-red text-white transition-all hover:bg-kv-red-dark active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
