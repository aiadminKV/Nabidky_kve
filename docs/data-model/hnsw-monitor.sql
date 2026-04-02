-- HNSW build monitoring for product_embeddings_v2
-- Paste individual queries into Supabase SQL editor as needed.

-- 1) Main progress view
SELECT
  pid,
  phase,
  round(100.0 * blocks_done / nullif(blocks_total, 0), 1) AS progress_pct,
  blocks_done,
  blocks_total,
  tuples_done,
  tuples_total,
  now() - (
    SELECT query_start
    FROM pg_stat_activity
    WHERE pid = pg_stat_progress_create_index.pid
  ) AS running_for
FROM pg_stat_progress_create_index;

-- 2) Active HNSW workers
SELECT
  pid,
  state,
  wait_event_type,
  wait_event,
  now() - query_start AS running_for
FROM pg_stat_activity
WHERE query ILIKE '%hnsw%'
  AND pid <> pg_backend_pid();

-- 3) Has the HNSW index appeared yet?
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'product_embeddings_v2'
  AND indexname ILIKE '%hnsw%';

-- 4) Current on-disk size around embeddings table
SELECT
  pg_size_pretty(pg_relation_size('product_embeddings_v2')) AS table_data,
  pg_size_pretty(
    pg_total_relation_size('product_embeddings_v2') - pg_relation_size('product_embeddings_v2')
  ) AS table_indexes,
  pg_size_pretty(pg_total_relation_size('product_embeddings_v2')) AS table_total,
  pg_size_pretty(pg_database_size(current_database())) AS database_total;

-- 5) Quick health snapshot
SELECT
  count(*) FILTER (WHERE state = 'active') AS active_queries,
  count(*) FILTER (WHERE wait_event_type = 'IO') AS io_wait_queries,
  count(*) AS total_other_sessions
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid();

-- 6) Use this after the build finishes
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'product_embeddings_v2'
ORDER BY indexname;
