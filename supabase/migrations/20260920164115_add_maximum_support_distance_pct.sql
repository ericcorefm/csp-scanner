ALTER TABLE strategy_profiles
ADD COLUMN IF NOT EXISTS maximum_support_distance_pct numeric DEFAULT 50;
