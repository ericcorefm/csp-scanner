# Unavailable Price Bug Fix

This build fixes the intermittent Analyze Ticker `Stock Price = Unavailable` issue.

Root causes fixed:
1. `stockCache` lived at module scope inside the Supabase Edge Function, so a warm function instance could reuse an old empty/null snapshot across later requests.
2. Analyze Ticker always spent a fresh Stocks Basic request to rediscover a price already known by Today's Candidates.
3. Pending/all-null technical responses were cached in the frontend for six hours, making stale `Unavailable` values persist.
4. If price was found only from the option snapshot fallback, price-dependent support/resistance values were not recalculated.

Changes:
- Reset the Edge Function stock cache for each HTTP request.
- Prefer the price already known from Today's Candidates when Analyze Ticker runs.
- Fall back to latest persisted `candidate_scans.stock_price` before spending a new grouped-market API request.
- Preserve and reuse client stock-price cache in Analyze Ticker.
- Do not cache all-null technical snapshots as valid technical data.
- Recalculate support/resistance if stock price becomes available after option-chain retrieval.

Deployment:
1. Upload/commit the project contents.
2. Redeploy Supabase Edge Function `market-scan`.
3. Rebuild/redeploy the frontend.
4. Run Rescan once, then test Analyze Ticker with SOFI/CLSK/CIFR.
