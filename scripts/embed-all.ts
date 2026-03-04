/**
 * Bulk embedding generator - runs overnight, processes entire catalog.
 *
 * Uses direct Postgres connection (bypasses Supabase PostgREST timeouts).
 * Processes BATCH_SIZE products per cycle, filters WHERE embedding IS NULL.
 * Fully resumable - safe to kill and restart at any time.
 *
 * Setup: add SUPABASE_DB_URL to .env
 *   Format: postgresql://postgres.[project-ref]:[password]@aws-0-eu-north-1.pooler.supabase.com:6543/postgres
 *   Find it in: Supabase Dashboard → Settings → Database → Connection string (Transaction mode)
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-all.ts
 *   cd backend && npx tsx ../scripts/embed-all.ts --batch=30 --delay=500
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
const require = createRequire(resolve(import.meta.dirname, "../backend/package.json"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require("pg") as typeof import("pg");
import OpenAI from "openai";

const { Pool } = pg;

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE = parseInt(getArg("batch") ?? "30");
const DELAY_MS   = parseInt(getArg("delay")  ?? "400");

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIM   = 1536;
const DESC_MAX        = 500;
const LOG_EVERY       = 10; // print status every N batches

// ── Helpers ───────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function buildEmbeddingText(p: Record<string, string | null>): string {
  const lines: string[] = [p.name ?? ""];
  if (p.name_secondary) lines.push(p.name_secondary);

  const mfr = [
    p.manufacturer ? `Výrobce: ${p.manufacturer}` : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ].filter(Boolean).join(" | ");
  if (mfr) lines.push(mfr);

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length) lines.push(`Kategorie: ${cats.join(" > ")}`);

  if (p.description) lines.push(`Popis: ${p.description.slice(0, DESC_MAX)}`);

  return lines.join("\n");
}

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error(`
❌  SUPABASE_DB_URL not set in .env

Add it from: Supabase Dashboard → Settings → Database → Connection string (Transaction mode)
Format: postgresql://postgres.[ref]:[password]@aws-0-eu-north-1.pooler.supabase.com:6543/postgres
    `);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  // Disable statement timeout for all connections in the pool
  pool.on("connect", (client) => {
    client.query("SET statement_timeout = 0; SET lock_timeout = 0;").catch(() => {});
  });

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Check total remaining
  const { rows: [{ remaining }] } = await pool.query<{ remaining: string }>(
    `SELECT COUNT(*) AS remaining FROM products WHERE embedding IS NULL`,
  );
  const total = parseInt(remaining);
  console.log(`\n🚀 embed-all: ${fmt(total)} products to embed`);
  console.log(`   batch=${BATCH_SIZE}  delay=${DELAY_MS}ms  model=${EMBEDDING_MODEL}`);

  if (total === 0) {
    console.log("✅ All products already have embeddings.");
    await pool.end();
    return;
  }

  const estMinutes = Math.ceil((total / BATCH_SIZE) * (DELAY_MS + 5000) / 60_000);
  console.log(`   Estimated time: ~${estMinutes} minutes\n`);

  let processed = 0;
  let errors = 0;
  let batchNum = 0;
  const startTime = Date.now();

  while (true) {
    // Fetch next batch directly from Postgres
    const { rows: products } = await pool.query<Record<string, string | null>>(`
      SELECT id, sku, name, name_secondary, description,
             manufacturer_code, manufacturer,
             category, subcategory, sub_subcategory
      FROM products
      WHERE embedding IS NULL
      LIMIT $1
    `, [BATCH_SIZE]);

    if (products.length === 0) break;

    batchNum++;

    // Build embedding texts
    const texts = products.map(buildEmbeddingText);

    // Call OpenAI
    let embeddings: number[][];
    try {
      const resp = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIM,
        input: texts,
      });
      embeddings = resp.data.map((d) => d.embedding);
    } catch (err: any) {
      const msg: string = err.message ?? String(err);
      console.error(`  ❌ OpenAI error: ${msg}`);
      errors += products.length;

      if (msg.includes("rate_limit")) {
        console.log("  ⏳ Rate limited – waiting 60s...");
        await sleep(60_000);
        batchNum--; // retry same batch
        continue;
      }

      await sleep(DELAY_MS);
      continue;
    }

    // Write in small chunks to stay within any DB limits
    const SAVE_CHUNK = 20;
    let batchErrors = 0;
    for (let j = 0; j < products.length; j += SAVE_CHUNK) {
      const chunk    = products.slice(j, j + SAVE_CHUNK);
      const chunkEmb = embeddings.slice(j, j + SAVE_CHUNK);
      const ids      = chunk.map((p) => p.id);
      const vectors  = chunkEmb.map((e) => `[${e.join(",")}]`);

      try {
        await pool.query(`
          UPDATE products AS p
          SET embedding = v.emb::vector
          FROM (
            SELECT unnest($1::uuid[]) AS id,
                   unnest($2::text[]) AS emb
          ) AS v
          WHERE p.id = v.id
        `, [ids, vectors]);
      } catch (err: any) {
        console.error(`  ❌ DB chunk error: ${err.message}`);
        batchErrors += chunk.length;
      }

      if (j + SAVE_CHUNK < products.length) await sleep(50);
    }
    errors += batchErrors;
    processed += products.length;

    // Progress log
    if (batchNum % LOG_EVERY === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining2 = total - processed;
      const etaSec = rate > 0 ? Math.round(remaining2 / rate) : 0;
      const etaMin = Math.ceil(etaSec / 60);
      console.log(
        `  [${fmt(processed)}/${fmt(total)}]  errors=${errors}  ` +
        `rate=${rate.toFixed(1)}/s  ETA=${etaMin}min`,
      );
    }

    await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Done in ${elapsed} min`);
  console.log(`   Processed: ${fmt(processed)}`);
  console.log(`   Errors:    ${errors}`);
  console.log(`   Remaining: ${fmt(total - processed)}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
