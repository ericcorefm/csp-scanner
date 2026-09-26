/*
# Add stock price filter columns to strategy_profiles

1. New Columns
- `minimum_stock_price` (numeric, nullable) — minimum underlying stock price filter. NULL = no minimum.
- `maximum_stock_price` (numeric, nullable) — maximum underlying stock price filter. NULL = no maximum.

2. Purpose
These columns allow users to filter scan candidates by the underlying stock price,
independent of the put strike price. This lets users exclude low-priced or high-priced
stocks from their scan results while still using strike-based filtering separately.

3. Security
No security changes. The strategy_profiles table already has RLS enabled with
existing policies for anon/authenticated access.
*/

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS minimum_stock_price numeric,
  ADD COLUMN IF NOT EXISTS maximum_stock_price numeric;
