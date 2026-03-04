/**
 * Phase 2: Import embeddings from embeddings.jsonl into the database.
 *
 * Uses PostgreSQL COPY via a temp table - fastest possible bulk import,
 * no PostgREST, no statement timeouts.
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-import.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
const require = createRequire(resolve(import.meta.dirname, "../backend/package.json"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require("pg") as typeof import("pg");

import fs from "node:fs";
import readline from "node:readline";

const INPUT_FILE = resolve(import.meta.dirname, "../embeddings.jsonl");
const CHUNK_SIZE = 500; // rows per UPDATE statement

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
    console.error("    Run embed-generate.ts first.");
    process.exit(1);
  }

  const stats = fs.statSync(INPUT_FILE);
  console.log(`\n📥 embed-import`);
  console.log(`   Input: ${INPUT_FILE} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

  const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    // Count lines
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

    // Create temp table
    await client.query(`SET statement_timeout = 0`);
    await client.query(`SET lock_timeout = 0`);
    await client.query(`
      CREATE TEMP TABLE _embedding_import (
        id   UUID PRIMARY KEY,
        emb  TEXT NOT NULL
      ) ON COMMIT DROP
    `);

    // Stream JSONL → temp table in chunks
    const rl = readline.createInterface({
      input: fs.createReadStream(INPUT_FILE),
      crlfDelay: Infinity,
    });

    let chunk: Array<{ id: string; emb: string }> = [];
    let imported = 0;
    let errors = 0;
    const startTime = Date.now();

    const flushChunk = async () => {
      if (chunk.length === 0) return;

      // INSERT chunk into temp table using unnest
      const ids  = chunk.map((r) => r.id);
      const embs = chunk.map((r) => r.emb);

      try {
        await client.query(`
          INSERT INTO _embedding_import (id, emb)
          SELECT unnest($1::uuid[]), unnest($2::text[])
          ON CONFLICT (id) DO UPDATE SET emb = EXCLUDED.emb
        `, [ids, embs]);
        imported += chunk.length;
      } catch (err: any) {
        console.error(`  ❌ Insert chunk error: ${err.message}`);
        errors += chunk.length;
      }

      if (imported % (CHUNK_SIZE * 20) === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = imported / elapsed;
        const eta = rate > 0 ? Math.ceil((totalLines - imported) / rate / 60) : 0;
        console.log(`  [${fmt(imported)}/${fmt(totalLines)}]  rate=${rate.toFixed(0)}/s  ETA=${eta}min`);
      }

      chunk = [];
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const { id, embedding } = JSON.parse(line);
        chunk.push({ id, emb: `[${(embedding as number[]).join(",")}]` });
        if (chunk.length >= CHUNK_SIZE) await flushChunk();
      } catch {
        errors++;
      }
    }
    await flushChunk(); // flush remainder

    console.log(`\n  ✅ ${fmt(imported)} records loaded into temp table`);
    console.log("  🔄 Updating products table...");

    // Bulk UPDATE from temp table - single statement, fastest possible
    const { rowCount } = await client.query(`
      UPDATE products AS p
      SET embedding = i.emb::vector
      FROM _embedding_import AS i
      WHERE p.id = i.id
    `);

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n✅ Import done in ${elapsed} min`);
    console.log(`   Updated rows: ${fmt(rowCount ?? 0)}`);
    console.log(`   Errors:       ${errors}`);

    // Verify
    const { rows: [{ withEmb }] } = await client.query<{ withEmb: string }>(
      `SELECT COUNT(*) AS "withEmb" FROM products WHERE embedding IS NOT NULL`,
    );
    console.log(`\n📊 Products with embedding: ${fmt(parseInt(withEmb))}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
