-- Fix no-auth mode: drop user_id NOT NULL column from candidate_scans
-- The app no longer sends user_id (auth removed), causing 23502 not-null violations on INSERT.

ALTER TABLE public.candidate_scans
  DROP COLUMN IF EXISTS user_id CASCADE;

-- Ensure anon/authenticated have full CRUD grants (RLS policies are already permissive)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.candidate_scans TO anon, authenticated;
