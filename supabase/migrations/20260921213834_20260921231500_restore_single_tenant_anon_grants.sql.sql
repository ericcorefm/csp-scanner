/*
  Restore database privileges for intentional single-tenant / no-auth mode.

  Root cause fixed here:
  20260921164017_20260921140000_add_user_auth_and_ownership.sql executed
  REVOKE ALL ... FROM anon on the app's personal tables. Later migrations restored
  permissive RLS policies, but RLS policies do not restore PostgreSQL table grants.
  Therefore the browser (anon role) could still receive "permission denied" when
  loading strategy_profiles, causing the app-wide "Failed to load" screen.
*/

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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
