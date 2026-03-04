/**
 * Phase 2: Read products.jsonl, generate embeddings, save to embeddings.jsonl.
 *
 * NO Supabase connection - runs fully offline from Supabase.
 * Resumable: skips IDs already present in embeddings.jsonl.
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-generate.ts
 *   cd backend && npx tsx ../scripts/embed-generate.ts --batch=100 --delay=300
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import fs from "node:fs";
import readline from "node:readline";

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE  = parseInt(getArg("batch") ?? "100");
const DELAY_MS    = parseInt(getArg("delay") ?? "300");

const INPUT_FILE  = resolve(import.meta.dirname, "../products.jsonl");
const OUTPUT_FILE = resolve(import.meta.dirname, "../embeddings.jsonl");

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIM   = 1536;
const DESC_MAX        = 500;
const LOG_EVERY       = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

function buildEmbeddingText(p: Record<string, string | null>): string {
  const lines: string[] = [p.name ?? ""];
  if (p.name_secondary) lines.push(p.name_secondary);

  const mfr = [
    p.manufacturer      ? `Výrobce: ${p.manufacturer}`      : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ].filter(Boolean).join(" | ");
  if (mfr) lines.push(mfr);

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length) lines.push(`Kategorie: ${cats.join(" > ")}`);

  if (p.description) lines.push(`Popis: ${p.description.slice(0, DESC_MAX)}`);

  return lines.join("\n");
}

/** Load IDs already written to embeddings.jsonl (resume support). */
async function loadAlreadyDone(): Promise<Set<string>> {
  const done = new Set<string>();
  if (!fs.existsSync(OUTPUT_FILE)) return done;

  const rl = readline.createInterface({
    input: fs.createReadStream(OUTPUT_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const { id } = JSON.parse(line);
      if (id) done.add(id);
    } catch { /* skip malformed */ }
  }
  return done;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  File not found: ${INPUT_FILE}`);
    console.error("    Run embed-export.ts first.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log("🔍 Loading progress...");
  const alreadyDone = await loadAlreadyDone();

  // Count total lines in input file
  let totalProducts = 0;
  {
    const counter = readline.createInterface({
      input: fs.createReadStream(INPUT_FILE),
      crlfDelay: Infinity,
    });
    for await (const line of counter) {
      if (line.trim()) totalProducts++;
    }
  }

  const remaining = totalProducts - alreadyDone.size;

  console.log(`\n🚀 embed-generate (NO Supabase connection)`);
  console.log(`   Input:           ${INPUT_FILE}`);
  console.log(`   Total products:  ${fmt(totalProducts)}`);
  console.log(`   Already done:    ${fmt(alreadyDone.size)}`);
  console.log(`   To process:      ${fmt(remaining)}`);
  console.log(`   batch=${BATCH_SIZE}  delay=${DELAY_MS}ms\n`);

  if (remaining === 0) {
    console.log("✅ All products already embedded. Run embed-import.ts to push to DB.");
    return;
  }

  const out = fs.createWriteStream(OUTPUT_FILE, { flags: "a" });

  let processed = 0;
  let errors = 0;
  let batchNum = 0;
  const startTime = Date.now();

  // Stream through products.jsonl in batches
  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  let batch: Array<Record<string, string | null>> = [];

  const processBatch = async (b: Array<Record<string, string | null>>) => {
    const texts = b.map(buildEmbeddingText);

    try {
      const resp = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIM,
        input: texts,
      });

      for (let i = 0; i < b.length; i++) {
        out.write(JSON.stringify({ id: b[i].id, embedding: resp.data[i].embedding }) + "\n");
        alreadyDone.add(b[i].id!);
      }

      processed += b.length;
      batchNum++;

    } catch (err: any) {
      const msg: string = err.message ?? String(err);
      console.error(`  ❌ OpenAI error: ${msg}`);
      errors += b.length;

      if (msg.includes("rate_limit")) {
        console.log("  ⏳ Rate limited – waiting 60s...");
        await sleep(60_000);
        // retry same batch
        await processBatch(b);
        return;
      }
    }

    if (batchNum % LOG_EVERY === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const eta = rate > 0 ? Math.ceil((remaining - processed) / rate / 60) : 0;
      console.log(
        `  [${fmt(processed)}/${fmt(remaining)}]  errors=${errors}  ` +
        `rate=${rate.toFixed(0)}/s  ETA=${eta}min`,
      );
    }

    await sleep(DELAY_MS);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    let product: Record<string, string | null>;
    try {
      product = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip already processed (resume support)
    if (alreadyDone.has(product.id!)) continue;

    batch.push(product);

    if (batch.length >= BATCH_SIZE) {
      await processBatch(batch);
      batch = [];
    }
  }

  // Process remaining partial batch
  if (batch.length > 0) {
    await processBatch(batch);
  }

  out.end();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Generation done in ${elapsed} min`);
  console.log(`   Processed: ${fmt(processed)}`);
  console.log(`   Errors:    ${errors}`);
  console.log(`\n👉 Next: cd backend && npx tsx ../scripts/embed-import.ts`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
