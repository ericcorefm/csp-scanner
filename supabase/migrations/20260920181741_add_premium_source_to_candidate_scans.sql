/*
# Add premium_source column to candidate_scans

1. Modified Tables
- `candidate_scans`: add `premium_source` text column (nullable) to record how the
  Suggested STO premium was estimated.
  Allowed values: 'MID', 'LAST', 'DAY CLOSE', 'MANUAL', 'UNAVAILABLE'.
  - MID    — latest bid/ask midpoint from Massive Options Chain Snapshot
  - LAST   — latest trade price from snapshot
  - DAY CLOSE — day.close from snapshot
  - MANUAL — user entered the actual STO fill via Enter Quote
  - UNAVAILABLE — no premium data returned by any source

2. Security
- No RLS changes. Existing policies remain in place.

3. Notes
- Column is nullable so existing rows are not affected.
- No destructive operations.
*/

ALTER TABLE candidate_scans
  ADD COLUMN IF NOT EXISTS premium_source text;
