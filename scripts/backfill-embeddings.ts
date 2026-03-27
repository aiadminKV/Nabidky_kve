/**
 * One-off: generates embeddings for all products that don't have one yet.
 *
 * Usage: npx tsx backfill-embeddings.ts
 *        npx tsx backfill-embeddings.ts --dry-run   # just count, no writes
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import pg from "pg";
import OpenAI from "openai";

const DB_URL = process.env.SUPABASE_DB_URL!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const DRY_RUN = process.argv.includes("--dry-run");

const MODEL = "text-embedding-3-small";
const DIMS = 256;
const BATCH = 500;
const DELAY_MS = 200;
const MAX_RETRIES = 5;

function fmt(n: number): string { return n.toLocaleString("cs-CZ"); }
function elapsed(t: number): string { return `${((Date.now() - t) / 1000).toFixed(1)}s`; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function buildText(p: {
  name: string; supplier_name: string | null; search_hints: string | null;
  category_main: string | null; category_sub: string | null; category_line: string | null;
  description: string | null;
}): string {
  const lines: string[] = [p.name];
  if (p.search_hints) lines.push(`Také známo jako: ${p.search_hints}`);
  if (p.supplier_name) lines.push(`Výrobce: ${p.supplier_name}`);
  const cats = [p.category_main, p.category_sub, p.category_line].filter(Boolean);
  if (cats.length > 0) lines.push(`Kategorie: ${cats.join(" > ")}`);
  if (p.description) lines.push(`Popis: ${p.description.slice(0, 500)}`);
  return lines.join("\n");
}

async function main() {
  console.log(`\n  Backfill embeddings ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}\n`);
  const t0 = Date.now();

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Find products without embeddings
  const { rows } = await client.query<{
    id: number; sku: string; name: string; supplier_name: string | null;
    search_hints: string | null; category_main: string | null;
    category_sub: string | null; category_line: string | null;
    description: string | null;
  }>(`
    SELECT p.id, p.sku, p.name, p.supplier_name, p.search_hints,
           p.category_main, p.category_sub, p.category_line, p.description
    FROM products_v2 p
    LEFT JOIN product_embeddings_v2 pe ON pe.product_id = p.id
    WHERE pe.product_id IS NULL AND p.removed_at IS NULL
    ORDER BY p.id
  `);

  // Filter out products with empty names
  const valid = rows.filter((r) => r.name && r.name.trim().length > 0);
  const skipped = rows.length - valid.length;

  console.log(`  Missing embeddings: ${fmt(rows.length)}`);
  console.log(`  With valid name:    ${fmt(valid.length)}`);
  console.log(`  Empty name (skip):  ${fmt(skipped)}`);

  if (DRY_RUN) {
    await client.end();
    console.log("\n  DRY RUN — no embeddings generated.\n");
    return;
  }

  console.log(`\n  Starting embedding generation...\n`);

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const texts = batch.map((p) => buildText(p));
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(valid.length / BATCH);

    console.log(`  Batch ${batchNum}/${totalBatches}: generating ${batch.length} embeddings...`);

    let retries = 0;
    let success = false;

    while (retries < MAX_RETRIES && !success) {
      try {
        const resp = await openai.embeddings.create({
          model: MODEL, dimensions: DIMS, input: texts,
        });

        console.log(`  Batch ${batchNum}: OpenAI OK, writing to DB...`);

        await client.query("BEGIN");
        for (let j = 0; j < batch.length; j++) {
          const p = batch[j];
          const vec = JSON.stringify(resp.data[j].embedding);
          await client.query(
            `INSERT INTO product_embeddings_v2 (product_id, sku, embedding, embedding_text, model_version, created_at)
             VALUES ($1, $2, $3::vector, $4, 'text-embedding-3-small-256', now())
             ON CONFLICT (product_id) DO UPDATE SET
               sku = EXCLUDED.sku, embedding = EXCLUDED.embedding,
               embedding_text = EXCLUDED.embedding_text, model_version = EXCLUDED.model_version`,
            [p.id, p.sku, vec, texts[j]],
          );
        }
        await client.query("COMMIT");

        processed += batch.length;
        success = true;
        console.log(`  Batch ${batchNum}: done (${fmt(processed)} / ${fmt(valid.length)}, ${elapsed(t0)})`);
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Batch ${batchNum}: error (retry ${retries}/${MAX_RETRIES}): ${msg}`);
        if (msg.includes("rate_limit") || msg.includes("429")) {
          const wait = Math.min(2000 * Math.pow(2, retries), 120_000);
          console.log(`  Rate limited, waiting ${(wait / 1000).toFixed(0)}s...`);
          await sleep(wait);
        } else if (retries >= MAX_RETRIES) {
          await client.query("ROLLBACK").catch(() => {});
          errors += batch.length;
          processed += batch.length;
          console.log(`  Batch ${batchNum}: FAILED after ${MAX_RETRIES} retries`);
        } else {
          await client.query("ROLLBACK").catch(() => {});
          await sleep(1000 * retries);
        }
      }
    }

    await sleep(DELAY_MS);
  }

  await client.end();

  console.log(`\n  Done! ${fmt(processed)} processed, ${fmt(errors)} errors`);
  console.log(`  Time: ${elapsed(t0)}\n`);
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message}\n`);
  process.exit(1);
});
