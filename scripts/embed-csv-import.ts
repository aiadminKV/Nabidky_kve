/**
 * Import 256-dim embeddings via PostgreSQL COPY protocol.
 *
 * 1. Creates staging table _emb_staging
 * 2. Streams data via COPY (fastest bulk insert)
 * 3. Single UPDATE join into products
 * 4. Drops staging table
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
const pg = require("pg") as typeof import("pg");
const { from: copyFrom } =
  require("pg-copy-streams") as typeof import("pg-copy-streams");

import fs from "node:fs";
import readline from "node:readline";
import { Readable } from "node:stream";

const INPUT_FILE = resolve(import.meta.dirname, "../embeddings-256.jsonl");

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("❌  SUPABASE_DB_URL not set in .env");
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const stats = fs.statSync(INPUT_FILE);
  console.log(`\n📥 embed-csv-import (COPY protocol)`);
  console.log(
    `   Input: ${INPUT_FILE} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
  );

  // --- Count records ---
  console.log("   Counting records...");
  let totalLines = 0;
  {
    const counter = readline.createInterface({
      input: fs.createReadStream(INPUT_FILE),
      crlfDelay: Infinity,
    });
    for await (const line of counter) {
      if (line.trim()) totalLines++;
    }
  }
  console.log(`   Records: ${fmt(totalLines)}\n`);

  // --- Connect ---
  console.log("🔌 Connecting to database...");
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 0,
  });
  await client.connect();
  console.log("   Connected!\n");

  // No statement timeout for this session
  await client.query("SET statement_timeout = 0");

  // --- Step 1: Create staging table ---
  console.log("📦 Step 1/4: Creating staging table...");
  await client.query("DROP TABLE IF EXISTS _emb_staging");
  await client.query(
    "CREATE UNLOGGED TABLE _emb_staging (sku TEXT NOT NULL, emb TEXT NOT NULL)",
  );
  console.log("   Done.\n");

  // --- Step 2: COPY data into staging ---
  console.log("🚀 Step 2/4: Streaming data via COPY...");
  const copyStream = client.query(
    copyFrom("COPY _emb_staging (sku, emb) FROM STDIN WITH (FORMAT text)"),
  );

  let streamed = 0;
  const startTime = Date.now();
  let lastLog = Date.now();

  const readable = new Readable({
    async read() {
      // We can't use readline here directly, so we'll use a generator approach
    },
  });

  // Create a transform: read JSONL → output tab-separated lines for COPY
  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  // We need to pipe data into the COPY stream
  // Use a promise-based approach
  const copyPromise = new Promise<void>((resolve, reject) => {
    copyStream.on("finish", resolve);
    copyStream.on("error", reject);
  });

  let backpressure = false;

  // Buffer writes for better throughput
  const WRITE_BUFFER_SIZE = 256;
  let writeBuf: string[] = [];

  const flushBuf = async () => {
    if (writeBuf.length === 0) return;
    const chunk = writeBuf.join("");
    writeBuf = [];
    if (!copyStream.write(chunk)) {
      await new Promise<void>((r) => copyStream.once("drain", r));
    }
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      // Fast extraction without full JSON.parse of 256-float array
      const skuStart = line.indexOf('"sku":"') + 7;
      const skuEnd = line.indexOf('"', skuStart);
      const sku = line.substring(skuStart, skuEnd);

      const embStart = line.indexOf('"embedding":') + 12;
      const embEnd = line.lastIndexOf("]") + 1;
      const vecStr = line.substring(embStart, embEnd);

      writeBuf.push(`${sku}\t${vecStr}\n`);
      streamed++;

      if (writeBuf.length >= WRITE_BUFFER_SIZE) {
        await flushBuf();
      }

      if (Date.now() - lastLog > 5000) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = streamed / elapsed;
        const pct = ((streamed / totalLines) * 100).toFixed(1);
        const eta =
          rate > 0 ? Math.ceil((totalLines - streamed) / rate / 60) : "?";
        console.log(
          `   [${fmt(streamed)}/${fmt(totalLines)}] ${pct}%  rate=${fmt(Math.round(rate))}/s  ETA=${eta}min`,
        );
        lastLog = Date.now();
      }
    } catch {
      // skip malformed lines
    }
  }
  await flushBuf();

  copyStream.end();
  await copyPromise;

  const copyElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `   ✅ COPY done: ${fmt(streamed)} rows in ${copyElapsed}s\n`,
  );

  // --- Step 3: UPDATE products from staging ---
  console.log("🔄 Step 3/4: Updating products (single UPDATE join)...");
  const updateStart = Date.now();
  const updateRes = await client.query(`
    UPDATE products p
    SET embedding = s.emb::vector
    FROM _emb_staging s
    WHERE p.sku = s.sku
  `);
  const updateElapsed = ((Date.now() - updateStart) / 1000).toFixed(1);
  console.log(
    `   ✅ Updated ${fmt(updateRes.rowCount ?? 0)} rows in ${updateElapsed}s\n`,
  );

  // --- Step 4: Cleanup ---
  console.log("🧹 Step 4/4: Dropping staging table...");
  await client.query("DROP TABLE IF EXISTS _emb_staging");
  console.log("   Done.\n");

  // --- Verify ---
  const {
    rows: [{ total, withemb }],
  } = await client.query<{ total: string; withemb: string }>(
    "SELECT COUNT(*) AS total, COUNT(embedding) AS withemb FROM products",
  );
  console.log(
    `📊 Products: ${fmt(parseInt(total))} total, ${fmt(parseInt(withemb))} with embedding`,
  );

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ All done in ${totalElapsed} min`);

  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
