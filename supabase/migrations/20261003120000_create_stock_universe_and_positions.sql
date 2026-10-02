/*
# Stocks side: Scan Universe and Positions

Separate from the CSP (options) tables so neither side can affect the other.

1. stock_universe  — your stock watchlist for "My Scan Universe" (Stocks).
2. stock_positions — stock trades (open and closed). Fractional shares,
   no commission. Target/stop are saved from the trade plan at entry.

Security: same single-tenant / no-auth model as the rest of the app.
*/

CREATE TABLE IF NOT EXISTS stock_universe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL UNIQUE,
  company_name text,
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  company_name text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  entry_price numeric NOT NULL,
  shares numeric NOT NULL,
  target_price numeric,
  stop_price numeric,
  max_cycle_days integer NOT NULL DEFAULT 30,
  exit_date date,
  exit_price numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_positions_status_idx ON stock_positions(status, entry_date DESC);

ALTER TABLE stock_universe ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "all_stock_universe" ON stock_universe;
CREATE POLICY "all_stock_universe" ON stock_universe FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "all_stock_positions" ON stock_positions;
CREATE POLICY "all_stock_positions" ON stock_positions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stock_universe TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stock_positions TO anon, authenticated, service_role;
