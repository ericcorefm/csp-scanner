ALTER TABLE strategy_profiles
  ADD COLUMN IF NOT EXISTS technical_rules_enabled boolean NOT NULL DEFAULT true;