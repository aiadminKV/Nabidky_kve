/**
 * Controlled migration: writes LONGTEXT from CSV into products_v2.description.
 *
 * Progress tracking:
 *   description IS NULL  → not yet migrated
 *   description = ''     → migrated, no description in CSV
 *   description = 'text' → migrated with description
 *
 * Can be stopped and resumed at any time — picks up where it left off.
 *
 * Usage:
 *   npx tsx backfill-descriptions.ts --batch 1000         # first 1000
 *   npx tsx backfill-descriptions.ts --batch 5000         # next 5000
 *   npx tsx backfill-descriptions.ts --batch 5000 --all   # keep going until done
 *   npx tsx backfill-descriptions.ts --status             # just show progress
 *   npx tsx backfill-descriptions.ts --dry-run --batch 1000  # preview without writes
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL!;
const CSV_PATH = process.argv.find((a) => a.startsWith("--csv="))?.split("=")[1]
  || "/tmp/matnr_dispo_info.csv";

const BATCH_SIZE = parseInt(
  process.argv.find((a) => a.startsWith("--batch="))?.split("=")[1]
  || process.argv[process.argv.indexOf("--batch") + 1]
  || "1000",
);
const DRY_RUN = process.argv.includes("--dry-run");
const STATUS_ONLY = process.argv.includes("--status");
const ALL = process.argv.includes("--all");

function fmt(n: number): string { return n.toLocaleString("cs-CZ"); }
function elapsed(t: number): string { return `${((Date.now() - t) / 1000).toFixed(1)}s`; }

function makePgClient(): pg.Client {
  return new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

interface DbHealth {
  db_size_mb: number;
  products_heap_mb: number;
  products_total_mb: number;
  dead_tuples: number;
  remaining_null: number;
  migrated: number;
  migrated_with_text: number;
}

async function getDbHealth(client: pg.Client): Promise<DbHealth> {
  const { rows } = await client.query<DbHealth>(`
    SELECT
      (pg_database_size(current_database()) / 1048576)::int           AS db_size_mb,
      (pg_relation_size('products_v2') / 1048576)::int                AS products_heap_mb,
      (pg_total_relation_size('products_v2') / 1048576)::int          AS products_total_mb,
      (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'products_v2') AS dead_tuples,
      (SELECT count(*) FROM products_v2 WHERE description IS NULL AND removed_at IS NULL)::int AS remaining_null,
      (SELECT count(*) FROM products_v2 WHERE description IS NOT NULL AND removed_at IS NULL)::int AS migrated,
      (SELECT count(*) FROM products_v2 WHERE description IS NOT NULL AND description != '' AND removed_at IS NULL)::int AS migrated_with_text
  `);
  return rows[0];
}

function printHealth(h: DbHealth, label: string): void {
  console.log(`\n  ── ${label} ──`);
  console.log(`  DB size:          ${fmt(h.db_size_mb)} MB / 12 288 MB (${(h.db_size_mb / 12288 * 100).toFixed(1)}%)`);
  console.log(`  products_v2 heap: ${fmt(h.products_heap_mb)} MB`);
  console.log(`  products_v2 total:${fmt(h.products_total_mb)} MB`);
  console.log(`  Dead tuples:      ${fmt(h.dead_tuples)}`);
  console.log(`  ──`);
  console.log(`  Remaining (NULL): ${fmt(h.remaining_null)}`);
  console.log(`  Migrated:         ${fmt(h.migrated)} (${fmt(h.migrated_with_text)} with text)`);
}

async function main() {
  console.log(`\n  Backfill descriptions`);
  console.log(`  Batch: ${fmt(BATCH_SIZE)} | Mode: ${DRY_RUN ? "DRY RUN" : STATUS_ONLY ? "STATUS" : "LIVE"} | Continue: ${ALL ? "until done" : "one batch"}\n`);

  const monitorClient = makePgClient();
  await monitorClient.connect();

  const before = await getDbHealth(monitorClient);
  printHealth(before, "BEFORE");

  if (STATUS_ONLY) {
    await monitorClient.end();
    return;
  }

  if (before.remaining_null === 0) {
    console.log("\n  Nothing to do — all products already have description.\n");
    await monitorClient.end();
    return;
  }

  // Load CSV → MATNR → LONGTEXT map
  console.log(`\n  Loading CSV: ${CSV_PATH}`);
  const t0 = Date.now();
  const descMap = new Map<string, string>();
  const csvParser = createReadStream(CSV_PATH, { encoding: "utf-8" }).pipe(
    parse({ delimiter: ";", columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true, quote: false }),
  );
  for await (const row of csvParser as AsyncIterable<Record<string, string>>) {
    const matnr = row.MATNR?.trim();
    if (matnr) descMap.set(matnr, (row.LONGTEXT ?? "").trim());
  }
  console.log(`  CSV loaded: ${fmt(descMap.size)} products in ${elapsed(t0)}`);

  const nonEmpty = [...descMap.values()].filter((v) => v.length > 0).length;
  console.log(`  With description: ${fmt(nonEmpty)} | Empty: ${fmt(descMap.size - nonEmpty)}`);

  // Process batches
  let totalUpdated = 0;
  let batchNum = 0;

  do {
    batchNum++;
    const batchStart = Date.now();

    // Get next batch of products with NULL description
    const writeClient = makePgClient();
    await writeClient.connect();

    try {
      const { rows: products } = await writeClient.query<{ id: number; source_matnr: string }>(
        `SELECT id, source_matnr FROM products_v2
         WHERE description IS NULL AND removed_at IS NULL
         ORDER BY id LIMIT $1`,
        [BATCH_SIZE],
      );

      if (products.length === 0) {
        console.log(`\n  Batch ${batchNum}: nothing left to process.`);
        await writeClient.end();
        break;
      }

      // Match with CSV
      let withText = 0;
      let empty = 0;
      const updates: Array<{ id: number; description: string }> = [];

      for (const p of products) {
        const desc = descMap.get(p.source_matnr) ?? "";
        updates.push({ id: p.id, description: desc });
        if (desc.length > 0) withText++;
        else empty++;
      }

      console.log(`\n  Batch ${batchNum}: ${fmt(products.length)} products (${fmt(withText)} with text, ${fmt(empty)} empty)`);

      if (DRY_RUN) {
        console.log(`  DRY RUN — skipping write.`);
        await writeClient.end();
        break;
      }

      // Write in single transaction
      await writeClient.query("BEGIN");
      for (const u of updates) {
        await writeClient.query(
          "UPDATE products_v2 SET description = $1 WHERE id = $2",
          [u.description, u.id],
        );
      }
      await writeClient.query("COMMIT");

      totalUpdated += products.length;
      console.log(`  Written in ${elapsed(batchStart)}`);
    } catch (err) {
      await writeClient.query("ROLLBACK").catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${msg}`);
      await writeClient.end();
      break;
    } finally {
      await writeClient.end();
    }

    // Health check after each batch
    const after = await getDbHealth(monitorClient);
    const dbGrowth = after.db_size_mb - before.db_size_mb;
    const heapGrowth = after.products_heap_mb - before.products_heap_mb;
    const deadGrowth = after.dead_tuples - before.dead_tuples;

    printHealth(after, `AFTER batch ${batchNum}`);
    console.log(`  ──`);
    console.log(`  DB growth:     +${fmt(dbGrowth)} MB`);
    console.log(`  Heap growth:   +${fmt(heapGrowth)} MB`);
    console.log(`  New dead tup:  +${fmt(deadGrowth)}`);
    console.log(`  Total updated: ${fmt(totalUpdated)}`);

    // Safety: stop if DB growth is alarming (>500 MB per batch)
    if (dbGrowth > 500) {
      console.log(`\n  ⚠ DB grew by ${fmt(dbGrowth)} MB — stopping for safety.`);
      break;
    }

    // Pace: sleep between batches to let DB breathe
    if (ALL && after.remaining_null > 0) {
      console.log(`  Sleeping 3s before next batch...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } while (ALL);

  // Final health
  const final = await getDbHealth(monitorClient);
  printHealth(final, "FINAL");
  console.log(`\n  Done. ${fmt(totalUpdated)} products updated.\n`);

  await monitorClient.end();
}

main().catch((err) => {
  console.error(`\n  FATAL: ${err.message}\n`);
  process.exit(1);
});
