/**
 * Phase B: Bulk load prepared V2 data into Supabase Postgres.
 *
 * Connects directly via SUPABASE_DB_URL (bypasses PostgREST / MCP timeouts).
 *
 * Phases:
 *   --phase=ddl      Create _v2 tables (PK + UNIQUE + FK only, no indexes/triggers)
 *   --phase=load     Bulk load data (add --test for 100 rows per table)
 *   --phase=post     Create indexes, triggers, RPC functions
 *   --phase=validate Run validation queries
 *   --phase=all      Run ddl → load → post → validate sequentially
 *
 * Usage:
 *   npx tsx load-v2-data.ts --phase=ddl
 *   npx tsx load-v2-data.ts --phase=load --test
 *   npx tsx load-v2-data.ts --phase=load
 *   npx tsx load-v2-data.ts --phase=post
 *   npx tsx load-v2-data.ts --phase=validate
 *   npx tsx load-v2-data.ts --phase=all --test
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { createRequire } from "node:module";
const require = createRequire(resolve(import.meta.dirname, "../backend/package.json"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require("pg") as typeof import("pg");

import fs from "node:fs";
import readline from "node:readline";
import { parse } from "csv-parse";

// ─── Config ──────────────────────────────────────────────────────────

const PREPARED_DIR = resolve(import.meta.dirname, "../data-model/prepared");
const BATCH_SIZE = 1000;

const FILES = {
  statusTypes: resolve(PREPARED_DIR, "01_status_types.csv"),
  categories: resolve(PREPARED_DIR, "02_categories.csv"),
  branches: resolve(PREPARED_DIR, "03_branches.csv"),
  products: resolve(PREPARED_DIR, "04_products.csv"),
  identifiers: resolve(PREPARED_DIR, "05_identifiers.csv"),
  prices: resolve(PREPARED_DIR, "06_prices.csv"),
  stock: resolve(PREPARED_DIR, "07_stock.csv"),
  customers: resolve(PREPARED_DIR, "08_customers.csv"),
  embeddings: resolve(PREPARED_DIR, "09_embeddings.jsonl"),
};

// ─── Helpers ─────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("cs-CZ");
}

function elapsed(startMs: number): string {
  const s = (Date.now() - startMs) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}min`;
}

function parseArgs(): { phase: string; test: boolean } {
  const args = process.argv.slice(2);
  let phase = "all";
  let test = false;
  for (const a of args) {
    if (a.startsWith("--phase=")) phase = a.split("=")[1];
    if (a === "--test") test = true;
  }
  return { phase, test };
}

async function readCsvRows<T extends Record<string, string>>(
  filePath: string,
  limit?: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    const stream = fs.createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, relax_column_count: true }),
    );
    stream.on("data", (row: T) => {
      if (limit && rows.length >= limit) return;
      rows.push(row);
    });
    stream.on("end", () => resolve(rows));
    stream.on("error", reject);
  });
}

async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const _ of rl) count++;
  return count - 1; // subtract header
}

// ─── DDL ─────────────────────────────────────────────────────────────

const DDL_SQL = `
-- Ensure search_path includes extensions
SET search_path TO 'public', 'extensions';

-- ═══════════════════════════════════════════════════
-- STATUS TYPES
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS status_types_v2 (
  status_code   text    PRIMARY KEY,
  status_type   text    NOT NULL CHECK (status_type IN ('purchase', 'sales')),
  status_text   text    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- PRODUCT CATEGORIES
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_categories_v2 (
  category_code   text    PRIMARY KEY,
  category_name   text    NOT NULL,
  level           smallint NOT NULL CHECK (level IN (1, 2, 3)),
  parent_code     text    REFERENCES product_categories_v2(category_code),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- BRANCHES
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS branches_v2 (
  id                bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_branch_code text    UNIQUE NOT NULL,
  name              text,
  active            boolean  NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- CUSTOMERS
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS customers_v2 (
  id               bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kunnr     text     UNIQUE NOT NULL,
  ico              text,
  dic              text,
  name             text     NOT NULL,
  address          text,
  sperr            text,
  loevm            text,
  search_vector    tsvector,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- PRODUCTS V2
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS products_v2 (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_matnr         text        UNIQUE NOT NULL,
  sku                  text        UNIQUE NOT NULL,
  name                 text        NOT NULL,
  unit                 text,
  supplier_name        text,

  category_code        text        REFERENCES product_categories_v2(category_code),
  category_main        text,
  category_sub         text,
  category_line        text,

  status_purchase_code text,
  status_sales_code    text,
  status_purchase_text text,
  status_sales_text    text,

  dispo                text,
  is_stock_item        boolean     NOT NULL DEFAULT false,
  description          text,
  thumbnail_url        text,

  source_ean_raw       text,
  source_idnlf_raw     text,

  search_hints         text,

  removed_at           timestamptz,
  search_vector        tsvector,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- PRODUCT IDENTIFIERS
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_identifiers_v2 (
  id               bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       bigint   NOT NULL REFERENCES products_v2(id) ON DELETE RESTRICT,
  identifier_type  text     NOT NULL CHECK (identifier_type IN ('EAN', 'IDNLF')),
  identifier_value text     NOT NULL,

  UNIQUE (product_id, identifier_type, identifier_value)
);

-- ═══════════════════════════════════════════════════
-- PRODUCT PRICE
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_price_v2 (
  product_id       bigint      PRIMARY KEY REFERENCES products_v2(id) ON DELETE RESTRICT,
  current_price    numeric(12,2) NOT NULL,
  currency         text        NOT NULL DEFAULT 'CZK',
  batch_id         bigint,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- PRODUCT BRANCH STOCK
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_branch_stock_v2 (
  product_id       bigint      NOT NULL REFERENCES products_v2(id) ON DELETE RESTRICT,
  branch_id        bigint      NOT NULL REFERENCES branches_v2(id) ON DELETE RESTRICT,
  stock_qty        numeric(12,3) NOT NULL CHECK (stock_qty > 0),
  batch_id         bigint,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (product_id, branch_id)
);

-- ═══════════════════════════════════════════════════
-- PRODUCT EMBEDDINGS V2
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_embeddings_v2 (
  product_id       bigint    PRIMARY KEY REFERENCES products_v2(id) ON DELETE RESTRICT,
  sku              text      NOT NULL,
  embedding        vector(256) NOT NULL,
  embedding_text   text,
  model_version    text      NOT NULL DEFAULT 'text-embedding-3-small-256',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════
-- IMPORT BATCHES
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS import_batches_v2 (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_name      text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running', 'completed', 'failed')),
  row_count_products integer,
  row_count_prices   integer,
  row_count_stock    integer,
  row_count_identifiers integer,
  error_message    text,
  metadata         jsonb       DEFAULT '{}'
);
`;

// ─── POST-LOAD: Indexes ─────────────────────────────────────────────

const POST_INDEXES_SQL = `
SET statement_timeout = '3600s';
SET search_path TO 'public', 'extensions';

-- products_v2
CREATE INDEX IF NOT EXISTS idx_products_v2_search ON products_v2 USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_products_v2_name_trgm ON products_v2 USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_v2_sku_trgm ON products_v2 USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_v2_category ON products_v2 (category_code) WHERE category_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_v2_supplier ON products_v2 (supplier_name) WHERE supplier_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_v2_not_removed ON products_v2 (removed_at) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_v2_stock_item ON products_v2 (is_stock_item) WHERE is_stock_item = true;

-- product_identifiers_v2
CREATE INDEX IF NOT EXISTS idx_identifiers_v2_product ON product_identifiers_v2 (product_id);
CREATE INDEX IF NOT EXISTS idx_identifiers_v2_value ON product_identifiers_v2 (identifier_value);

-- product_branch_stock_v2
CREATE INDEX IF NOT EXISTS idx_branch_stock_v2_branch ON product_branch_stock_v2 (branch_id);

-- customers_v2
CREATE INDEX IF NOT EXISTS idx_customers_v2_ico ON customers_v2 (ico) WHERE ico IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_v2_name_trgm ON customers_v2 USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_v2_address_trgm ON customers_v2 USING gin (address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_v2_search ON customers_v2 USING gin (search_vector);

-- product_embeddings_v2
CREATE INDEX IF NOT EXISTS idx_pe_v2_sku ON product_embeddings_v2 (sku);
`;

const POST_HNSW_SQL = `
SET statement_timeout = '7200s';
SET search_path TO 'public', 'extensions';

CREATE INDEX IF NOT EXISTS idx_pe_v2_hnsw ON product_embeddings_v2
  USING hnsw (embedding vector_cosine_ops) WITH (m = 24, ef_construction = 200);
`;

// ─── POST-LOAD: Trigger ─────────────────────────────────────────────

const POST_TRIGGER_SQL = `
SET search_path TO 'public', 'extensions';

CREATE OR REPLACE FUNCTION products_v2_search_vector_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public', 'extensions' AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.sku, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.search_hints, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.supplier_name, '')), 'B') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_main, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_sub, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_line, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.description, '')), 'D');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_v2_search_vector ON products_v2;
CREATE TRIGGER trg_products_v2_search_vector
  BEFORE INSERT OR UPDATE OF name, supplier_name, category_main, category_sub, category_line, description, sku, search_hints
  ON products_v2
  FOR EACH ROW EXECUTE FUNCTION products_v2_search_vector_update();

-- Customer search_vector trigger
CREATE OR REPLACE FUNCTION customers_v2_search_vector_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public', 'extensions' AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.source_kunnr, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.ico, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.address, '')), 'B');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_v2_search_vector ON customers_v2;
CREATE TRIGGER trg_customers_v2_search_vector
  BEFORE INSERT OR UPDATE OF name, source_kunnr, ico, address
  ON customers_v2
  FOR EACH ROW EXECUTE FUNCTION customers_v2_search_vector_update();
`;

// ─── POST-LOAD: RPC Functions ────────────────────────────────────────

const POST_RPC_SEMANTIC = `
SET search_path TO 'public', 'extensions';

CREATE OR REPLACE FUNCTION search_products_v2_semantic(
  query_embedding     vector,
  max_results         integer DEFAULT 10,
  similarity_threshold double precision DEFAULT 0.5,
  manufacturer_filter text DEFAULT NULL,
  category_filter     text DEFAULT NULL,
  stock_item_only     boolean DEFAULT false,
  in_stock_only       boolean DEFAULT false,
  branch_code_filter  text DEFAULT NULL
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  cosine_similarity double precision
)
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '10s'
AS $$
DECLARE
  safe_manufacturer text;
BEGIN
  IF in_stock_only OR branch_code_filter IS NOT NULL THEN
    SET LOCAL hnsw.ef_search = 1000;
  ELSE
    SET LOCAL hnsw.ef_search = 200;
  END IF;

  safe_manufacturer := replace(replace(replace(
    manufacturer_filter, '\\', '\\\\'), '%', '\\%'), '_', '\\_');

  RETURN QUERY
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    (1 - (pe.embedding <=> query_embedding))::double precision AS cosine_similarity
  FROM product_embeddings_v2 pe
  JOIN products_v2 p ON p.id = pe.product_id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.removed_at IS NULL
    AND (1 - (pe.embedding <=> query_embedding)) > similarity_threshold
    AND (manufacturer_filter IS NULL
         OR p.supplier_name ILIKE '%' || safe_manufacturer || '%')
    AND (category_filter IS NULL
         OR p.category_code = category_filter
         OR p.category_code LIKE category_filter || '%')
    AND (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id
        AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY pe.embedding <=> query_embedding
  LIMIT max_results;
END;
$$;
`;

const POST_RPC_FULLTEXT = `
SET search_path TO 'public', 'extensions';

CREATE OR REPLACE FUNCTION search_products_v2_fulltext(
  search_query        text,
  max_results         integer DEFAULT 20,
  manufacturer_filter text DEFAULT NULL,
  category_filter     text DEFAULT NULL,
  stock_item_only     boolean DEFAULT false,
  in_stock_only       boolean DEFAULT false,
  branch_code_filter  text DEFAULT NULL
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  rank             real,
  similarity_score real
)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '5s'
AS $$
DECLARE
  sanitized       TEXT;
  safe_mfr        TEXT;
  ts_q            TSQUERY;
  ts_prefix       TSQUERY;
  prefix_str      TEXT;
BEGIN
  sanitized := trim(unaccent(search_query));
  sanitized := regexp_replace(sanitized, '([ABCDKZabcdkz])([0-9]+)[xX×]([0-9]+)',
    '\\2P \\1\\3', 'g');
  ts_q := plainto_tsquery('public.cs_unaccent', sanitized);
  prefix_str := regexp_replace(
    trim(regexp_replace(sanitized, '\\s+', ' ', 'g')),
    '(\\S+)', '\\1:*', 'g');
  prefix_str := replace(prefix_str, ' ', ' & ');
  BEGIN
    ts_prefix := to_tsquery('public.cs_unaccent', prefix_str);
  EXCEPTION WHEN OTHERS THEN
    ts_prefix := NULL;
  END;

  safe_mfr := replace(replace(replace(
    manufacturer_filter, '\\', '\\\\'), '%', '\\%'), '_', '\\_');

  RETURN QUERY
  WITH candidates AS (
    SELECT p.id FROM products_v2 p
    WHERE p.removed_at IS NULL
      AND (manufacturer_filter IS NULL
           OR p.supplier_name ILIKE '%' || safe_mfr || '%')
      AND (category_filter IS NULL
           OR p.category_code = category_filter
           OR p.category_code LIKE category_filter || '%')
      AND (p.sku = sanitized
           OR EXISTS (
             SELECT 1 FROM product_identifiers_v2 pi
             WHERE pi.product_id = p.id AND pi.identifier_value = sanitized
           )
           OR (ts_q::TEXT <> '' AND p.search_vector @@ ts_q)
           OR (ts_prefix IS NOT NULL AND p.search_vector @@ ts_prefix))
    LIMIT max_results * 10
  )
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    GREATEST(
      COALESCE(ts_rank_cd(p.search_vector, ts_q), 0),
      COALESCE(ts_rank_cd(p.search_vector, ts_prefix), 0) * 0.8
    )::REAL AS rank,
    GREATEST(
      similarity(p.name, sanitized),
      similarity(COALESCE(p.sku, ''), sanitized)
    )::REAL AS similarity_score
  FROM candidates c
  JOIN products_v2 p ON p.id = c.id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY
    CASE WHEN p.sku = sanitized THEN 0 ELSE 1 END,
    GREATEST(
      COALESCE(ts_rank_cd(p.search_vector, ts_q), 0),
      COALESCE(ts_rank_cd(p.search_vector, ts_prefix), 0) * 0.8
    ) DESC,
    GREATEST(
      similarity(p.name, sanitized),
      similarity(COALESCE(p.sku, ''), sanitized)
    ) DESC
  LIMIT max_results;
END;
$$;
`;

const POST_RPC_CATEGORY_TREE = `
SET search_path TO 'public', 'extensions';

CREATE OR REPLACE FUNCTION get_category_tree_v2()
RETURNS TABLE(
  category_code text,
  category_name text,
  level smallint,
  parent_code text,
  product_count bigint
)
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $$
  SELECT
    c.category_code,
    c.category_name,
    c.level,
    c.parent_code,
    count(p.id) AS product_count
  FROM product_categories_v2 c
  LEFT JOIN products_v2 p ON p.category_code = c.category_code AND p.removed_at IS NULL
  GROUP BY c.category_code, c.category_name, c.level, c.parent_code
  HAVING count(p.id) > 0
  ORDER BY c.category_code;
$$;
`;

const POST_RPC_BY_IDS = `
SET search_path TO 'public', 'extensions';

CREATE OR REPLACE FUNCTION get_products_v2_by_ids(
  product_ids bigint[]
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  status_purchase_text text,
  status_sales_text    text
)
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $$
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    p.status_purchase_text,
    p.status_sales_text
  FROM products_v2 p
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.id = ANY(product_ids);
$$;
`;

// ─── LOAD FUNCTIONS ──────────────────────────────────────────────────

async function loadStatusTypes(client: InstanceType<typeof pg.Client>, limit?: number) {
  const rows = await readCsvRows<{ status_code: string; status_type: string; status_text: string }>(
    FILES.statusTypes, limit,
  );
  if (rows.length === 0) return 0;

  const codes = rows.map(r => r.status_code);
  const types = rows.map(r => r.status_type);
  const texts = rows.map(r => r.status_text);

  await client.query(`
    INSERT INTO status_types_v2 (status_code, status_type, status_text)
    SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[])
    ON CONFLICT (status_code) DO NOTHING
  `, [codes, types, texts]);

  return rows.length;
}

async function loadCategories(client: InstanceType<typeof pg.Client>, limit?: number) {
  const rows = await readCsvRows<{
    category_code: string; category_name: string; level: string; parent_code: string;
  }>(FILES.categories, limit);
  if (rows.length === 0) return 0;

  // Sort by level to ensure parents exist before children (FK)
  rows.sort((a, b) => parseInt(a.level) - parseInt(b.level));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const codes = batch.map(r => r.category_code);
    const names = batch.map(r => r.category_name);
    const levels = batch.map(r => parseInt(r.level));
    const parents = batch.map(r => r.parent_code || null);

    await client.query(`
      INSERT INTO product_categories_v2 (category_code, category_name, level, parent_code)
      SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::smallint[]), unnest($4::text[])
      ON CONFLICT (category_code) DO NOTHING
    `, [codes, names, levels, parents]);
  }

  return rows.length;
}

async function loadBranches(client: InstanceType<typeof pg.Client>, limit?: number) {
  const rows = await readCsvRows<{ source_branch_code: string; name: string }>(
    FILES.branches, limit,
  );
  if (rows.length === 0) return 0;

  const codes = rows.map(r => r.source_branch_code);
  const names = rows.map(r => r.name || null);

  await client.query(`
    INSERT INTO branches_v2 (source_branch_code, name)
    SELECT unnest($1::text[]), unnest($2::text[])
    ON CONFLICT (source_branch_code) DO NOTHING
  `, [codes, names]);

  return rows.length;
}

async function loadProducts(
  client: InstanceType<typeof pg.Client>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rows = await readCsvRows<Record<string, string>>(FILES.products, limit);
  if (rows.length === 0) return 0;

  let loaded = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await client.query(`
      INSERT INTO products_v2 (
        source_matnr, sku, name, unit, supplier_name,
        category_code, category_main, category_sub, category_line,
        status_purchase_code, status_sales_code,
        status_purchase_text, status_sales_text,
        dispo, is_stock_item, description, thumbnail_url,
        source_ean_raw, source_idnlf_raw, search_hints
      )
      SELECT
        unnest($1::text[]),  unnest($2::text[]),  unnest($3::text[]),
        unnest($4::text[]),  unnest($5::text[]),  unnest($6::text[]),
        unnest($7::text[]),  unnest($8::text[]),  unnest($9::text[]),
        unnest($10::text[]), unnest($11::text[]), unnest($12::text[]),
        unnest($13::text[]), unnest($14::text[]), unnest($15::boolean[]),
        unnest($16::text[]), unnest($17::text[]), unnest($18::text[]),
        unnest($19::text[]), unnest($20::text[])
      ON CONFLICT (source_matnr) DO NOTHING
    `, [
      batch.map(r => r.source_matnr),
      batch.map(r => r.sku),
      batch.map(r => r.name),
      batch.map(r => r.unit || null),
      batch.map(r => r.supplier_name || null),
      batch.map(r => r.category_code || null),
      batch.map(r => r.category_main || null),
      batch.map(r => r.category_sub || null),
      batch.map(r => r.category_line || null),
      batch.map(r => r.status_purchase_code || null),
      batch.map(r => r.status_sales_code || null),
      batch.map(r => r.status_purchase_text || null),
      batch.map(r => r.status_sales_text || null),
      batch.map(r => r.dispo || null),
      batch.map(r => r.is_stock_item === "true"),
      batch.map(r => r.description || null),
      batch.map(r => r.thumbnail_url || null),
      batch.map(r => r.source_ean_raw || null),
      batch.map(r => r.source_idnlf_raw || null),
      batch.map(r => r.search_hints || null),
    ]);

    loaded += batch.length;
    if (onProgress) onProgress(loaded);
  }

  return loaded;
}

async function buildMatnrIdMap(client: InstanceType<typeof pg.Client>): Promise<Map<string, number>> {
  const { rows } = await client.query<{ id: number; source_matnr: string }>(
    `SELECT id, source_matnr FROM products_v2`,
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.source_matnr, r.id);
  return map;
}

async function buildBranchIdMap(client: InstanceType<typeof pg.Client>): Promise<Map<string, number>> {
  const { rows } = await client.query<{ id: number; source_branch_code: string }>(
    `SELECT id, source_branch_code FROM branches_v2`,
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.source_branch_code, r.id);
  return map;
}

async function loadIdentifiers(
  client: InstanceType<typeof pg.Client>,
  matnrMap: Map<string, number>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rows = await readCsvRows<{
    source_matnr: string; identifier_type: string; identifier_value: string;
  }>(FILES.identifiers, limit);
  if (rows.length === 0) return 0;

  let loaded = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const productIds: number[] = [];
    const types: string[] = [];
    const values: string[] = [];

    for (const r of batch) {
      const pid = matnrMap.get(r.source_matnr);
      if (!pid) { skipped++; continue; }
      productIds.push(pid);
      types.push(r.identifier_type);
      values.push(r.identifier_value);
    }

    if (productIds.length > 0) {
      await client.query(`
        INSERT INTO product_identifiers_v2 (product_id, identifier_type, identifier_value)
        SELECT unnest($1::bigint[]), unnest($2::text[]), unnest($3::text[])
        ON CONFLICT (product_id, identifier_type, identifier_value) DO NOTHING
      `, [productIds, types, values]);
    }

    loaded += batch.length;
    if (onProgress) onProgress(loaded);
  }
  if (skipped > 0) console.log(`    (${fmt(skipped)} identifiers skipped — no matching product)`);

  return loaded;
}

async function loadPrices(
  client: InstanceType<typeof pg.Client>,
  matnrMap: Map<string, number>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rows = await readCsvRows<{
    source_matnr: string; current_price: string; currency: string;
  }>(FILES.prices, limit);
  if (rows.length === 0) return 0;

  let loaded = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const productIds: number[] = [];
    const prices: number[] = [];
    const currencies: string[] = [];

    for (const r of batch) {
      const pid = matnrMap.get(r.source_matnr);
      if (!pid) { skipped++; continue; }
      productIds.push(pid);
      prices.push(parseFloat(r.current_price));
      currencies.push(r.currency || "CZK");
    }

    if (productIds.length > 0) {
      await client.query(`
        INSERT INTO product_price_v2 (product_id, current_price, currency)
        SELECT unnest($1::bigint[]), unnest($2::numeric[]), unnest($3::text[])
        ON CONFLICT (product_id) DO NOTHING
      `, [productIds, prices, currencies]);
    }

    loaded += batch.length;
    if (onProgress) onProgress(loaded);
  }
  if (skipped > 0) console.log(`    (${fmt(skipped)} prices skipped — no matching product)`);

  return loaded;
}

async function loadStock(
  client: InstanceType<typeof pg.Client>,
  matnrMap: Map<string, number>,
  branchMap: Map<string, number>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rows = await readCsvRows<{
    source_matnr: string; branch_code: string; stock_qty: string;
  }>(FILES.stock, limit);
  if (rows.length === 0) return 0;

  let loaded = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const productIds: number[] = [];
    const branchIds: number[] = [];
    const qtys: number[] = [];

    for (const r of batch) {
      const pid = matnrMap.get(r.source_matnr);
      const bid = branchMap.get(r.branch_code);
      if (!pid || !bid) { skipped++; continue; }
      productIds.push(pid);
      branchIds.push(bid);
      qtys.push(parseFloat(r.stock_qty));
    }

    if (productIds.length > 0) {
      await client.query(`
        INSERT INTO product_branch_stock_v2 (product_id, branch_id, stock_qty)
        SELECT unnest($1::bigint[]), unnest($2::bigint[]), unnest($3::numeric[])
        ON CONFLICT (product_id, branch_id) DO NOTHING
      `, [productIds, branchIds, qtys]);
    }

    loaded += batch.length;
    if (onProgress) onProgress(loaded);
  }
  if (skipped > 0) console.log(`    (${fmt(skipped)} stock rows skipped — no matching product/branch)`);

  return loaded;
}

async function loadCustomers(
  client: InstanceType<typeof pg.Client>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rows = await readCsvRows<{
    source_kunnr: string; ico: string; dic: string;
    name: string; address: string; sperr: string; loevm: string;
  }>(FILES.customers, limit);
  if (rows.length === 0) return 0;

  let loaded = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await client.query(`
      INSERT INTO customers_v2 (source_kunnr, ico, dic, name, address, sperr, loevm)
      SELECT
        unnest($1::text[]), unnest($2::text[]), unnest($3::text[]),
        unnest($4::text[]), unnest($5::text[]), unnest($6::text[]),
        unnest($7::text[])
      ON CONFLICT (source_kunnr) DO NOTHING
    `, [
      batch.map(r => r.source_kunnr),
      batch.map(r => r.ico || null),
      batch.map(r => r.dic || null),
      batch.map(r => r.name),
      batch.map(r => r.address || null),
      batch.map(r => r.sperr || null),
      batch.map(r => r.loevm || null),
    ]);

    loaded += batch.length;
    if (onProgress) onProgress(loaded);
  }

  return loaded;
}

async function loadEmbeddings(
  client: InstanceType<typeof pg.Client>,
  matnrMap: Map<string, number>,
  limit?: number,
  onProgress?: (loaded: number) => void,
) {
  const rl = readline.createInterface({
    input: fs.createReadStream(FILES.embeddings),
    crlfDelay: Infinity,
  });

  let loaded = 0;
  let skipped = 0;
  let errors = 0;

  let batchProductIds: number[] = [];
  let batchSkus: string[] = [];
  let batchEmbVectors: string[] = [];
  let batchTexts: string[] = [];
  const EMB_BATCH = 200;

  const flushBatch = async () => {
    if (batchProductIds.length === 0) return;
    try {
      await client.query(`
        INSERT INTO product_embeddings_v2 (product_id, sku, embedding, embedding_text)
        SELECT unnest($1::bigint[]), unnest($2::text[]),
               unnest($3::text[])::vector,
               unnest($4::text[])
        ON CONFLICT (product_id) DO NOTHING
      `, [batchProductIds, batchSkus, batchEmbVectors, batchTexts]);
    } catch (err: any) {
      // Fallback: insert one-by-one
      for (let j = 0; j < batchProductIds.length; j++) {
        try {
          await client.query(`
            INSERT INTO product_embeddings_v2 (product_id, sku, embedding, embedding_text)
            VALUES ($1, $2, $3::vector, $4)
            ON CONFLICT (product_id) DO NOTHING
          `, [batchProductIds[j], batchSkus[j], batchEmbVectors[j], batchTexts[j]]);
        } catch {
          errors++;
        }
      }
    }
    batchProductIds = [];
    batchSkus = [];
    batchEmbVectors = [];
    batchTexts = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (limit && loaded >= limit) break;

    try {
      const obj = JSON.parse(line) as {
        source_matnr: string; sku: string;
        embedding: number[]; embedding_text: string;
      };

      const pid = matnrMap.get(obj.source_matnr);
      if (!pid) { skipped++; continue; }

      batchProductIds.push(pid);
      batchSkus.push(obj.sku);
      batchEmbVectors.push(`[${obj.embedding.join(",")}]`);
      batchTexts.push(obj.embedding_text || "");

      loaded++;

      if (batchProductIds.length >= EMB_BATCH) {
        await flushBatch();
        if (onProgress) onProgress(loaded);
      }
    } catch {
      errors++;
    }
  }
  await flushBatch();
  if (onProgress) onProgress(loaded);

  if (skipped > 0) console.log(`    (${fmt(skipped)} embeddings skipped — no matching product)`);
  if (errors > 0) console.log(`    (${fmt(errors)} embedding parse/insert errors)`);

  return loaded;
}

// ─── BACKFILL SEARCH VECTORS ─────────────────────────────────────────

async function backfillSearchVectors(client: InstanceType<typeof pg.Client>) {
  console.log("  Backfilling search_vector for products_v2...");
  const t = Date.now();
  await client.query(`SET statement_timeout = '3600s'`);
  await client.query(`
    UPDATE products_v2 SET search_vector =
      setweight(to_tsvector('public.cs_unaccent', coalesce(sku, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(search_hints, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(supplier_name, '')), 'B') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(category_main, '')), 'C') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(category_sub, '')), 'C') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(category_line, '')), 'C') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(description, '')), 'D')
    WHERE search_vector IS NULL
  `);
  console.log(`  search_vector backfill done in ${elapsed(t)}`);

  console.log("  Backfilling search_vector for customers_v2...");
  const t2 = Date.now();
  await client.query(`
    UPDATE customers_v2 SET search_vector =
      setweight(to_tsvector('public.cs_unaccent', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(source_kunnr, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(ico, '')), 'A') ||
      setweight(to_tsvector('public.cs_unaccent', coalesce(address, '')), 'B')
    WHERE search_vector IS NULL
  `);
  console.log(`  customer search_vector backfill done in ${elapsed(t2)}`);
}

// ─── VALIDATION ──────────────────────────────────────────────────────

async function runValidation(client: InstanceType<typeof pg.Client>) {
  console.log("\n  Row counts:");
  const { rows: counts } = await client.query(`
    SELECT 'products_v2' AS tbl, count(*) AS cnt FROM products_v2
    UNION ALL SELECT 'product_price_v2', count(*) FROM product_price_v2
    UNION ALL SELECT 'product_branch_stock_v2', count(*) FROM product_branch_stock_v2
    UNION ALL SELECT 'product_identifiers_v2', count(*) FROM product_identifiers_v2
    UNION ALL SELECT 'product_categories_v2', count(*) FROM product_categories_v2
    UNION ALL SELECT 'branches_v2', count(*) FROM branches_v2
    UNION ALL SELECT 'customers_v2', count(*) FROM customers_v2
    UNION ALL SELECT 'status_types_v2', count(*) FROM status_types_v2
    UNION ALL SELECT 'product_embeddings_v2', count(*) FROM product_embeddings_v2
    ORDER BY 1
  `);
  for (const r of counts) {
    console.log(`    ${r.tbl.padEnd(30)} ${fmt(parseInt(r.cnt)).padStart(12)}`);
  }

  console.log("\n  FK integrity check:");
  const { rows: orphans } = await client.query(`
    SELECT 'orphan prices' AS chk, count(*) AS cnt
    FROM product_price_v2 pr LEFT JOIN products_v2 p ON p.id = pr.product_id WHERE p.id IS NULL
    UNION ALL
    SELECT 'orphan stock', count(*)
    FROM product_branch_stock_v2 bs LEFT JOIN products_v2 p ON p.id = bs.product_id WHERE p.id IS NULL
    UNION ALL
    SELECT 'orphan identifiers', count(*)
    FROM product_identifiers_v2 pi LEFT JOIN products_v2 p ON p.id = pi.product_id WHERE p.id IS NULL
    UNION ALL
    SELECT 'orphan embeddings', count(*)
    FROM product_embeddings_v2 pe LEFT JOIN products_v2 p ON p.id = pe.product_id WHERE p.id IS NULL
  `);
  for (const r of orphans) {
    const cnt = parseInt(r.cnt);
    console.log(`    ${r.chk.padEnd(25)} ${cnt === 0 ? "OK" : `${cnt} ORPHANS`}`);
  }

  console.log("\n  Sample products:");
  const { rows: sample } = await client.query(`
    SELECT p.source_matnr, p.sku, p.name, p.supplier_name,
           pr.current_price, p.category_main
    FROM products_v2 p
    LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
    ORDER BY random()
    LIMIT 5
  `);
  for (const r of sample) {
    console.log(`    ${r.sku} | ${(r.name || "").substring(0, 40)} | ${r.current_price ?? "no price"} | ${r.supplier_name ?? ""}`);
  }

  console.log("\n  Stock coverage:");
  const { rows: [stockInfo] } = await client.query(`
    SELECT count(DISTINCT product_id) AS products_with_stock FROM product_branch_stock_v2
  `);
  console.log(`    Products with stock: ${fmt(parseInt(stockInfo.products_with_stock))}`);
}

// ─── MAIN ────────────────────────────────────────────────────────────

async function main() {
  const { phase, test } = parseArgs();
  const limit = test ? 100 : undefined;

  console.log(`
════════════════════════════════════════════════════════════
  KV Offer Manager — V2 Bulk Load
════════════════════════════════════════════════════════════
  Phase: ${phase}
  Mode:  ${test ? "TEST (100 rows per table)" : "FULL"}
`);

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("SUPABASE_DB_URL not set in .env");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  const globalStart = Date.now();

  try {
    await client.query(`SET statement_timeout = '600s'`);
    await client.query(`SET lock_timeout = '60s'`);

    // ── DDL ────────────────────────────────────────
    if (phase === "ddl" || phase === "all") {
      console.log("── Phase: DDL ──────────────────────────────────");
      const t = Date.now();
      await client.query(DDL_SQL);
      console.log(`  Tables created in ${elapsed(t)}`);
    }

    // ── LOAD ───────────────────────────────────────
    if (phase === "load" || phase === "all") {
      console.log("\n── Phase: LOAD ─────────────────────────────────");
      await client.query(`SET statement_timeout = '3600s'`);

      const progress = (label: string, total?: number) => {
        let lastLog = 0;
        return (loaded: number) => {
          if (loaded - lastLog >= 50_000 || loaded === total) {
            const pct = total ? ` (${((loaded / total) * 100).toFixed(1)}%)` : "";
            console.log(`    ${label}: ${fmt(loaded)}${pct}`);
            lastLog = loaded;
          }
        };
      };

      // 1. Lookups — always load ALL rows (tiny tables, FK dependencies)
      let t = Date.now();
      const nSt = await loadStatusTypes(client);
      console.log(`  status_types_v2: ${fmt(nSt)} rows (${elapsed(t)})`);

      t = Date.now();
      const nCat = await loadCategories(client);
      console.log(`  categories_v2: ${fmt(nCat)} rows (${elapsed(t)})`);

      t = Date.now();
      const nBr = await loadBranches(client);
      console.log(`  branches_v2: ${fmt(nBr)} rows (${elapsed(t)})`);

      // 2. Products
      t = Date.now();
      const totalProducts = limit ?? await countLines(FILES.products);
      const nProd = await loadProducts(client, limit, progress("products_v2", totalProducts));
      console.log(`  products_v2: ${fmt(nProd)} rows (${elapsed(t)})`);

      // 3. Build MATNR→ID and branch→ID maps
      console.log("  Building ID maps...");
      t = Date.now();
      const matnrMap = await buildMatnrIdMap(client);
      const branchMap = await buildBranchIdMap(client);
      console.log(`  ID maps built: ${fmt(matnrMap.size)} products, ${fmt(branchMap.size)} branches (${elapsed(t)})`);

      // 4. Identifiers
      t = Date.now();
      const totalIdent = limit ?? await countLines(FILES.identifiers);
      const nIdent = await loadIdentifiers(client, matnrMap, limit, progress("identifiers", totalIdent));
      console.log(`  identifiers_v2: ${fmt(nIdent)} rows (${elapsed(t)})`);

      // 5. Prices
      t = Date.now();
      const totalPrices = limit ?? await countLines(FILES.prices);
      const nPrices = await loadPrices(client, matnrMap, limit, progress("prices", totalPrices));
      console.log(`  prices_v2: ${fmt(nPrices)} rows (${elapsed(t)})`);

      // 6. Stock
      t = Date.now();
      const totalStock = limit ?? await countLines(FILES.stock);
      const nStock = await loadStock(client, matnrMap, branchMap, limit, progress("stock", totalStock));
      console.log(`  stock_v2: ${fmt(nStock)} rows (${elapsed(t)})`);

      // 7. Customers
      t = Date.now();
      const totalCust = limit ?? await countLines(FILES.customers);
      const nCust = await loadCustomers(client, limit, progress("customers", totalCust));
      console.log(`  customers_v2: ${fmt(nCust)} rows (${elapsed(t)})`);

      // 8. Embeddings
      t = Date.now();
      console.log("  Loading embeddings (this may take a while)...");
      const nEmb = await loadEmbeddings(client, matnrMap, limit, progress("embeddings"));
      console.log(`  embeddings_v2: ${fmt(nEmb)} rows (${elapsed(t)})`);
    }

    // ── POST ───────────────────────────────────────
    if (phase === "post" || phase === "all") {
      console.log("\n── Phase: POST (indexes + triggers + RPCs) ─────");

      // Backfill search vectors BEFORE creating GIN indexes on them
      await backfillSearchVectors(client);

      // Indexes
      console.log("  Creating secondary indexes...");
      let t = Date.now();
      await client.query(POST_INDEXES_SQL);
      console.log(`  Secondary indexes created in ${elapsed(t)}`);

      // HNSW (can be slow)
      console.log("  Creating HNSW index (may take 5-30 min)...");
      t = Date.now();
      await client.query(POST_HNSW_SQL);
      console.log(`  HNSW index created in ${elapsed(t)}`);

      // Triggers
      console.log("  Creating triggers...");
      t = Date.now();
      await client.query(POST_TRIGGER_SQL);
      console.log(`  Triggers created in ${elapsed(t)}`);

      // RPC functions
      console.log("  Creating RPC functions...");
      t = Date.now();
      await client.query(POST_RPC_SEMANTIC);
      await client.query(POST_RPC_FULLTEXT);
      await client.query(POST_RPC_CATEGORY_TREE);
      await client.query(POST_RPC_BY_IDS);
      console.log(`  RPC functions created in ${elapsed(t)}`);
    }

    // ── VALIDATE ───────────────────────────────────
    if (phase === "validate" || phase === "all") {
      console.log("\n── Phase: VALIDATE ─────────────────────────────");
      await runValidation(client);
    }

    console.log(`
════════════════════════════════════════════════════════════
  DONE in ${elapsed(globalStart)}
════════════════════════════════════════════════════════════
`);
  } catch (err: any) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    if (err.detail) console.error(`  Detail: ${err.detail}`);
    if (err.hint) console.error(`  Hint: ${err.hint}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
