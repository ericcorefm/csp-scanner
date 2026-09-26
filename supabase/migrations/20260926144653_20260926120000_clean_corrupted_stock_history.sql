-- Clean corrupted/stale stock history cache.
-- The cache contained only 1 ticker (ATXS) with 210 rows ending 2026-01-22,
-- while scans expected fresh history for hundreds of tickers. Truncating
-- forces the next scan to re-fetch history via the cache-warming pipeline.

TRUNCATE TABLE stock_history_cache;
