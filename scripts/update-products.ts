/**
 * Diff-based product catalog update.
 *
 * Compares a new CSV file against existing products in Supabase and:
 * - Adds new products (present in CSV but not in DB)
 * - Updates changed products (price, name, etc.)
 * - Removes products no longer in the CSV
 *
 * Usage: npm run update -- --file ../Kros-new.csv [--dry-run]
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

function parseCzechDecimal(value: string): number | null {
  if (!value || value.trim() === "") return null;
  return parseFloat(value.replace(",", ".")) || null;
}

function nullIfEmpty(value: string): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

interface CsvRow {
  CISLO: string;
  NAZEV: string;
  NAZEV2: string;
  DLOUHY_POPIS: string;
  JEDNOTKA: string;
  CENA_PRODEJNI: string;
  EAN: string;
  KOD_VYROBCE: string;
  VYROBCE: string;
  UROVEN1: string;
  UROVEN2: string;
  UROVEN3: string;
  ESHOP: string;
  [key: string]: string;
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const dryRun = process.argv.includes("--dry-run");

  if (!fileArg) {
    console.error("Usage: npm run update -- --file=<path-to-csv> [--dry-run]");
    process.exit(1);
  }

  const filePath = resolve(fileArg.split("=")[1]);
  console.log(`📂 Reading new CSV: ${filePath}`);
  if (dryRun) console.log("🔍 DRY RUN – no changes will be written\n");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Step 1: Load all existing SKUs from DB
  console.log("📊 Loading existing products from DB...");
  const existingSkus = new Set<string>();
  let page = 0;
  const PAGE_SIZE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("sku")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) throw new Error(`DB read failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) existingSkus.add(row.sku);
    page++;
  }

  console.log(`   Found ${existingSkus.size} existing products\n`);

  // Step 2: Parse CSV and compare
  const csvSkus = new Set<string>();
  const toUpsert: Record<string, unknown>[] = [];

  const parser = createReadStream(filePath).pipe(
    parse({
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );

  for await (const row of parser as AsyncIterable<CsvRow>) {
    const sku = row.CISLO?.trim();
    if (!sku) continue;

    csvSkus.add(sku);
    toUpsert.push({
      sku,
      name: row.NAZEV.trim(),
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
    });
  }

  // Step 3: Compute diff
  const toAdd = [...csvSkus].filter((s) => !existingSkus.has(s));
  const toRemove = [...existingSkus].filter((s) => !csvSkus.has(s));
  const toUpdate = [...csvSkus].filter((s) => existingSkus.has(s));

  console.log(`📋 Diff summary:`);
  console.log(`   New products to add:    ${toAdd.length}`);
  console.log(`   Products to update:     ${toUpdate.length}`);
  console.log(`   Products to remove:     ${toRemove.length}`);
  console.log(`   Total in new CSV:       ${csvSkus.size}\n`);

  if (dryRun) {
    if (toAdd.length > 0) console.log(`   Sample new: ${toAdd.slice(0, 5).join(", ")}...`);
    if (toRemove.length > 0) console.log(`   Sample remove: ${toRemove.slice(0, 5).join(", ")}...`);
    console.log("\n🔍 Dry run complete – no changes applied.");
    return;
  }

  // Step 4: Apply upserts in batches
  console.log("⬆️  Upserting products...");
  let upserted = 0;

  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("products")
      .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });

    if (error) {
      console.error(`   ❌ Batch upsert failed at offset ${i}:`, error.message);
    } else {
      upserted += batch.length;
      if ((i / BATCH_SIZE) % 20 === 0) {
        console.log(`   ✓ ${upserted} / ${toUpsert.length}...`);
      }
    }
  }

  // Step 5: Remove products no longer in CSV
  if (toRemove.length > 0) {
    console.log(`\n🗑️  Removing ${toRemove.length} obsolete products...`);

    for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
      const batch = toRemove.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("products")
        .delete()
        .in("sku", batch);

      if (error) {
        console.error(`   ❌ Delete batch failed:`, error.message);
      }
    }
  }

  console.log(`\n✅ Update complete:`);
  console.log(`   Upserted: ${upserted}`);
  console.log(`   Removed:  ${toRemove.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
