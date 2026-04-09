import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const OFFSET = parseInt(process.argv[2] ?? "685000", 10);

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const r = await client.query(
  "SELECT product_id FROM product_embeddings_v2 ORDER BY product_id LIMIT 1 OFFSET $1",
  [OFFSET],
);
console.log(r.rows[0]?.product_id ?? "not found");
await client.end();
