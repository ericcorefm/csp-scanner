# Analyze Ticker fixes

This build fixes the Analyze Ticker path and removes stale duplicate backend code.

## Fixed
- `Analyze Ticker` continues through contract discovery if the main daily-history request is empty.
- Historical stock data request now includes explicit aggregate query parameters.
- Added a previous-close fallback for current stock price.
- Added an option-snapshot underlying-price fallback when available.
- Missing quote data no longer makes a discovered contract fail Analyze Ticker.
- Technical rules are not used as a hard rejection when there is insufficient price history; the UI shows a warning instead.
- Analyze Ticker now uses the same single `market-scan` Edge Function as Market Discovery.
- Removed the stale duplicate `supabase/functions/analyze-ticker` function and its config entry.
- Removed stale frontend/profile fields that were no longer used: `order_type`, `max_dte`, and `preferred_strikes`.
- Simplified Analyze Ticker contract display to the current discovery workflow: strike, expiration, DTE, and quote status.
- Guarded distance calculations against divide-by-zero when support/history is unavailable.

## Important
The active backend is now only `supabase/functions/market-scan/index.ts` for discovery, universe scanning, and ticker analysis.
