/*
# Add max_strikes_per_ticker to strategy_profiles

1. Modified Tables
- `strategy_profiles`: add `max_strikes_per_ticker` integer column with DEFAULT 1.
  Controls how many candidate strikes per ticker are returned in discovery/universe
  scan mode. Default is 1 (best strike per ticker).

2. Security
- No RLS changes. Existing policies remain in place.

3. Notes
- Column has a NOT NULL DEFAULT so existing rows get 1 automatically.
- No destructive operations.
*/

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS max_strikes_per_ticker integer NOT NULL DEFAULT 1;
