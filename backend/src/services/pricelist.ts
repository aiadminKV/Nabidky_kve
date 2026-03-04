import ExcelJS from "exceljs";
import { getAdminClient } from "./supabase.js";

const BATCH_SIZE = 1000;
const DB_PAGE_SIZE = 1000;

export interface ParsedProduct {
  sku: string;
  name: string;
  name_secondary: string | null;
  description: string | null;
  unit: string | null;
  price: number | null;
  ean: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
  eshop_url: string | null;
}

export interface DiffSummary {
  totalInFile: number;
  totalInDb: number;
  toAdd: number;
  toUpdate: number;
  toRemove: number;
  sampleNew: string[];
  sampleRemove: string[];
}

export interface ApplyResult {
  upserted: number;
  removed: number;
  errors: number;
}

export type ColumnMapping = Record<number, keyof ParsedProduct>;

export interface ColumnPreview {
  headers: string[];
  sampleRows: string[][];
  suggestedMapping: ColumnMapping;
  totalRows: number;
}

export const PRODUCT_FIELDS: Array<{ key: keyof ParsedProduct; label: string; required: boolean }> = [
  { key: "sku", label: "SKU / Kód produktu", required: true },
  { key: "name", label: "Název", required: true },
  { key: "name_secondary", label: "Název 2", required: false },
  { key: "description", label: "Popis", required: false },
  { key: "unit", label: "Jednotka (MJ)", required: false },
  { key: "price", label: "Cena", required: false },
  { key: "ean", label: "EAN", required: false },
  { key: "manufacturer_code", label: "Kód výrobce", required: false },
  { key: "manufacturer", label: "Výrobce", required: false },
  { key: "category", label: "Kategorie", required: false },
  { key: "subcategory", label: "Podkategorie", required: false },
  { key: "sub_subcategory", label: "Pod-podkategorie", required: false },
  { key: "eshop_url", label: "E-shop URL", required: false },
];

type ProgressCallback = (event: { type: string; data: Record<string, unknown> }) => Promise<void>;

const COLUMN_ALIASES: Record<string, keyof ParsedProduct> = {
  cislo: "sku",
  sku: "sku",
  "kód": "sku",
  kod: "sku",
  nazev: "name",
  název: "name",
  name: "name",
  nazev2: "name_secondary",
  název2: "name_secondary",
  "název 2": "name_secondary",
  dlouhy_popis: "description",
  "dlouhý_popis": "description",
  popis: "description",
  description: "description",
  jednotka: "unit",
  unit: "unit",
  mj: "unit",
  cena_prodejni: "price",
  "cena_prodejní": "price",
  "cena prodejní": "price",
  cena: "price",
  price: "price",
  ean: "ean",
  kod_vyrobce: "manufacturer_code",
  "kód_výrobce": "manufacturer_code",
  "kód výrobce": "manufacturer_code",
  manufacturer_code: "manufacturer_code",
  vyrobce: "manufacturer",
  výrobce: "manufacturer",
  manufacturer: "manufacturer",
  uroven1: "category",
  "úroveň1": "category",
  "úroveň 1": "category",
  category: "category",
  uroven2: "subcategory",
  "úroveň2": "subcategory",
  "úroveň 2": "subcategory",
  subcategory: "subcategory",
  uroven3: "sub_subcategory",
  "úroveň3": "sub_subcategory",
  "úroveň 3": "sub_subcategory",
  sub_subcategory: "sub_subcategory",
  eshop: "eshop_url",
  eshop_url: "eshop_url",
  url: "eshop_url",
};

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[""]/g, "");
}

function parseCzechDecimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const str = String(value).trim();
  if (str === "") return null;
  const num = parseFloat(str.replace(",", "."));
  return isNaN(num) ? null : num;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const usedFields = new Set<keyof ParsedProduct>();

  for (let i = 0; i < headers.length; i++) {
    const raw = normalizeHeader(headers[i]);
    const mapped = COLUMN_ALIASES[raw];
    if (mapped && !usedFields.has(mapped)) {
      mapping[i] = mapped;
      usedFields.add(mapped);
    }
  }

  return mapping;
}

/**
 * Preview column headers + sample rows from an Excel buffer.
 */
export async function previewExcelColumns(buffer: Uint8Array): Promise<ColumnPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel soubor neobsahuje žádný list");

  const headers: string[] = [];
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    while (headers.length < colNumber) headers.push("");
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const sampleRows: string[][] = [];
  const maxSamples = 5;
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || sampleRows.length >= maxSamples) return;
    const rowData: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      rowData.push(String(row.getCell(i + 1).value ?? "").trim());
    }
    sampleRows.push(rowData);
  });

  return {
    headers,
    sampleRows,
    suggestedMapping: suggestMapping(headers),
    totalRows: worksheet.rowCount - 1,
  };
}

/**
 * Preview column headers + sample rows from a CSV buffer.
 */
export function previewCsvColumns(buffer: Uint8Array): ColumnPreview {
  const text = new TextDecoder("utf-8").decode(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 1) throw new Error("CSV soubor je prázdný");

  const headers = parseCsvLine(lines[0]);
  const sampleRows: string[][] = [];
  const maxSamples = 5;

  for (let i = 1; i < lines.length && sampleRows.length < maxSamples; i++) {
    sampleRows.push(parseCsvLine(lines[i]));
  }

  return {
    headers,
    sampleRows,
    suggestedMapping: suggestMapping(headers),
    totalRows: lines.length - 1,
  };
}

/**
 * Parse an Excel buffer into an array of product records.
 * Uses explicit column mapping if provided, otherwise auto-detects.
 */
export async function parseExcelBuffer(
  buffer: Uint8Array,
  onProgress?: ProgressCallback,
  explicitMapping?: ColumnMapping,
): Promise<ParsedProduct[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel soubor neobsahuje žádný list");

  const columnMap = new Map<number, keyof ParsedProduct>();

  if (explicitMapping) {
    for (const [colIdx, field] of Object.entries(explicitMapping)) {
      columnMap.set(Number(colIdx) + 1, field);
    }
  } else {
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      const raw = normalizeHeader(String(cell.value ?? ""));
      const mapped = COLUMN_ALIASES[raw];
      if (mapped) columnMap.set(colNumber, mapped);
    });
  }

  const hasSkuColumn = [...columnMap.values()].includes("sku");
  if (!hasSkuColumn) {
    throw new Error("Sloupec SKU (CISLO) nebyl namapován");
  }

  const products: ParsedProduct[] = [];
  const totalRows = worksheet.rowCount - 1;

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const record: Partial<ParsedProduct> = {};
    columnMap.forEach((field, colNumber) => {
      const cellValue = row.getCell(colNumber).value;

      if (field === "price") {
        record[field] = parseCzechDecimal(cellValue);
      } else {
        record[field] = toStringOrNull(cellValue) as string & null;
      }
    });

    const sku = record.sku?.trim();
    if (!sku) return;

    products.push({
      sku,
      name: record.name?.trim() ?? "",
      name_secondary: record.name_secondary ?? null,
      description: record.description ?? null,
      unit: record.unit ?? null,
      price: record.price ?? null,
      ean: record.ean ?? null,
      manufacturer_code: record.manufacturer_code ?? null,
      manufacturer: record.manufacturer ?? null,
      category: record.category ?? null,
      subcategory: record.subcategory ?? null,
      sub_subcategory: record.sub_subcategory ?? null,
      eshop_url: record.eshop_url ?? null,
    });
  });

  if (onProgress) {
    await onProgress({
      type: "parse_complete",
      data: { total: products.length, processed: totalRows },
    });
  }

  return products;
}

/**
 * Parse a CSV/semicolon-separated buffer into an array of product records.
 * Handles quoted fields and Czech decimal format.
 */
export async function parseCsvBuffer(
  buffer: Uint8Array,
  onProgress?: ProgressCallback,
  explicitMapping?: ColumnMapping,
): Promise<ParsedProduct[]> {
  const text = new TextDecoder("utf-8").decode(buffer);
  const lines = text.split(/\r?\n/);

  if (lines.length < 2) throw new Error("CSV soubor je prázdný nebo nemá hlavičku");

  const columnMap = new Map<number, keyof ParsedProduct>();

  if (explicitMapping) {
    for (const [colIdx, field] of Object.entries(explicitMapping)) {
      columnMap.set(Number(colIdx), field);
    }
  } else {
    const headerCols = parseCsvLine(lines[0]);
    for (let i = 0; i < headerCols.length; i++) {
      const raw = normalizeHeader(headerCols[i]);
      const mapped = COLUMN_ALIASES[raw];
      if (mapped) columnMap.set(i, mapped);
    }
  }

  const hasSkuColumn = [...columnMap.values()].includes("sku");
  if (!hasSkuColumn) {
    throw new Error("Sloupec SKU (CISLO) nebyl namapován");
  }

  const products: ParsedProduct[] = [];

  for (let lineNum = 1; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line.trim()) continue;

    const cols = parseCsvLine(line);
    const record: Partial<ParsedProduct> = {};

    columnMap.forEach((field, colIndex) => {
      const cellValue = cols[colIndex] ?? "";

      if (field === "price") {
        record[field] = parseCzechDecimal(cellValue);
      } else {
        record[field] = toStringOrNull(cellValue) as string & null;
      }
    });

    const sku = record.sku?.trim();
    if (!sku) continue;

    products.push({
      sku,
      name: record.name?.trim() ?? "",
      name_secondary: record.name_secondary ?? null,
      description: record.description ?? null,
      unit: record.unit ?? null,
      price: record.price ?? null,
      ean: record.ean ?? null,
      manufacturer_code: record.manufacturer_code ?? null,
      manufacturer: record.manufacturer ?? null,
      category: record.category ?? null,
      subcategory: record.subcategory ?? null,
      sub_subcategory: record.sub_subcategory ?? null,
      eshop_url: record.eshop_url ?? null,
    });
  }

  if (onProgress) {
    await onProgress({
      type: "parse_complete",
      data: { total: products.length, processed: lines.length - 1 },
    });
  }

  return products;
}

/**
 * Parse a single CSV line respecting quoted fields (semicolon-delimited).
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ";") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }

  result.push(current);
  return result;
}

/**
 * Load all existing SKUs from the database.
 */
export async function loadExistingSkus(
  onProgress?: ProgressCallback,
): Promise<Set<string>> {
  const supabase = getAdminClient();
  const skus = new Set<string>();
  let page = 0;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("sku")
      .range(page * DB_PAGE_SIZE, (page + 1) * DB_PAGE_SIZE - 1);

    if (error) throw new Error(`Chyba čtení z DB: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) skus.add(row.sku);
    page++;

    if (onProgress && page % 50 === 0) {
      await onProgress({
        type: "db_loading",
        data: { loaded: skus.size },
      });
    }
  }

  return skus;
}

/**
 * Compute diff between file products and existing DB products.
 */
export function computeDiff(
  fileSkus: Set<string>,
  dbSkus: Set<string>,
): { toAdd: string[]; toUpdate: string[]; toRemove: string[] } {
  const toAdd = [...fileSkus].filter((s) => !dbSkus.has(s));
  const toUpdate = [...fileSkus].filter((s) => dbSkus.has(s));
  const toRemove = [...dbSkus].filter((s) => !fileSkus.has(s));
  return { toAdd, toUpdate, toRemove };
}

/**
 * Apply product changes: upsert all file products, delete removed ones.
 * Clears embeddings for updated products (name may have changed).
 */
export async function applyChanges(
  products: ParsedProduct[],
  toRemoveSkus: string[],
  onProgress?: ProgressCallback,
): Promise<ApplyResult> {
  const supabase = getAdminClient();
  let upserted = 0;
  let errors = 0;

  const totalBatches = Math.ceil(products.length / BATCH_SIZE);

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const { error } = await supabase
      .from("products")
      .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });

    if (error) {
      errors++;
      console.error(`Batch upsert ${batchNum} failed:`, error.message);
    } else {
      upserted += batch.length;
    }

    if (onProgress) {
      await onProgress({
        type: "upsert_progress",
        data: {
          batch: batchNum,
          totalBatches,
          upserted,
          total: products.length,
          percent: Math.round((upserted / products.length) * 100),
        },
      });
    }
  }

  let removed = 0;
  if (toRemoveSkus.length > 0) {
    const removeBatches = Math.ceil(toRemoveSkus.length / BATCH_SIZE);

    for (let i = 0; i < toRemoveSkus.length; i += BATCH_SIZE) {
      const batch = toRemoveSkus.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      const { error } = await supabase
        .from("products")
        .delete()
        .in("sku", batch);

      if (error) {
        errors++;
        console.error(`Delete batch ${batchNum} failed:`, error.message);
      } else {
        removed += batch.length;
      }

      if (onProgress) {
        await onProgress({
          type: "delete_progress",
          data: {
            batch: batchNum,
            totalBatches: removeBatches,
            removed,
            total: toRemoveSkus.length,
            percent: Math.round((removed / toRemoveSkus.length) * 100),
          },
        });
      }
    }
  }

  return { upserted, removed, errors };
}
