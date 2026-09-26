
/*
  Candidate scan persistence compatibility for the intentional no-auth build.
  This is idempotent and safe to apply after earlier auth/no-auth migrations.
*/

ALTER TABLE IF EXISTS public.candidate_scans
  DROP COLUMN IF EXISTS user_id CASCADE;

ALTER TABLE IF EXISTS public.candidate_scans
  ALTER COLUMN stock_price DROP NOT NULL;

ALTER TABLE IF EXISTS public.candidate_scans
  ADD COLUMN IF NOT EXISTS secondary_support numeric,
  ADD COLUMN IF NOT EXISTS resistance numeric,
  ADD COLUMN IF NOT EXISTS strike_distance_from_stock numeric,
  ADD COLUMN IF NOT EXISTS strike_distance_from_support numeric,
  ADD COLUMN IF NOT EXISTS has_quotes boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS stock_source text,
  ADD COLUMN IF NOT EXISTS premium_source text;

ALTER TABLE IF EXISTS public.candidate_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "insert_own_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "update_own_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "delete_own_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "select_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "insert_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "update_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "delete_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "anon_select_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "anon_insert_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "anon_update_candidate_scans" ON public.candidate_scans;
DROP POLICY IF EXISTS "anon_delete_candidate_scans" ON public.candidate_scans;

CREATE POLICY "select_candidate_scans"
  ON public.candidate_scans FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_candidate_scans"
  ON public.candidate_scans FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_candidate_scans"
  ON public.candidate_scans FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_candidate_scans"
  ON public.candidate_scans FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.candidate_scans TO anon, authenticated;
