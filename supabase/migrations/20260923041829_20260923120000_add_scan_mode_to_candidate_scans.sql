/*
# Add scan_mode column to candidate_scans

## Purpose
Separates Market Discovery results from My Scan Universe results so that
a universe rescan does not overwrite discovery results (and vice versa).

## Changes
- Adds `scan_mode text NOT NULL DEFAULT 'discovery'` to candidate_scans.
- Adds an index on (strategy_profile_id, scan_mode, created_at) for efficient
  per-mode loading.
- Existing rows default to 'discovery' which is correct since all prior scans
  were discovery-mode.

## Security
- No RLS or policy changes. The table is single-tenant (anon+authenticated).
*/

ALTER TABLE candidate_scans
  ADD COLUMN IF NOT EXISTS scan_mode text NOT NULL DEFAULT 'discovery';

CREATE INDEX IF NOT EXISTS idx_candidate_scans_profile_mode_created
  ON candidate_scans (strategy_profile_id, scan_mode, created_at DESC);
