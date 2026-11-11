-- Pin the search_path of the SECURITY DEFINER signup trigger and remove the
-- needless EXECUTE grants that made it reachable over the Data API.
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
