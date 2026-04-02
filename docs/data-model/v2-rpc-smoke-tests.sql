\timing on
\set ON_ERROR_STOP on

SET search_path TO 'public', 'extensions';
SET statement_timeout = '30s';

-- Sample fixtures used by this smoke test
-- exact lookup by SKU
--   sku: 1386822
-- exact lookup by EAN
--   ean: 4049504220657 -> sku: 1975430
-- stocked product for stock/branch filters
--   sku: 1189526 at branch WH_1002

SELECT 'exact_lookup_sku_top1' AS test_name,
       CASE
         WHEN (SELECT sku FROM lookup_products_v2_exact('1386822', 5) LIMIT 1) = '1386822'
         THEN 'OK' ELSE 'FAIL'
       END AS result;

SELECT sku, name, match_type, matched_value
FROM lookup_products_v2_exact('1386822', 5);

SELECT 'exact_lookup_ean_top1' AS test_name,
       CASE
         WHEN (SELECT sku FROM lookup_products_v2_exact('4049504220657', 5) LIMIT 1) = '1975430'
         THEN 'OK' ELSE 'FAIL'
       END AS result;

SELECT sku, name, match_type, matched_value
FROM lookup_products_v2_exact('4049504220657', 5);

SELECT 'fulltext_partial_name_has_rows' AS test_name,
       CASE
         WHEN (SELECT count(*) FROM search_products_v2_fulltext('led driver', 5)) > 0
         THEN 'OK' ELSE 'FAIL'
       END AS result;

SELECT sku, name, rank, similarity_score
FROM search_products_v2_fulltext('led driver', 5);

SELECT 'semantic_same_embedding_top1' AS test_name,
       CASE
         WHEN (
           WITH q AS (
             SELECT embedding
             FROM product_embeddings_v2
             WHERE sku = '1386822'
           )
           SELECT sku
           FROM search_products_v2_semantic((SELECT embedding FROM q), 5, 0.1)
           LIMIT 1
         ) = '1386822'
         THEN 'OK' ELSE 'FAIL'
       END AS result;

WITH q AS (
  SELECT embedding
  FROM product_embeddings_v2
  WHERE sku = '1386822'
)
SELECT sku, name, round(cosine_similarity::numeric, 4) AS cosine_similarity, has_stock
FROM search_products_v2_semantic((SELECT embedding FROM q), 5, 0.1);

SELECT 'semantic_in_stock_only_all_true' AS test_name,
       CASE
         WHEN (
           WITH q AS (
             SELECT embedding
             FROM product_embeddings_v2
             WHERE sku = '1189526'
           ),
           r AS (
             SELECT *
             FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1, NULL, NULL, false, true, NULL)
           )
           SELECT count(*) = count(*) FILTER (WHERE has_stock)
           FROM r
         )
         THEN 'OK' ELSE 'FAIL'
       END AS result;

WITH q AS (
  SELECT embedding
  FROM product_embeddings_v2
  WHERE sku = '1189526'
)
SELECT sku, name, has_stock, cosine_similarity
FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1, NULL, NULL, false, true, NULL);

SELECT 'semantic_branch_filter_only_wh_1002' AS test_name,
       CASE
         WHEN (
           WITH q AS (
             SELECT embedding
             FROM product_embeddings_v2
             WHERE sku = '1189526'
           ),
           r AS (
             SELECT *
             FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1, NULL, NULL, false, false, 'WH_1002')
           )
           SELECT count(*) > 0
           FROM r
         )
         THEN 'OK' ELSE 'FAIL'
       END AS result;

WITH q AS (
  SELECT embedding
  FROM product_embeddings_v2
  WHERE sku = '1189526'
)
SELECT sku, name, has_stock, cosine_similarity
FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1, NULL, NULL, false, false, 'WH_1002');

SELECT 'category_tree_has_rows' AS test_name,
       CASE
         WHEN (SELECT count(*) FROM get_category_tree_v2()) > 0
         THEN 'OK' ELSE 'FAIL'
       END AS result;

SELECT *
FROM get_category_tree_v2()
LIMIT 5;

SELECT 'get_products_v2_by_ids_returns_rows' AS test_name,
       CASE
         WHEN (
           SELECT count(*)
           FROM get_products_v2_by_ids(ARRAY[
             (SELECT id FROM products_v2 WHERE sku = '1386822'),
             (SELECT id FROM products_v2 WHERE sku = '1189526')
           ])
         ) = 2
         THEN 'OK' ELSE 'FAIL'
       END AS result;

SELECT id, sku, name, removed_at
FROM get_products_v2_by_ids(ARRAY[
  (SELECT id FROM products_v2 WHERE sku = '1386822'),
  (SELECT id FROM products_v2 WHERE sku = '1189526')
]);

-- Timing-oriented smoke checks
EXPLAIN ANALYZE
SELECT *
FROM lookup_products_v2_exact('1386822', 10);

EXPLAIN ANALYZE
SELECT *
FROM lookup_products_v2_exact('4049504220657', 10);

EXPLAIN ANALYZE
WITH q AS (
  SELECT embedding
  FROM product_embeddings_v2
  WHERE sku = '1386822'
)
SELECT *
FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1);

EXPLAIN ANALYZE
WITH q AS (
  SELECT embedding
  FROM product_embeddings_v2
  WHERE sku = '1189526'
)
SELECT *
FROM search_products_v2_semantic((SELECT embedding FROM q), 10, 0.1, NULL, NULL, false, true, 'WH_1002');
