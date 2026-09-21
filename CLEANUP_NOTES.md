# CSP Scanner cleanup

This package is intentionally **single-tenant / no-auth**.

Cleanup performed:
- Removed duplicate root-level React/TypeScript source files. Active app code lives only under `src/`.
- Removed generated `dist/` assets and nested/stale ZIP/build artifacts.
- Removed obsolete empty auth-only folders/functions.
- Added `20260921223000_finalize_single_tenant_no_auth.sql` to remove stale `user_id NOT NULL DEFAULT auth.uid()` ownership columns left by the earlier auth experiment. Those columns can make anonymous inserts fail and surface as **Failed to load**.
- Restored single-tenant uniqueness for strategy profile names and Scan Universe symbols.
- Improved default-profile creation so database insert failures show the real error.
- Scan Universe upserts now explicitly conflict on `symbol`.

After importing/syncing this project:
1. Apply the latest Supabase migration.
2. Redeploy `supabase/functions/market-scan/index.ts`.
3. Rebuild/reload the Vite/Bolt frontend.
4. Confirm the `MASSIVE_API_KEY` server secret still exists.

## 2026-09-21 — Failed-to-load root cause fix
The prior auth migration revoked all PostgreSQL privileges from the `anon` role on the app's personal tables. The later no-auth migrations recreated permissive RLS policies, but an RLS policy does **not** re-grant table privileges. Because the frontend intentionally runs without authentication, its Supabase client uses the `anon` role; `strategy_profiles.select()` could therefore fail before the app rendered.

Added migration:
`20260921231500_restore_single_tenant_anon_grants.sql`

It restores `USAGE` on `public` and `SELECT/INSERT/UPDATE/DELETE` on the app tables to `anon` and `authenticated`.
