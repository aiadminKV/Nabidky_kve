/**
 * Generate embeddings from local Kros.csv — NO Supabase connection needed.
 *
 * Uses text-embedding-3-small @ 256 dimensions for optimal cost/size/quality balance.
 * Resumable: skips SKUs already in output file.
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-csv-generate.ts
 *   cd backend && npx tsx ../scripts/embed-csv-generate.ts --limit=100
 *   cd backend && npx tsx ../scripts/embed-csv-generate.ts --batch=200 --delay=200
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import OpenAI from "openai";
import fs from "node:fs";
import readline from "node:readline";

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE = parseInt(getArg("batch") ?? "100");
const DELAY_MS = parseInt(getArg("delay") ?? "300");
const LIMIT = getArg("limit") ? parseInt(getArg("limit")!) : Infinity;

const CSV_FILE = resolve(import.meta.dirname, "../Kros.csv");
const OUTPUT_FILE = resolve(import.meta.dirname, "../embeddings-256.jsonl");

const MODEL = "text-embedding-3-small";
const DIMS = 256;
const DESC_MAX = 500;
const LOG_EVERY = 10;

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

interface CsvProduct {
  sku: string;
  name: string;
  name_secondary: string | null;
  description: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
}

function buildEmbeddingText(p: CsvProduct): string {
  const lines: string[] = [p.name];

  if (p.name_secondary) lines.push(p.name_secondary);

  const mfr = [
    p.manufacturer ? `Výrobce: ${p.manufacturer}` : null,
    p.manufacturer_code ? `Kód: ${p.manufacturer_code}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  if (mfr) lines.push(mfr);

  const cats = [p.category, p.subcategory, p.sub_subcategory].filter(Boolean);
  if (cats.length) lines.push(`Kategorie: ${cats.join(" > ")}`);

  if (p.description) lines.push(`Popis: ${p.description.slice(0, DESC_MAX)}`);

  return lines.join("\n");
}

function parseCsvRow(row: Record<string, string>): CsvProduct | null {
  const sku = row["CISLO"]?.trim();
  const name = row["NAZEV"]?.trim().replace(/^"|"$/g, "");
  if (!sku || !name) return null;

  return {
    sku,
    name,
    name_secondary: row["NAZEV2"]?.trim().replace(/^"|"$/g, "") || null,
    description: row["DLOUHY_POPIS"]?.trim().replace(/^"|"$/g, "") || null,
    manufacturer_code: row["KOD_VYROBCE"]?.trim().replace(/^"|"$/g, "") || null,
    manufacturer: row["VYROBCE"]?.trim().replace(/^"|"$/g, "") || null,
    category: row["UROVEN1"]?.trim().replace(/^"|"$/g, "") || null,
    subcategory: row["UROVEN2"]?.trim().replace(/^"|"$/g, "") || null,
    sub_subcategory: row["UROVEN3"]?.trim().replace(/^"|"$/g, "") || null,
  };
}

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
      const { sku } = JSON.parse(line);
      if (sku) done.add(sku);
    } catch {
      /* skip malformed */
    }
  }
  return done;
}

/**
 * Parse a CSV line with semicolon delimiter and inconsistent quoting.
 * Handles fields like: "value with ; inside" and unquoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function readCsv(): Promise<CsvProduct[]> {
  const products: CsvProduct[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_FILE, "utf-8"),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    if (lineNum === 1) {
      headers = parseCsvLine(line);
      continue;
    }

    const fields = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fields[i] ?? "";
    }

    const p = parseCsvRow(row);
    if (p) products.push(p);
  }

  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌  File not found: ${CSV_FILE}`);
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log("🔍 Loading CSV...");
  const allProducts = await readCsv();
  console.log(`   Parsed: ${fmt(allProducts.length)} products from CSV`);

  console.log("🔍 Checking previous progress...");
  const alreadyDone = await loadAlreadyDone();

  const toProcess = allProducts
    .filter((p) => !alreadyDone.has(p.sku))
    .slice(0, LIMIT);

  console.log(`\n🚀 embed-csv-generate (offline from Supabase)`);
  console.log(`   Model:           ${MODEL} @ ${DIMS} dims`);
  console.log(`   CSV:             ${CSV_FILE}`);
  console.log(`   Output:          ${OUTPUT_FILE}`);
  console.log(`   Total in CSV:    ${fmt(allProducts.length)}`);
  console.log(`   Already done:    ${fmt(alreadyDone.size)}`);
  console.log(`   To process:      ${fmt(toProcess.length)}`);
  console.log(`   batch=${BATCH_SIZE}  delay=${DELAY_MS}ms\n`);

  if (toProcess.length === 0) {
    console.log("✅ All products already embedded.");
    return;
  }

  const out = fs.createWriteStream(OUTPUT_FILE, { flags: "a" });

  let processed = 0;
  let errors = 0;
  let batchNum = 0;
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const texts = batch.map(buildEmbeddingText);

    try {
      const resp = await openai.embeddings.create({
        model: MODEL,
        dimensions: DIMS,
        input: texts,
      });

      for (let j = 0; j < batch.length; j++) {
        out.write(
          JSON.stringify({
            sku: batch[j].sku,
            embedding: resp.data[j].embedding,
          }) + "\n",
        );
      }

      processed += batch.length;
      batchNum++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ OpenAI error: ${msg}`);
      errors += batch.length;

      if (msg.includes("rate_limit")) {
        console.log("  ⏳ Rate limited – waiting 60s...");
        await sleep(60_000);
        i -= BATCH_SIZE; // retry
        continue;
      }
    }

    if (batchNum % LOG_EVERY === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const eta =
        rate > 0
          ? Math.ceil((toProcess.length - processed) / rate / 60)
          : 0;
      console.log(
        `  [${fmt(processed)}/${fmt(toProcess.length)}]  errors=${errors}  ` +
          `rate=${rate.toFixed(0)}/s  ETA=${eta}min`,
      );
    }

    await sleep(DELAY_MS);
  }

  out.end();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Generation done in ${elapsed} min`);
  console.log(`   Model:     ${MODEL} @ ${DIMS} dims`);
  console.log(`   Processed: ${fmt(processed)}`);
  console.log(`   Errors:    ${errors}`);
  console.log(`   Output:    ${OUTPUT_FILE}`);
  console.log(
    `\n👉 Next: cd backend && npx tsx ../scripts/embed-csv-import.ts`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
