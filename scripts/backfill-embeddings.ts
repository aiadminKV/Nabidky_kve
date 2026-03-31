/**
 * Generates embeddings for products that are missing them or have stale ones.
 *
 * Usage:
 *   npx tsx backfill-embeddings.ts              # products with no embedding
 *   npx tsx backfill-embeddings.ts --stale      # products where embedding text ≠ current name
 *   npx tsx backfill-embeddings.ts --dry-run    # just count, no writes
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import pg from "pg";
import OpenAI from "openai";

const DB_URL = process.env.SUPABASE_DB_URL!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const DRY_RUN = process.argv.includes("--dry-run");
const STALE = process.argv.includes("--stale");

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

function makePgClient(): pg.Client {
  return new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

async function main() {
  const mode = STALE ? "stale" : "missing";
  console.log(`\n  Backfill embeddings — mode: ${mode} ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}\n`);
  const t0 = Date.now();

  const queryClient = makePgClient();
  await queryClient.connect();

  type ProductRow = {
    id: number; sku: string; name: string; supplier_name: string | null;
    search_hints: string | null; category_main: string | null;
    category_sub: string | null; category_line: string | null;
    description: string | null;
  };

  let rows: ProductRow[];

  if (STALE) {
    // Products that have an embedding but whose name has changed since it was generated
    ({ rows } = await queryClient.query<ProductRow>(`
      SELECT p.id, p.sku, p.name, p.supplier_name, p.search_hints,
             p.category_main, p.category_sub, p.category_line, p.description
      FROM products_v2 p
      JOIN product_embeddings_v2 e ON e.product_id = p.id
      WHERE p.removed_at IS NULL
        AND p.name IS NOT NULL AND p.name != ''
        AND split_part(e.embedding_text, E'\\n', 1) != p.name
      ORDER BY p.id
    `));
    console.log(`  Stale embeddings (name changed): ${fmt(rows.length)}`);
  } else {
    // Products with no embedding at all
    ({ rows } = await queryClient.query<ProductRow>(`
      SELECT p.id, p.sku, p.name, p.supplier_name, p.search_hints,
             p.category_main, p.category_sub, p.category_line, p.description
      FROM products_v2 p
      LEFT JOIN product_embeddings_v2 pe ON pe.product_id = p.id
      WHERE pe.product_id IS NULL AND p.removed_at IS NULL
      ORDER BY p.id
    `));

    const valid = rows.filter((r) => r.name && r.name.trim().length > 0);
    const skipped = rows.length - valid.length;
    console.log(`  Missing embeddings: ${fmt(rows.length)}`);
    console.log(`  With valid name:    ${fmt(valid.length)}`);
    console.log(`  Empty name (skip):  ${fmt(skipped)}`);
    rows = valid;
  }

  await queryClient.end();

  if (DRY_RUN) {
    console.log("\n  DRY RUN — no embeddings generated.\n");
    return;
  }

  if (rows.length === 0) {
    console.log("\n  Nothing to do.\n");
    return;
  }

  console.log(`\n  Starting embedding generation...\n`);

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const texts = batch.map((p) => buildText(p));
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(rows.length / BATCH);

    console.log(`  Batch ${batchNum}/${totalBatches}: generating ${batch.length} embeddings...`);

    let retries = 0;
    let success = false;

    while (retries < MAX_RETRIES && !success) {
      try {
        const resp = await openai.embeddings.create({
          model: MODEL, dimensions: DIMS, input: texts,
        });

        console.log(`  Batch ${batchNum}: OpenAI OK, writing to DB...`);

        // Fresh pg connection per batch — prevents ETIMEDOUT on long runs
        const writeClient = makePgClient();
        await writeClient.connect();
        try {
          await writeClient.query("BEGIN");
          for (let j = 0; j < batch.length; j++) {
            const p = batch[j];
            const vec = JSON.stringify(resp.data[j].embedding);
            await writeClient.query(
              `INSERT INTO product_embeddings_v2 (product_id, sku, embedding, embedding_text, model_version, created_at)
               VALUES ($1, $2, $3::vector, $4, 'text-embedding-3-small-256', now())
               ON CONFLICT (product_id) DO UPDATE SET
                 sku = EXCLUDED.sku, embedding = EXCLUDED.embedding,
                 embedding_text = EXCLUDED.embedding_text, model_version = EXCLUDED.model_version`,
              [p.id, p.sku, vec, texts[j]],
            );
          }
          await writeClient.query("COMMIT");
        } catch (pgErr) {
          await writeClient.query("ROLLBACK").catch(() => {});
          throw pgErr;
        } finally {
          await writeClient.end();
        }

        processed += batch.length;
        success = true;
        console.log(`  Batch ${batchNum}: done (${fmt(processed)} / ${fmt(rows.length)}, ${elapsed(t0)})`);
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Batch ${batchNum}: error (retry ${retries}/${MAX_RETRIES}): ${msg}`);
        if (msg.includes("rate_limit") || msg.includes("429")) {
          const wait = Math.min(2000 * Math.pow(2, retries), 120_000);
          console.log(`  Rate limited, waiting ${(wait / 1000).toFixed(0)}s...`);
          await sleep(wait);
        } else if (retries >= MAX_RETRIES) {
          errors += batch.length;
          console.log(`  Batch ${batchNum}: FAILED after ${MAX_RETRIES} retries`);
        } else {
          await sleep(1000 * retries);
        }
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n  Done! ${fmt(processed)} processed, ${fmt(errors)} errors`);
  console.log(`  Time: ${elapsed(t0)}\n`);
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message}\n`);
  process.exit(1);
});
