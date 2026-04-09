/**
 * Checks what score and rank a specific SKU gets for a query.
 * Usage: npx tsx backend/scripts/_check-score.ts "query text" SKU [limit]
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QdrantClient } from "@qdrant/js-client-rest";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const { generateQueryEmbedding } = await import("../src/services/embedding.js");

const query = process.argv[2] ?? "Datový kabel UTP CAT6 LSOH";
const targetSku = process.argv[3] ?? "1132208";
const limit = parseInt(process.argv[4] ?? "200", 10);

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? "http://localhost:6333",
  checkCompatibility: false,
});

console.log(`Query: "${query}"`);
console.log(`Looking for SKU: ${targetSku} in top-${limit}\n`);

const embedding = await generateQueryEmbedding(query);

const results = await qdrant.search("products_v2", {
  vector: embedding,
  limit,
  score_threshold: 0.0,
  with_payload: ["sku", "name", "is_stock_item", "supplier_name", "category_main"],
});

const targetIdx = results.findIndex((r) => r.payload?.["sku"] === targetSku);

if (targetIdx === -1) {
  console.log(`SKU ${targetSku} NOT found in top-${limit}`);
} else {
  const hit = results[targetIdx]!;
  console.log(`SKU ${targetSku} rank: #${targetIdx + 1} | score: ${hit.score.toFixed(4)}`);
  console.log(`  Name: ${hit.payload?.["name"]}`);
  console.log(`  Supplier: ${hit.payload?.["supplier_name"]}`);
  console.log(`  Stock: ${hit.payload?.["is_stock_item"]}`);
}

console.log("\nTop-10 results:");
results.slice(0, 10).forEach((r, i) => {
  const mark = r.payload?.["sku"] === targetSku ? " ← TARGET" : "";
  console.log(
    `  #${i + 1}  ${String(r.payload?.["sku"]).padEnd(14)} ${String(r.payload?.["name"]).slice(0, 40).padEnd(42)} ${r.score.toFixed(4)}${mark}`,
  );
});
