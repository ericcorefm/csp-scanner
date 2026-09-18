# Modifications made

- Fixed Rescan persistence failure by mapping only columns that actually exist in `candidate_scans`.
- Added Supabase delete/insert error checks instead of silently ignoring failures.
- Added `scanning`, `scanError`, `lastScanAt`, and `scanSource` UI state.
- Added disabled/spinning `Scanning...` button behavior.
- Added visible LIVE vs DEMO data labeling and last scan time.
- Added a live-data client (`src/lib/liveMarketData.ts`).
- Added a Supabase Edge Function (`supabase/functions/market-scan/index.ts`) for Tradier quotes, option chains, Greeks, volume/OI, price history, support/trend, and CSP filtering.
- Live API token remains server-side via the `TRADIER_TOKEN` Edge Function secret.
- Added configurable scan universe via `CSP_SCAN_SYMBOLS`.
- Fixed `Layout.tsx` nav icon typing (`LucideIcon` instead of missing `LayoutDashboard`).
- Initial scan now waits for open positions to load so existing CSP positions can be excluded correctly.
- Kept a clearly-labeled DEMO fallback so the app remains usable before the live Edge Function is deployed.

See `LIVE_DATA_SETUP.md` for deployment/configuration steps.
