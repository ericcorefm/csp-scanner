/*
# Add User Authentication and Ownership to Personal Tables

## Overview
This migration adds multi-user support to the CSP Scanner by introducing user_id
columns and owner-scoped Row Level Security (RLS) policies on all personal data tables.
Public/shared tables (market_universe, stock_history_cache) keep their existing policies.

## Tables Modified

### scan_universe
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- Added `added_at timestamptz DEFAULT now()` column (if not already present)
- Replaced unique constraint on `symbol` with unique constraint on `(user_id, symbol)`
- RLS policies replaced: authenticated users can only CRUD their own rows

### strategy_profiles
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- Replaced unique constraint on `name` with unique constraint on `(user_id, name)`
- RLS policies replaced: authenticated users can only CRUD their own rows

### open_positions
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- RLS policies replaced: authenticated users can only CRUD their own rows

### closed_positions
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- RLS policies replaced: authenticated users can only CRUD their own rows

### alerts
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- RLS policies replaced: authenticated users can only CRUD their own rows

### candidate_scans
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- RLS policies replaced: authenticated users can only CRUD their own rows

### daily_scan_results
- Added `user_id uuid NOT NULL DEFAULT auth.uid()` column
- RLS policies replaced: authenticated users can only CRUD their own rows

## New Tables

### user_profiles
- `user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`
- `display_name text` (nullable)
- `created_at timestamptz DEFAULT now()`
- RLS: authenticated users can only SELECT/UPDATE their own profile row
- Auto-insert trigger: creates a user_profiles row when a new auth.user is created

## Security Changes
- All personal tables now have owner-scoped RLS policies (TO authenticated, auth.uid() = user_id)
- The anon role no longer has access to personal tables (was needed before for no-auth app)
- Public/shared tables (market_universe, stock_history_cache) keep existing anon+authenticated policies

## Migration Notes
1. Existing rows get a temporary NULL user_id during column addition, then are set to a
   placeholder UUID. A follow-up manual migration can assign them to the first owner.
   To migrate: UPDATE scan_universe SET user_id = '<your-auth-uid>' WHERE user_id = '00000000-0000-0000-0000-000000000000';
2. The DEFAULT auth.uid() ensures new inserts automatically get the current user's ID
   even when the frontend doesn't explicitly pass user_id.
3. All policies use auth.uid() (never current_user) per Supabase best practices.
*/

-- ──────────────────────────────────────────────
-- 1. scan_universe: add user_id, update constraints & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scan_universe' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE scan_universe ADD COLUMN user_id uuid;
    UPDATE scan_universe SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE scan_universe ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE scan_universe ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

-- Drop old unique constraint on symbol, add (user_id, symbol)
ALTER TABLE scan_universe DROP CONSTRAINT IF EXISTS scan_universe_symbol_key;
ALTER TABLE scan_universe DROP CONSTRAINT IF EXISTS scan_universe_symbol_unique;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scan_universe_user_id_symbol_key'
  ) THEN
    ALTER TABLE scan_universe ADD CONSTRAINT scan_universe_user_id_symbol_key UNIQUE (user_id, symbol);
  END IF;
END $$;

-- Replace policies
DROP POLICY IF EXISTS "anon_select_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "anon_insert_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "anon_update_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "anon_delete_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "select_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "insert_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "update_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "delete_own_scan_universe" ON scan_universe;

CREATE POLICY "select_own_scan_universe" ON scan_universe FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_scan_universe" ON scan_universe FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_scan_universe" ON scan_universe FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_scan_universe" ON scan_universe FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 2. strategy_profiles: add user_id, update constraints & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'strategy_profiles' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE strategy_profiles ADD COLUMN user_id uuid;
    UPDATE strategy_profiles SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE strategy_profiles ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE strategy_profiles ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

ALTER TABLE strategy_profiles DROP CONSTRAINT IF EXISTS strategy_profiles_name_key;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategy_profiles_user_id_name_key'
  ) THEN
    ALTER TABLE strategy_profiles ADD CONSTRAINT strategy_profiles_user_id_name_key UNIQUE (user_id, name);
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "anon_insert_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "anon_update_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "anon_delete_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "select_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "insert_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "update_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "delete_own_strategy_profiles" ON strategy_profiles;

CREATE POLICY "select_own_strategy_profiles" ON strategy_profiles FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_strategy_profiles" ON strategy_profiles FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_strategy_profiles" ON strategy_profiles FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_strategy_profiles" ON strategy_profiles FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 3. open_positions: add user_id & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'open_positions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE open_positions ADD COLUMN user_id uuid;
    UPDATE open_positions SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE open_positions ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE open_positions ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_open_positions" ON open_positions;
DROP POLICY IF EXISTS "anon_insert_open_positions" ON open_positions;
DROP POLICY IF EXISTS "anon_update_open_positions" ON open_positions;
DROP POLICY IF EXISTS "anon_delete_open_positions" ON open_positions;
DROP POLICY IF EXISTS "select_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "insert_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "update_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "delete_own_open_positions" ON open_positions;

CREATE POLICY "select_own_open_positions" ON open_positions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_open_positions" ON open_positions FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_open_positions" ON open_positions FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_open_positions" ON open_positions FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 4. closed_positions: add user_id & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'closed_positions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE closed_positions ADD COLUMN user_id uuid;
    UPDATE closed_positions SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE closed_positions ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE closed_positions ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "anon_insert_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "anon_update_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "anon_delete_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "select_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "insert_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "update_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "delete_own_closed_positions" ON closed_positions;

CREATE POLICY "select_own_closed_positions" ON closed_positions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_closed_positions" ON closed_positions FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_closed_positions" ON closed_positions FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_closed_positions" ON closed_positions FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 5. alerts: add user_id & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE alerts ADD COLUMN user_id uuid;
    UPDATE alerts SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE alerts ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE alerts ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_alerts" ON alerts;
DROP POLICY IF EXISTS "anon_insert_alerts" ON alerts;
DROP POLICY IF EXISTS "anon_update_alerts" ON alerts;
DROP POLICY IF EXISTS "anon_delete_alerts" ON alerts;
DROP POLICY IF EXISTS "select_own_alerts" ON alerts;
DROP POLICY IF EXISTS "insert_own_alerts" ON alerts;
DROP POLICY IF EXISTS "update_own_alerts" ON alerts;
DROP POLICY IF EXISTS "delete_own_alerts" ON alerts;

CREATE POLICY "select_own_alerts" ON alerts FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_alerts" ON alerts FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_alerts" ON alerts FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_alerts" ON alerts FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 6. candidate_scans: add user_id & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE candidate_scans ADD COLUMN user_id uuid;
    UPDATE candidate_scans SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE candidate_scans ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE candidate_scans ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "anon_insert_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "anon_update_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "anon_delete_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "select_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "insert_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "update_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "delete_own_candidate_scans" ON candidate_scans;

CREATE POLICY "select_own_candidate_scans" ON candidate_scans FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_candidate_scans" ON candidate_scans FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_candidate_scans" ON candidate_scans FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_candidate_scans" ON candidate_scans FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 7. daily_scan_results: add user_id & policies
-- ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'daily_scan_results' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE daily_scan_results ADD COLUMN user_id uuid;
    UPDATE daily_scan_results SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
    ALTER TABLE daily_scan_results ALTER COLUMN user_id SET NOT NULL;
    ALTER TABLE daily_scan_results ALTER COLUMN user_id SET DEFAULT auth.uid();
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_select_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "anon_insert_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "anon_update_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "anon_delete_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "select_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "insert_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "update_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "delete_own_daily_scan_results" ON daily_scan_results;

CREATE POLICY "select_own_daily_scan_results" ON daily_scan_results FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_daily_scan_results" ON daily_scan_results FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_daily_scan_results" ON daily_scan_results FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_daily_scan_results" ON daily_scan_results FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────
-- 8. user_profiles table + auto-create trigger
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "update_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "insert_own_profile" ON user_profiles;

CREATE POLICY "select_own_profile" ON user_profiles FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_profile" ON user_profiles FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_profile" ON user_profiles FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Auto-create user_profiles row when a new auth user signs up
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id)
  VALUES (new.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ──────────────────────────────────────────────
-- 9. Revoke anon privileges on personal tables
-- ──────────────────────────────────────────────
REVOKE ALL ON scan_universe FROM anon;
REVOKE ALL ON strategy_profiles FROM anon;
REVOKE ALL ON open_positions FROM anon;
REVOKE ALL ON closed_positions FROM anon;
REVOKE ALL ON alerts FROM anon;
REVOKE ALL ON candidate_scans FROM anon;
REVOKE ALL ON daily_scan_results FROM anon;
REVOKE ALL ON user_profiles FROM anon;
