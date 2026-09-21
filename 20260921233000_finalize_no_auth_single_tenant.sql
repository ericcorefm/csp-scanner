
/*
  Finalize intentional no-auth / single-tenant mode.

  The earlier auth migration added user_id NOT NULL DEFAULT auth.uid() to
  personal tables. With no signed-in user, auth.uid() is NULL, so inserts such
  as candidate_scans can fail after a successful live scan ("Rescan failed").

  This migration removes those obsolete ownership columns and restores
  single-tenant uniqueness where appropriate.
*/

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'strategy_profiles',
    'candidate_scans',
    'open_positions',
    'closed_positions',
    'daily_scan_results',
    'alerts',
    'scan_universe'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS user_id CASCADE', t);
    END IF;
  END LOOP;
END $$;

-- Restore single-tenant uniqueness.
ALTER TABLE scan_universe DROP CONSTRAINT IF EXISTS scan_universe_user_id_symbol_key;
ALTER TABLE strategy_profiles DROP CONSTRAINT IF EXISTS strategy_profiles_user_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS scan_universe_symbol_single_tenant_uidx
  ON scan_universe(symbol);

CREATE UNIQUE INDEX IF NOT EXISTS strategy_profiles_name_single_tenant_uidx
  ON strategy_profiles(name);

-- RLS stays enabled; anon/authenticated are intentionally allowed in this no-auth app.
GRANT USAGE ON SCHEMA public TO anon, authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'strategy_profiles',
    'candidate_scans',
    'open_positions',
    'closed_positions',
    'daily_scan_results',
    'alerts',
    'scan_universe',
    'market_universe',
    'stock_history_cache'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO anon, authenticated',
        t
      );
    END IF;
  END LOOP;
END $$;
