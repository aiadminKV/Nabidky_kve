/**
 * Import 256-dim embeddings from embeddings-256.jsonl into Supabase.
 *
 * Matches by SKU (not UUID). Uses direct pg connection with no statement timeout.
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-csv-import.ts
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
import readline from "node:readline";

const INPUT_FILE = resolve(import.meta.dirname, "../embeddings-256.jsonl");
const CHUNK_SIZE = 500;

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("❌  SUPABASE_DB_URL not set in .env");
    console.error(
      "    Add it from Supabase Dashboard → Settings → Database → Connection string (Session mode)",
    );
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  File not found: ${INPUT_FILE}`);
    console.error("    Run embed-csv-generate.ts first.");
    process.exit(1);
  }

  const stats = fs.statSync(INPUT_FILE);
  console.log(`\n📥 embed-csv-import (SKU-based matching)`);
  console.log(
    `   Input: ${INPUT_FILE} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
  );

  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
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
    console.log(`   Records to import: ${fmt(totalLines)}\n`);

    await client.query(`SET statement_timeout = 0`);
    await client.query(`SET lock_timeout = 0`);

    // Create temp table keyed by SKU
    await client.query(`
      CREATE TEMP TABLE _emb_import (
        sku  TEXT PRIMARY KEY,
        emb  TEXT NOT NULL
      ) ON COMMIT DROP
    `);

    const rl = readline.createInterface({
      input: fs.createReadStream(INPUT_FILE),
      crlfDelay: Infinity,
    });

    let chunk: Array<{ sku: string; emb: string }> = [];
    let imported = 0;
    let errors = 0;
    const startTime = Date.now();

    const flushChunk = async () => {
      if (chunk.length === 0) return;

      const skus = chunk.map((r) => r.sku);
      const embs = chunk.map((r) => r.emb);

      try {
        await client.query(
          `
          INSERT INTO _emb_import (sku, emb)
          SELECT unnest($1::text[]), unnest($2::text[])
          ON CONFLICT (sku) DO UPDATE SET emb = EXCLUDED.emb
        `,
          [skus, embs],
        );
        imported += chunk.length;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Insert chunk error: ${msg}`);
        errors += chunk.length;
      }

      if (imported % (CHUNK_SIZE * 20) === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = imported / elapsed;
        const eta =
          rate > 0 ? Math.ceil((totalLines - imported) / rate / 60) : 0;
        console.log(
          `  [${fmt(imported)}/${fmt(totalLines)}]  rate=${rate.toFixed(0)}/s  ETA=${eta}min`,
        );
      }

      chunk = [];
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const { sku, embedding } = JSON.parse(line);
        chunk.push({
          sku,
          emb: `[${(embedding as number[]).join(",")}]`,
        });
        if (chunk.length >= CHUNK_SIZE) await flushChunk();
      } catch {
        errors++;
      }
    }
    await flushChunk();

    console.log(`\n  ✅ ${fmt(imported)} records loaded into temp table`);
    console.log("  🔄 Updating products table (matching by SKU)...");

    const { rowCount } = await client.query(`
      UPDATE products AS p
      SET embedding = i.emb::vector
      FROM _emb_import AS i
      WHERE p.sku = i.sku
    `);

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n✅ Import done in ${elapsed} min`);
    console.log(`   Updated rows: ${fmt(rowCount ?? 0)}`);
    console.log(`   Errors:       ${errors}`);

    const {
      rows: [{ total, withEmb }],
    } = await client.query<{ total: string; withEmb: string }>(
      `SELECT COUNT(*) AS total, COUNT(embedding) AS "withEmb" FROM products`,
    );
    console.log(
      `\n📊 Products: ${fmt(parseInt(total))} total, ${fmt(parseInt(withEmb))} with embedding`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
