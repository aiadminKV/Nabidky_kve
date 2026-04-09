/**
 * One-time fix: recreate the supplier_name payload index as a full-text index.
 *
 * The previous migration may have created a keyword index (or no index at all),
 * causing match:{text:"..."} queries to return 0 results.
 * This script deletes the old index and creates the correct text index.
 * No re-embedding needed — only payload re-indexing.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import * as dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(process.cwd(), "../.env") });

const COLLECTION_NAME = "products_v2_large";
const FIELD = "supplier_name";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const qdrant = new QdrantClient({ url: QDRANT_URL, ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}), checkCompatibility: false });

async function main() {
  console.log(`Qdrant: ${QDRANT_URL}`);
  console.log(`Collection: ${COLLECTION_NAME}`);
  console.log(`Field: ${FIELD}`);
  console.log("");

  // 1. Check collection exists
  try {
    const info = await qdrant.getCollection(COLLECTION_NAME);
    console.log(`Collection found. Points: ${info.points_count?.toLocaleString() ?? "?"}`);
  } catch {
    console.error(`Collection "${COLLECTION_NAME}" not found. Aborting.`);
    process.exit(1);
  }

  // 2. Delete old index (if any)
  console.log(`\nDeleting old "${FIELD}" index (if exists)...`);
  try {
    await qdrant.deletePayloadIndex(COLLECTION_NAME, FIELD);
    console.log("Old index deleted.");
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found") || msg.includes("404") || msg.includes("doesn't exist")) {
      console.log("No existing index found — skipping delete.");
    } else {
      console.warn(`Warning during delete: ${msg}`);
    }
  }

  // 3. Create new text index
  console.log(`\nCreating text index on "${FIELD}" (word tokenizer, lowercase)...`);
  await qdrant.createPayloadIndex(COLLECTION_NAME, {
    field_name: FIELD,
    field_schema: {
      type: "text",
      tokenizer: "word",
      lowercase: true,
    } as any,
  });
  console.log("Text index created successfully.");

  // 4. Quick smoke test
  console.log("\nSmoke test — searching for 'ABB' in supplier_name...");
  const testFilter = {
    must: [
      { key: "supplier_name", match: { text: "ABB" } },
      { key: "removed", match: { value: false } },
    ],
  };
  const testVector = new Array(512).fill(0.0);
  const testResults = await qdrant.search(COLLECTION_NAME, {
    vector: testVector,
    limit: 3,
    filter: testFilter,
    with_payload: ["sku", "name", "supplier_name"],
  });
  if (testResults.length === 0) {
    console.log("WARNING: Smoke test returned 0 results — index may still be building (large collections take a moment).");
  } else {
    console.log(`Smoke test OK — got ${testResults.length} result(s):`);
    for (const r of testResults) {
      const p = r.payload as any;
      console.log(`  SKU: ${p.sku} | ${p.name} | ${p.supplier_name}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => { console.error(err); process.exit(1); });
