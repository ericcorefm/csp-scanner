/*
# Clean corrupted rows from stock_history_cache

## Problem
The chart's Weekly / Monthly views fetched weekly and monthly bars from Massive
and saved them into stock_history_cache, which must hold DAILY bars only.
  - Weekly bars are dated on weekends (week start) -> extra fake "days".
  - Monthly bars are dated the 1st of the month -> when the 1st was a trading
    day, the real daily bar was overwritten with a whole month's OHLCV.
Both corrupt RSI, moving averages, support and trend for affected tickers.

The edge function no longer writes non-daily bars (fixed in market-scan).

## Cleanup
1. Delete every weekend-dated row (no US trading session is on a weekend).
2. Delete 1st-of-month rows whose volume is > 3x the ticker's average volume
   over the surrounding +/- 10 calendar days (a monthly aggregate, not a day).
   The next history fetch for that ticker re-downloads the correct daily bar.
*/

DELETE FROM stock_history_cache
WHERE EXTRACT(ISODOW FROM trade_date) IN (6, 7);

DELETE FROM stock_history_cache AS h
WHERE EXTRACT(DAY FROM h.trade_date) = 1
  AND h.volume > 3 * (
    SELECT AVG(n.volume)
    FROM stock_history_cache AS n
    WHERE n.ticker = h.ticker
      AND n.trade_date <> h.trade_date
      AND n.trade_date BETWEEN h.trade_date - INTERVAL '10 days' AND h.trade_date + INTERVAL '10 days'
  );
