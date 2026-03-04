/**
 * Import products from CSV (Kros.csv) into Supabase.
 *
 * CSV format: semicolon-delimited, Czech decimal separators (comma).
 * Columns: CISLO;NAZEV;NAZEV2;DLOUHY_POPIS;JEDNOTKA;CENA_NAKUPNI;CENA_PRODEJNI;
 *          RECYKLACNI_POPLATEK;DPH;ESHOP;OBRAZEK;EAN;KOD_VYROBCE;VYROBCE;
 *          UROVEN1;UROVEN2;UROVEN3
 *
 * Usage: npm run import -- --file ../Kros.csv
 */
import { config } from "dotenv";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });
import { parse } from "csv-parse";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = 500;

interface CsvRow {
  CISLO: string;
  NAZEV: string;
  NAZEV2: string;
  DLOUHY_POPIS: string;
  JEDNOTKA: string;
  CENA_NAKUPNI: string;
  CENA_PRODEJNI: string;
  RECYKLACNI_POPLATEK: string;
  DPH: string;
  ESHOP: string;
  OBRAZEK: string;
  EAN: string;
  KOD_VYROBCE: string;
  VYROBCE: string;
  UROVEN1: string;
  UROVEN2: string;
  UROVEN3: string;
}

interface ProductInsert {
  sku: string;
  name: string;
  name_secondary: string | null;
  description: string | null;
  unit: string | null;
  price: number | null;
  ean: string | null;
  manufacturer_code: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
  eshop_url: string | null;
}

function parseCzechDecimal(value: string): number | null {
  if (!value || value.trim() === "") return null;
  const normalized = value.replace(",", ".");
  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function nullIfEmpty(value: string): string | null {
  if (!value) return null;
  let trimmed = value.trim();
  // Strip wrapping double quotes left over from quote:false parsing
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed.length > 0 ? trimmed : null;
}

function stripQuotes(value: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function mapRow(row: CsvRow): ProductInsert {
  return {
    sku: stripQuotes(row.CISLO),
    name: stripQuotes(row.NAZEV),
    name_secondary: nullIfEmpty(row.NAZEV2),
    description: nullIfEmpty(row.DLOUHY_POPIS),
    unit: nullIfEmpty(row.JEDNOTKA),
    price: parseCzechDecimal(row.CENA_PRODEJNI),
    ean: nullIfEmpty(row.EAN),
    manufacturer_code: nullIfEmpty(row.KOD_VYROBCE),
    manufacturer: nullIfEmpty(row.VYROBCE),
    category: nullIfEmpty(row.UROVEN1),
    subcategory: nullIfEmpty(row.UROVEN2),
    sub_subcategory: nullIfEmpty(row.UROVEN3),
    eshop_url: nullIfEmpty(row.ESHOP),
  };
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const filePath = fileArg
    ? resolve(fileArg.split("=")[1])
    : resolve(import.meta.dirname, "../Kros.csv");

  console.log(`📂 Reading CSV from: ${filePath}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const parser = createReadStream(filePath, { encoding: "utf-8" }).pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      quote: false,
    }),
  );

  let batch: ProductInsert[] = [];
  let totalInserted = 0;
  let totalSkipped = 0;
  let batchNumber = 0;

  for await (const row of parser as AsyncIterable<CsvRow>) {
    if (!row.CISLO || row.CISLO.trim() === "") {
      totalSkipped++;
      continue;
    }

    batch.push(mapRow(row));

    if (batch.length >= BATCH_SIZE) {
      batchNumber++;
      const { error } = await supabase
        .from("products")
        .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });

      if (error) {
        console.error(`❌ Batch ${batchNumber} failed:`, error.message);
      } else {
        totalInserted += batch.length;
        if (batchNumber % 20 === 0) {
          console.log(`  ✓ ${totalInserted} products imported...`);
        }
      }

      batch = [];
    }
  }

  if (batch.length > 0) {
    batchNumber++;
    const { error } = await supabase
      .from("products")
      .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });

    if (error) {
      console.error(`❌ Final batch failed:`, error.message);
    } else {
      totalInserted += batch.length;
    }
  }

  console.log(`\n✅ Import complete:`);
  console.log(`   Inserted/updated: ${totalInserted}`);
  console.log(`   Skipped (empty): ${totalSkipped}`);
  console.log(`   Batches: ${batchNumber}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
