/*
# Stock Scanner tables

Adds the Stocks side of the app. Completely separate from the CSP (options)
tables, so tuning stock rules can never change CSP results.

1. stock_profiles — saved stock strategy profiles. Rules live in one jsonb
   column so new rules can be added without schema changes.
2. stock_scans — one row per completed stock scan (results + counts as jsonb).
   The app loads the latest row per scan mode on startup.

Security: same intentional single-tenant / no-auth model as the rest of the app
(RLS enabled, anon + authenticated allowed).
*/

CREATE TABLE IF NOT EXISTS stock_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_profiles_name_uidx ON stock_profiles(name);

CREATE TABLE IF NOT EXISTS stock_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_mode text NOT NULL DEFAULT 'discovery',
  profile_id uuid REFERENCES stock_profiles(id) ON DELETE SET NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stock_scans_mode_time_idx ON stock_scans(scan_mode, scanned_at DESC);

ALTER TABLE stock_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_stock_profiles" ON stock_profiles;
DROP POLICY IF EXISTS "insert_stock_profiles" ON stock_profiles;
DROP POLICY IF EXISTS "update_stock_profiles" ON stock_profiles;
DROP POLICY IF EXISTS "delete_stock_profiles" ON stock_profiles;
CREATE POLICY "select_stock_profiles" ON stock_profiles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_stock_profiles" ON stock_profiles FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_stock_profiles" ON stock_profiles FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_stock_profiles" ON stock_profiles FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "select_stock_scans" ON stock_scans;
DROP POLICY IF EXISTS "insert_stock_scans" ON stock_scans;
DROP POLICY IF EXISTS "update_stock_scans" ON stock_scans;
DROP POLICY IF EXISTS "delete_stock_scans" ON stock_scans;
CREATE POLICY "select_stock_scans" ON stock_scans FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_stock_scans" ON stock_scans FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_stock_scans" ON stock_scans FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_stock_scans" ON stock_scans FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stock_profiles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stock_scans TO anon, authenticated;