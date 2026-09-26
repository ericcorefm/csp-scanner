/*
# Make preferred_croi_max nullable (optional setting)

1. Modified Columns
- `strategy_profiles.preferred_croi_max`: changed from `NOT NULL DEFAULT 4.0`
  to nullable with `DEFAULT NULL`.
  This allows users to leave "Preferred CROI Maximum" blank in Settings,
  meaning no preferred maximum is set.

2. Data Migration
- Existing rows with `preferred_croi_max = 0` are set to NULL.
- All other existing positive values (e.g. 4.0) are preserved.

3. Notes
- `preferred_croi_max` is NOT a hard qualification rule. It is a display/ranking
  preference only. Null means "no preference."
- This is a non-destructive change: no data is lost.
*/

ALTER TABLE strategy_profiles ALTER COLUMN preferred_croi_max DROP NOT NULL;
ALTER TABLE strategy_profiles ALTER COLUMN preferred_croi_max SET DEFAULT NULL;
UPDATE strategy_profiles SET preferred_croi_max = NULL WHERE preferred_croi_max = 0;
