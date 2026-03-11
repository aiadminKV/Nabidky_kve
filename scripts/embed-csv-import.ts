/**
 * Import 256-dim embeddings via Supabase REST API.
 * Supports RESUME — skips already inserted SKUs.
 * Low-pressure mode: concurrency=2, delay between batches.
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
const CONCURRENCY = 2;
const DELAY_MS = 200;
const MAX_RETRIES = 3;

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  // --- Load existing SKUs for resume ---
  console.log("\n📋 Loading existing SKUs for resume...");
  const existingSkus = new Set<string>();
  let offset = 0;
  const PAGE = 10000;
  while (true) {
    const { data, error } = await supabase
      .from("product_embeddings")
      .select("sku")
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("  Error loading SKUs:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data) existingSkus.add(row.sku);
    offset += data.length;
    if (data.length < PAGE) break;
  }
  console.log(`   Already inserted: ${fmt(existingSkus.size)}\n`);

  // --- Count total ---
  console.log("   Counting JSONL records...");
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
  const remaining = totalLines - existingSkus.size;
  console.log(`   Total: ${fmt(totalLines)}, remaining: ${fmt(remaining)}`);
  console.log(
    `   batch=${BATCH_SIZE}, concurrency=${CONCURRENCY}, delay=${DELAY_MS}ms\n`,
  );

  if (remaining <= 0) {
    console.log("✅ Nothing to import — all records already exist.");
    return;
  }

  // --- Import ---
  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();
  let lastLog = Date.now();

  let batch: Array<{ sku: string; embedding: string }> = [];
  const inflight = new Set<Promise<void>>();

  const sendBatch = async (items: typeof batch, attempt = 1): Promise<void> => {
    try {
      const res = await supabase.from("product_embeddings").insert(items);
      if (res.error) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * attempt);
          return sendBatch(items, attempt + 1);
        }
        console.error(`  ❌ Insert error (after ${attempt} attempts): ${res.error.message}`);
        errors += items.length;
      } else {
        inserted += items.length;
      }
    } catch (err: unknown) {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * attempt);
        return sendBatch(items, attempt + 1);
      }
      console.error(
        `  ❌ Fetch error (after ${attempt} attempts): ${err instanceof Error ? err.message : err}`,
      );
      errors += items.length;
    }
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    // Fast string extraction
    const skuStart = line.indexOf('"sku":"') + 7;
    const skuEnd = line.indexOf('"', skuStart);
    const sku = line.substring(skuStart, skuEnd);

    if (existingSkus.has(sku)) {
      skipped++;
      continue;
    }

    const embStart = line.indexOf('"embedding":') + 12;
    const embEnd = line.lastIndexOf("]") + 1;
    const embedding = line.substring(embStart, embEnd);

    batch.push({ sku, embedding });

    if (batch.length >= BATCH_SIZE) {
      if (inflight.size >= CONCURRENCY) {
        await Promise.race(inflight);
      }

      const items = batch;
      batch = [];
      const p = sendBatch(items).finally(() => inflight.delete(p));
      inflight.add(p);

      await sleep(DELAY_MS);

      if (Date.now() - lastLog > 5000) {
        const done = inserted + errors;
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = done / elapsed;
        const pct = ((done / remaining) * 100).toFixed(1);
        const eta = rate > 0 ? Math.ceil((remaining - done) / rate / 60) : "?";
        console.log(
          `  [${fmt(done)}/${fmt(remaining)}] ${pct}%  ${fmt(Math.round(rate))}/s  ETA=${eta}min  err=${errors}`,
        );
        lastLog = Date.now();
      }
    }
  }

  if (batch.length > 0) {
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
    const p = sendBatch(batch).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Import done in ${elapsed} min`);
  console.log(`   Inserted: ${fmt(inserted)}`);
  console.log(`   Skipped:  ${fmt(skipped)}`);
  console.log(`   Errors:   ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
