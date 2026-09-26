/*
# Make max_strike nullable (optional setting)

1. Modified Columns
- `strategy_profiles.max_strike`: changed from `NOT NULL DEFAULT 25`
  to nullable with `DEFAULT NULL`.
  This allows users to leave "Maximum Put Strike" blank in Settings,
  meaning no maximum strike filter is applied during qualification.

2. Data Migration
- Existing rows with `max_strike = 0` (which was never a meaningful value)
  are set to NULL so they are treated as "no maximum".
- All other existing positive values (e.g. 25) are preserved.

3. Security
- No RLS or policy changes. Existing policies remain in place.

4. Notes
- This is a non-destructive change: no data is lost.
- The column remains `numeric` — only the NOT NULL constraint and default
  are changed.
- `max_strikes_per_ticker` is NOT touched; it stays NOT NULL DEFAULT 1.
*/

-- Drop the NOT NULL constraint so the column can hold NULL
ALTER TABLE strategy_profiles ALTER COLUMN max_strike DROP NOT NULL;

-- Change the default from 25 to NULL
ALTER TABLE strategy_profiles ALTER COLUMN max_strike SET DEFAULT NULL;

-- Convert any existing 0 values to NULL (0 was never a meaningful max strike)
UPDATE strategy_profiles SET max_strike = NULL WHERE max_strike = 0;
