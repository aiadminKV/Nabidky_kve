/**
 * Check what embedding_text was stored for a given SKU.
 * Usage: npx tsx backend/scripts/_check-embedding-text.ts 1132208
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const sku = process.argv[2] ?? "1132208";
const DATABASE_URL = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "";

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const r = await client.query(`
  SELECT pv.sku, pv.name, pv.category_sub, pv.category_line, pv.supplier_name, pev.embedding_text
  FROM products_v2 pv
  LEFT JOIN product_embeddings_v2 pev ON pv.id = pev.product_id
  WHERE pv.sku = $1
  LIMIT 1
`, [sku]);

if (r.rows[0]) {
  const row = r.rows[0];
  console.log("SKU:", row.sku);
  console.log("Name:", row.name);
  console.log("Category sub:", row.category_sub);
  console.log("Category line:", row.category_line);
  console.log("Supplier:", row.supplier_name);
  console.log("\nEmbedding text that was embedded:");
  console.log(row.embedding_text ?? "(null - embedding_text column doesn't exist)");
} else {
  console.log("SKU not found:", sku);
}

await client.end();
