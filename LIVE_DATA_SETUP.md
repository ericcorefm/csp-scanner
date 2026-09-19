# CSP Scanner — Live Rescan setup

The app uses live market data from Massive (formerly Polygon.io). There is no DEMO fallback — if the API fails, the error is shown directly.

## What was fixed

1. The original Rescan re-ran deterministic mock data, so prices never changed.
2. `candidate_scans` inserts spread the whole `CandidateScan` object into Supabase. The UI object contains `strike_distance_from_stock` and `strike_distance_from_support`, but those columns do not exist in the database table. PostgREST can reject that insert. The app now maps only real DB columns and checks delete/insert errors.
3. Rescan now has a loading state, last-scan timestamp, LIVE source label, and visible errors.
4. `Layout.tsx` referenced `LayoutDashboard` without importing it. The nav icon type now uses `LucideIcon`.

## Enable live Massive data

The Supabase Edge Function is:

`supabase/functions/market-scan/index.ts`

Deploy it to your Supabase project, then set this Supabase Edge Function secret:

`MASSIVE_API_KEY=<your Massive API key>`

Get your API key at [massive.com](https://massive.com).

The frontend calls the function through `supabase.functions.invoke('market-scan')`, so the API key is never exposed in browser code.

## Scan universe

The default symbols are hardcoded in the Edge Function:

`SOFI,CIFR,WULF,RIOT,RGTI,QBTS,RIVN,IREN,APLD`

To override, set the `CSP_SCAN_SYMBOLS` environment variable (not a secret — just a config value):

`CSP_SCAN_SYMBOLS=AAPL,MSFT,NVDA`

## Behavior without the API key

Rescan fails with a visible error message showing the exact Massive API failure. There is no DEMO fallback.

## Notes

- The Edge Function fetches daily aggregates for trend/support and the option chain snapshot for put contracts with greeks, bid/ask, volume, and open interest.
- It favors the three longest expirations and applies the current strategy profile.
- CSP screening rules are unchanged from the original implementation.
