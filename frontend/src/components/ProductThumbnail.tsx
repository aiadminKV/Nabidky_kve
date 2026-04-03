"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { getProductImageUrl } from "@/lib/types";

interface ProductThumbnailProps {
  sku: string | undefined | null;
  name?: string;
  /** sm = 32px (table rows), md = 48px, lg = 64px (search card) */
  size?: "sm" | "md" | "lg";
  /** Override thumbnail image size — default "S" for small, "L" for large containers */
  thumbSize?: "S" | "L";
}

const SIZE_CLASSES = {
  sm: "h-8 w-8",
  md: "h-12 w-12",
  lg: "h-16 w-16",
};

const ZOOM_WIDTH = 208;  // w-52
const ZOOM_HEIGHT = 240; // h-48 image + name + padding

export function ProductThumbnail({ sku, name = "", size = "sm", thumbSize }: ProductThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [zoomStyle, setZoomStyle] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const resolvedThumbSize = thumbSize ?? (size === "lg" ? "L" : "S");
  const thumbUrl = getProductImageUrl(sku, resolvedThumbSize);
  const zoomUrl = getProductImageUrl(sku, "L");

  useEffect(() => { setMounted(true); }, []);

  const computeZoomPos = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Horizontal: prefer right side, fall back to left
    const spaceRight = vw - rect.right;
    let left: number;
    if (spaceRight >= ZOOM_WIDTH + 8) {
      left = rect.right + 8;
    } else {
      left = Math.max(8, rect.left - ZOOM_WIDTH - 8);
    }

    // Vertical: center on the thumbnail, then clamp to viewport
    let top = rect.top + rect.height / 2 - ZOOM_HEIGHT / 2;
    top = Math.max(8, Math.min(top, vh - ZOOM_HEIGHT - 8));

    setZoomStyle({ top, left });
  }, []);

  const handleMouseEnter = useCallback(() => {
    computeZoomPos();
    setHovered(true);
  }, [computeZoomPos]);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
  }, []);

  if (!thumbUrl || failed) {
    return (
      <div className={`${SIZE_CLASSES[size]} shrink-0 rounded-lg bg-kv-gray-100 border border-kv-gray-200 flex items-center justify-center`}>
        <svg className="h-4 w-4 text-kv-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
        </svg>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Thumbnail */}
      <div className={`${SIZE_CLASSES[size]} rounded-lg bg-kv-gray-50 border border-kv-gray-200 overflow-hidden flex items-center justify-center cursor-zoom-in`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl}
          alt={name}
          className="max-h-full max-w-full object-contain p-0.5"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </div>

      {/* Hover zoom — rendered via portal so overflow:hidden can't clip it */}
      {hovered && mounted && createPortal(
        <div
          style={{
            position: "fixed",
            top: zoomStyle.top,
            left: zoomStyle.left,
            width: ZOOM_WIDTH,
            zIndex: 9999,
            pointerEvents: "none",
          }}
          className="rounded-xl border border-kv-gray-200 bg-white shadow-xl p-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomUrl ?? thumbUrl}
            alt={name}
            className="h-48 w-full object-contain"
            onError={() => setFailed(true)}
            draggable={false}
          />
          {name && (
            <p className="mt-1.5 text-center text-[10px] text-kv-gray-400 leading-tight line-clamp-2">{name}</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
