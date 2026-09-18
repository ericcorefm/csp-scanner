# CSP Scanner — Live Rescan setup

The app now has a real live-data path plus an explicit DEMO fallback.

## What was fixed

1. The original Rescan re-ran deterministic mock data, so prices never changed.
2. `candidate_scans` inserts spread the whole `CandidateScan` object into Supabase. The UI object contains `strike_distance_from_stock` and `strike_distance_from_support`, but those columns do not exist in the database table. PostgREST can reject that insert. The app now maps only real DB columns and checks delete/insert errors.
3. Rescan now has a loading state, last-scan timestamp, LIVE/DEMO source label, and visible errors.
4. `Layout.tsx` referenced `LayoutDashboard` without importing it. The nav icon type now uses `LucideIcon`.

## Enable live Tradier data

The new Supabase Edge Function is:

`supabase/functions/market-scan/index.ts`

Deploy it to your Supabase project, then set this Supabase Edge Function secret:

`TRADIER_TOKEN=<your Tradier API token>`

Optional universe secret:

`CSP_SCAN_SYMBOLS=SOFI,CIFR,WULF,RIVN,RIOT,RGTI,QBTS,IREN,APLD`

The frontend calls the function through `supabase.functions.invoke('market-scan')`, so the Tradier token is never exposed in browser code.

## Behavior without the live function/token

Rescan still works, but the UI clearly says `DEMO market data`. It never labels mock quotes as live.

## Notes

- The Edge Function favors the three longest expirations Tradier returns and applies the current strategy profile.
- It calculates trend/support from daily price history and options metrics from the live chain.
- Fundamentals remain the existing local prototype data in this version. A separate fundamentals provider can be added next without changing the Rescan flow.
