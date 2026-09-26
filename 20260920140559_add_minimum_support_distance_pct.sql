ALTER TABLE strategy_profiles
ADD COLUMN IF NOT EXISTS minimum_support_distance_pct numeric DEFAULT 15;
