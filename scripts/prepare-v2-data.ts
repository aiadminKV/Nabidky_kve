/**
 * Phase A: Local data preparation for V2 migration.
 *
 * Reads source CSV files from SAP, transforms them according to the new data model,
 * and writes prepared CSV files ready for DB bulk load (Phase B).
 *
 * Input:  data-model/*.csv (source CSVs from SAP)
 * Output: data-model/prepared/*.csv
 *
 * Usage: npx tsx prepare-v2-data.ts [--source-dir=../data-model]
 */
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import * as iconv from "iconv-lite";

// ─── Config ──────────────────────────────────────────────────────────

const SOURCE_DIR_DEFAULT = resolve(import.meta.dirname, "../data-model");
const OUTPUT_DIR_DEFAULT = resolve(import.meta.dirname, "../data-model/prepared");

const SOURCE_FILES = {
  products: "matnr_dispo_info.csv",
  statuses: "status_type (2).csv",
  categories: "name_of_category (2).csv",
  customers: "customer_info (1).csv",
};

const BATCH_LOG_INTERVAL = 100_000;

// ─── Types ───────────────────────────────────────────────────────────

interface ProductCsvRow {
  MATNR: string;
  MAKTX: string;
  MEINS: string;
  EAN: string;
  IDNLF: string;
  LIFNR: string;
  C4_PRICE: string;
  MSTAE: string;
  MSTAV: string;
  MATKL: string;
  DISPO: string;
  DESC: string;
  THUMB_FILE: string;
  [key: string]: string; // WH_#### dynamic columns
}

interface StatusRow {
  MMSTA: string;
  MMSTB: string;
  VMSTA: string;
  VMSTB: string;
}

interface CategoryRow {
  CLASS: string;
  KSCHL: string;
}

interface CustomerCsvRow {
  KUNNR: string;
  STCD2: string;
  STCEG: string;
  NAME1: string;
  ADDRE: string;
  SPERR: string;
  LOEVM: string;
}

interface PreparedProduct {
  source_matnr: string;
  sku: string;
  name: string;
  unit: string;
  supplier_name: string;
  category_code: string;
  category_main: string;
  category_sub: string;
  category_line: string;
  status_purchase_code: string;
  status_sales_code: string;
  status_purchase_text: string;
  status_sales_text: string;
  dispo: string;
  is_stock_item: string; // 'true'/'false' for CSV
  description: string;
  thumbnail_url: string;
  source_ean_raw: string;
  source_idnlf_raw: string;
  search_hints: string;
}

interface PreparedIdentifier {
  source_matnr: string;
  identifier_type: string;
  identifier_value: string;
}

interface PreparedPrice {
  source_matnr: string;
  current_price: string;
  currency: string;
}

interface PreparedStock {
  source_matnr: string;
  branch_code: string;
  stock_qty: string;
}

interface PreparedCustomer {
  source_kunnr: string;
  ico: string;
  dic: string;
  name: string;
  address: string;
  sperr: string;
  loevm: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function readFileWithEncoding(filePath: string): string {
  const raw = readFileSync(filePath);
  const utf8 = raw.toString("utf-8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return iconv.decode(raw, "cp1250");
}

function matnrToSku(matnr: string): string {
  const stripped = matnr.replace(/^0+/, "");
  return stripped || "0";
}

function isStockItem(dispo: string): boolean {
  return dispo?.trim().toUpperCase() === "ANO";
}

function splitEan(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitIdnlf(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",:")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePrice(value: string): number | null {
  if (!value || !value.trim()) return null;
  const normalized = value.replace(",", ".");
  const num = parseFloat(normalized);
  return isNaN(num) || num <= 0 ? null : num;
}

function parseStockQty(value: string): number {
  if (!value || !value.trim()) return 0;
  const normalized = value.replace(",", ".");
  const num = parseFloat(normalized);
  return isNaN(num) ? 0 : num;
}

function computeStockHash(stocks: Array<[string, number]>): string {
  if (stocks.length === 0) return "";
  const sorted = stocks.sort(([a], [b]) => a.localeCompare(b));
  return createHash("md5").update(JSON.stringify(sorted)).digest("hex");
}

function trim(s: string): string {
  return s?.trim() ?? "";
}

// ─── Lookup Builders ─────────────────────────────────────────────────

function buildStatusLookup(sourceDir: string): {
  purchaseMap: Map<string, string>;
  salesMap: Map<string, string>;
  rows: Array<{ status_code: string; status_type: string; status_text: string }>;
} {
  const filePath = join(sourceDir, SOURCE_FILES.statuses);
  const content = readFileWithEncoding(filePath);
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  const purchaseMap = new Map<string, string>();
  const salesMap = new Map<string, string>();
  const rows: Array<{ status_code: string; status_type: string; status_text: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const [mmsta, mmstb, vmsta, vmstb] = parts.map(trim);

    if (mmsta) {
      purchaseMap.set(mmsta, mmstb);
      rows.push({ status_code: mmsta, status_type: "purchase", status_text: mmstb });
    }
    if (vmsta) {
      salesMap.set(vmsta, vmstb);
      rows.push({ status_code: vmsta, status_type: "sales", status_text: vmstb });
    }
  }

  console.log(`  Status types: ${rows.length} (purchase: ${purchaseMap.size}, sales: ${salesMap.size})`);
  return { purchaseMap, salesMap, rows };
}

function buildCategoryLookup(sourceDir: string): {
  codeToName: Map<string, string>;
  rows: Array<{ category_code: string; category_name: string; level: number; parent_code: string }>;
} {
  const filePath = join(sourceDir, SOURCE_FILES.categories);
  const content = readFileWithEncoding(filePath);
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  const codeToName = new Map<string, string>();
  const rows: Array<{
    category_code: string;
    category_name: string;
    level: number;
    parent_code: string;
  }> = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const code = trim(parts[0]);
    const name = trim(parts[1]);
    if (!code) continue;

    codeToName.set(code, name);

    let level: number;
    let parentCode: string;
    if (code.length <= 3) {
      level = 1;
      parentCode = "";
    } else if (code.length <= 5) {
      level = 2;
      parentCode = code.slice(0, 3);
    } else {
      level = 3;
      parentCode = code.slice(0, 5);
    }

    rows.push({ category_code: code, category_name: name, level, parent_code: parentCode });
  }

  console.log(`  Categories: ${rows.length} (L1: ${rows.filter((r) => r.level === 1).length}, L2: ${rows.filter((r) => r.level === 2).length}, L3: ${rows.filter((r) => r.level === 3).length})`);
  return { codeToName, rows };
}

function resolveCategoryHierarchy(
  matkl: string,
  codeToName: Map<string, string>,
): { main: string; sub: string; line: string } {
  if (!matkl || !matkl.trim()) return { main: "", sub: "", line: "" };

  const code = matkl.trim();
  const l1 = code.length >= 3 ? code.slice(0, 3) : code;
  const l2 = code.length >= 5 ? code.slice(0, 5) : "";
  const l3 = code.length >= 7 ? code : "";

  return {
    main: codeToName.get(l1) ?? "",
    sub: l2 ? (codeToName.get(l2) ?? "") : "",
    line: l3 ? (codeToName.get(l3) ?? "") : "",
  };
}

// ─── CSV Writer Helper ───────────────────────────────────────────────

async function writeCsv<T extends Record<string, unknown>>(
  filePath: string,
  columns: string[],
  rows: T[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(filePath);
    const stringifier = stringify({ header: true, columns, delimiter: "," });
    stringifier.pipe(output);

    for (const row of rows) {
      stringifier.write(row);
    }

    stringifier.end();
    output.on("finish", () => resolve(rows.length));
    output.on("error", reject);
    stringifier.on("error", reject);
  });
}

async function writeStreamCsv(
  filePath: string,
  columns: string[],
): Promise<{
  write: (row: Record<string, unknown>) => void;
  end: () => Promise<number>;
}> {
  const output = createWriteStream(filePath);
  const stringifier = stringify({ header: true, columns, delimiter: "," });
  stringifier.pipe(output);
  let count = 0;

  return {
    write(row: Record<string, unknown>) {
      stringifier.write(row);
      count++;
    },
    end() {
      return new Promise<number>((resolve, reject) => {
        stringifier.end();
        output.on("finish", () => resolve(count));
        output.on("error", reject);
        stringifier.on("error", reject);
      });
    },
  };
}

// ─── Main Pipeline ───────────────────────────────────────────────────

async function main() {
  const sourceDirArg = process.argv.find((a) => a.startsWith("--source-dir="));
  const sourceDir = sourceDirArg
    ? resolve(sourceDirArg.split("=")[1])
    : SOURCE_DIR_DEFAULT;

  const outputDir = OUTPUT_DIR_DEFAULT;
  await mkdir(outputDir, { recursive: true });

  console.log(`Source: ${sourceDir}`);
  console.log(`Output: ${outputDir}\n`);

  // ── A1: Build lookups ────────────────────────────────────────────
  console.log("[A1] Building lookup data...");

  const statuses = buildStatusLookup(sourceDir);
  const categories = buildCategoryLookup(sourceDir);

  // ── A2: Extract WH_ columns + process main product file ─────────
  console.log("\n[A2] Parsing matnr_dispo_info.csv...");

  const productFilePath = join(sourceDir, SOURCE_FILES.products);

  const products: PreparedProduct[] = [];
  const identifiers: PreparedIdentifier[] = [];
  const prices: PreparedPrice[] = [];
  const stockRows: PreparedStock[] = [];
  const branchCodes = new Set<string>();
  const usedCategoryCodes = new Set<string>();
  let whColumns: string[] = [];

  let rowCount = 0;
  let priceCount = 0;
  let stockCount = 0;
  let identCount = 0;
  let stockItemCount = 0;
  let productsWithStockCount = 0;

  const parser = createReadStream(productFilePath, { encoding: "utf-8" }).pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      quote: false,
    }),
  );

  let headerProcessed = false;

  for await (const row of parser as AsyncIterable<ProductCsvRow>) {
    if (!headerProcessed) {
      whColumns = Object.keys(row).filter((k) => k.startsWith("WH_"));
      for (const wh of whColumns) branchCodes.add(wh);
      console.log(`  WH columns found: ${whColumns.length} (${whColumns[0]}...${whColumns[whColumns.length - 1]})`);
      headerProcessed = true;
    }

    const matnr = trim(row.MATNR);
    if (!matnr) continue;

    rowCount++;

    // ── Product core ──
    const matkl = trim(row.MATKL);
    const catHierarchy = resolveCategoryHierarchy(matkl, categories.codeToName);

    if (matkl) usedCategoryCodes.add(matkl);
    if (matkl.length >= 5) usedCategoryCodes.add(matkl.slice(0, 5));
    if (matkl.length >= 3) usedCategoryCodes.add(matkl.slice(0, 3));

    const mstae = trim(row.MSTAE);
    const mstav = trim(row.MSTAV);
    const dispo = trim(row.DISPO);
    const stockItem = isStockItem(dispo);
    if (stockItem) stockItemCount++;

    products.push({
      source_matnr: matnr,
      sku: matnrToSku(matnr),
      name: trim(row.MAKTX),
      unit: trim(row.MEINS),
      supplier_name: trim(row.LIFNR),
      category_code: matkl,
      category_main: catHierarchy.main,
      category_sub: catHierarchy.sub,
      category_line: catHierarchy.line,
      status_purchase_code: mstae,
      status_sales_code: mstav,
      status_purchase_text: statuses.purchaseMap.get(mstae) ?? "",
      status_sales_text: statuses.salesMap.get(mstav) ?? "",
      dispo,
      is_stock_item: stockItem ? "true" : "false",
      description: trim(row.DESC),
      thumbnail_url: trim(row.THUMB_FILE),
      source_ean_raw: trim(row.EAN),
      source_idnlf_raw: trim(row.IDNLF),
      search_hints: "",
    });

    // ── Identifiers ──
    const eans = splitEan(row.EAN);
    for (const ean of eans) {
      identifiers.push({ source_matnr: matnr, identifier_type: "EAN", identifier_value: ean });
      identCount++;
    }
    const idnlfs = splitIdnlf(row.IDNLF);
    for (const idnlf of idnlfs) {
      identifiers.push({ source_matnr: matnr, identifier_type: "IDNLF", identifier_value: idnlf });
      identCount++;
    }

    // ── Price ──
    const price = parsePrice(row.C4_PRICE);
    if (price !== null) {
      prices.push({
        source_matnr: matnr,
        current_price: price.toFixed(2),
        currency: "CZK",
      });
      priceCount++;
    }

    // ── Stock (unpivot WH_ columns, only positive values) ──
    let hasAnyStock = false;
    for (const wh of whColumns) {
      const qty = parseStockQty(row[wh]);
      if (qty > 0) {
        stockRows.push({
          source_matnr: matnr,
          branch_code: wh,
          stock_qty: qty.toString(),
        });
        stockCount++;
        hasAnyStock = true;
      }
    }
    if (hasAnyStock) productsWithStockCount++;

    if (rowCount % BATCH_LOG_INTERVAL === 0) {
      console.log(`  ... ${rowCount.toLocaleString()} rows processed`);
    }
  }

  console.log(`  Total: ${rowCount.toLocaleString()} products`);
  console.log(`  Prices: ${priceCount.toLocaleString()} (${((priceCount / rowCount) * 100).toFixed(1)}%)`);
  console.log(`  Stock items (DISPO=ANO): ${stockItemCount.toLocaleString()}`);
  console.log(`  Products with stock: ${productsWithStockCount.toLocaleString()}`);
  console.log(`  Stock rows (sparse): ${stockCount.toLocaleString()}`);
  console.log(`  Identifiers: ${identCount.toLocaleString()}`);
  console.log(`  Branches: ${branchCodes.size}`);

  // ── A2b: Validate categories ─────────────────────────────────────
  console.log("\n[A2b] Validating categories...");

  const knownCodes = new Set(categories.rows.map((r) => r.category_code));
  let unknownCount = 0;

  for (const code of usedCategoryCodes) {
    if (!code || knownCodes.has(code)) continue;

    let level: number;
    let parentCode: string;
    if (code.length <= 3) {
      level = 1;
      parentCode = "";
    } else if (code.length <= 5) {
      level = 2;
      parentCode = code.slice(0, 3);
    } else {
      level = 3;
      parentCode = code.slice(0, 5);
    }

    categories.rows.push({
      category_code: code,
      category_name: "Neznámá kategorie",
      level,
      parent_code: parentCode,
    });
    knownCodes.add(code);
    unknownCount++;
  }

  if (unknownCount > 0) {
    console.log(`  Added ${unknownCount} unknown categories as 'Neznámá kategorie'`);
  } else {
    console.log(`  All categories valid`);
  }

  // ── A3: Process customers ────────────────────────────────────────
  console.log("\n[A3] Parsing customer_info...");

  const customerFilePath = join(sourceDir, SOURCE_FILES.customers);
  const customers: PreparedCustomer[] = [];

  const customerParser = createReadStream(customerFilePath, { encoding: "utf-8" }).pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      quote: false,
    }),
  );

  for await (const row of customerParser as AsyncIterable<CustomerCsvRow>) {
    const kunnr = trim(row.KUNNR);
    if (!kunnr) continue;

    customers.push({
      source_kunnr: kunnr,
      ico: trim(row.STCD2),
      dic: trim(row.STCEG),
      name: trim(row.NAME1),
      address: trim(row.ADDRE),
      sperr: trim(row.SPERR),
      loevm: trim(row.LOEVM),
    });
  }

  console.log(`  Customers: ${customers.length.toLocaleString()}`);

  // ── A4: Write output files ───────────────────────────────────────
  console.log("\n[A4] Writing output files...\n");

  // 01_status_types.csv
  const statusCount = await writeCsv(
    join(outputDir, "01_status_types.csv"),
    ["status_code", "status_type", "status_text"],
    statuses.rows,
  );
  console.log(`  01_status_types.csv: ${statusCount} rows`);

  // 02_categories.csv — ensure parent categories exist before children
  categories.rows.sort((a, b) => a.level - b.level || a.category_code.localeCompare(b.category_code));
  const catCount = await writeCsv(
    join(outputDir, "02_categories.csv"),
    ["category_code", "category_name", "level", "parent_code"],
    categories.rows,
  );
  console.log(`  02_categories.csv: ${catCount} rows`);

  // 03_branches.csv
  const branchRows = Array.from(branchCodes)
    .sort()
    .map((code) => ({ source_branch_code: code, name: "" }));
  const branchCount = await writeCsv(
    join(outputDir, "03_branches.csv"),
    ["source_branch_code", "name"],
    branchRows,
  );
  console.log(`  03_branches.csv: ${branchCount} rows`);

  // 04_products.csv
  const productWriter = await writeStreamCsv(
    join(outputDir, "04_products.csv"),
    [
      "source_matnr", "sku", "name", "unit", "supplier_name",
      "category_code", "category_main", "category_sub", "category_line",
      "status_purchase_code", "status_sales_code",
      "status_purchase_text", "status_sales_text",
      "dispo", "is_stock_item",
      "description", "thumbnail_url",
      "source_ean_raw", "source_idnlf_raw", "search_hints",
    ],
  );
  for (const p of products) productWriter.write(p);
  const productCount = await productWriter.end();
  console.log(`  04_products.csv: ${productCount.toLocaleString()} rows`);

  // 05_identifiers.csv
  const identWriter = await writeStreamCsv(
    join(outputDir, "05_identifiers.csv"),
    ["source_matnr", "identifier_type", "identifier_value"],
  );
  for (const id of identifiers) identWriter.write(id);
  const identWritten = await identWriter.end();
  console.log(`  05_identifiers.csv: ${identWritten.toLocaleString()} rows`);

  // 06_prices.csv
  const priceWriter = await writeStreamCsv(
    join(outputDir, "06_prices.csv"),
    ["source_matnr", "current_price", "currency"],
  );
  for (const p of prices) priceWriter.write(p);
  const pricesWritten = await priceWriter.end();
  console.log(`  06_prices.csv: ${pricesWritten.toLocaleString()} rows`);

  // 07_stock.csv
  const stockWriter = await writeStreamCsv(
    join(outputDir, "07_stock.csv"),
    ["source_matnr", "branch_code", "stock_qty"],
  );
  for (const s of stockRows) stockWriter.write(s);
  const stockWritten = await stockWriter.end();
  console.log(`  07_stock.csv: ${stockWritten.toLocaleString()} rows`);

  // 08_customers.csv
  const customerCount = await writeCsv(
    join(outputDir, "08_customers.csv"),
    ["source_kunnr", "ico", "dic", "name", "address", "sperr", "loevm"],
    customers,
  );
  console.log(`  08_customers.csv: ${customerCount.toLocaleString()} rows`);

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("Phase A complete!");
  console.log("═".repeat(60));
  console.log(`
  Products:     ${products.length.toLocaleString()}
  Prices:       ${prices.length.toLocaleString()} (${((prices.length / products.length) * 100).toFixed(1)}%)
  Stock items:  ${stockItemCount.toLocaleString()} (DISPO=ANO)
  With stock:   ${productsWithStockCount.toLocaleString()} (any WH > 0)
  Stock rows:   ${stockRows.length.toLocaleString()} (sparse)
  Identifiers:  ${identifiers.length.toLocaleString()}
  Categories:   ${categories.rows.length} (${unknownCount} auto-added)
  Branches:     ${branchCodes.size}
  Customers:    ${customers.length.toLocaleString()}
  Statuses:     ${statuses.rows.length}

  Output:       ${outputDir}

  Next step:    Run prepare-v2-embeddings.ts to generate embeddings (09_embeddings.jsonl)
  Then:         Run Phase B (load-v2-data.ts) to bulk insert into DB
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
