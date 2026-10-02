/*
# Make sure the edge function can write the price-history cache

The scanner saves downloaded daily price history to stock_history_cache (and
last-known prices to stock_price_cache) using the service role. Saves have
been failing, so history was re-downloaded every scan and never kept.

This migration only ADDS privileges; it changes no data and no structure.
It also re-asserts the (ticker, trade_date) primary key that the upsert uses.
*/

GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stock_history_cache TO service_role, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.stock_price_cache') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stock_price_cache TO service_role, anon, authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.stock_history_cache'::regclass AND contype = 'p'
  ) THEN
    EXECUTE 'ALTER TABLE public.stock_history_cache ADD PRIMARY KEY (ticker, trade_date)';
  END IF;
END $$;