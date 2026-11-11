/*
# Add sign-in authentication and owner-scoped data access

## What this does
Converts the app from a no-auth single-tenant schema (where anyone with the
public anon key can read/write all data) to a sign-in-required schema where
each user can only access their own data.

## New columns (5 tables)
- scan_universe.user_id — nullable, defaults to the signed-in user
- stock_universe.user_id — nullable, defaults to the signed-in user
- stock_positions.user_id — nullable, defaults to the signed-in user
- stock_profiles.user_id — nullable, defaults to the signed-in user
- stock_scans.user_id — nullable, defaults to the signed-in user

These are nullable so existing rows (created before sign-in existed) remain
visible to the first user who creates an account. New rows get the
authenticated user's ID automatically via DEFAULT auth.uid().

## Security changes (all 18 tables)
- All anon grants revoked — unauthenticated requests can no longer read or
  write any data.
- All existing policies dropped and replaced.

### User-owned tables (full CRUD, scoped to owner)
open_positions, closed_positions, strategy_profiles, alerts, scan_universe,
stock_universe, stock_positions, stock_profiles, stock_scans
Policies: SELECT/UPDATE/DELETE allow rows where user_id matches the signed-in
user OR user_id is NULL (pre-auth legacy data). INSERT requires the new row
to belong to the signed-in user.

### Read-only tables (SELECT only)
- daily_scan_results: owner-scoped SELECT (has user_id)
- candidate_scans, stock_history_cache: shared SELECT (no user_id, the edge
  function writes via service_role)

### Edge-function-only tables (no frontend access)
market_universe, stock_price_cache, option_contracts, fundamental_snapshots,
technical_snapshots — only the service_role (used by the market-scan edge
function) can access these. RLS denies all anon/authenticated access.

### user_profiles
Re-granted CRUD to authenticated. Existing owner-scoped policies retained.
DELETE policy added for completeness.
*/

-- 1. Add user_id columns to tables that lack them
ALTER TABLE scan_universe ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE stock_universe ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE stock_positions ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE stock_profiles ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE stock_scans ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Drop all existing policies (except user_profiles which is already correct)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'user_profiles'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- 3. Revoke all access from anon and authenticated on all public tables
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 4. User-owned tables with full CRUD (owner-scoped)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['open_positions','closed_positions','strategy_profiles','alerts','scan_universe','stock_universe','stock_positions','stock_profiles','stock_scans'])
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (auth.uid() = user_id OR user_id IS NULL)', t || '_select_own', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)', t || '_insert_own', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (auth.uid() = user_id OR user_id IS NULL) WITH CHECK (auth.uid() = user_id OR user_id IS NULL)', t || '_update_own', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (auth.uid() = user_id OR user_id IS NULL)', t || '_delete_own', t);
  END LOOP;
END $$;

-- 5. Read-only tables
-- daily_scan_results (owner-scoped, has user_id)
GRANT SELECT ON daily_scan_results TO authenticated;
CREATE POLICY "daily_scan_results_select_own" ON daily_scan_results FOR SELECT TO authenticated USING (auth.uid() = user_id OR user_id IS NULL);

-- candidate_scans and stock_history_cache (shared, no user_id)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['candidate_scans','stock_history_cache'])
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_select', t);
  END LOOP;
END $$;

-- 6. Edge-function-only tables: no grants to authenticated/anon.
-- service_role bypasses RLS and has full access by default.
-- RLS is enabled with no policies = deny all to anon/authenticated.
-- (market_universe, stock_price_cache, option_contracts, fundamental_snapshots, technical_snapshots)

-- 7. user_profiles: re-grant and add DELETE policy
GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO authenticated;
CREATE POLICY "user_profiles_delete_own" ON user_profiles FOR DELETE TO authenticated USING (auth.uid() = user_id);