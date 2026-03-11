import type { ParsedItem } from "./types";

let counter = 0;

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
      const num = parseFloat(cols[2].replace(",", "."));
      quantity = isNaN(num) ? null : num;
    } else if (cols.length === 2) {
      const num = parseFloat(cols[1].replace(",", "."));
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
