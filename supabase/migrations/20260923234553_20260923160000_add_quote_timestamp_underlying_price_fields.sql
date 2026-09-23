/*
# Add quote timestamp and underlying price fields to candidate_scans

## Purpose
Track when option quotes and underlying stock prices were fetched so the
UI can display quote age and detect stale quotes. Previously the scanner
stored bid/ask/mid but had no timestamp, making it impossible to tell
whether a displayed premium was fresh or from a prior session.

## New Columns on `candidate_scans`
1. `quote_timestamp` (timestamptz, nullable) — when the option bid/ask/mid
   was fetched from the data provider.
2. `quote_source` (text, nullable) — where the quote came from, e.g.
   'live_option_snapshot', 'delayed', 'last_trade'.
3. `underlying_price` (numeric, nullable) — the underlying stock price
   observed at the time the option chain was fetched. Distinct from
   `stock_price` which may come from a separate daily-aggregates call.
4. `underlying_price_timestamp` (timestamptz, nullable) — when the
   underlying price was observed.
5. `underlying_price_source` (text, nullable) — source of the underlying
   price, e.g. 'option_chain_snapshot', 'stocks_basic'.

## Security
No RLS policy changes — the existing anon/authenticated policies on
candidate_scans already cover all columns. No new tables.

## Notes
- All columns are nullable so existing rows are unaffected.
- `stock_price` is kept as-is for backward compatibility; `underlying_price`
  is the fresher value from the option chain when available.
- Idempotent: uses DO $$ ... IF NOT EXISTS ... END $$ blocks.
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'quote_timestamp') THEN
    ALTER TABLE candidate_scans ADD COLUMN quote_timestamp timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'quote_source') THEN
    ALTER TABLE candidate_scans ADD COLUMN quote_source text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'underlying_price') THEN
    ALTER TABLE candidate_scans ADD COLUMN underlying_price numeric;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'underlying_price_timestamp') THEN
    ALTER TABLE candidate_scans ADD COLUMN underlying_price_timestamp timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_scans' AND column_name = 'underlying_price_source') THEN
    ALTER TABLE candidate_scans ADD COLUMN underlying_price_source text;
  END IF;
END $$;