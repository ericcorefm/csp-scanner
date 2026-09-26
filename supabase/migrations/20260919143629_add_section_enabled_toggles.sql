/*
# Add section-enabled toggle columns to strategy_profiles

## Purpose
Adds 6 boolean columns so users can turn entire rule sections ON/OFF.
When OFF, rules in that section are not used to reject candidates, but
field values are preserved for when the section is turned back ON.

## New Columns on strategy_profiles
- order_strike_enabled (boolean, default true)
- expiration_enabled (boolean, default true)
- croi_pc_enabled (boolean, default true)
- cycle_liquidity_enabled (boolean, default true)
- spread_enabled (boolean, default true)
- short_interest_enabled (boolean, default true)

## Security
- No new tables. Existing RLS policies on strategy_profiles remain unchanged.
- No destructive operations — all additions are additive.
*/

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS order_strike_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS expiration_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS croi_pc_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS cycle_liquidity_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS spread_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS short_interest_enabled boolean NOT NULL DEFAULT true;