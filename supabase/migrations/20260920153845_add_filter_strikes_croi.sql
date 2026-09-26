ALTER TABLE strategy_profiles
ADD COLUMN IF NOT EXISTS filter_strikes_croi boolean DEFAULT true;
