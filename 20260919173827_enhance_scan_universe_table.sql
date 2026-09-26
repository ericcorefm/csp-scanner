/*
# Enhance scan_universe table with company_name, source, enabled

1. Modified Tables
- `scan_universe`: Added `company_name` (text, nullable), `source` (text, default 'manual'), `enabled` (boolean, default true)
- Renamed column `symbol` to `ticker` is NOT done — we add `ticker` as a new column and copy from `symbol`, then drop `symbol`.
  Actually, to avoid data loss we simply add `ticker` text column, copy values, and keep both. But the app reads `symbol`.
  Simpler: keep `symbol` as-is and just add the new columns. The app will be updated to use `symbol` as ticker.

2. Data Migration
- Insert SOFI if not present (was missing from default set)
- Set enabled = true for all existing rows
- Set source = 'default' for the 9 original tickers

3. Security
- RLS already enabled with anon policies. No changes needed.
*/

ALTER TABLE scan_universe
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- Mark existing default tickers with source='default'
UPDATE scan_universe SET source = 'default' WHERE symbol IN ('SOFI','CIFR','WULF','RIOT','RGTI','QBTS','RIVN','IREN','APLD');

-- Insert SOFI if missing
INSERT INTO scan_universe (symbol, source, enabled)
SELECT 'SOFI', 'default', true
WHERE NOT EXISTS (SELECT 1 FROM scan_universe WHERE symbol = 'SOFI');

-- Ensure all existing rows have enabled = true
UPDATE scan_universe SET enabled = true WHERE enabled IS NULL OR enabled = true;