"use client";

import { useState, useRef, useCallback } from "react";
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

export function ProductThumbnail({ sku, name = "", size = "sm", thumbSize }: ProductThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [zoomPos, setZoomPos] = useState<"left" | "right">("right");
  const containerRef = useRef<HTMLDivElement>(null);

  const resolvedThumbSize = thumbSize ?? (size === "lg" ? "L" : "S");
  const thumbUrl = getProductImageUrl(sku, resolvedThumbSize);
  const zoomUrl = getProductImageUrl(sku, "L");

  const handleMouseEnter = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    setZoomPos(spaceRight >= 220 ? "right" : "left");
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
  }, []);

  if (!thumbUrl || failed) {
    // Placeholder box — same size, neutral color
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
      {/* Thumbnail — small image for fast load */}
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

      {/* Hover zoom — large image */}
      {hovered && (
        <div
          className={`
            absolute z-50 top-1/2 -translate-y-1/2 w-52 rounded-xl border border-kv-gray-200 bg-white shadow-xl p-2
            ${zoomPos === "right" ? "left-full ml-2" : "right-full mr-2"}
          `}
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
        </div>
      )}
    </div>
  );
}
