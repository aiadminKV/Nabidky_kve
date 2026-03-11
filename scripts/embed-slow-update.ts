/**
 * Slowly copy embeddings from product_embeddings → products.embedding
 *
 * Pure SKU cursor approach — no IS NULL checks, no full table scans.
 * Saves cursor to a local file for resume capability.
 *
 * Usage:  cd backend && npx tsx ../scripts/embed-slow-update.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
const require = createRequire(
  resolve(import.meta.dirname, "../backend/package.json"),
);
const pg = require("pg") as typeof import("pg");
import fs from "node:fs";

const BATCH = 1000;
const PAUSE_MS = 2000;
const CURSOR_FILE = resolve(import.meta.dirname, "../.embed-update-cursor");

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("❌  SUPABASE_DB_URL not set");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  console.log("\n🔌 Connecting...");
  await client.connect();
  await client.query("SET statement_timeout = '60s'");

  // Total count
  const {
    rows: [{ total }],
  } = await client.query<{ total: string }>(
    "SELECT COUNT(*) AS total FROM product_embeddings",
  );
  const totalNum = parseInt(total);

  // Resume cursor
  let lastSku = "";
  if (fs.existsSync(CURSOR_FILE)) {
    lastSku = fs.readFileSync(CURSOR_FILE, "utf-8").trim();
    console.log(`   Resuming from SKU: ${lastSku}`);
  }

  // Count already done (SKUs <= cursor)
  let doneNum = 0;
  if (lastSku) {
    const {
      rows: [{ cnt }],
    } = await client.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM product_embeddings WHERE sku <= $1",
      [lastSku],
    );
    doneNum = parseInt(cnt);
  }

  const remaining = totalNum - doneNum;
  console.log(`   Total: ${fmt(totalNum)}`);
  console.log(`   Already done: ${fmt(doneNum)}`);
  console.log(`   Remaining: ${fmt(remaining)}`);
  console.log(`   Batch: ${BATCH}, pause: ${PAUSE_MS}ms\n`);

  if (remaining <= 0) {
    console.log("✅ All products already updated.");
    fs.unlinkSync(CURSOR_FILE);
    await client.end();
    return;
  }

  let updated = 0;
  let batchNum = 0;
  const startTime = Date.now();

  let currentBatch = BATCH;

  while (true) {
    batchNum++;
    const t0 = Date.now();

    let res;
    try {
      res = await client.query(
        `UPDATE products p
         SET embedding = sub.embedding
         FROM (
           SELECT pe.sku, pe.embedding
           FROM product_embeddings pe
           WHERE pe.sku > $1
           ORDER BY pe.sku
           LIMIT $2
         ) sub
         WHERE p.sku = sub.sku`,
        [lastSku, currentBatch],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout") && currentBatch > 100) {
        // Halve batch size and retry
        currentBatch = Math.floor(currentBatch / 2);
        console.log(`  ⚠️  Timeout — reducing batch to ${currentBatch}, retrying...`);
        await sleep(3000);
        batchNum--;
        continue;
      }
      throw err;
    }

    if (res.rowCount === 0) break;

    // After success, gradually restore batch size
    if (currentBatch < BATCH) {
      currentBatch = Math.min(BATCH, currentBatch + 100);
    }

    updated += res.rowCount!;
    const ms = Date.now() - t0;

    // Advance cursor
    const {
      rows: [{ max_sku }],
    } = await client.query<{ max_sku: string }>(
      `SELECT sku AS max_sku FROM product_embeddings WHERE sku > $1 ORDER BY sku LIMIT 1 OFFSET $2`,
      [lastSku, currentBatch - 1],
    );
    lastSku = max_sku;

    // Save cursor
    fs.writeFileSync(CURSOR_FILE, lastSku);

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = updated / elapsed;
    const eta = rate > 0 ? Math.ceil((remaining - updated) / rate / 60) : "?";
    const pct = ((updated / remaining) * 100).toFixed(1);

    console.log(
      `  #${batchNum}: ${res.rowCount} rows in ${ms}ms | ${fmt(updated)}/${fmt(remaining)} (${pct}%) | ETA=${eta}min`,
    );

    await sleep(PAUSE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Done in ${elapsed} min — updated ${fmt(updated)} products`);

  // Cleanup cursor file
  if (fs.existsSync(CURSOR_FILE)) fs.unlinkSync(CURSOR_FILE);

  // Verify
  const {
    rows: [{ cnt }],
  } = await client.query<{ cnt: string }>(
    "SELECT COUNT(embedding) AS cnt FROM products",
  );
  console.log(`📊 Products with embedding: ${fmt(parseInt(cnt))}/${fmt(totalNum)}`);

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
