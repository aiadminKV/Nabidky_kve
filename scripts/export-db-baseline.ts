/**
 * Exports the current DB state as a CSV in the same format as the API CSV.
 * Uses a direct Postgres connection for speed (single query, server-side cursor).
 *
 * Usage: npx tsx export-db-baseline.ts
 */
import { config } from "dotenv";
import { resolve, join } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createWriteStream } from "node:fs";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL!;
const SYNC_DIR = resolve(import.meta.dirname, "../data-model/sync");
const OUT_PATH = join(SYNC_DIR, "previous_matnr_dispo_info.csv");

const WH_CODES = [
  "WH_1001","WH_1002","WH_1020","WH_1021","WH_1022","WH_1023","WH_1024",
  "WH_1025","WH_1026","WH_1027","WH_1028","WH_1030","WH_1031","WH_1032",
  "WH_1033","WH_1034","WH_1035","WH_1036","WH_1037","WH_1038","WH_1060",
  "WH_1061","WH_1062",
];

function fmt(n: number): string { return n.toLocaleString("cs-CZ"); }
function elapsed(t: number): string { return `${((Date.now() - t) / 1000).toFixed(1)}s`; }

async function main() {
  console.log("\n  Exporting DB → baseline CSV (direct pg connection)...\n");
  const t0 = Date.now();

  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`  Connected in ${elapsed(t0)}`);

  // Pivot stock per product as individual WH columns using crosstab-style aggregation
  const whAgg = WH_CODES.map(
    (wh) => `MAX(CASE WHEN b.source_branch_code = '${wh}' THEN bs.stock_qty ELSE NULL END) AS "${wh}"`,
  ).join(",\n    ");

  const sql = `
    SELECT
      p.source_matnr                     AS "MATNR",
      p.name                             AS "MAKTX",
      COALESCE(p.unit, '')               AS "MEINS",
      COALESCE(p.source_ean_raw, '')     AS "EAN",
      COALESCE(p.source_idnlf_raw, '')   AS "IDNLF",
      COALESCE(p.supplier_name, '')      AS "LIFNR",
      COALESCE(
        to_char(pr.current_price, 'FM999999999990.00'), ''
      )                                  AS "C4_PRICE",
      COALESCE(p.status_purchase_code, '') AS "MSTAE",
      COALESCE(p.status_sales_code, '')    AS "MSTAV",
      COALESCE(p.category_code, '')      AS "MATKL",
      COALESCE(p.dispo, '')              AS "DISPO",
      ${whAgg}
    FROM products_v2 p
    LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
    LEFT JOIN product_branch_stock_v2 bs ON bs.product_id = p.id
    LEFT JOIN branches_v2 b ON b.id = bs.branch_id
    WHERE p.removed_at IS NULL
    GROUP BY
      p.id, p.source_matnr, p.name, p.unit,
      p.source_ean_raw, p.source_idnlf_raw, p.supplier_name,
      p.status_purchase_code, p.status_sales_code, p.category_code, p.dispo,
      pr.current_price
    ORDER BY p.source_matnr
  `;

  const ws = createWriteStream(OUT_PATH, { encoding: "utf-8" });

  // Header
  ws.write(["MATNR","MAKTX","MEINS","EAN","IDNLF","LIFNR","C4_PRICE","MSTAE","MSTAV","MATKL","DISPO",...WH_CODES].join(";") + "\n");

  let count = 0;
  const logEvery = 100_000;

  // Use server-side cursor for streaming — avoid loading all 928K rows into memory
  await client.query("BEGIN");
  await client.query(`DECLARE export_cur CURSOR FOR ${sql}`);

  const FETCH_SIZE = 10_000;

  while (true) {
    const res = await client.query(`FETCH ${FETCH_SIZE} FROM export_cur`);
    if (res.rows.length === 0) break;

    for (const row of res.rows) {
      const whValues = WH_CODES.map((wh) => {
        const qty = row[wh];
        if (qty == null || qty === 0) return "";
        // Format with comma decimal like API (e.g. 1,000)
        return String(qty).replace(".", ",");
      });

      const line = [
        row.MATNR, row.MAKTX, row.MEINS, row.EAN, row.IDNLF, row.LIFNR,
        row.C4_PRICE.replace(".", ","),
        row.MSTAE, row.MSTAV, row.MATKL, row.DISPO,
        ...whValues,
      ].join(";");

      ws.write(line + "\n");
      count++;
    }

    if (count % logEvery === 0) {
      console.log(`  ${fmt(count)} products exported... (${elapsed(t0)})`);
    }
  }

  await client.query("COMMIT");
  await client.end();

  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve());
    ws.on("error", reject);
  });

  console.log(`\n  Done! Exported ${fmt(count)} products`);
  console.log(`  Output: ${OUT_PATH}`);
  console.log(`  Time: ${elapsed(t0)}\n`);
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message}\n`);
  process.exit(1);
});
