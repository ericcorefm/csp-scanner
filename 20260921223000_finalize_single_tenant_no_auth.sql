/*
  Finalize the intentional single-tenant/no-auth configuration.

  A prior auth migration added NOT NULL user_id columns whose default is auth.uid().
  In anonymous mode auth.uid() is NULL, so inserts (including creation of the default
  strategy profile) can fail even though later RLS policies allow anon CRUD.

  This migration removes those ownership columns/constraints and restores the
  original single-tenant uniqueness rules.
*/

DROP TABLE IF EXISTS user_profiles CASCADE;
DROP TABLE IF EXISTS admin_users CASCADE;

-- scan_universe
ALTER TABLE IF EXISTS scan_universe DROP CONSTRAINT IF EXISTS scan_universe_user_id_symbol_key;
ALTER TABLE IF EXISTS scan_universe DROP COLUMN IF EXISTS user_id;
DELETE FROM scan_universe a USING scan_universe b
WHERE a.symbol = b.symbol AND a.ctid < b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS scan_universe_symbol_single_tenant_idx ON scan_universe(symbol);

-- strategy_profiles
ALTER TABLE IF EXISTS strategy_profiles DROP CONSTRAINT IF EXISTS strategy_profiles_user_id_name_key;
ALTER TABLE IF EXISTS strategy_profiles DROP COLUMN IF EXISTS user_id;
DELETE FROM strategy_profiles a USING strategy_profiles b
WHERE a.name = b.name AND a.ctid < b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_profiles_name_single_tenant_idx ON strategy_profiles(name);

-- Remaining personal tables no longer have per-user ownership in single-tenant mode.
ALTER TABLE IF EXISTS open_positions DROP COLUMN IF EXISTS user_id;
ALTER TABLE IF EXISTS closed_positions DROP COLUMN IF EXISTS user_id;
ALTER TABLE IF EXISTS alerts DROP COLUMN IF EXISTS user_id;
ALTER TABLE IF EXISTS candidate_scans DROP COLUMN IF EXISTS user_id;
ALTER TABLE IF EXISTS daily_scan_results DROP COLUMN IF EXISTS user_id;

-- Ensure the open anon/authenticated policies from the no-auth migration exist.
-- Recreate defensively in case the auth migration was the last applied migration.
DO $$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'strategy_profiles','candidate_scans','open_positions','closed_positions',
    'daily_scan_results','alerts','scan_universe','market_universe','stock_history_cache'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', 'select_' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon, authenticated WITH CHECK (true)', 'insert_' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)', 'update_' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon, authenticated USING (true)', 'delete_' || t, t);
  END LOOP;
END $$;
