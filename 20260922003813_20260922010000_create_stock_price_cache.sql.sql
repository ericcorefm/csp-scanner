/*
# Create stock_price_cache table

1. New Tables
- `stock_price_cache`
  - `ticker` (text, primary key) — stock symbol, uppercase
  - `price` (numeric, not null) — last valid stock price
  - `trade_date` (date) — the trading date this price came from
  - `source` (text) — where the price came from: grouped_daily, option_snapshot, daily_aggregates, previous_close, candidate_scans
  - `updated_at` (timestamptz, default now()) — when this row was last updated

2. Purpose
- Persistent last-valid-price cache so a single grouped-daily API failure
  (401/403/429/empty) never causes every ticker to show "Unavailable".
- Prices are upserted whenever a valid positive finite price is found.
- Prices are NEVER overwritten with null/0 — only valid values are written.

3. Security
- Single-tenant no-auth app: permissive RLS for anon + authenticated.
*/

CREATE TABLE IF NOT EXISTS stock_price_cache (
  ticker text PRIMARY KEY,
  price numeric NOT NULL,
  trade_date date,
  source text NOT NULL DEFAULT 'unknown',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stock_price_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_stock_price_cache ON stock_price_cache;
CREATE POLICY select_stock_price_cache ON stock_price_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS insert_stock_price_cache ON stock_price_cache;
CREATE POLICY insert_stock_price_cache ON stock_price_cache
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS update_stock_price_cache ON stock_price_cache;
CREATE POLICY update_stock_price_cache ON stock_price_cache
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS delete_stock_price_cache ON stock_price_cache;
CREATE POLICY delete_stock_price_cache ON stock_price_cache
  FOR DELETE TO anon, authenticated USING (true);