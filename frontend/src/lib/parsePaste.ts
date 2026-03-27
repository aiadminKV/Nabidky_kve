import type { ParsedItem } from "./types";

let counter = 0;

/**
 * Parse Czech number notation:
 *   "1.000"   → 1000  (dot before exactly 3 digits = thousands separator)
 *   "1.000,5" → 1000.5
 *   "1,5"     → 1.5   (comma = decimal separator)
 *   "2.5"     → 2.5   (dot + fewer than 3 digits = decimal)
 *   "1.000.000" → 1000000
 */
export function parseNumberCzech(s: string): number {
  const trimmed = s.trim();
  // If contains comma → comma is decimal separator, dots are thousands
  if (trimmed.includes(",")) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".");
    return parseFloat(normalized);
  }
  // No comma — dot before exactly 3 digits = thousands separator
  if (/\.\d{3}$/.test(trimmed) || /\.\d{3}\./.test(trimmed)) {
    return parseFloat(trimmed.replace(/\./g, ""));
  }
  // Otherwise dot = decimal separator
  return parseFloat(trimmed);
}

/**
 * Parse pasted text into structured items.
 *
 * Expected tab-separated format (columns in order):
 *   Název \t MJ \t Množství
 *
 * Handles:
 *   - 3+ columns with tabs  → col 0 = name, col 1 = unit, col 2 = quantity
 *   - 2 columns with tabs   → col 0 = name, col 1 = quantity (if numeric) or unit
 *   - 1 column (no tabs)    → plain list of names
 *   - \r\n / \r line endings from Excel
 */
export function parsePastedText(raw: string): ParsedItem[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return [];

  const items: ParsedItem[] = [];

  for (const line of lines) {
    const cols = line.split("\t").map((c) => c.trim());
    const name = cols[0];
    if (!name) continue;

    let unit: string | null = null;
    let quantity: number | null = null;

    if (cols.length >= 3) {
      unit = cols[1] || null;
      const num = parseNumberCzech(cols[2]);
      quantity = isNaN(num) ? null : num;
    } else if (cols.length === 2) {
      const num = parseNumberCzech(cols[1]);
      if (!isNaN(num)) {
        quantity = num;
      } else {
        unit = cols[1] || null;
      }
    }

    items.push({
      id: `paste_${++counter}`,
      name,
      unit,
      quantity,
    });
  }

  return items;
}
