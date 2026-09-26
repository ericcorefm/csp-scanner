/*
# Add Expiration and Strike filter columns to strategy_profiles

## Purpose
Adds configurable DTE range, preferred expiration dates, minimum strike, and preferred strike prices
to the strategy_profiles table so users can filter which options contracts are evaluated.

## New Columns on strategy_profiles
- min_dte (integer, default 365) — minimum days-to-expiration for scanned contracts
- max_dte (integer, default 550) — maximum days-to-expiration for scanned contracts
- preferred_expirations (text[], default empty) — exact expiration dates to scan; if empty, use DTE range
- min_strike (numeric, nullable) — minimum put strike; if null, no minimum
- preferred_strikes (numeric[], default empty) — specific strike prices to evaluate; if empty, scan all within min/max range

## Security
- No new tables. Existing RLS policies on strategy_profiles remain unchanged.
- No destructive operations — all additions are additive.

## Notes
- preferred_expirations stores dates as text in YYYY-MM-DD format
- preferred_strikes stores numeric values (e.g. 10, 12, 13, 15, 20, 25)
- If preferred_expirations is empty, the DTE range (min_dte to max_dte) is used
- If preferred_strikes is empty, all strikes within [min_strike, max_strike] are evaluated
*/

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS min_dte integer NOT NULL DEFAULT 365;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS max_dte integer NOT NULL DEFAULT 550;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS preferred_expirations text[] NOT NULL DEFAULT '{}';

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS min_strike numeric;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS preferred_strikes numeric[] NOT NULL DEFAULT '{}';