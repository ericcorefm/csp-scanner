ALTER TABLE candidate_scans ALTER COLUMN stock_price DROP NOT NULL;

ALTER TABLE candidate_scans
  ADD COLUMN IF NOT EXISTS secondary_support numeric,
  ADD COLUMN IF NOT EXISTS resistance numeric,
  ADD COLUMN IF NOT EXISTS strike_distance_from_stock numeric,
  ADD COLUMN IF NOT EXISTS strike_distance_from_support numeric,
  ADD COLUMN IF NOT EXISTS has_quotes boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS stock_source text;
