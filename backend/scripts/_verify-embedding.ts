/**
 * Verify that the embedding stored in Qdrant matches what's in Supabase for a SKU.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QdrantClient } from "@qdrant/js-client-rest";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const sku = process.argv[2] ?? "1132208";
const DATABASE_URL = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "";

const dbClient = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await dbClient.connect();

// Get product internal ID and embedding from Supabase
const r = await dbClient.query(`
  SELECT pv.id, pv.sku, pv.name, pev.product_id,
    substring(pev.embedding::text, 1, 80) as emb_prefix
  FROM products_v2 pv
  LEFT JOIN product_embeddings_v2 pev ON pv.id = pev.product_id
  WHERE pv.sku = $1
  LIMIT 1
`, [sku]);

if (!r.rows[0]) { console.log("Not found in Supabase"); process.exit(1); }
const row = r.rows[0];
console.log(`Supabase product id: ${row.id}`);
console.log(`Supabase sku: ${row.sku}`);
console.log(`Supabase name: ${row.name}`);
console.log(`Supabase embedding product_id: ${row.product_id}`);
console.log(`Supabase embedding prefix: ${row.emb_prefix}`);

// Get actual first few embedding values from Supabase
const embR = await dbClient.query(`
  SELECT embedding::float4[] as emb
  FROM product_embeddings_v2
  WHERE product_id = $1
`, [row.product_id]);

const sbEmb: number[] = embR.rows[0]?.emb ?? [];
console.log(`\nSupabase embedding dims: ${sbEmb.length}`);
console.log(`Supabase emb[0..4]: [${sbEmb.slice(0, 5).map(v => v.toFixed(4)).join(", ")}]`);

// Get Qdrant embedding for the same ID
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  checkCompatibility: false,
});

const qdId = parseInt(row.id, 10);
console.log(`\nQuerying Qdrant for point id: ${qdId}`);

try {
  const pts = await qdrant.retrieve("products_v2", {
    ids: [qdId],
    with_vector: true,
    with_payload: ["sku", "name"],
  });
  if (pts.length === 0) {
    console.log("NOT FOUND in Qdrant");
  } else {
    const pt = pts[0]!;
    const qdEmb = Array.isArray(pt.vector) ? pt.vector as number[] : [];
    console.log(`Qdrant sku: ${pt.payload?.["sku"]}`);
    console.log(`Qdrant name: ${pt.payload?.["name"]}`);
    console.log(`Qdrant embedding dims: ${qdEmb.length}`);
    console.log(`Qdrant emb[0..4]: [${qdEmb.slice(0, 5).map(v => v.toFixed(4)).join(", ")}]`);
    
    // Compare first 5 values
    const match = sbEmb.slice(0, 5).every((v, i) => Math.abs(v - (qdEmb[i] ?? 0)) < 0.001);
    console.log(`\nEmbeddings match (first 5 dims): ${match ? "✅ YES" : "❌ NO — MISMATCH!"}`);
  }
} catch (err) {
  console.log("Qdrant error:", err);
}

await dbClient.end();
