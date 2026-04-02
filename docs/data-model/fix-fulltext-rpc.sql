-- Fix fulltext search RPC: add unicode normalization and trigram fallback
-- Already applied to production DB on 2026-03-24
-- Run this on Supabase SQL Editor if not yet applied

-- 1. Add trigram index on products_v2.name (enables trigram similarity in WHERE)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_v2_name_trgm
  ON products_v2 USING gin (name gin_trgm_ops);

-- 2. Replace fulltext search RPC with improved version
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
SET statement_timeout TO '8s'
AS $$
DECLARE
  sanitized  text;
  safe_mfr   text;
  ts_q       tsquery;
  ts_prefix  tsquery;
  prefix_str text;
BEGIN
  -- IMPORTANT: unicode replacements BEFORE unaccent (unaccent turns × into *)
  sanitized := search_query;
  sanitized := replace(sanitized, '×', 'x');
  sanitized := replace(sanitized, E'\u2013', '-');
  sanitized := replace(sanitized, E'\u2014', '-');
  sanitized := trim(unaccent(sanitized));
  sanitized := regexp_replace(sanitized, '(\d)\s*mm[²2]', '\1', 'gi');
  sanitized := regexp_replace(sanitized, '\s+', ' ', 'g');
  sanitized := trim(sanitized);

  -- Build tsquery variants
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
  WITH ts_candidates AS (
    SELECT p.id AS pid
    FROM products_v2 p
    WHERE p.removed_at IS NULL
      AND (manufacturer_filter IS NULL OR p.supplier_name ILIKE '%' || safe_mfr || '%')
      AND (category_filter IS NULL OR p.category_code = category_filter OR p.category_code LIKE category_filter || '%')
      AND (
           EXISTS (SELECT 1 FROM product_identifiers_v2 pi WHERE pi.product_id = p.id AND pi.identifier_value = sanitized)
        OR (ts_q::text <> '' AND p.search_vector @@ ts_q)
        OR (ts_prefix IS NOT NULL AND p.search_vector @@ ts_prefix)
      )
    LIMIT max_results * 10
  ),
  trgm_candidates AS (
    SELECT p.id AS pid
    FROM products_v2 p
    WHERE NOT EXISTS (SELECT 1 FROM ts_candidates)
      AND p.removed_at IS NULL
      AND (manufacturer_filter IS NULL OR p.supplier_name ILIKE '%' || safe_mfr || '%')
      AND (category_filter IS NULL OR p.category_code = category_filter OR p.category_code LIKE category_filter || '%')
      AND length(sanitized) >= 3
      AND p.name % sanitized
    ORDER BY similarity(p.name, sanitized) DESC
    LIMIT max_results * 3
  ),
  all_candidates AS (
    SELECT pid FROM ts_candidates
    UNION
    SELECT pid FROM trgm_candidates
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
  FROM all_candidates c
  JOIN products_v2 p ON p.id = c.pid
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

-- 3. Fix exact lookup RPC (unicode normalization before unaccent)
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
  -- Unicode replacements BEFORE unaccent
  sanitized := lookup_query;
  sanitized := replace(sanitized, '×', 'x');
  sanitized := replace(sanitized, E'\u2013', '-');
  sanitized := replace(sanitized, E'\u2014', '-');
  sanitized := trim(unaccent(sanitized));

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
