/*
# Create admin_users table

## Purpose
Allows an admin account to delete other user accounts and manage the app.
The admin role is stored server-side in raw_app_meta_data (user-immutable)
and mirrored in an admin_users table for quick lookups.

## New Tables
- `admin_users`
  - `user_id` (uuid, primary key, references auth.users)
  - `email` (text, for display purposes)
  - `created_at` (timestamptz)

## Security
- RLS enabled on admin_users.
- Anyone can read the table (needed to check if current user is admin via the anon-key frontend).
- Only the service role can insert/delete admin rows (done via edge functions, not the frontend).
*/

CREATE TABLE IF NOT EXISTS admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read the admin list so the frontend can check admin status
DROP POLICY IF EXISTS "admin_users_read_all" ON admin_users;
CREATE POLICY "admin_users_read_all"
ON admin_users FOR SELECT
TO anon, authenticated USING (true);

-- No INSERT/UPDATE/DELETE policies — admin rows are managed only via the service role in edge functions
