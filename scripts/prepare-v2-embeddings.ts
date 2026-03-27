/**
 * Phase A (step 2): Generate embeddings for V2 products.
 *
 * Reads 04_products.csv from prepared data, generates embeddings via OpenAI API,
 * and writes results to 09_embeddings.jsonl.
 *
 * Supports checkpointing — if interrupted, restart and it will resume from
 * the last completed batch.
 *
 * Usage: npx tsx prepare-v2-embeddings.ts [--batch-size=500] [--limit=1000]
 */
import { config } from "dotenv";
import { createReadStream, appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "csv-parse";
import OpenAI from "openai";

config({ path: resolve(import.meta.dirname, "../.env") });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PREPARED_DIR = resolve(import.meta.dirname, "../data-model/prepared");
const INPUT_FILE = join(PREPARED_DIR, "04_products.csv");
const OUTPUT_FILE = join(PREPARED_DIR, "09_embeddings.jsonl");
const CHECKPOINT_FILE = join(PREPARED_DIR, ".embeddings_checkpoint");

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 256;
const DEFAULT_BATCH_SIZE = 500;
const DELAY_BETWEEN_BATCHES_MS = 200;
const MAX_RETRIES = 5;
const LOG_INTERVAL = 10;

interface ProductRow {
  source_matnr: string;
  sku: string;
  name: string;
  unit: string;
  supplier_name: string;
  category_main: string;
  category_sub: string;
  category_line: string;
  description: string;
  search_hints: string;
}

function buildEmbeddingTextV2(p: ProductRow): string {
  const lines: string[] = [p.name];

  if (p.search_hints) {
    lines.push(`Také známo jako: ${p.search_hints}`);
  }
  if (p.supplier_name) {
    lines.push(`Výrobce: ${p.supplier_name}`);
  }

  const cats = [p.category_main, p.category_sub, p.category_line].filter(Boolean);
  if (cats.length > 0) {
    lines.push(`Kategorie: ${cats.join(" > ")}`);
  }

  if (p.description) {
    lines.push(`Popis: ${p.description.slice(0, 500)}`);
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArg(name: string, defaultValue: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split("=")[1], 10) : defaultValue;
}

function loadCheckpoint(): number {
  if (!existsSync(CHECKPOINT_FILE)) return 0;
  const val = parseInt(readFileSync(CHECKPOINT_FILE, "utf-8").trim(), 10);
  return isNaN(val) ? 0 : val;
}

function saveCheckpoint(processed: number): void {
  writeFileSync(CHECKPOINT_FILE, String(processed));
}

async function main() {
  const batchSize = parseArg("batch-size", DEFAULT_BATCH_SIZE);
  const limit = parseArg("limit", 0);

  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set in .env");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  console.log(`Model:      ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS} dims)`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Limit:      ${limit || "all"}`);
  console.log(`Input:      ${INPUT_FILE}`);
  console.log(`Output:     ${OUTPUT_FILE}\n`);

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  if (checkpoint > 0) {
    console.log(`Resuming from checkpoint: ${checkpoint.toLocaleString()} products already done\n`);
  }

  // Read all products into memory (need index-based access for checkpoint)
  console.log("Loading products...");
  const products: ProductRow[] = [];

  const parser = createReadStream(INPUT_FILE, { encoding: "utf-8" }).pipe(
    parse({
      delimiter: ",",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );

  for await (const row of parser as AsyncIterable<ProductRow>) {
    products.push(row);
  }

  const totalProducts = limit > 0 ? Math.min(products.length, limit) : products.length;
  console.log(`Loaded ${products.length.toLocaleString()} products, processing ${totalProducts.toLocaleString()}\n`);

  // Process in batches
  let processed = checkpoint;
  let totalTokens = 0;
  let batchCount = 0;
  let errors = 0;
  const startTime = Date.now();

  while (processed < totalProducts) {
    const batchEnd = Math.min(processed + batchSize, totalProducts);
    const batch = products.slice(processed, batchEnd);
    const texts = batch.map(buildEmbeddingTextV2);

    let retries = 0;
    let success = false;

    while (retries < MAX_RETRIES && !success) {
      try {
        const response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
          input: texts,
        });

        totalTokens += response.usage?.total_tokens ?? 0;

        // Append to JSONL
        const lines: string[] = [];
        for (let i = 0; i < batch.length; i++) {
          lines.push(
            JSON.stringify({
              source_matnr: batch[i].source_matnr,
              sku: batch[i].sku,
              embedding: response.data[i].embedding,
              embedding_text: texts[i],
            }),
          );
        }
        appendFileSync(OUTPUT_FILE, lines.join("\n") + "\n");

        processed = batchEnd;
        batchCount++;
        success = true;

        saveCheckpoint(processed);
      } catch (err) {
        retries++;
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("rate_limit") || msg.includes("429")) {
          const waitMs = Math.min(2000 * Math.pow(2, retries), 120_000);
          console.log(`  Rate limited, waiting ${(waitMs / 1000).toFixed(0)}s (retry ${retries}/${MAX_RETRIES})...`);
          await sleep(waitMs);
        } else if (retries < MAX_RETRIES) {
          console.error(`  API error (retry ${retries}/${MAX_RETRIES}): ${msg}`);
          await sleep(1000 * retries);
        } else {
          console.error(`  FATAL: Max retries reached for batch at offset ${processed}: ${msg}`);
          errors += batch.length;
          processed = batchEnd;
          saveCheckpoint(processed);
        }
      }
    }

    if (batchCount % LOG_INTERVAL === 0 && batchCount > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (processed - checkpoint) / elapsed;
      const remaining = (totalProducts - processed) / rate;
      console.log(
        `  ${processed.toLocaleString()} / ${totalProducts.toLocaleString()} ` +
          `(${((processed / totalProducts) * 100).toFixed(1)}%) ` +
          `| ${rate.toFixed(0)} products/s ` +
          `| ETA: ${(remaining / 60).toFixed(1)} min ` +
          `| tokens: ${totalTokens.toLocaleString()}`,
      );
    }

    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  // Cleanup checkpoint on success
  if (existsSync(CHECKPOINT_FILE)) {
    unlinkSync(CHECKPOINT_FILE);
  }

  const totalElapsed = (Date.now() - startTime) / 1000;
  console.log("\n" + "═".repeat(60));
  console.log("Embedding generation complete!");
  console.log("═".repeat(60));
  console.log(`
  Products:   ${processed.toLocaleString()}
  Batches:    ${batchCount}
  Tokens:     ${totalTokens.toLocaleString()}
  Errors:     ${errors}
  Time:       ${(totalElapsed / 60).toFixed(1)} min
  Rate:       ${((processed - checkpoint) / totalElapsed).toFixed(0)} products/s
  Output:     ${OUTPUT_FILE}
  
  Cost est:   ~$${((totalTokens / 1_000_000) * 0.02).toFixed(2)} (text-embedding-3-small @ $0.02/1M tokens)
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
