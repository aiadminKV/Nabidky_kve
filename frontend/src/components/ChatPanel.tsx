"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type DragEvent, type ReactNode } from "react";
import type { ChatMessage, ToolCallStatus, FileAttachment } from "@/lib/types";

const TOOL_ICONS: Record<string, string> = {
  search_product: "🔍",
  get_category_info: "📂",
  add_item_to_offer: "➕",
  replace_product_in_offer: "🔄",
  remove_item_from_offer: "🗑",
  parse_items_from_text: "📋",
  update_offer_header: "📝",
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

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-kv-gray-500">
      <div className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-kv-red/45 animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="h-2 w-2 rounded-full bg-kv-red/65 animate-bounce" style={{ animationDelay: "150ms" }} />
        <span className="h-2 w-2 rounded-full bg-kv-navy/40 animate-bounce" style={{ animationDelay: "300ms" }} />
      </div>
      <span className="text-xs font-medium">AI přemýšlí…</span>
    </div>
  );
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const EXCEL_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);
const EXCEL_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "webm", "ogg", "flac", "mp4", "mpeg"]);
const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/flac",
]);

function detectFileType(file: File): FileAttachment["type"] | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (EXCEL_MIMES.has(file.type) || EXCEL_EXTENSIONS.has(ext)) return "excel";
  if (file.type.startsWith("audio/") || AUDIO_MIMES.has(file.type) || AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

const FALLBACK_MIMES: Record<string, string> = {
  image: "image/jpeg",
  pdf: "application/pdf",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  audio: "audio/webm",
};

function fileToAttachment(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error(`Soubor "${file.name}" je příliš velký (max 20 MB).`));
      return;
    }
    const fileType = detectFileType(file);
    if (!fileType) {
      reject(new Error("Podporované formáty: obrázky, PDF, Excel, CSV a audio (MP3, WAV, M4A, WebM)."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({
        type: fileType,
        filename: file.name,
        mimeType: file.type || FALLBACK_MIMES[fileType],
        base64,
        previewUrl: fileType === "image" ? dataUrl : undefined,
      });
    };
    reader.onerror = () => reject(new Error("Nepodařilo se přečíst soubor."));
    reader.readAsDataURL(file);
  });
}

function FileIcon({ type }: { type: FileAttachment["type"] }) {
  const configs: Record<string, { bg: string; text: string; d: string }> = {
    excel: {
      bg: "bg-green-50", text: "text-green-600",
      d: "M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0 1 12 18.375",
    },
    audio: {
      bg: "bg-purple-50", text: "text-purple-600",
      d: "M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z",
    },
  };
  const c = configs[type];
  if (c) {
    return (
      <div className={`flex h-10 w-10 items-center justify-center rounded ${c.bg} ${c.text}`}>
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d={c.d} />
        </svg>
      </div>
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded bg-red-50 text-red-500">
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
    </div>
  );
}

function AudioAttachmentBadge({
  compact = false,
  onRemove,
}: {
  compact?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group relative flex items-center gap-2 rounded-full border border-kv-navy/15 bg-gradient-to-r from-kv-navy/10 to-kv-navy/5 ${
        compact ? "px-3 py-2" : "px-3.5 py-2.5"
      }`}
      aria-label="Zvuková příloha"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-kv-navy shadow-sm">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
        </svg>
      </div>
      <div className="flex items-end gap-1" aria-hidden="true">
        <span className="h-2.5 w-1 rounded-full bg-kv-navy/30" />
        <span className="h-4 w-1 rounded-full bg-kv-navy" />
        <span className="h-3 w-1 rounded-full bg-kv-navy/55" />
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Odebrat zvukovou přílohu"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-white/85 text-kv-gray-400 opacity-0 transition-opacity hover:bg-white hover:text-kv-navy group-hover:opacity-100"
        >
          <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      )}
    </div>
  );
}

function AttachmentPreview({ att, onRemove }: { att: FileAttachment; onRemove: () => void }) {
  if (att.type === "audio") {
    return <AudioAttachmentBadge onRemove={onRemove} />;
  }

  return (
    <div className="relative group flex items-center gap-2 rounded-lg border border-kv-gray-200 bg-kv-gray-50 px-3 py-2">
      {att.type === "image" && att.previewUrl ? (
        <img src={att.previewUrl} alt={att.filename} className="h-10 w-10 rounded object-cover" />
      ) : (
        <FileIcon type={att.type} />
      )}
      <span className="text-xs text-kv-gray-600 truncate max-w-[140px]">{att.filename}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-kv-gray-200 text-kv-gray-500 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-kv-gray-300"
      >
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

const MSG_ATT_STYLES: Record<string, { bg: string; text: string; icon: string }> = {
  excel: { bg: "bg-green-50", text: "text-green-500", icon: "M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625" },
  audio: { bg: "bg-purple-50", text: "text-purple-500", icon: "M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" },
  pdf: { bg: "bg-red-50", text: "text-red-400", icon: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" },
};

function MessageAttachments({ attachments }: { attachments: FileAttachment[] }) {
  return (
    <div className="flex flex-wrap gap-2 mb-1.5">
      {attachments.map((att, i) => {
        if (att.type === "image" && att.previewUrl) {
          return <img key={i} src={att.previewUrl} alt={att.filename} className="h-16 w-16 rounded object-cover border border-kv-gray-200" />;
        }
        if (att.type === "audio") {
          return <AudioAttachmentBadge key={i} compact />;
        }
        const s = MSG_ATT_STYLES[att.type] ?? MSG_ATT_STYLES.pdf;
        return (
          <div key={i} className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs text-kv-gray-500 ${s.bg}`}>
            <svg className={`h-3.5 w-3.5 ${s.text}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={s.icon} />
            </svg>
            <span>{att.filename}</span>
          </div>
        );
      })}
    </div>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  onSendMessage: (text: string, files?: FileAttachment[]) => void;
  onPasteDetected?: (text: string) => void;
  debugSlot?: ReactNode;
}

export function ChatPanel({ messages, isProcessing, onSendMessage, onPasteDetected, debugSlot }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addFile = useCallback(async (file: File) => {
    setFileError(null);
    try {
      const att = await fileToAttachment(file);
      setPendingFiles((prev) => [...prev, att]);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Chyba při zpracování souboru.");
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const startRecording = useCallback(async () => {
    setFileError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        setIsRecording(false);
        setRecordingSeconds(0);

        const blob = new Blob(chunks, { type: mimeType });
        const file = new File([blob], `hlasovka_${new Date().toISOString().slice(11, 19).replace(/:/g, "-")}.webm`, { type: "audio/webm" });
        void addFile(file);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch {
      setFileError("Nepodařilo se získat přístup k mikrofonu.");
    }
  }, [addFile]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      const hasFiles = pendingFiles.length > 0;
      const nonAudioFiles = pendingFiles.filter((file) => file.type !== "audio");
      const fallbackText = nonAudioFiles.length > 0
        ? `[Soubor: ${nonAudioFiles.map((file) => file.filename).join(", ")}]`
        : "";
      if ((!trimmed && !hasFiles) || isProcessing) return;
      onSendMessage(trimmed || fallbackText, hasFiles ? pendingFiles : undefined);
      setInput("");
      setPendingFiles([]);
      setFileError(null);
    },
    [input, isProcessing, onSendMessage, pendingFiles],
  );

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) await addFile(file);
    },
    [addFile],
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) await addFile(file);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [addFile],
  );

  const isTabular = useCallback((text: string): boolean => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return false;
    if (lines.some((l) => l.includes("\t"))) return true;
    return lines.length >= 3;
  }, []);

  useEffect(() => {
    if (!onPasteDetected) return;
    const callback = onPasteDetected;

    function handleGlobalPaste(e: globalThis.ClipboardEvent) {
      const text = e.clipboardData?.getData("text/plain");
      if (text && isTabular(text)) {
        e.preventDefault();
        callback(text);
      }
    }

    document.addEventListener("paste", handleGlobalPaste, true);
    return () => document.removeEventListener("paste", handleGlobalPaste, true);
  }, [onPasteDetected, isTabular]);

  const hasStreaming = messages.some((m) => m.isStreaming);
  const hasActiveToolCalls = messages.some(
    (m) => m.toolCalls?.some((tc) => tc.status === "running"),
  );
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || (!hasStreaming && !hasActiveToolCalls && messages.length === 0)) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: hasStreaming || hasActiveToolCalls ? "auto" : "smooth",
    });

    if (!hasStreaming && !hasActiveToolCalls) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, hasStreaming, hasActiveToolCalls]);

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Messages area */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center px-6">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-kv-red/10">
              <svg className="h-6 w-6 text-kv-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-kv-gray-800">Vložte poptávku</h3>
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
              {msg.attachments && msg.attachments.length > 0 && (
                <MessageAttachments attachments={msg.attachments} />
              )}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className={`flex flex-col gap-1 ${msg.text ? "mb-2" : ""}`}>
                  {msg.toolCalls.map((tc) => (
                    <ToolCallChip key={tc.id} tc={tc} />
                  ))}
                </div>
              )}
              {!msg.text.trim() && msg.isStreaming ? (
                <ThinkingIndicator />
              ) : (
                msg.text
              )}
              {msg.isStreaming && msg.text.trim() && (
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

      {/* Debug slot (inline, between messages and input) */}
      {debugSlot}

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-kv-red/5 border-2 border-dashed border-kv-red/30 rounded-lg m-2">
          <p className="text-sm font-medium text-kv-red">Přetáhněte soubor sem</p>
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-kv-gray-200 bg-white p-4">
        {/* Pending file attachments */}
        {pendingFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {pendingFiles.map((att, i) => (
              <AttachmentPreview key={`${att.filename}-${i}`} att={att} onRemove={() => removeFile(i)} />
            ))}
          </div>
        )}
        {fileError && (
          <p className="mb-3 text-xs text-red-500">{fileError}</p>
        )}
        {/* Recording indicator */}
        {isRecording && (
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium text-red-600">
              Nahrávání… {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, "0")}
            </span>
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          {/* File upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing || isRecording}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-kv-gray-400 transition-colors hover:bg-kv-gray-100 hover:text-kv-gray-600 disabled:opacity-40"
            title="Nahrát soubor (obrázek, PDF, Excel, audio)"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
            </svg>
          </button>
          {/* Voice recording button */}
          <button
            type="button"
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isProcessing}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
              isRecording
                ? "bg-red-500 text-white hover:bg-red-600 animate-pulse"
                : "text-kv-gray-400 hover:bg-kv-gray-100 hover:text-kv-gray-600 disabled:opacity-40"
            }`}
            title={isRecording ? "Zastavit nahrávání" : "Nahrát hlasovku"}
          >
            {isRecording ? (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="10" height="10" rx="1.5" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
              </svg>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.xlsx,.xls,.csv,audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Text input */}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            disabled={isProcessing || isRecording}
            placeholder=""
            rows={1}
            className="min-h-[40px] max-h-[120px] flex-1 resize-none rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-2.5 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-400 focus:border-kv-navy/30 focus:bg-white focus:ring-2 focus:ring-kv-navy/10 disabled:opacity-50"
          />

          {/* Send button */}
          <button
            type="submit"
            disabled={isProcessing || isRecording || (!input.trim() && pendingFiles.length === 0)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kv-red text-white transition-all hover:bg-kv-red-dark active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-red-100"
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
