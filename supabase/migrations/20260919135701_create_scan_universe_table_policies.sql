CREATE TABLE IF NOT EXISTS scan_universe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE scan_universe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_scan_universe" ON scan_universe;
CREATE POLICY "anon_select_scan_universe" ON scan_universe FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_scan_universe" ON scan_universe;
CREATE POLICY "anon_insert_scan_universe" ON scan_universe FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_scan_universe" ON scan_universe;
CREATE POLICY "anon_update_scan_universe" ON scan_universe FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_scan_universe" ON scan_universe;
CREATE POLICY "anon_delete_scan_universe" ON scan_universe FOR DELETE
  TO anon, authenticated USING (true);