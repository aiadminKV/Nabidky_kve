/**
 * Check rank of a SKU in Supabase semantic search.
 * Usage: npx tsx backend/scripts/_check-supabase-rank.ts "query" SKU [limit]
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const { generateQueryEmbedding } = await import("../src/services/embedding.js");
const { searchProductsSemantic } = await import("../src/services/search.js");

const query = process.argv[2] ?? "Datový kabel UTP CAT6 LSOH";
const targetSku = process.argv[3] ?? "1132208";
const limit = parseInt(process.argv[4] ?? "50", 10);

console.log(`Query: "${query}"`);
console.log(`Looking for SKU: ${targetSku} in SB top-${limit}\n`);

const embedding = await generateQueryEmbedding(query);
const results = await searchProductsSemantic(embedding, limit, 0.0);

const targetIdx = results.findIndex((r) => r.sku === targetSku);

if (targetIdx === -1) {
  console.log(`SKU ${targetSku} NOT found in Supabase top-${limit}`);
} else {
  const hit = results[targetIdx]!;
  console.log(`Supabase rank: #${targetIdx + 1} | score: ${hit.cosine_similarity?.toFixed(4)}`);
}

console.log("\nTop-10 Supabase results:");
results.slice(0, 10).forEach((r, i) => {
  const mark = r.sku === targetSku ? " ← TARGET" : "";
  console.log(`  #${i + 1}  ${String(r.sku).padEnd(14)} ${String(r.name).slice(0, 40).padEnd(42)} ${r.cosine_similarity?.toFixed(4)}${mark}`);
});
