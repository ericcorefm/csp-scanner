/*
# Create scan_universe table for managing the CSP scan ticker universe

## Purpose
Stores the list of stock tickers that the market-scan Edge Function scans for CSP candidates.
This allows users to add/remove tickers from the scan universe via the UI (Analyze Ticker feature)
without needing to change Edge Function environment variables.

## New Tables
- `scan_universe`
  - `id` (uuid, primary key, auto-generated)
  - `symbol` (text, not null, unique — the stock ticker, e.g. "SOFI")
  - `created_at` (timestamptz, defaults to now())

## Security
- Enable RLS on `scan_universe`.
- This is a single-tenant app with no sign-in screen, so all policies use `TO anon, authenticated`
  with `USING (true)` / `WITH CHECK (true)` because the data is intentionally shared/public.

## Notes
- The `symbol` column has a UNIQUE constraint to prevent duplicate tickers.
- The Edge Function reads from this table to determine which symbols to scan.
- The frontend can add/remove tickers via standard Supabase client calls.
*/