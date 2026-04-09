-- Migration: Enable RLS on products_v2
-- Must be run during a maintenance window via Supabase Dashboard SQL Editor
-- (MCP timeout is too short for this large table)
--
-- All other catalog tables already have RLS + authenticated_read policy.

-- Step 1: Enable RLS
ALTER TABLE public.products_v2 ENABLE ROW LEVEL SECURITY;

-- Step 2: Allow authenticated users to read
CREATE POLICY "authenticated_read"
  ON public.products_v2
  FOR SELECT
  TO authenticated
  USING (true);
