/*
# Create stock_history_cache table

1. New Tables
- `stock_history_cache`
  - `id` (uuid, primary key)
  - `ticker` (text, not null) — uppercase stock symbol
  - `trade_date` (date, not null) — the trading day (YYYY-MM-DD)
  - `open` (numeric) — open price
  - `high` (numeric) — high price
  - `low` (numeric) — low price
  - `close` (numeric, not null) — close price
  - `volume` (bigint) — daily volume
  - `updated_at` (timestamptz) — when this row was last refreshed
  - Unique constraint on (ticker, trade_date) so upserts replace existing rows

2. Indexes
- Index on (ticker, trade_date) for fast lookups when loading cached history per symbol
- Index on (ticker) for batch loading

3. Security
- Enable RLS
- Allow anon + authenticated CRUD (single-tenant, no auth — data is shared market data)
*/

CREATE TABLE IF NOT EXISTS stock_history_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  trade_date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric NOT NULL,
  volume bigint DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (ticker, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_history_ticker_date
  ON stock_history_cache (ticker, trade_date);
CREATE INDEX IF NOT EXISTS idx_stock_history_ticker
  ON stock_history_cache (ticker);

ALTER TABLE stock_history_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_stock_history" ON stock_history_cache;
CREATE POLICY "anon_select_stock_history" ON stock_history_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_stock_history" ON stock_history_cache;
CREATE POLICY "anon_insert_stock_history" ON stock_history_cache
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_stock_history" ON stock_history_cache;
CREATE POLICY "anon_update_stock_history" ON stock_history_cache
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_stock_history" ON stock_history_cache;
CREATE POLICY "anon_delete_stock_history" ON stock_history_cache
  FOR DELETE TO anon, authenticated USING (true);
