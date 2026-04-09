/**
 * Migrate product embeddings from Supabase → Qdrant
 *
 * Required env vars (read from root .env):
 *   SUPABASE_DB_URL or DATABASE_URL — PostgreSQL connection string
 *   QDRANT_URL    — Qdrant base URL (default: http://localhost:6333)
 *
 * Usage:
 *   npx tsx backend/scripts/qdrant-migrate.ts              # full migration
 *   npx tsx backend/scripts/qdrant-migrate.ts --recreate   # drop + recreate collection
 *   npx tsx backend/scripts/qdrant-migrate.ts --resume     # continue from highest ID already in Qdrant
 *   npx tsx backend/scripts/qdrant-migrate.ts --from 680000 # start from specific product_id
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QdrantClient } from "@qdrant/js-client-rest";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

// Prefer pooler (SUPABASE_DB_URL) over direct connection (DATABASE_URL).
// Pooler is more reliable — direct connection requires specific network/SSL setup.
const DATABASE_URL = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const RECREATE = process.argv.includes("--recreate");
const RESUME = process.argv.includes("--resume");
const FROM_IDX = process.argv.indexOf("--from");
const FROM_ID = FROM_IDX !== -1 ? parseInt(process.argv[FROM_IDX + 1], 10) : null;

const COLLECTION_NAME = "products_v2";
const VECTOR_SIZE = 256;
const BATCH_SIZE = 1000;
const LOG_INTERVAL = 10_000;

if (!DATABASE_URL) {
  console.error(
    "Missing database connection env var.\n" +
      "Add one of these to your .env:\n" +
      "  SUPABASE_DB_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres\n" +
      "  DATABASE_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres\n" +
      "Get the pooler URL from: Supabase Dashboard → Project Settings → Database → Connection pooling → URI",
  );
  process.exit(1);
}

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
  checkCompatibility: false,
});

async function ensureCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (exists && RECREATE) {
    console.log(`Dropping existing collection '${COLLECTION_NAME}'...`);
    await qdrant.deleteCollection(COLLECTION_NAME);
  }

  if (!exists || RECREATE) {
    console.log(`Creating collection '${COLLECTION_NAME}'...`);
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
        on_disk: true,
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
        on_disk: false,
      },
      optimizers_config: {
        memmap_threshold: 50_000,
      },
    });

    // Payload indexes for fast filtering
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "supplier_name",
      field_schema: "text",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "category_code",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "category_prefixes",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "is_stock_item",
      field_schema: "bool",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "branch_codes",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "removed",
      field_schema: "bool",
    });

    console.log("Collection and indexes created.");
  } else {
    console.log(`Collection '${COLLECTION_NAME}' already exists. Use --recreate to drop and rebuild.`);
  }
}

/** Parse pgvector text representation "[0.1,0.2,...]" to float array. */
function parseEmbedding(raw: string): number[] {
  return JSON.parse(raw.replace("[", "[").replace("]", "]"));
}

async function getResumeId(): Promise<number> {
  // Scroll through Qdrant to find the maximum numeric point ID already stored.
  console.log("Scanning Qdrant to find resume point (max stored ID)...");
  let maxId = 0;
  let nextOffset: string | number | null = null;
  const PAGE = 1000;

  do {
    const page = await qdrant.scroll(COLLECTION_NAME, {
      limit: PAGE,
      with_payload: false,
      with_vector: false,
      ...(nextOffset !== null ? { offset: nextOffset } : {}),
    });

    for (const pt of page.points) {
      const id = typeof pt.id === "number" ? pt.id : parseInt(String(pt.id), 10);
      if (id > maxId) maxId = id;
    }

    nextOffset = page.next_page_offset ?? null;
  } while (nextOffset !== null);

  console.log(`Resume: highest ID already in Qdrant = ${maxId.toLocaleString()}`);
  return maxId;
}

async function migrate(): Promise<void> {
  await ensureCollection();

  // Determine starting product_id
  let startFromId = 0;
  if (FROM_ID !== null && !isNaN(FROM_ID)) {
    startFromId = FROM_ID;
    console.log(`Starting from --from ${startFromId.toLocaleString()}`);
  } else if (RESUME) {
    startFromId = await getResumeId();
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Connected to PostgreSQL (${DATABASE_URL?.split("@")[1]?.split("/")[0] ?? "?"}).`);

  // Count total for progress
  const countResult = await client.query(
    "SELECT COUNT(*) FROM product_embeddings_v2",
  );
  const total = parseInt(countResult.rows[0].count, 10);
  const remaining = startFromId > 0
    ? await client.query("SELECT COUNT(*) FROM product_embeddings_v2 WHERE product_id > $1", [startFromId])
        .then((r) => parseInt(r.rows[0].count, 10))
    : total;

  console.log(
    `Total embeddings: ${total.toLocaleString()} | To migrate: ${remaining.toLocaleString()}` +
    (startFromId > 0 ? ` (resuming from id>${startFromId.toLocaleString()})` : ""),
  );

  let lastId = startFromId;
  let processed = 0;
  let errors = 0;

  const startTime = Date.now();

  while (true) {
    const { rows } = await client.query<{
      id: string;
      embedding: string;
      sku: string;
      name: string;
      unit: string | null;
      supplier_name: string | null;
      category_code: string | null;
      category_main: string | null;
      category_sub: string | null;
      category_line: string | null;
      is_stock_item: boolean;
      removed_at: string | null;
      current_price: string | null;
      branch_codes: string[] | null;
    }>(
      `
      SELECT
        pe.product_id                                                  AS id,
        pe.embedding::text                                             AS embedding,
        p.sku,
        p.name,
        p.unit,
        p.supplier_name,
        p.category_code,
        p.category_main,
        p.category_sub,
        p.category_line,
        p.is_stock_item,
        p.removed_at,
        pr.current_price,
        COALESCE(
          array_agg(DISTINCT b.source_branch_code)
            FILTER (WHERE b.source_branch_code IS NOT NULL),
          ARRAY[]::text[]
        ) AS branch_codes
      FROM product_embeddings_v2 pe
      JOIN products_v2 p          ON p.id = pe.product_id
      LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
      LEFT JOIN product_branch_stock_v2 bs ON bs.product_id = p.id
      LEFT JOIN branches_v2 b    ON b.id = bs.branch_id
      WHERE pe.product_id > $1
      GROUP BY pe.product_id, pe.embedding,
               p.sku, p.name, p.unit, p.supplier_name,
               p.category_code, p.category_main, p.category_sub, p.category_line,
               p.is_stock_item, p.removed_at, pr.current_price
      ORDER BY pe.product_id
      LIMIT $2
      `,
      [lastId, BATCH_SIZE],
    );

    if (rows.length === 0) break;

    const points = rows.map((row) => {
      // Build category_prefixes: all ancestor + own codes for prefix filtering
      // e.g. "4050205" → ["4050205", "40502", "405"]
      const categoryPrefixes: string[] = [];
      const code = row.category_code;
      if (code) {
        categoryPrefixes.push(code);
        if (code.length > 3) categoryPrefixes.push(code.slice(0, -2)); // level 2
        if (code.length > 5) categoryPrefixes.push(code.slice(0, -4)); // level 1 (3 digits)
        // Also add the first 3 chars explicitly for level-1 prefix
        if (code.length >= 3) {
          const l1 = code.slice(0, 3);
          if (!categoryPrefixes.includes(l1)) categoryPrefixes.push(l1);
        }
      }

      return {
        id: parseInt(row.id, 10),
        vector: parseEmbedding(row.embedding),
        payload: {
          sku: row.sku,
          name: row.name,
          unit: row.unit ?? null,
          supplier_name: row.supplier_name ?? null,
          category_code: row.category_code ?? null,
          category_prefixes: categoryPrefixes,
          category_main: row.category_main ?? null,
          category_sub: row.category_sub ?? null,
          category_line: row.category_line ?? null,
          is_stock_item: row.is_stock_item,
          current_price: row.current_price != null ? parseFloat(row.current_price) : null,
          branch_codes: row.branch_codes ?? [],
          removed: row.removed_at !== null,
        },
      };
    });

    try {
      await qdrant.upsert(COLLECTION_NAME, { wait: true, points });
      processed += points.length;
    } catch (err) {
      console.error(`Batch upsert error at id>${lastId}:`, err);
      errors += points.length;
    }

    lastId = parseInt(rows[rows.length - 1].id, 10);

    if (processed % LOG_INTERVAL === 0 || processed >= remaining) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.round(processed / Math.max(elapsed, 1));
      const pct = ((processed / remaining) * 100).toFixed(1);
      const eta = rate > 0 ? Math.round((remaining - processed) / rate) : 0;
      console.log(
        `Progress: ${processed.toLocaleString()}/${remaining.toLocaleString()} (${pct}%) | ` +
          `${rate}/s | ETA: ${Math.floor(eta / 60)}m${eta % 60}s | errors: ${errors}`,
      );
    }
  }

  await client.end();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. Migrated ${processed.toLocaleString()} points in ${elapsed}s. Errors: ${errors}`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
