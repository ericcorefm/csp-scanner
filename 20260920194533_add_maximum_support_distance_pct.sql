/*
# Add maximum_support_distance_pct to strategy_profiles

1. Modified Tables
- `strategy_profiles`: add `maximum_support_distance_pct` numeric column with DEFAULT 50.
  When Technical Rules are ON, a CSP contract passes the support-distance rules only when:
    Support Distance % >= minimum_support_distance_pct (default 15%)
    AND
    Support Distance % <= maximum_support_distance_pct (default 50%)
  Support Distance % formula is unchanged: ((Primary Support - Strike) / Primary Support) * 100

2. Security
- No RLS changes. Existing policies remain in place.

3. Notes
- Column is nullable-safe with a DEFAULT so existing rows get 50 automatically.
- No destructive operations.
*/

ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS maximum_support_distance_pct numeric NOT NULL DEFAULT 50;
