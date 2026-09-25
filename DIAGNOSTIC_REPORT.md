# CSP Scanner Diagnostic & Cleanup Report

Date: 2026-09-24
Source reviewed: uploaded project-bolt-github-ytpgaeyj (18).zip

## High-impact issues found and fixed

1. **Stale saved candidates were being partially re-evaluated on app load.**
   - `loadSavedCandidates()` re-applied only a subset of current filters while preserving old rejection reasons.
   - A contract rejected under an old setting could remain rejected after the setting was relaxed.
   - Fix: restore the most recent saved scan exactly as evaluated; apply new settings only on manual Rescan.

2. **Saved scan loading could mix several scan dates.**
   - The loader fetched up to 200/500 rows across multiple dates, then deduplicated them.
   - Old contracts could reappear after reload.
   - Fix: load only rows belonging to the most recent `scan_date` batch.

3. **Large discovery scans persisted thousands of option rows, while startup loaded only a small slice.**
   - This could omit the actual qualified ticker after reload.
   - Fix: persist only the best display-worthy contract(s) per ticker using the same ranking used by Today's Candidates.

4. **Pending status was not persisted.**
   - `technical_pending`, `pending_reasons`, and `pass_fail` were returned live but not stored in `candidate_scans`.
   - After reload, Pending could appear as Rejected or lose rule detail.
   - Fix: added migration `20260924193000_persist_candidate_pending_state.sql` and persistence mapping.

5. **Pending contracts were ranked like rejected contracts.**
   - `bestContract.ts` only gave pending priority when `qualified === true`, but the backend correctly represents Pending as `qualified=false, technical_pending=true`.
   - Fix: any `technical_pending` contract now ranks ahead of rejected contracts.

6. **Scan callback could capture stale Scan Universe symbols.**
   - `runScan` depended on `scanUniverse.length` while reading the full array.
   - Fix: dependency now tracks `scanUniverse` itself and `loadScanUniverse`.

7. **Manual quote edits could become stale after switching scan modes.**
   - Quote edits updated only the visible `candidates` array, not discovery/universe mode caches.
   - Fix: quote edits now update the active mode cache too.

8. **Nullable RSI fields had a TypeScript model mismatch.**
   - UI/database allow null, but `StrategyProfile` still declared `rsi_min` and `rsi_max` as required numbers.
   - Fix: both are `number | null`.

9. **Missing/new section flags could silently act as ON in the Edge Function.**
   - `isSectionOff()` treated only explicit `false` as off, so an undefined/stale field behaved as enabled.
   - Fix: sections are enabled only by explicit `true`; undefined/missing fields are treated as OFF.

10. **UTC date rollover remained in Add Position / close-position paths.**
    - `toISOString().split('T')[0]` can produce tomorrow's date in the user's local timezone.
    - Fix: added `formatLocalDate()` and used it in position open/close paths.

11. **Production UI still exposed the A/B regression debug panel.**
    - This was useful during debugging but adds noise and extra API work.
    - Fix: removed the A/B regression UI from Today's Candidates. Backend dev mode remains available if needed.

12. **Scan Universe date rendering could show `Invalid Date`.**
    - Fix: invalid/missing dates now display an em dash.

13. **Dead mock scanner code remained in active `src`.**
    - `src/lib/marketData.ts` was unused and contained old hard-coded rules (including volume `< 10`).
    - Fix: removed the dead module to prevent future accidental imports.

## Duplicate / stale artifacts found

The uploaded project contained:

- 23 root-level source duplicates that conflict with newer `src/**` files.
- an old `dist/` build.
- a nested `CSP_Scanner_Bolt_Modified.zip`.
- `download`, `download (1)`, and `download (2)` artifacts.
- root-level copies of migrations that also exist under `supabase/migrations/`.
- `.env` in the uploaded project.

The cleaned project ZIP excludes these stale/duplicate artifacts and does **not** include `.env`.

## Validation performed

- Parsed every `.ts` and `.tsx` file in `src/**` and `supabase/functions/**` with TypeScript's parser: **passed**.
- Verified all `@/...` imports resolve to an existing source file: **passed**.
- Full `npm ci` / Vite build could not be completed in the sandbox because dependency installation timed out. No claim of a full production build is made.

## Operational step required

Apply the new Supabase migration before relying on restored Pending status:

`supabase/migrations/20260924193000_persist_candidate_pending_state.sql`

Then redeploy the `market-scan` Edge Function because its section-toggle safety behavior changed.
