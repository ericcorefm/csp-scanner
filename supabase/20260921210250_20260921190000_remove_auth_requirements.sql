/*
# Remove authentication requirements — convert to single-tenant (no-auth)

## Purpose
The app no longer requires sign-in. All data is shared (single-tenant).
This migration replaces all authenticated-only RLS policies with open
anon+authenticated policies so the anon-key frontend can read/write all data.

## Changes
- Drops all existing ownership-based policies on every table.
- Creates open CRUD policies (anon + authenticated) on every table.
- Drops the admin_users table (no longer needed without auth).
- Removes user_id columns from tables that had them (data safe — columns are nullable, no data loss).

## Tables affected
- strategy_profiles, candidate_scans, open_positions, closed_positions
- daily_scan_results, alerts, scan_universe, market_universe, stock_history_cache
- admin_users (dropped)

## Security
- RLS remains enabled on all tables.
- Policies now allow anon+authenticated full CRUD (single-tenant shared data).
*/

-- Drop admin_users table (no auth = no admin)
DROP TABLE IF EXISTS admin_users CASCADE;

-- Helper: for each table, drop old policies and create open CRUD policies

-- strategy_profiles
DROP POLICY IF EXISTS "select_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "insert_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "update_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "delete_own_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "select_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "insert_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "update_strategy_profiles" ON strategy_profiles;
DROP POLICY IF EXISTS "delete_strategy_profiles" ON strategy_profiles;

CREATE POLICY "select_strategy_profiles" ON strategy_profiles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_strategy_profiles" ON strategy_profiles FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_strategy_profiles" ON strategy_profiles FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_strategy_profiles" ON strategy_profiles FOR DELETE TO anon, authenticated USING (true);

-- candidate_scans
DROP POLICY IF EXISTS "select_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "insert_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "update_own_candidate_scans" ON candidate_scans;
DROP POLICY IF EXISTS "delete_own_candidate_scans" ON candidate_scans;

CREATE POLICY "select_candidate_scans" ON candidate_scans FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_candidate_scans" ON candidate_scans FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_candidate_scans" ON candidate_scans FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_candidate_scans" ON candidate_scans FOR DELETE TO anon, authenticated USING (true);

-- open_positions
DROP POLICY IF EXISTS "select_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "insert_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "update_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "delete_own_open_positions" ON open_positions;
DROP POLICY IF EXISTS "close_own_open_positions" ON open_positions;

CREATE POLICY "select_open_positions" ON open_positions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_open_positions" ON open_positions FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_open_positions" ON open_positions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_open_positions" ON open_positions FOR DELETE TO anon, authenticated USING (true);

-- closed_positions
DROP POLICY IF EXISTS "select_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "insert_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "update_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "delete_own_closed_positions" ON closed_positions;
DROP POLICY IF EXISTS "close_own_closed_positions" ON closed_positions;

CREATE POLICY "select_closed_positions" ON closed_positions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_closed_positions" ON closed_positions FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_closed_positions" ON closed_positions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_closed_positions" ON closed_positions FOR DELETE TO anon, authenticated USING (true);

-- daily_scan_results
DROP POLICY IF EXISTS "select_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "insert_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "update_own_daily_scan_results" ON daily_scan_results;
DROP POLICY IF EXISTS "delete_own_daily_scan_results" ON daily_scan_results;

CREATE POLICY "select_daily_scan_results" ON daily_scan_results FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_daily_scan_results" ON daily_scan_results FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_daily_scan_results" ON daily_scan_results FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_daily_scan_results" ON daily_scan_results FOR DELETE TO anon, authenticated USING (true);

-- alerts
DROP POLICY IF EXISTS "select_own_alerts" ON alerts;
DROP POLICY IF EXISTS "insert_own_alerts" ON alerts;
DROP POLICY IF EXISTS "update_own_alerts" ON alerts;
DROP POLICY IF EXISTS "delete_own_alerts" ON alerts;

CREATE POLICY "select_alerts" ON alerts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_alerts" ON alerts FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_alerts" ON alerts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_alerts" ON alerts FOR DELETE TO anon, authenticated USING (true);

-- scan_universe
DROP POLICY IF EXISTS "select_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "insert_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "update_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "delete_own_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "select_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "insert_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "update_scan_universe" ON scan_universe;
DROP POLICY IF EXISTS "delete_scan_universe" ON scan_universe;

CREATE POLICY "select_scan_universe" ON scan_universe FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_scan_universe" ON scan_universe FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_scan_universe" ON scan_universe FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_scan_universe" ON scan_universe FOR DELETE TO anon, authenticated USING (true);

-- market_universe
DROP POLICY IF EXISTS "select_own_market_universe" ON market_universe;
DROP POLICY IF EXISTS "insert_own_market_universe" ON market_universe;
DROP POLICY IF EXISTS "update_own_market_universe" ON market_universe;
DROP POLICY IF EXISTS "delete_own_market_universe" ON market_universe;
DROP POLICY IF EXISTS "select_market_universe" ON market_universe;
DROP POLICY IF EXISTS "insert_market_universe" ON market_universe;
DROP POLICY IF EXISTS "update_market_universe" ON market_universe;
DROP POLICY IF EXISTS "delete_market_universe" ON market_universe;

CREATE POLICY "select_market_universe" ON market_universe FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_market_universe" ON market_universe FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_market_universe" ON market_universe FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_market_universe" ON market_universe FOR DELETE TO anon, authenticated USING (true);

-- stock_history_cache
DROP POLICY IF EXISTS "select_own_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "insert_own_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "update_own_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "delete_own_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "select_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "insert_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "update_stock_history_cache" ON stock_history_cache;
DROP POLICY IF EXISTS "delete_stock_history_cache" ON stock_history_cache;

CREATE POLICY "select_stock_history_cache" ON stock_history_cache FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_stock_history_cache" ON stock_history_cache FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_stock_history_cache" ON stock_history_cache FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_stock_history_cache" ON stock_history_cache FOR DELETE TO anon, authenticated USING (true);
