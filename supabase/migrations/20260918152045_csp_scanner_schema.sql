/*
# CSP Scanner - Core Schema

1. New Tables
- `strategy_profiles`: Editable trading strategy rules (CROI, premium capture, strike limits, spread, RSI, commission, etc.)
- `option_contracts`: Cached option chain data (strike, bid, ask, IV, delta, volume, OI, expiration)
- `technical_snapshots`: Cached technical analysis (RSI, MACD, MAs, Bollinger Bands, support/resistance, trend)
- `fundamental_snapshots`: Cached fundamental data (revenue, growth, cash, debt, liquidity, outlook, risks)
- `candidate_scans`: Daily scan results — qualified and rejected candidates with rejection reasons
- `open_positions`: Currently open CSP positions with live tracking
- `closed_positions`: Historical closed trades with profit/CROI/annualized return
- `daily_scan_results`: Daily summary metrics (new/removed candidates, BTC targets, 120-day reviews)
- `alerts`: System alerts (support breaks, trend changes, BTC-ready, 120-day review)

2. Security
- Single-tenant app (no sign-in). RLS enabled on all tables.
- anon + authenticated CRUD on all tables (data is intentionally shared).

3. Notes
- All monetary values stored as numeric for precision.
- Strategy profile fields are numeric/text to allow full editability.
*/

-- Strategy Profiles
CREATE TABLE IF NOT EXISTS strategy_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'My CSP Default',
  is_default boolean NOT NULL DEFAULT false,
  order_type text NOT NULL DEFAULT 'LIMIT',
  max_strike numeric NOT NULL DEFAULT 25,
  min_net_croi numeric NOT NULL DEFAULT 3.5,
  preferred_croi_max numeric NOT NULL DEFAULT 4.0,
  max_premium_capture numeric NOT NULL DEFAULT 25,
  max_recycle_days integer NOT NULL DEFAULT 120,
  min_target_oi integer NOT NULL DEFAULT 1000,
  preferred_daily_volume integer NOT NULL DEFAULT 25,
  preferred_spread_pct numeric NOT NULL DEFAULT 5,
  max_spread_pct numeric NOT NULL DEFAULT 10,
  rsi_min integer NOT NULL DEFAULT 40,
  rsi_max integer NOT NULL DEFAULT 60,
  require_ma20_above_ma50 boolean NOT NULL DEFAULT false,
  require_ma50_above_ma200 boolean NOT NULL DEFAULT false,
  require_price_above_ma200 boolean NOT NULL DEFAULT true,
  short_interest_warning numeric NOT NULL DEFAULT 10,
  short_interest_exclusion numeric NOT NULL DEFAULT 20,
  round_trip_commission numeric NOT NULL DEFAULT 1.34,
  btc_increment numeric NOT NULL DEFAULT 0.05,
  allow_penny_increments boolean NOT NULL DEFAULT true,
  exclude_existing_positions boolean NOT NULL DEFAULT true,
  exclude_downtrend_no_support boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE strategy_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_strategy_profiles" ON strategy_profiles;
CREATE POLICY "anon_select_strategy_profiles" ON strategy_profiles FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_strategy_profiles" ON strategy_profiles;
CREATE POLICY "anon_insert_strategy_profiles" ON strategy_profiles FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_strategy_profiles" ON strategy_profiles;
CREATE POLICY "anon_update_strategy_profiles" ON strategy_profiles FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_strategy_profiles" ON strategy_profiles;
CREATE POLICY "anon_delete_strategy_profiles" ON strategy_profiles FOR DELETE TO anon, authenticated USING (true);

-- Option Contracts (cached market data)
CREATE TABLE IF NOT EXISTS option_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  company_name text,
  stock_price numeric NOT NULL,
  strike numeric NOT NULL,
  expiration date NOT NULL,
  dte integer NOT NULL,
  bid numeric NOT NULL,
  ask numeric NOT NULL,
  mid numeric NOT NULL,
  spread_pct numeric NOT NULL,
  iv numeric NOT NULL,
  delta numeric,
  volume integer NOT NULL DEFAULT 0,
  open_interest integer NOT NULL DEFAULT 0,
  volume_classification text,
  option_type text NOT NULL DEFAULT 'PUT',
  supports_penny boolean NOT NULL DEFAULT false,
  cached_at timestamptz DEFAULT now()
);

ALTER TABLE option_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_option_contracts" ON option_contracts;
CREATE POLICY "anon_select_option_contracts" ON option_contracts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_option_contracts" ON option_contracts;
CREATE POLICY "anon_insert_option_contracts" ON option_contracts FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_option_contracts" ON option_contracts;
CREATE POLICY "anon_update_option_contracts" ON option_contracts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_option_contracts" ON option_contracts;
CREATE POLICY "anon_delete_option_contracts" ON option_contracts FOR DELETE TO anon, authenticated USING (true);

-- Technical Snapshots (cached)
CREATE TABLE IF NOT EXISTS technical_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  stock_price numeric NOT NULL,
  ma20 numeric,
  ma50 numeric,
  ma200 numeric,
  rsi numeric,
  macd_line numeric,
  macd_signal numeric,
  macd_histogram numeric,
  bb_upper numeric,
  bb_middle numeric,
  bb_lower numeric,
  volume_trend text,
  trend_classification text NOT NULL,
  primary_support numeric,
  secondary_support numeric,
  resistance numeric,
  swing_lows jsonb,
  price_touches jsonb,
  pivot_levels jsonb,
  cached_at timestamptz DEFAULT now(),
  UNIQUE(ticker)
);

ALTER TABLE technical_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_technical_snapshots" ON technical_snapshots;
CREATE POLICY "anon_select_technical_snapshots" ON technical_snapshots FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_technical_snapshots" ON technical_snapshots;
CREATE POLICY "anon_insert_technical_snapshots" ON technical_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_technical_snapshots" ON technical_snapshots;
CREATE POLICY "anon_update_technical_snapshots" ON technical_snapshots FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_technical_snapshots" ON technical_snapshots;
CREATE POLICY "anon_delete_technical_snapshots" ON technical_snapshots FOR DELETE TO anon, authenticated USING (true);

-- Fundamental Snapshots (cached)
CREATE TABLE IF NOT EXISTS fundamental_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  company_name text,
  revenue numeric,
  revenue_growth_pct numeric,
  profitability text,
  cash_balance numeric,
  debt numeric,
  cash_flow text,
  liquidity text,
  outlook text,
  recent_developments text,
  risk_factors text,
  short_interest_pct numeric,
  cached_at timestamptz DEFAULT now(),
  UNIQUE(ticker)
);

ALTER TABLE fundamental_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_fundamental_snapshots" ON fundamental_snapshots;
CREATE POLICY "anon_select_fundamental_snapshots" ON fundamental_snapshots FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_fundamental_snapshots" ON fundamental_snapshots;
CREATE POLICY "anon_insert_fundamental_snapshots" ON fundamental_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_fundamental_snapshots" ON fundamental_snapshots;
CREATE POLICY "anon_update_fundamental_snapshots" ON fundamental_snapshots FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_fundamental_snapshots" ON fundamental_snapshots;
CREATE POLICY "anon_delete_fundamental_snapshots" ON fundamental_snapshots FOR DELETE TO anon, authenticated USING (true);

-- Candidate Scans (scan results with pass/fail per candidate)
CREATE TABLE IF NOT EXISTS candidate_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date date NOT NULL DEFAULT CURRENT_DATE,
  ticker text NOT NULL,
  company_name text,
  stock_price numeric NOT NULL,
  strike numeric NOT NULL,
  expiration date NOT NULL,
  dte integer NOT NULL,
  bid numeric NOT NULL,
  ask numeric NOT NULL,
  mid numeric NOT NULL,
  spread_pct numeric NOT NULL,
  iv numeric NOT NULL,
  delta numeric,
  volume integer NOT NULL DEFAULT 0,
  open_interest integer NOT NULL DEFAULT 0,
  volume_classification text,
  trend_classification text,
  primary_support numeric,
  suggested_sto numeric,
  suggested_btc numeric,
  net_profit numeric,
  net_croi numeric,
  premium_capture numeric,
  breakeven numeric,
  qualified boolean NOT NULL DEFAULT false,
  rejection_reasons text[],
  strategy_profile_id uuid REFERENCES strategy_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE candidate_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_candidate_scans" ON candidate_scans;
CREATE POLICY "anon_select_candidate_scans" ON candidate_scans FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_candidate_scans" ON candidate_scans;
CREATE POLICY "anon_insert_candidate_scans" ON candidate_scans FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_candidate_scans" ON candidate_scans;
CREATE POLICY "anon_update_candidate_scans" ON candidate_scans FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_candidate_scans" ON candidate_scans;
CREATE POLICY "anon_delete_candidate_scans" ON candidate_scans FOR DELETE TO anon, authenticated USING (true);

-- Open Positions
CREATE TABLE IF NOT EXISTS open_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  company_name text,
  strike numeric NOT NULL,
  expiration date NOT NULL,
  contracts integer NOT NULL DEFAULT 1,
  open_date date NOT NULL DEFAULT CURRENT_DATE,
  actual_sto numeric NOT NULL,
  current_bid numeric NOT NULL DEFAULT 0,
  current_ask numeric NOT NULL DEFAULT 0,
  current_mid numeric NOT NULL DEFAULT 0,
  btc_target numeric NOT NULL,
  net_target_profit numeric,
  net_croi numeric,
  premium_capture numeric,
  collateral numeric,
  breakeven numeric,
  stock_price numeric,
  trend_classification text,
  primary_support numeric,
  support_status text,
  position_status text NOT NULL DEFAULT 'Waiting',
  days_open integer NOT NULL DEFAULT 0,
  days_to_review integer,
  strategy_profile_id uuid REFERENCES strategy_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE open_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_open_positions" ON open_positions;
CREATE POLICY "anon_select_open_positions" ON open_positions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_open_positions" ON open_positions;
CREATE POLICY "anon_insert_open_positions" ON open_positions FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_open_positions" ON open_positions;
CREATE POLICY "anon_update_open_positions" ON open_positions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_open_positions" ON open_positions;
CREATE POLICY "anon_delete_open_positions" ON open_positions FOR DELETE TO anon, authenticated USING (true);

-- Closed Positions
CREATE TABLE IF NOT EXISTS closed_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  company_name text,
  strike numeric NOT NULL,
  contracts integer NOT NULL DEFAULT 1,
  sto_price numeric NOT NULL,
  btc_price numeric NOT NULL,
  net_profit numeric NOT NULL,
  net_croi numeric NOT NULL,
  premium_capture numeric NOT NULL,
  days_in_trade integer NOT NULL,
  annualized_return numeric,
  open_date date NOT NULL,
  close_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE closed_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_closed_positions" ON closed_positions;
CREATE POLICY "anon_select_closed_positions" ON closed_positions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_closed_positions" ON closed_positions;
CREATE POLICY "anon_insert_closed_positions" ON closed_positions FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_closed_positions" ON closed_positions;
CREATE POLICY "anon_update_closed_positions" ON closed_positions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_closed_positions" ON closed_positions;
CREATE POLICY "anon_delete_closed_positions" ON closed_positions FOR DELETE TO anon, authenticated USING (true);

-- Daily Scan Results (summary)
CREATE TABLE IF NOT EXISTS daily_scan_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date date NOT NULL UNIQUE,
  qualified_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  removed_tickers text[],
  near_btc_count integer NOT NULL DEFAULT 0,
  near_120_day_count integer NOT NULL DEFAULT 0,
  support_breaks text[],
  trend_changes text[],
  created_at timestamptz DEFAULT now()
);

ALTER TABLE daily_scan_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_daily_scan_results" ON daily_scan_results;
CREATE POLICY "anon_select_daily_scan_results" ON daily_scan_results FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_daily_scan_results" ON daily_scan_results;
CREATE POLICY "anon_insert_daily_scan_results" ON daily_scan_results FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_daily_scan_results" ON daily_scan_results;
CREATE POLICY "anon_update_daily_scan_results" ON daily_scan_results FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_daily_scan_results" ON daily_scan_results;
CREATE POLICY "anon_delete_daily_scan_results" ON daily_scan_results FOR DELETE TO anon, authenticated USING (true);

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  ticker text,
  message text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_alerts" ON alerts;
CREATE POLICY "anon_select_alerts" ON alerts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_alerts" ON alerts;
CREATE POLICY "anon_insert_alerts" ON alerts FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_alerts" ON alerts;
CREATE POLICY "anon_update_alerts" ON alerts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_alerts" ON alerts;
CREATE POLICY "anon_delete_alerts" ON alerts FOR DELETE TO anon, authenticated USING (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_candidate_scans_date ON candidate_scans(scan_date);
CREATE INDEX IF NOT EXISTS idx_candidate_scans_qualified ON candidate_scans(qualified);
CREATE INDEX IF NOT EXISTS idx_option_contracts_ticker ON option_contracts(ticker);
CREATE INDEX IF NOT EXISTS idx_open_positions_ticker ON open_positions(ticker);
CREATE INDEX IF NOT EXISTS idx_closed_positions_close_date ON closed_positions(close_date);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

-- Insert default strategy profile
INSERT INTO strategy_profiles (name, is_default)
SELECT 'My CSP Default', true
WHERE NOT EXISTS (SELECT 1 FROM strategy_profiles WHERE is_default = true);
