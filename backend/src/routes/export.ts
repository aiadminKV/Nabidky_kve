import { Hono } from "hono";
import ExcelJS from "exceljs";
import { authMiddleware } from "../middleware/auth.js";

const exportRouter = new Hono();

interface OfferHeader {
  customerId: string;
  customerIco: string;
  customerName: string;
  deliveryDate: string;
  offerName: string;
  phone: string;
  email: string;
  specialAction: string;
  branch: string;
  deliveryAddress: string;
}

interface ExportItem {
  originalName: string;
  quantity: number | null;
  unit: string | null;
  sku: string | null;
  productName: string | null;
  manufacturerCode: string | null;
  manufacturer: string | null;
  matchType: string;
  confidence: number;
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1E40AF" },
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 10,
};

const CELL_FONT: Partial<ExcelJS.Font> = { size: 10 };

function applyHeaderStyle(row: ExcelJS.Row, colCount: number) {
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle" };
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
  }
}

/**
 * POST /export/xlsx
 * Generate XLSX matching the KV Elektro import template.
 * Sheet 1: Customer header + item rows.
 * Sheet 2: Field descriptions.
 */
exportRouter.post("/export/xlsx", authMiddleware, async (c) => {
  const { header, items } = await c.req.json<{
    header?: Partial<OfferHeader>;
    items: ExportItem[];
  }>();

  if (!items?.length) {
    return c.json({ error: "Items are required" }, 400);
  }

  const h: OfferHeader = {
    customerId: header?.customerId ?? "",
    customerIco: header?.customerIco ?? "",
    customerName: header?.customerName ?? "",
    deliveryDate: header?.deliveryDate ?? "",
    offerName: header?.offerName ?? "",
    phone: header?.phone ?? "",
    email: header?.email ?? "",
    specialAction: header?.specialAction ?? "",
    branch: header?.branch ?? "",
    deliveryAddress: header?.deliveryAddress ?? "",
  };

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.creator = "KV Elektro – Správce nabídek";

  // ── Sheet 1: Data ──
  const dataSheet = workbook.addWorksheet("Import");

  // Customer header section
  const customerHeaders = [
    "ID", "IČ", "Název", "termín dodání",
    "Název zakázky / Číslo objednávky", "tel", "email",
    "spec.akce", "pobočka", "adresa dodání",
  ];
  const customerHeaderRow = dataSheet.addRow(customerHeaders);
  applyHeaderStyle(customerHeaderRow, customerHeaders.length);

  const customerDataRow = dataSheet.addRow([
    h.customerId,
    h.customerIco,
    h.customerName,
    h.deliveryDate,
    h.offerName,
    h.phone,
    h.email,
    h.specialAction,
    h.branch,
    h.deliveryAddress,
  ]);
  customerDataRow.font = CELL_FONT;

  // Empty separator row
  dataSheet.addRow([]);

  // Item header section
  const itemHeaders = ["Artikl", "prodID", "Název", "Množství", "MJ"];
  const itemHeaderRow = dataSheet.addRow(itemHeaders);
  applyHeaderStyle(itemHeaderRow, itemHeaders.length);

  // Item data rows
  for (const item of items) {
    const row = dataSheet.addRow([
      item.sku ?? "",
      item.manufacturerCode ?? "",
      item.originalName,
      item.quantity,
      item.unit ?? "ks",
    ]);
    row.font = CELL_FONT;

    const fillColor = getMatchColor(item.matchType);
    if (fillColor) {
      for (let c = 1; c <= 5; c++) {
        row.getCell(c).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: fillColor },
        };
      }
    }
  }

  // Column widths
  dataSheet.getColumn(1).width = 14;
  dataSheet.getColumn(2).width = 18;
  dataSheet.getColumn(3).width = 45;
  dataSheet.getColumn(4).width = 12;
  dataSheet.getColumn(5).width = 8;
  dataSheet.getColumn(6).width = 14;
  dataSheet.getColumn(7).width = 25;
  dataSheet.getColumn(8).width = 14;
  dataSheet.getColumn(9).width = 14;
  dataSheet.getColumn(10).width = 30;

  // ── Sheet 2: Popisky ──
  const descSheet = workbook.addWorksheet("Popisky");

  const descHeaderRow = descSheet.addRow(["Pole", "Popis", "Povinné"]);
  applyHeaderStyle(descHeaderRow, 3);

  const descriptions = [
    ["", "DATA HLAVIČKY", ""],
    ["ID", "ID zákazníka (interní identifikátor)", "ano"],
    ["IČ", "IČO zákazníka", "ano"],
    ["termín dodání", "Datum dodání objednávky", "ano"],
    ["Název zakázky", "Název nabídky / akce / číslo objednávky", "ano"],
    ["tel", "Kontaktní telefon", "volitelné"],
    ["email", "Kontaktní email", "volitelné"],
    ["spec.akce", "Kód speciální akce", "volitelné"],
    ["pobočka", "Pobočka pro odběr", "volitelné"],
    ["adresa dodání", "Adresa pro doručení zásilky", "volitelné"],
    ["", "", ""],
    ["", "DATA POLOŽEK", ""],
    ["Artikl", "SKU kód produktu z katalogu KV Elektro", "ano"],
    ["prodID", "Kód výrobce (manufacturer code)", "volitelné"],
    ["Název", "Název produktu z poptávky", "ano"],
    ["Množství", "Objednané množství", "ano"],
    ["MJ", "Měrná jednotka (ks, m, bal…) — pokud chybí, přebere se z katalogu", "volitelné"],
    ["", "", ""],
    ["", "POZNÁMKY", ""],
    ["TAN", "Položka s vyplněným Artikl — standardní objednávka", ""],
    ["TATX", "Položka BEZ Artiklu — textová poznámka s množstvím", ""],
  ];

  for (const row of descriptions) {
    const r = descSheet.addRow(row);
    r.font = CELL_FONT;
    if (row[0] === "" && row[1].startsWith("DATA") || row[1] === "POZNÁMKY") {
      r.font = { ...CELL_FONT, bold: true };
    }
  }

  descSheet.getColumn(1).width = 22;
  descSheet.getColumn(2).width = 50;
  descSheet.getColumn(3).width = 14;

  const buffer = await workbook.xlsx.writeBuffer();

  c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  c.header("Content-Disposition", `attachment; filename="kv-nabidka-${Date.now()}.xlsx"`);

  return c.body(buffer as ArrayBuffer);
});

function getMatchColor(type: string): string | null {
  const map: Record<string, string> = {
    match: "FFE8F5E9",
    confirmed: "FFE8F5E9",
    uncertain: "FFFFFDE7",
    multiple: "FFE3F2FD",
    alternative: "FFFFF3E0",
    not_found: "FFFFEBEE",
  };
  return map[type] ?? null;
}

export { exportRouter };
