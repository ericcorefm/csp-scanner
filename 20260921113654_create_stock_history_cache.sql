/*
# Create stock_history_cache table

1. New Tables
- `stock_history_cache`
  - `ticker` (text, not null) — stock symbol, uppercase
  - `trade_date` (date, not null) — the trading day
  - `open` (numeric) — open price
  - `high` (numeric) — high price
  - `low` (numeric) — low price
  - `close` (numeric) — close price
  - `volume` (numeric) — daily volume
  - `updated_at` (timestamptz) — when this row was last refreshed
  - Primary key: (ticker, trade_date)
  - Index on (ticker, trade_date desc) for fast lookups

2. Purpose
- Caches daily OHLCV bars from Massive so we don't re-fetch 18 months of history
  on every scan. The edge function loads cached bars first, only calls Massive
  when the cache is stale or incomplete, then saves new bars back.

3. Security
- This is a server-side cache table, written by the edge function using the
  service role key. The frontend never reads it directly. RLS is enabled with
  anon+authenticated full access since the data is public market data with no
  user-specific sensitivity.
*/

CREATE TABLE IF NOT EXISTS stock_history_cache (
  ticker text NOT NULL,
  trade_date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (ticker, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_history_cache_ticker_date
  ON stock_history_cache (ticker, trade_date DESC);

ALTER TABLE stock_history_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_stock_history" ON stock_history_cache;
CREATE POLICY "anon_select_stock_history" ON stock_history_cache FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_stock_history" ON stock_history_cache;
CREATE POLICY "anon_insert_stock_history" ON stock_history_cache FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_stock_history" ON stock_history_cache;
CREATE POLICY "anon_update_stock_history" ON stock_history_cache FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_stock_history" ON stock_history_cache;
CREATE POLICY "anon_delete_stock_history" ON stock_history_cache FOR DELETE
  TO anon, authenticated USING (true);
