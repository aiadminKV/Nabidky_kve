\timing on
\set ON_ERROR_STOP on

-- Safe-ish HNSW build for small Supabase compute.
-- Run this only through DIRECT connection, not the pooler.
-- Monitor progress with: data-model/hnsw-monitor.sql

SET application_name = 'hnsw_build_v2_safe';
SET search_path TO 'public', 'extensions';
SET client_min_messages TO NOTICE;

-- No timeout for this admin task.
SET statement_timeout = '0';
SET lock_timeout = '30s';
SET idle_in_transaction_session_timeout = '0';

-- Conservative setting for the upgraded small tier.
-- Higher than default (128MB), but still leaves headroom for the database.
SET maintenance_work_mem = '512MB';
SET max_parallel_maintenance_workers = 1;

SHOW statement_timeout;
SHOW maintenance_work_mem;
SHOW max_parallel_maintenance_workers;

-- Official pgvector defaults:
-- m = 16
-- ef_construction = 64
--
-- Why these values:
-- - they are the pgvector quality baseline, not a degraded mode
-- - much lower IO and build cost than our previous 24 / 200 attempt
-- - query quality can still be improved later with hnsw.ef_search at read time
CREATE INDEX IF NOT EXISTS idx_pe_v2_hnsw
  ON product_embeddings_v2
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
