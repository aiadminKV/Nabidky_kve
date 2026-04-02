/**
 * Finds top-20 vector neighbors for each test product from evaluace-master-final.csv
 * and outputs the full set of product IDs to backfill descriptions for.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL!;
const CSV_PATH = resolve(import.meta.dirname, "../docs/general/evaluace-master-final.csv");
const TOP_K = 20;

function makePgClient() {
  return new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

const csv = readFileSync(CSV_PATH, "utf8");
const lines = csv.trim().split("\n").slice(1);
const matnrs: string[] = [];
for (const line of lines) {
  const parts = line.split(";");
  const sap = parts[3]?.trim().replace(/"/g, "");
  if (sap && !sap.includes("+") && /^\d+$/.test(sap)) {
    matnrs.push(sap.padStart(18, "0"));
  }
}
const unique = [...new Set(matnrs)];
console.log(`\nUnique simple SAP codes: ${unique.length}`);

const client = makePgClient();
await client.connect();

// Get test products + their embeddings
const { rows: testProducts } = await client.query<{
  id: number; source_matnr: string; name: string; embedding: string;
}>(`
  SELECT p.id, p.source_matnr, p.name, e.embedding
  FROM products_v2 p
  JOIN product_embeddings_v2 e ON e.product_id = p.id
  WHERE p.source_matnr = ANY($1) AND p.removed_at IS NULL
`, [unique]);

console.log(`Test products with embeddings: ${testProducts.length} / ${unique.length}`);

// For each test product, find top-K neighbors
const neighborIds = new Set<number>(testProducts.map(p => p.id));
let done = 0;

for (const tp of testProducts) {
  const { rows: neighbors } = await client.query<{ product_id: number }>(`
    SELECT e.product_id
    FROM product_embeddings_v2 e
    WHERE e.product_id != $1
    ORDER BY e.embedding <=> $2
    LIMIT $3
  `, [tp.id, tp.embedding, TOP_K]);

  neighbors.forEach(n => neighborIds.add(n.product_id));
  done++;
  if (done % 50 === 0) process.stdout.write(`  ${done}/${testProducts.length} done...\n`);
}

console.log(`\nTotal unique products (test + neighbors): ${neighborIds.size}`);

// Get details for summary
const { rows: details } = await client.query<{
  id: number; source_matnr: string; name: string;
  category_main: string; category_sub: string; has_desc: boolean;
}>(`
  SELECT p.id, p.source_matnr, p.name, p.category_main, p.category_sub,
         p.description IS NOT NULL AS has_desc
  FROM products_v2 p
  WHERE p.id = ANY($1)
  ORDER BY p.category_main, p.category_sub
`, [[...neighborIds]]);

const withDesc = details.filter(d => d.has_desc).length;
const withoutDesc = details.filter(d => !d.has_desc).length;

console.log(`With description already:  ${withDesc}`);
console.log(`Without description (backfill): ${withoutDesc}`);

// Category breakdown
const catMap = new Map<string, { total: number; without: number }>();
for (const r of details) {
  const key = `${r.category_main} / ${r.category_sub}`;
  const c = catMap.get(key) ?? { total: 0, without: 0 };
  c.total++;
  if (!r.has_desc) c.without++;
  catMap.set(key, c);
}

console.log("\n─────────────────────────────────────────────────────────");
console.log("Kategorie                                          total  bez desc");
console.log("─────────────────────────────────────────────────────────");
[...catMap.entries()]
  .sort((a, b) => b[1].without - a[1].without)
  .forEach(([k, v]) => {
    console.log(`  ${k.padEnd(50)} ${String(v.total).padStart(5)}  ${String(v.without).padStart(6)}`);
  });

// Save IDs for use by backfill script
const outputPath = "/tmp/backfill-target-ids.json";
writeFileSync(outputPath, JSON.stringify([...neighborIds]));
console.log(`\nIDs uloženy do: ${outputPath}`);
console.log(`Celkem k backfillu: ${withoutDesc} produktů\n`);

await client.end();
