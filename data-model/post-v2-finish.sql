\timing on
\set ON_ERROR_STOP on

SET application_name = 'post_v2_finish';
SET search_path TO 'public', 'extensions';
SET statement_timeout = '0';
SET lock_timeout = '30s';

-- Supports identifier contains lookup without forcing seq scan
CREATE INDEX IF NOT EXISTS idx_identifiers_v2_value_trgm
  ON product_identifiers_v2 USING gin (identifier_value gin_trgm_ops);

-- Products search_vector trigger
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

-- Customers search_vector trigger
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

-- Semantic search
CREATE OR REPLACE FUNCTION search_products_v2_semantic(
  query_embedding      vector,
  max_results          integer DEFAULT 10,
  similarity_threshold double precision DEFAULT 0.5,
  manufacturer_filter  text DEFAULT NULL,
  category_filter      text DEFAULT NULL,
  stock_item_only      boolean DEFAULT false,
  in_stock_only        boolean DEFAULT false,
  branch_code_filter   text DEFAULT NULL
)
RETURNS TABLE(
  id                bigint,
  sku               text,
  name              text,
  unit              text,
  current_price     numeric,
  supplier_name     text,
  category_main     text,
  category_sub      text,
  category_line     text,
  is_stock_item     boolean,
  has_stock         boolean,
  removed_at        timestamptz,
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
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    (1 - (pe.embedding <=> query_embedding))::double precision AS cosine_similarity
  FROM product_embeddings_v2 pe
  JOIN products_v2 p ON p.id = pe.product_id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.removed_at IS NULL
    AND (1 - (pe.embedding <=> query_embedding)) > similarity_threshold
    AND (manufacturer_filter IS NULL OR p.supplier_name ILIKE '%' || safe_manufacturer || '%')
    AND (category_filter IS NULL OR p.category_code = category_filter OR p.category_code LIKE category_filter || '%')
    AND (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1
      FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY pe.embedding <=> query_embedding
  LIMIT max_results;
END;
$$;

-- Fulltext search
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
  sanitized  text;
  safe_mfr   text;
  ts_q       tsquery;
  ts_prefix  tsquery;
  prefix_str text;
BEGIN
  sanitized := trim(unaccent(search_query));
  sanitized := regexp_replace(sanitized, '([ABCDKZabcdkz])([0-9]+)[xX×]([0-9]+)', '\2P \1\3', 'g');
  ts_q := plainto_tsquery('public.cs_unaccent', sanitized);
  prefix_str := regexp_replace(trim(regexp_replace(sanitized, '\s+', ' ', 'g')), '(\S+)', '\1:*', 'g');
  prefix_str := replace(prefix_str, ' ', ' & ');
  BEGIN
    ts_prefix := to_tsquery('public.cs_unaccent', prefix_str);
  EXCEPTION WHEN OTHERS THEN
    ts_prefix := NULL;
  END;

  safe_mfr := replace(replace(replace(
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH candidates AS (
    SELECT p.id
    FROM products_v2 p
    WHERE p.removed_at IS NULL
      AND (manufacturer_filter IS NULL OR p.supplier_name ILIKE '%' || safe_mfr || '%')
      AND (category_filter IS NULL OR p.category_code = category_filter OR p.category_code LIKE category_filter || '%')
      AND (
        (ts_q::text <> '' AND p.search_vector @@ ts_q)
        OR (ts_prefix IS NOT NULL AND p.search_vector @@ ts_prefix)
      )
    LIMIT max_results * 10
  )
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    GREATEST(
      COALESCE(ts_rank_cd(p.search_vector, ts_q), 0),
      COALESCE(ts_rank_cd(p.search_vector, ts_prefix), 0) * 0.8
    )::real AS rank,
    GREATEST(
      similarity(p.name, sanitized),
      similarity(COALESCE(p.sku, ''), sanitized)
    )::real AS similarity_score
  FROM candidates c
  JOIN products_v2 p ON p.id = c.id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1
      FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY
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

-- Exact / identifier lookup
CREATE OR REPLACE FUNCTION lookup_products_v2_exact(
  lookup_query text,
  max_results integer DEFAULT 20,
  include_removed boolean DEFAULT false
)
RETURNS TABLE(
  id bigint,
  sku text,
  name text,
  unit text,
  current_price numeric,
  supplier_name text,
  category_main text,
  category_sub text,
  category_line text,
  is_stock_item boolean,
  has_stock boolean,
  removed_at timestamptz,
  match_type text,
  matched_value text
)
LANGUAGE plpgsql
SET statement_timeout TO '5s'
AS $$
DECLARE
  sanitized text;
  safe_lookup text;
BEGIN
  sanitized := trim(unaccent(lookup_query));
  safe_lookup := replace(replace(replace(
    sanitized, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH matches AS (
    SELECT
      p.id AS product_id,
      1 AS priority,
      'sku_exact'::text AS found_match_type,
      p.sku AS found_match_value
    FROM products_v2 p
    WHERE p.sku = sanitized
      AND (include_removed OR p.removed_at IS NULL)

    UNION ALL

    SELECT
      p.id AS product_id,
      2 AS priority,
      lower(pi.identifier_type) || '_exact' AS found_match_type,
      pi.identifier_value AS found_match_value
    FROM product_identifiers_v2 pi
    JOIN products_v2 p ON p.id = pi.product_id
    WHERE pi.identifier_value = sanitized
      AND (include_removed OR p.removed_at IS NULL)

    UNION ALL

    SELECT
      p.id AS product_id,
      3 AS priority,
      lower(pi.identifier_type) || '_contains' AS found_match_type,
      pi.identifier_value AS found_match_value
    FROM product_identifiers_v2 pi
    JOIN products_v2 p ON p.id = pi.product_id
    WHERE length(sanitized) >= 6
      AND pi.identifier_value ILIKE '%' || safe_lookup || '%' ESCAPE '\'
      AND (include_removed OR p.removed_at IS NULL)
  ),
  ranked AS (
    SELECT DISTINCT ON (product_id)
      product_id,
      priority,
      found_match_type AS resolved_match_type,
      found_match_value AS resolved_match_value
    FROM matches
    ORDER BY product_id, priority, length(found_match_value)
  )
  SELECT
    p.id,
    p.sku,
    p.name,
    p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main,
    p.category_sub,
    p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    r.resolved_match_type,
    r.resolved_match_value
  FROM ranked r
  JOIN products_v2 p ON p.id = r.product_id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  ORDER BY r.priority, p.sku
  LIMIT max_results;
END;
$$;

-- Category tree
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
    NULL::bigint AS product_count
  FROM product_categories_v2 c
  ORDER BY c.category_code;
$$;

-- Product detail including removed products
CREATE OR REPLACE FUNCTION get_products_v2_by_ids(product_ids bigint[])
RETURNS TABLE(
  id bigint,
  sku text,
  name text,
  unit text,
  current_price numeric,
  supplier_name text,
  category_main text,
  category_sub text,
  category_line text,
  is_stock_item boolean,
  has_stock boolean,
  removed_at timestamptz,
  status_purchase_text text,
  status_sales_text text
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
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    p.status_purchase_text,
    p.status_sales_text
  FROM products_v2 p
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.id = ANY(product_ids);
$$;
\timing on
\set ON_ERROR_STOP on

SET application_name = 'post_v2_finish';
SET search_path TO 'public', 'extensions';
SET statement_timeout = '0';
SET lock_timeout = '30s';

-- Product search_vector trigger
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

-- RPCs
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
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

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
         OR p.supplier_name ILIKE '%' || safe_manufacturer || '%' ESCAPE '\')
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
    '\2P \1\3', 'g');
  ts_q := plainto_tsquery('public.cs_unaccent', sanitized);
  prefix_str := regexp_replace(
    trim(regexp_replace(sanitized, '\s+', ' ', 'g')),
    '(\S+)', '\1:*', 'g');
  prefix_str := replace(prefix_str, ' ', ' & ');
  BEGIN
    ts_prefix := to_tsquery('public.cs_unaccent', prefix_str);
  EXCEPTION WHEN OTHERS THEN
    ts_prefix := NULL;
  END;

  safe_mfr := replace(replace(replace(
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH candidates AS (
    SELECT p.id FROM products_v2 p
    WHERE p.removed_at IS NULL
      AND (manufacturer_filter IS NULL
           OR p.supplier_name ILIKE '%' || safe_mfr || '%' ESCAPE '\')
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
