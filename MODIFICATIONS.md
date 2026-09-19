# Modifications made

- Fixed Rescan persistence failure by mapping only columns that actually exist in `candidate_scans`.
- Added Supabase delete/insert error checks instead of silently ignoring failures.
- Added `scanning`, `scanError`, `lastScanAt`, and `scanSource` UI state.
- Added disabled/spinning `Scanning...` button behavior.
- Added visible LIVE data labeling and last scan time.
- Added a live-data client (`src/lib/liveMarketData.ts`).
- Added a Supabase Edge Function (`supabase/functions/market-scan/index.ts`) for Massive (formerly Polygon.io) quotes, option chains, Greeks, volume/OI, price history, support/trend, and CSP filtering.
- Live API token is server-side via the `MASSIVE_API_KEY` Edge Function secret.
- Default scan universe is hardcoded in the Edge Function: SOFI,CIFR,WULF,RIOT,RGTI,QBTS,RIVN,IREN,APLD. Override with the `CSP_SCAN_SYMBOLS` env var (not a secret).
- Removed all Tradier references (TRADIER_TOKEN, Tradier API endpoints, Tradier fallback logic).
- Removed DEMO fallback — if Massive fails, the exact error is shown to the user; no silent fallback to mock data.
- Fixed `Layout.tsx` nav icon typing (`LucideIcon` instead of missing `LayoutDashboard`).
- Initial scan now waits for open positions to load so existing CSP positions can be excluded correctly.

See `LIVE_DATA_SETUP.md` for deployment/configuration steps.
