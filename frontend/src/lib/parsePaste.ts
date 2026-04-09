import type { ParsedItem } from "./types";

let counter = 0;

// ── Column mapping ─────────────────────────────────────────────────────────────

export type ColumnRole = "name" | "unit" | "quantity" | "skip";

export interface ColumnMapping {
  /** Role for each column index */
  roles: ColumnRole[];
  /** Skip the first row (treat as header) */
  skipFirstRow: boolean;
}

/** Parse raw paste into raw rows+columns (no mapping applied). */
export function parseRawRows(raw: string): string[][] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.split("\t").map((c) => c.trim()));
}

/**
 * Auto-detect a reasonable default column mapping.
 * Heuristic: last col that looks numeric → quantity, second-to-last that looks like unit → unit, rest → name.
 */
export function autoDetectMapping(rows: string[][]): ColumnMapping {
  if (rows.length === 0) return { roles: [], skipFirstRow: false };
  const numCols = Math.max(...rows.map((r) => r.length));
  const roles: ColumnRole[] = Array(numCols).fill("skip");

  // Count how many values in each column look numeric
  const numericRatio = Array(numCols).fill(0).map((_, ci) => {
    const vals = rows.map((r) => r[ci] ?? "").filter((v) => v.trim());
    if (vals.length === 0) return 0;
    const numeric = vals.filter((v) => !isNaN(parseNumberCzech(v))).length;
    return numeric / vals.length;
  });

  // Count how many values look like short unit strings (2–5 chars, mostly alpha)
  const unitRatio = Array(numCols).fill(0).map((_, ci) => {
    const vals = rows.map((r) => r[ci] ?? "").filter((v) => v.trim());
    if (vals.length === 0) return 0;
    const unitLike = vals.filter((v) => /^[a-zA-Z]{1,5}$/.test(v.trim())).length;
    return unitLike / vals.length;
  });

  // Pick quantity: rightmost column with high numeric ratio
  let qtyIdx = -1;
  for (let i = numCols - 1; i >= 0; i--) {
    if (numericRatio[i] >= 0.5) { qtyIdx = i; break; }
  }
  if (qtyIdx >= 0) roles[qtyIdx] = "quantity";

  // Pick unit: rightmost column (before qty) with high unit-like ratio
  let unitIdx = -1;
  for (let i = (qtyIdx >= 0 ? qtyIdx : numCols) - 1; i >= 0; i--) {
    if (unitRatio[i] >= 0.5) { unitIdx = i; break; }
  }
  if (unitIdx >= 0) roles[unitIdx] = "unit";

  // All remaining up to unitIdx/qtyIdx → name (first col and any contiguous skipped cols)
  for (let i = 0; i < numCols; i++) {
    if (roles[i] === "skip" && i < Math.max(unitIdx >= 0 ? unitIdx : 0, qtyIdx >= 0 ? qtyIdx : 0, 1)) {
      roles[i] = "name";
    }
  }
  // Always mark column 0 as name if nothing else claimed it
  if (roles[0] === "skip") roles[0] = "name";

  return { roles, skipFirstRow: false };
}

/** Parse pasted text using an explicit column mapping. */
export function parsePastedTextWithMapping(raw: string, mapping: ColumnMapping): ParsedItem[] {
  const allRows = parseRawRows(raw);
  const rows = mapping.skipFirstRow ? allRows.slice(1) : allRows;
  const items: ParsedItem[] = [];

  for (const cols of rows) {
    const nameParts: string[] = [];
    let unit: string | null = null;
    let quantity: number | null = null;

    mapping.roles.forEach((role, ci) => {
      const val = cols[ci]?.trim() ?? "";
      if (!val) return;
      if (role === "name") nameParts.push(val);
      else if (role === "unit" && !unit) unit = val;
      else if (role === "quantity" && quantity === null) {
        const n = parseNumberCzech(val);
        if (!isNaN(n)) quantity = n;
      }
    });

    const name = nameParts.join(" ").trim();
    if (!name) continue;
    items.push({ id: `paste_${++counter}`, name, unit, quantity });
  }

  return items;
}

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
