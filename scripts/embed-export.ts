/**
 * Phase 1: Export all products from Supabase to local JSONL file.
 *
 * Uses DIRECT pg connection via Session Mode Pooler (bypasses PostgREST / PGRST002).
 * Cursor-based pagination on UUID primary key - pure index scan, no timeouts.
 *
 * Output: products.jsonl (one product per line)
 *
 * Usage:
 *   cd backend && npx tsx ../scripts/embed-export.ts
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
// Resolve pg from backend/node_modules (scripts dir has no node_modules)
const require = createRequire(resolve(import.meta.dirname, "../backend/package.json"));
const { Client } = require("pg") as typeof import("pg");

import fs from "node:fs";

const OUTPUT_FILE = resolve(import.meta.dirname, "../products.jsonl");
const PAGE_SIZE   = 2000;

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("❌  SUPABASE_DB_URL not set in .env");
    process.exit(1);
  }

  console.log(`\n📤 embed-export  (direct pg → Session Mode Pooler)`);
  console.log(`   Output: ${OUTPUT_FILE}\n`);

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("   ✅ DB connected\n");

  const out = fs.createWriteStream(OUTPUT_FILE, { flags: "w" });
  let written = 0;
  let lastId  = "00000000-0000-0000-0000-000000000000";
  const startTime = Date.now();

  // Cursor-based pagination via UUID primary key - uses btree index, never full-table scan
  while (true) {
    const res = await client.query<Record<string, unknown>>(
      `SELECT id, sku, name, name_secondary, description,
              manufacturer_code, manufacturer, category,
              subcategory, sub_subcategory
       FROM products
       WHERE id > $1
       ORDER BY id
       LIMIT $2`,
      [lastId, PAGE_SIZE],
    );

    if (res.rows.length === 0) break;

    for (const row of res.rows) {
      out.write(JSON.stringify(row) + "\n");
      written++;
    }

    lastId = res.rows[res.rows.length - 1].id as string;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate    = written / elapsed;
    process.stdout.write(
      `\r  exported=${fmt(written)}  rate=${rate.toFixed(0)}/s  elapsed=${elapsed.toFixed(0)}s   `,
    );
  }

  out.end();
  await client.end();
  process.stdout.write("\n");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Export done in ${elapsed}s`);
  console.log(`   Exported:  ${fmt(written)} products`);
  console.log(`   File:      ${OUTPUT_FILE}`);
  console.log(`\n👉 Next: cd backend && npx tsx ../scripts/embed-generate.ts`);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
