/**
 * Quick test: generate a query embedding (256 dims, text-embedding-3-small)
 * and compare against our 100 test embeddings from embeddings-256.jsonl.
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/test-semantic-256.ts "jistič 3P B16"
 *   cd backend && npx tsx ../scripts/test-semantic-256.ts "LED svítidlo průmyslové"
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import fs from "node:fs";
import readline from "node:readline";

const EMBEDDINGS_FILE = resolve(import.meta.dirname, "../embeddings-256.jsonl");
const MODEL = "text-embedding-3-small";
const DIMS = 256;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error("Usage: npx tsx ../scripts/test-semantic-256.ts \"query\"");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Load embeddings
  const products: Array<{ sku: string; embedding: number[] }> = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(EMBEDDINGS_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    products.push(JSON.parse(line));
  }

  console.log(`Loaded ${products.length} product embeddings`);
  console.log(`Query: "${query}"`);
  console.log(`Model: ${MODEL} @ ${DIMS} dims\n`);

  // Generate query embedding
  const resp = await openai.embeddings.create({
    model: MODEL,
    dimensions: DIMS,
    input: query,
  });
  const queryEmb = resp.data[0].embedding;

  // Compute similarities
  const results = products
    .map((p) => ({
      sku: p.sku,
      similarity: cosineSimilarity(queryEmb, p.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);

  console.log("Top 10 results:");
  for (const r of results) {
    console.log(`  SKU: ${r.sku}  similarity: ${r.similarity.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
