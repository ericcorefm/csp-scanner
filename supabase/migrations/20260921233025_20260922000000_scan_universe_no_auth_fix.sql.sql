-- ============================================================
-- Fix scan_universe for no-auth / single-tenant mode
-- ============================================================

-- 1. Drop the (user_id, symbol) unique CONSTRAINT — it's unusable without auth
ALTER TABLE public.scan_universe
  DROP CONSTRAINT IF EXISTS scan_universe_user_id_symbol_key;

-- 2. Drop the user_id column entirely (no-auth build)
ALTER TABLE public.scan_universe
  DROP COLUMN IF EXISTS user_id CASCADE;

-- 3. Create a unique index on just symbol for single-tenant upserts
CREATE UNIQUE INDEX IF NOT EXISTS scan_universe_symbol_single_tenant_uidx
  ON public.scan_universe (symbol);

-- 4. Restore permissive anon+authenticated permissions
GRANT SELECT ON public.scan_universe TO anon, authenticated;
GRANT INSERT ON public.scan_universe TO anon, authenticated;
GRANT UPDATE ON public.scan_universe TO anon, authenticated;
GRANT DELETE ON public.scan_universe TO anon, authenticated;

-- 5. RLS: drop stale policies, recreate permissive ones for no-auth
ALTER TABLE public.scan_universe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_scan_universe ON public.scan_universe;
CREATE POLICY select_scan_universe ON public.scan_universe
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS insert_scan_universe ON public.scan_universe;
CREATE POLICY insert_scan_universe ON public.scan_universe
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS update_scan_universe ON public.scan_universe;
CREATE POLICY update_scan_universe ON public.scan_universe
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS delete_scan_universe ON public.scan_universe;
CREATE POLICY delete_scan_universe ON public.scan_universe
  FOR DELETE TO anon, authenticated USING (true);