-- Make rsi_min and rsi_max nullable (they were NOT NULL with defaults)
ALTER TABLE strategy_profiles ALTER COLUMN rsi_min DROP NOT NULL;
ALTER TABLE strategy_profiles ALTER COLUMN rsi_max DROP NOT NULL;

-- Remove column defaults so new rows get NULL unless explicitly set
ALTER TABLE strategy_profiles ALTER COLUMN rsi_min DROP DEFAULT;
ALTER TABLE strategy_profiles ALTER COLUMN rsi_max DROP DEFAULT;
ALTER TABLE strategy_profiles ALTER COLUMN minimum_support_distance_pct DROP DEFAULT;
ALTER TABLE strategy_profiles ALTER COLUMN maximum_support_distance_pct DROP DEFAULT;