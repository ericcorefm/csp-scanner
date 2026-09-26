-- Preserve the exact evaluated status of saved scan results across reloads.
-- Pending was previously lost because candidate_scans stored only qualified + rejection_reasons.
ALTER TABLE candidate_scans
  ADD COLUMN IF NOT EXISTS technical_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pass_fail jsonb NOT NULL DEFAULT '[]'::jsonb;