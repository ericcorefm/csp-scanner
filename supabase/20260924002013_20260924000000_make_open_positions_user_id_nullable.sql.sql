/*
# Make open_positions.user_id nullable (no-auth single-tenant fix)

## Problem
The `open_positions` table has a `user_id` column that is `NOT NULL` with
default `auth.uid()`. This app is intentionally no-auth / single-tenant,
so `auth.uid()` returns NULL for the anon-key client. Every insert fails
with a NOT NULL constraint violation.

## Fix
Drop the NOT NULL constraint on `user_id` so the anon-key client can
insert rows without providing a user_id. The column itself is kept for
backward compatibility — it just no longer requires a value.

## Security
No RLS policy changes. Existing anon/authenticated policies remain intact.
*/

ALTER TABLE open_positions ALTER COLUMN user_id DROP NOT NULL;
