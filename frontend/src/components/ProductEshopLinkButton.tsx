"use client";

interface ProductEshopLinkButtonProps {
  sku: string | null | undefined;
  size?: "sm" | "md";
}

function getProductEshopUrl(sku: string): string {
  return `https://www.kvelektro.cz/p${encodeURIComponent(sku)}`;
}

export function ProductEshopLinkButton({
  sku,
  size = "sm",
}: ProductEshopLinkButtonProps) {
  if (!sku) return null;

  const sizeClass =
    size === "md"
      ? "h-6 w-6 rounded-lg"
      : "h-5 w-5 rounded";

  const iconClass = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";

  return (
    <a
      href={getProductEshopUrl(sku)}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Otevřít na e-shopu"
      className={`flex shrink-0 items-center justify-center text-kv-gray-300 transition-all hover:bg-kv-gray-100 hover:text-kv-navy ${sizeClass}`}
    >
      <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H19.5M19.5 6V12M19.5 6L10.5 15" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v3A2.25 2.25 0 0 1 17.25 19.5h-10.5A2.25 2.25 0 0 1 4.5 17.25v-10.5A2.25 2.25 0 0 1 6.75 4.5h3" />
      </svg>
    </a>
  );
}
