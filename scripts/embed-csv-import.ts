/**
 * Import 256-dim embeddings via Supabase REST API (PostgREST).
 *
 * INSERTs into a clean `product_embeddings` table using parallel HTTP requests.
 * Much faster than pg COPY/UPDATE because PostgREST batch insert into empty table is optimized.
 *
 * Usage:  cd backend && npx tsx ../scripts/embed-csv-import.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
const require = createRequire(
  resolve(import.meta.dirname, "../backend/package.json"),
);
const { createClient } = require("@supabase/supabase-js");

import fs from "node:fs";
import readline from "node:readline";

const INPUT_FILE = resolve(import.meta.dirname, "../embeddings-256.jsonl");
const BATCH_SIZE = 100;
const CONCURRENCY = 8;

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("❌  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  const stats = fs.statSync(INPUT_FILE);
  console.log(`\n📥 embed-import (REST API, batch=${BATCH_SIZE}, concurrency=${CONCURRENCY})`);
  console.log(`   Input: ${(stats.size / 1024 / 1024).toFixed(0)} MB\n`);

  // Count lines
  console.log("   Counting...");
  let totalLines = 0;
  {
    const c = readline.createInterface({
      input: fs.createReadStream(INPUT_FILE),
      crlfDelay: Infinity,
    });
    for await (const l of c) {
      if (l.trim()) totalLines++;
    }
  }
  console.log(`   Records: ${fmt(totalLines)}\n`);

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  let inserted = 0;
  let errors = 0;
  const startTime = Date.now();
  let lastLog = Date.now();

  let batch: Array<{ sku: string; embedding: string }> = [];
  const inflight = new Set<Promise<void>>();

  const sendBatch = (items: typeof batch): Promise<void> => {
    return supabase
      .from("product_embeddings")
      .insert(items)
      .then((res: { error: unknown }) => {
        if (res.error) {
          const msg =
            typeof res.error === "object" && res.error !== null
              ? (res.error as Record<string, unknown>).message || JSON.stringify(res.error)
              : String(res.error);
          console.error(`  ❌ Insert error: ${msg}`);
          errors += items.length;
        } else {
          inserted += items.length;
        }
      })
      .catch((err: unknown) => {
        console.error(`  ❌ Fetch error: ${err instanceof Error ? err.message : err}`);
        errors += items.length;
      });
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      // Fast string extraction (no full JSON.parse of 256-float array)
      const skuStart = line.indexOf('"sku":"') + 7;
      const skuEnd = line.indexOf('"', skuStart);
      const sku = line.substring(skuStart, skuEnd);

      const embStart = line.indexOf('"embedding":') + 12;
      const embEnd = line.lastIndexOf("]") + 1;
      const embedding = line.substring(embStart, embEnd);

      batch.push({ sku, embedding });
    } catch {
      errors++;
      continue;
    }

    if (batch.length >= BATCH_SIZE) {
      // Wait for a slot if at max concurrency
      if (inflight.size >= CONCURRENCY) {
        await Promise.race(inflight);
      }

      const items = batch;
      batch = [];
      const p = sendBatch(items).finally(() => inflight.delete(p));
      inflight.add(p);

      // Progress logging
      if (Date.now() - lastLog > 3000) {
        const done = inserted + errors;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = done / elapsed;
        const pct = ((done / totalLines) * 100).toFixed(1);
        const eta = rate > 0 ? Math.ceil((totalLines - done) / rate / 60) : "?";
        console.log(
          `  [${fmt(done)}/${fmt(totalLines)}] ${pct}%  ${fmt(Math.round(rate))}/s  ETA=${eta}min  err=${errors}`,
        );
        lastLog = Date.now();
      }
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
    const p = sendBatch(batch).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Import done in ${elapsed} min`);
  console.log(`   Inserted: ${fmt(inserted)}`);
  console.log(`   Errors:   ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
