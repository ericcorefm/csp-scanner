-- Add support_distance_enabled as a separate section toggle
-- This decouples support distance filtering from the technical_rules_enabled toggle.
ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS support_distance_enabled boolean NOT NULL DEFAULT true;

-- Make the distance percentage fields nullable (they may already be nullable)
ALTER TABLE strategy_profiles
  ALTER COLUMN minimum_support_distance_pct DROP NOT NULL;
ALTER TABLE strategy_profiles
  ALTER COLUMN maximum_support_distance_pct DROP NOT NULL;
