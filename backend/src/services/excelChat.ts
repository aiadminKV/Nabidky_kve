import ExcelJS from "exceljs";

const MAX_ROWS = 500;

interface SpreadsheetParseResult {
  sheetName: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

/**
 * Parse an Excel buffer into structured data suitable for agent consumption.
 * Returns headers and up to MAX_ROWS rows of data.
 */
export async function parseExcelForChat(base64: string): Promise<SpreadsheetParseResult[]> {
  const buffer = Buffer.from(base64, "base64");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const results: SpreadsheetParseResult[] = [];

  for (const worksheet of workbook.worksheets) {
    if (!worksheet || worksheet.rowCount < 2) continue;

    const headers: string[] = [];
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      while (headers.length < colNumber) headers.push("");
      headers[colNumber - 1] = cellToString(cell.value);
    });

    if (headers.every((h) => !h.trim())) continue;

    const rows: string[][] = [];
    let totalDataRows = 0;

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      totalDataRows++;
      if (rows.length >= MAX_ROWS) return;

      const rowData: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        rowData.push(cellToString(row.getCell(i + 1).value));
      }
      if (rowData.some((c) => c.trim())) {
        rows.push(rowData);
      }
    });

    results.push({
      sheetName: worksheet.name,
      headers,
      rows,
      totalRows: totalDataRows,
      truncated: totalDataRows > MAX_ROWS,
    });
  }

  return results;
}

/**
 * Parse a CSV buffer into structured data suitable for agent consumption.
 */
export function parseCsvForChat(base64: string): SpreadsheetParseResult[] {
  const text = Buffer.from(base64, "base64").toString("utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 1) return [];

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);
  const rows: string[][] = [];

  for (let i = 1; i < lines.length && rows.length < MAX_ROWS; i++) {
    const row = parseCsvLine(lines[i], delimiter);
    if (row.some((c) => c.trim())) {
      rows.push(row);
    }
  }

  return [{
    sheetName: "CSV",
    headers,
    rows,
    totalRows: lines.length - 1,
    truncated: lines.length - 1 > MAX_ROWS,
  }];
}

/**
 * Convert parsed spreadsheet data to a readable text format for the agent.
 * Uses TSV-like format which the parser agent handles well.
 */
export function spreadsheetToText(sheets: SpreadsheetParseResult[], filename: string): string {
  if (sheets.length === 0) {
    return `Soubor "${filename}" je prázdný nebo neobsahuje čitelná data.`;
  }

  const parts: string[] = [`Obsah souboru "${filename}":`];

  for (const sheet of sheets) {
    if (sheets.length > 1) {
      parts.push(`\n--- List: ${sheet.sheetName} (${sheet.totalRows} řádků) ---`);
    } else {
      parts.push(`(${sheet.totalRows} řádků)`);
    }

    parts.push(sheet.headers.join("\t"));

    for (const row of sheet.rows) {
      parts.push(row.join("\t"));
    }

    if (sheet.truncated) {
      parts.push(`\n... (zobrazeno ${MAX_ROWS} z ${sheet.totalRows} řádků)`);
    }
  }

  return parts.join("\n");
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return String((value as { result: unknown }).result ?? "");
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

function detectDelimiter(line: string): string {
  const semicolons = (line.match(/;/g) || []).length;
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs >= semicolons && tabs >= commas) return "\t";
  if (semicolons >= commas) return ";";
  return ",";
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
