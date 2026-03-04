import { Hono } from "hono";
import ExcelJS from "exceljs";
import { authMiddleware } from "../middleware/auth.js";
import { getUserClient } from "../services/supabase.js";

const exportRouter = new Hono();

interface ExportItem {
  originalName: string;
  quantity: number | null;
  sku: string | null;
  productName: string | null;
  manufacturerCode: string | null;
  manufacturer: string | null;
  matchType: string;
  confidence: number;
  extraColumns?: Record<string, string>;
}

/**
 * POST /export/xlsx
 * Generate an XLSX file for SAP import.
 * Key columns: product code (SKU) + quantity.
 */
exportRouter.post("/export/xlsx", authMiddleware, async (c) => {
  const { offerId, items } = await c.req.json<{
    offerId?: string;
    items?: ExportItem[];
  }>();

  let exportItems: ExportItem[];

  if (items) {
    exportItems = items;
  } else if (offerId) {
    const token = c.req.header("Authorization")?.slice(7) ?? "";
    const supabase = getUserClient(token);

    const { data, error } = await supabase
      .from("offer_items")
      .select(`
        original_name,
        quantity,
        matched_product_id,
        match_type,
        confidence,
        products:matched_product_id (sku, name, manufacturer_code, manufacturer)
      `)
      .eq("offer_id", offerId)
      .order("position");

    if (error) {
      return c.json({ error: `Failed to load offer items: ${error.message}` }, 500);
    }

    exportItems = (data ?? []).map((item) => {
      const product = item.products as unknown as Record<string, string> | null;
      return {
        originalName: item.original_name,
        quantity: item.quantity,
        sku: product?.sku ?? null,
        productName: product?.name ?? null,
        manufacturerCode: product?.manufacturer_code ?? null,
        manufacturer: product?.manufacturer ?? null,
        matchType: item.match_type ?? "not_found",
        confidence: item.confidence ?? 0,
      };
    });
  } else {
    return c.json({ error: "Either offerId or items must be provided" }, 400);
  }

  const extraKeys = new Set<string>();
  for (const item of exportItems) {
    if (item.extraColumns) {
      for (const key of Object.keys(item.extraColumns)) {
        extraKeys.add(key);
      }
    }
  }
  const extraKeysList = Array.from(extraKeys);

  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.creator = "KV Elektro – Správce nabídek";

  const sheet = workbook.addWorksheet("SAP Import");

  const baseColumns: Partial<ExcelJS.Column>[] = [
    { header: "Kód produktu (SKU)", key: "sku", width: 20 },
    { header: "Množství", key: "quantity", width: 12 },
    { header: "Název z poptávky", key: "originalName", width: 40 },
  ];

  const extraColumnDefs: Partial<ExcelJS.Column>[] = extraKeysList.map((key) => ({
    header: key,
    key: `extra_${key}`,
    width: Math.max(15, Math.min(key.length + 4, 30)),
  }));

  const tailColumns: Partial<ExcelJS.Column>[] = [
    { header: "Nalezený produkt", key: "productName", width: 40 },
    { header: "Kód výrobce", key: "manufacturerCode", width: 25 },
    { header: "Výrobce", key: "manufacturer", width: 20 },
    { header: "Typ shody", key: "matchType", width: 15 },
    { header: "Jistota (%)", key: "confidence", width: 12 },
  ];

  sheet.columns = [...baseColumns, ...extraColumnDefs, ...tailColumns];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1E40AF" },
  };
  headerRow.alignment = { vertical: "middle" };

  for (const item of exportItems) {
    const rowData: Record<string, unknown> = {
      sku: item.sku ?? "",
      quantity: item.quantity,
      originalName: item.originalName,
      productName: item.productName ?? "",
      manufacturerCode: item.manufacturerCode ?? "",
      manufacturer: item.manufacturer ?? "",
      matchType: translateMatchType(item.matchType),
      confidence: item.confidence,
    };

    for (const key of extraKeysList) {
      rowData[`extra_${key}`] = item.extraColumns?.[key] ?? "";
    }

    const row = sheet.addRow(rowData);

    const fillColor = getMatchColor(item.matchType);
    if (fillColor) {
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: fillColor },
        };
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();

  c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  c.header("Content-Disposition", `attachment; filename="kv-nabidka-${Date.now()}.xlsx"`);

  return c.body(buffer as ArrayBuffer);
});

function translateMatchType(type: string): string {
  const map: Record<string, string> = {
    match: "Shoda",
    uncertain: "Nejistá shoda",
    multiple: "Více možností",
    alternative: "Alternativa",
    not_found: "Nenalezeno",
    confirmed: "Potvrzeno",
    skipped: "Přeskočeno",
  };
  return map[type] ?? type;
}

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
