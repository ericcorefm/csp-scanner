// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY
// Modes:
//   "discovery" — scan broad universe from market_universe table
//   "universe"  — scan user's enabled scan_universe tickers
//   "analyze"   — deep-analyze a single ticker (replaces analyze-ticker)
//   "chart-bars"— OHLCV bars for the chart
//
// Qualification model (identical for scans and Analyze Ticker):
//   any enabled hard rule definitely fails            → Rejected
//   no failures, but data for an enabled rule missing → Pending
//   every enabled rule has data and passes            → Qualified
// Disabled rules have zero effect.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';
const MAX_CHAIN_PAGES = 10;
const MAX_DISCOVERY_SYMBOLS = 250;

type Profile = {
  id: string;
  max_strike: number | null;
  max_strikes_per_ticker: number;
  min_dte: number;
  minimum_stock_price: number | null;
  maximum_stock_price: number | null;
  min_net_croi: number;
  max_premium_capture: number;
  max_spread_pct: number;
  min_target_oi: number;
  preferred_daily_volume: number;
  short_interest_exclusion: number;
  round_trip_commission: number;
  btc_increment: number;
  allow_penny_increments: boolean;
  exclude_existing_positions: boolean;
  exclude_downtrend_no_support: boolean;
  minimum_support_distance_pct: number | null;
  maximum_support_distance_pct: number | null;
  rsi_min: number | null;
  rsi_max: number | null;
  require_ma20_above_ma50: boolean;
  require_ma50_above_ma200: boolean;
  require_price_above_ma200: boolean;
  order_strike_enabled: boolean;
  expiration_enabled: boolean;
  croi_pc_enabled: boolean;
  filter_strikes_croi: boolean;
  cycle_liquidity_enabled: boolean;
  spread_enabled: boolean;
  short_interest_enabled: boolean;
  technical_rules_enabled: boolean;
  support_distance_enabled: boolean;
};

type HistoryBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

const DEBUG_TICKERS = new Set(['BLNK', 'RIVN', 'XPEV', 'RUN', 'DKNG', 'SNAP', 'CMCSA', 'MARA', 'SOFI', 'CLSK', 'CIFR', 'FCEL', 'RIOT']);

function isRetryableStatus(status: number): boolean {
  // Only retry transient network errors (status 0) or 5xx responses
  return status === 0 || (status >= 500 && status < 600);
}

// ── Bulk grouped daily prices ──
// Fetches the latest completed U.S. stock market day in ONE request.
// Tries today first, walks backwards up to 7 calendar days.
// Returns a Map<ticker, closePrice>.
async function fetchGroupedDailyPrices(
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
): Promise<{ priceMap: Map<string, number>; barMap: Map<string, HistoryBar>; tradingDate: string | null; httpStatus: number | null }> {
  const priceMap = new Map<string, number>();
  const barMap = new Map<string, HistoryBar>();
  let lastHttpStatus: number | null = null;

  // Stocks Basic is end-of-day and limited to 5 stock API calls/minute.
  // Start with the most recently COMPLETED trading day instead of probing
  // today/weekends first, which used to burn several calls before finding data.
  const first = new Date(today);
  first.setDate(first.getDate() - 1);
  while (first.getDay() === 0 || first.getDay() === 6) {
    first.setDate(first.getDate() - 1);
  }

  // Only walk back through business days. In normal operation the first call
  // succeeds, so the entire 121-symbol scan consumes one stock API request.
  for (let businessOffset = 0; businessOffset < 5; businessOffset++) {
    const tryDate = new Date(first);
    let remaining = businessOffset;
    while (remaining > 0) {
      tryDate.setDate(tryDate.getDate() - 1);
      if (tryDate.getDay() !== 0 && tryDate.getDay() !== 6) remaining--;
    }

    const dateStr = fmt(tryDate);
    const path = `/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`;
    const result = await massiveFetch(path, apiKey, 'GROUPED', `grouped_daily_${dateStr}`);
    lastHttpStatus = result.ok ? 200 : result.status;

    if (!result.ok) {
      console.log(`[GroupedDaily] ${dateStr} failed: HTTP ${result.status}`);
      // Do not keep spending the 5/minute Basic quota after a rate-limit or auth error.
      if (result.status === 401 || result.status === 403 || result.status === 429) break;
      continue;
    }

    const results = result.data?.results || [];
    for (const r of results) {
      const ticker = String(r.T || r.ticker || '').toUpperCase();
      const close = Number(r.c || r.close || 0);
      if (ticker && Number.isFinite(close) && close > 0) {
        priceMap.set(ticker, close);
        barMap.set(ticker, {
          date: dateStr,
          open: Number(r.o || close), high: Number(r.h || close), low: Number(r.l || close),
          close, volume: Number(r.v || 0),
        });
      }
    }

    if (priceMap.size > 0) {
      console.log(`[GroupedDaily] Found ${priceMap.size} stock prices for completed trading date ${dateStr}`);
      console.log(`[PRICE BULK] HTTP ${lastHttpStatus} | trading_date=${dateStr} | prices_returned=${priceMap.size}`);
      return { priceMap, barMap, tradingDate: dateStr, httpStatus: lastHttpStatus };
    }
  }

  console.log(`[PRICE BULK] HTTP ${lastHttpStatus} | trading_date=null | prices_returned=0 — GROUPED FAILED, using fallbacks`);
  console.log('[GroupedDaily] No completed grouped daily response available');
  return { priceMap, barMap, tradingDate: null, httpStatus: lastHttpStatus };
}

type ChainStatus = 'success' | 'no_options' | 'api_error' | 'unauthorized' | 'rate_limited' | 'network_error';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function massiveFetch(
  path: string,
  apiKey: string,
  symbol: string,
  stage: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const url = `${MASSIVE_API}${path}`;
  const ts = new Date().toISOString();
  console.log(`[Massive] ${symbol} | stage=${stage} | GET ${url} | ts=${ts}`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    console.error(`[Massive] ${symbol} | stage=${stage} | NETWORK ERROR: ${msg}`);
    return { ok: false, status: 0, body: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const bodyText = await response.text();
    const truncated = bodyText.slice(0, 500);
    console.error(`[Massive] ${symbol} | stage=${stage} | HTTP ${response.status} | body: ${truncated}`);
    return { ok: false, status: response.status, body: truncated || response.statusText };
  }

  console.log(`[Massive] ${symbol} | stage=${stage} | HTTP ${response.status} | OK`);

  try {
    const data = await response.json();
    return { ok: true, data };
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[Massive] ${symbol} | stage=${stage} | JSON PARSE ERROR: ${msg}`);
    return { ok: false, status: response.status, body: `JSON parse error: ${msg}` };
  }
}

// ── Supabase REST helper ──
async function supabaseSelect(table: string, columns: string, filter?: string): Promise<any[]> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) { console.error(`[Supabase] Missing URL or service key for ${table}`); return []; }
  let url = `${supabaseUrl}/rest/v1/${table}?select=${columns}`;
  if (filter) url += `&${filter}`;
  const resp = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } });
  if (!resp.ok) { console.error(`[Supabase] ${table} select failed: HTTP ${resp.status}`); return []; }
  return await resp.json();
}

async function fetchScanUniverse(): Promise<{ ticker: string; company_name: string | null }[]> {
  const filter = 'enabled=eq.true&order=symbol';
  const rows = await supabaseSelect('scan_universe', 'symbol,company_name', filter);
  return (rows || []).map((r: any) => ({ ticker: String(r.symbol).toUpperCase(), company_name: r.company_name || null }));
}

async function fetchMarketUniverse(limit: number): Promise<{ ticker: string; company_name: string | null }[]> {
  const rows = await supabaseSelect('market_universe', 'ticker,company_name', 'active=eq.true&optionable=eq.true&order=ticker');
  const mapped = (rows || []).map((r: any) => ({ ticker: String(r.ticker).toUpperCase(), company_name: r.company_name || null }));
  // Deterministic order. This used to be a random shuffle, so every Rescan
  // processed symbols in a different order (and, with the old early-stop,
  // scanned a different subset) — a direct cause of inconsistent results.
  return mapped.sort((a, b) => a.ticker.localeCompare(b.ticker)).slice(0, limit);
}

async function fetchLatestCandidateStockPrice(ticker: string): Promise<number | null> {
  const upper = ticker.toUpperCase().trim();
  if (!upper) return null;
  const rows = await supabaseSelect(
    'candidate_scans',
    'stock_price,created_at',
    `ticker=eq.${encodeURIComponent(upper)}&stock_price=not.is.null&order=created_at.desc&limit=1`,
  );
  const value = Number(rows?.[0]?.stock_price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ── Persistent stock price cache (stock_price_cache table) ──
// Last-valid-price cache. Never overwrites a valid price with null/0.
async function loadCachedStockPrice(ticker: string): Promise<{ price: number; source: string; tradeDate: string | null } | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return null;
  const url = `${supabaseUrl}/rest/v1/stock_price_cache?select=price,source,trade_date&ticker=eq.${encodeURIComponent(ticker)}&limit=1`;
  try {
    const resp = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } });
    if (!resp.ok) return null;
    const rows = await resp.json() as any[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const price = Number(rows[0].price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, source: String(rows[0].source || 'cached'), tradeDate: rows[0].trade_date ? String(rows[0].trade_date) : null };
  } catch {
    return null;
  }
}

async function saveCachedStockPrice(ticker: string, price: number, source: string, tradeDate: string | null): Promise<void> {
 const upper = ticker.toUpperCase().trim();
 if (!upper || !Number.isFinite(price) || price <= 0) return;
 const supabaseUrl = Deno.env.get('SUPABASE_URL');
 const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if (!supabaseUrl || !serviceKey) return;
 try {
   const resp = await fetch(`${supabaseUrl}/rest/v1/stock_price_cache`, {
     method: 'POST',
     headers: {
       apikey: serviceKey,
       Authorization: `Bearer ${serviceKey}`,
       'Content-Type': 'application/json',
       Prefer: 'resolution=merge-duplicates',
     },
     body: JSON.stringify({ ticker: upper, price, source, trade_date: tradeDate, updated_at: new Date().toISOString() }),
   });
   if (!resp.ok) {
     console.log(`[PriceCache] ${upper} | save failed: HTTP ${resp.status}`);
   }
 } catch (e) {
   console.log(`[PriceCache] ${upper} | save error: ${e instanceof Error ? e.message : String(e)}`);
 }
}

// ── Bulk load cached stock prices for all scan tickers ──
async function bulkLoadCachedStockPrices(tickers: string[]): Promise<Map<string, { price: number; source: string; tradeDate: string | null }>> {
  const result = new Map<string, { price: number; source: string; tradeDate: string | null }>();
  if (tickers.length === 0) return result;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return result;
  // Fetch in chunks of 50 to avoid URL length limits
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    const filter = `ticker=in.(${chunk.map((t) => encodeURIComponent(t)).join(',')})`;
    const url = `${supabaseUrl}/rest/v1/stock_price_cache?select=ticker,price,source,trade_date&${filter}`;
    try {
      const resp = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } });
      if (!resp.ok) continue;
      const rows = await resp.json() as any[];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const price = Number(row.price);
        if (Number.isFinite(price) && price > 0) {
          result.set(String(row.ticker).toUpperCase(), { price, source: String(row.source || 'cached'), tradeDate: row.trade_date ? String(row.trade_date) : null });
        }
      }
    } catch {
      // continue to next chunk
    }
  }
  return result;
}

// ── Stock history cache: load/save daily OHLCV bars in Supabase ──
async function loadCachedHistory(ticker: string, maxBars = 250): Promise<HistoryBar[]> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return [];
  const url = `${supabaseUrl}/rest/v1/stock_history_cache?select=trade_date,open,high,low,close,volume&ticker=eq.${encodeURIComponent(ticker)}&order=trade_date.desc&limit=${maxBars}`;
  try {
    const resp = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' } });
    if (!resp.ok) return [];
    const rows = await resp.json() as any[];
    if (!Array.isArray(rows) || rows.length === 0) return [];
    return rows.map((r) => ({
      date: String(r.trade_date),
      open: Number(r.open || 0),
      high: Number(r.high || 0),
      low: Number(r.low || 0),
      close: Number(r.close || 0),
      volume: Number(r.volume || 0),
    })).filter((b) => Number.isFinite(b.close) && b.close > 0 && !isWeekendDate(b.date)).reverse();
  } catch {
    return [];
  }
}

async function saveCachedHistory(ticker: string, bars: HistoryBar[]): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey || bars.length === 0) return;
  const now = new Date().toISOString();
  const rows = bars.map((b) => ({
    ticker,
    trade_date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    updated_at: now,
  }));
  // Upsert via POST with Prefer: resolution=merge-duplicates
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/stock_history_cache`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => 'unreadable');
      console.log(`[Cache SAVE FAIL] ${ticker} | HTTP ${resp.status} | body: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`[Cache SAVE ERROR] ${ticker} | ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Append the grouped-daily bar (one API call covers every ticker) to the
// history cache for all scanned symbols. This keeps technical history current
// every trading day without spending one rate-limited request per ticker.
async function saveGroupedBarsToCache(barMap: Map<string, HistoryBar>, tickers: string[]): Promise<number> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey || barMap.size === 0) return 0;
  const now = new Date().toISOString();
  const rows = tickers
    .map((t) => ({ t, b: barMap.get(t) }))
    .filter((x) => x.b)
    .map(({ t, b }) => ({ ticker: t, trade_date: b!.date, open: b!.open, high: b!.high, low: b!.low, close: b!.close, volume: b!.volume, updated_at: now }));
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/stock_history_cache`, {
        method: 'POST',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(chunk),
      });
      if (resp.ok) saved += chunk.length;
      else console.log(`[GroupedBars SAVE FAIL] HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    } catch (e) {
      console.log(`[GroupedBars SAVE ERROR] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return saved;
}

// ── Weekly / Monthly aggregation from daily bars ──
function aggregateWeeks(daily: HistoryBar[]): HistoryBar[] {
  if (daily.length === 0) return [];
  const weeks = new Map<string, HistoryBar[]>();
  for (const bar of daily) {
    const d = new Date(bar.date + 'T00:00:00Z');
    const dayOfWeek = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((dayOfWeek + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key)!.push(bar);
  }
  return Array.from(weeks.entries()).map(([date, bars]) => ({
    date,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars.at(-1)!.close,
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  })).sort((a, b) => a.date.localeCompare(b.date));
}

function aggregateMonths(daily: HistoryBar[]): HistoryBar[] {
  if (daily.length === 0) return [];
  const months = new Map<string, HistoryBar[]>();
  for (const bar of daily) {
    const key = bar.date.slice(0, 7) + '-01'; // YYYY-MM-01
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push(bar);
  }
  return Array.from(months.entries()).map(([date, bars]) => ({
    date,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars.at(-1)!.close,
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Technical indicators ──
function sma(values: number[], n: number) {
  if (!values.length) return 0;
  const slice = values.slice(-Math.min(n, values.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Wilder's RSI (same method TradingView uses), seeded with a simple average of
// the first `period` changes and smoothed across all available history.
// Returns null when there is not enough data — never a fake neutral value.
function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function findSwingLows(bars: HistoryBar[]): number[] {
  const lows: number[] = [];
  const window = Math.min(3, Math.floor(bars.length / 4));
  if (window < 1) return bars.length > 0 ? [Math.min(...bars.map(b => b.low))] : [];
  for (let i = window; i < bars.length - window; i++) {
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (bars[i].low > bars[i-j].low || bars[i].low > bars[i+j].low) { isLow = false; break; }
    }
    if (isLow) lows.push(bars[i].low);
  }
  return lows.sort((a, b) => b - a);
}

function findSwingHighs(bars: HistoryBar[]): number[] {
  const highs: number[] = [];
  const window = Math.min(3, Math.floor(bars.length / 4));
  if (window < 1) return bars.length > 0 ? [Math.max(...bars.map(b => b.high))] : [];
  for (let i = window; i < bars.length - window; i++) {
    let isHigh = true;
    for (let j = 1; j <= window; j++) {
      if (bars[i].high < bars[i-j].high || bars[i].high < bars[i+j].high) { isHigh = false; break; }
    }
    if (isHigh) highs.push(bars[i].high);
  }
  return highs.sort((a, b) => a - b);
}

// Primary Support = nearest meaningful swing low below current price.
// Falls back to the 20-bar low if no swing low exists below price.
function calcPrimarySupport(bars: HistoryBar[], price: number): number {
  const lookback = Math.min(bars.length, 120);
  const lows = findSwingLows(bars.slice(-lookback));
  const below = lows.filter((x) => x < price && x > 0);
  if (below.length > 0) return below[0];
  // Fallback: lowest low in recent 20 bars
  const recent = bars.slice(-Math.min(20, bars.length));
  return Math.min(...recent.map((b) => b.low));
}

// Secondary Support = next meaningful swing low below primary support.
function calcSecondarySupport(bars: HistoryBar[], primarySupport: number): number {
  const lookback = Math.min(bars.length, 120);
  const lows = findSwingLows(bars.slice(-lookback));
  const below = lows.filter((x) => x < primarySupport && x > 0);
  if (below.length > 0) return below[0];
  return primarySupport * 0.95;
}

// Resistance = nearest meaningful swing high above current price.
function findResistance(bars: HistoryBar[], price: number): number {
  const lookback = Math.min(bars.length, 120);
  const highs = findSwingHighs(bars.slice(-lookback));
  const above = highs.filter((x) => x > price && x > 0);
  if (above.length > 0) return above[0];
  // Fallback: highest high in recent 50 bars
  const recent = bars.slice(-Math.min(50, bars.length));
  return Math.max(...recent.map((b) => b.high));
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  for (let i = 1; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
  return emaPrev;
}

function macd(values: number[]): { macd: number; signal: number; histogram: number } {
  if (values.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12Arr: number[] = [];
  const ema26Arr: number[] = [];
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = values[0], e26 = values[0];
  for (let i = 0; i < values.length; i++) {
    e12 = i === 0 ? values[0] : values[i] * k12 + e12 * (1 - k12);
    e26 = i === 0 ? values[0] : values[i] * k26 + e26 * (1 - k26);
    ema12Arr.push(e12);
    ema26Arr.push(e26);
  }
  const macdLine = ema12Arr.map((v, i) => v - ema26Arr[i]);
  const signalLine = ema(macdLine.slice(-Math.min(macdLine.length, 35)), 9);
  const currentMacd = macdLine.at(-1) || 0;
  return { macd: Number(currentMacd.toFixed(4)), signal: Number(signalLine.toFixed(4)), histogram: Number((currentMacd - signalLine).toFixed(4)) };
}

function bollingerBands(values: number[], period = 20, mult = 2): { upper: number; middle: number; lower: number; position: string } {
  if (values.length < period) return { upper: 0, middle: 0, lower: 0, position: 'Insufficient data' };
  const slice = values.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = values.at(-1) || 0;
  let position = 'Middle';
  if (price >= upper) position = 'Above Upper';
  else if (price <= lower) position = 'Below Lower';
  else if (price > mid) position = 'Upper Half';
  else position = 'Lower Half';
  return { upper: Number(upper.toFixed(2)), middle: Number(mid.toFixed(2)), lower: Number(lower.toFixed(2)), position };
}

function volumeTrend(bars: HistoryBar[]): string {
  if (bars.length < 20) return 'Insufficient data';
  const recent = bars.slice(-10).map((b) => b.volume);
  const prior = bars.slice(-20, -10).map((b) => b.volume);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (priorAvg === 0) return 'No prior volume';
  const ratio = recentAvg / priorAvg;
  if (ratio >= 1.5) return 'Surging';
  if (ratio >= 1.1) return 'Increasing';
  if (ratio <= 0.5) return 'Fading';
  if (ratio <= 0.9) return 'Declining';
  return 'Stable';
}

function trend(bars: HistoryBar[]) {
  const closes = bars.map((b) => b.close);
  const price = closes.at(-1) || 0;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const rr = rsi(closes) ?? 50;
  // If we have 200+ bars, use full MA200-based trend
  if (closes.length >= 200) {
    const ma200 = sma(closes, 200);
    if (price > ma20 && ma20 > ma50 && ma50 > ma200) return 'Bullish';
    if (price > ma20 && ma20 >= ma50) return 'Improving';
    if (price > ma20 && rr >= 40) return 'Rebound';
    if (Math.abs(price - ma20) / Math.max(price, 0.01) < 0.03) return 'Stabilizing';
    if (price >= ma50 * 0.98) return 'Sideways';
    return 'Downtrend';
  }
  // With 60-199 bars: use MA20/MA50 only (no MA200)
  if (price > ma20 && ma20 > ma50) return 'Bullish';
  if (price > ma20 && ma20 >= ma50) return 'Improving';
  if (price > ma20 && rr >= 40) return 'Rebound';
  if (Math.abs(price - ma20) / Math.max(price, 0.01) < 0.03) return 'Stabilizing';
  if (price >= ma50 * 0.98) return 'Sideways';
  return 'Downtrend';
}

// ── BTC optimization: iterative approach matching client calcBtcOptimization ──
// Iterates upward from $0.01 in configured increments, picks the HIGHEST BTC
// that satisfies both Net CROI >= min AND Premium Capture <= max.
// This ensures server and client always produce the same BTC value.
function calcBtc(suggestedSTO: number, strike: number, p: Profile): {
  btc: number | null;
  netProfit: number;
  netCroi: number;
  pc: number;
} {
  const collateral = strike * 100;
  const increment = p.allow_penny_increments ? 0.01 : Math.max(0.01, p.btc_increment || 0.05);
  const minCroi = p.min_net_croi;
  const maxPc = p.max_premium_capture;

  let best: { btc: number; netProfit: number; netCroi: number; pc: number } | null = null;

  let price = 0.01;
  while (price < suggestedSTO) {
    const btcPrice = parseFloat(price.toFixed(2));
    const netProfit = (suggestedSTO - btcPrice) * 100 - p.round_trip_commission;
    const netCroi = collateral > 0 ? (netProfit / collateral) * 100 : 0;
    const pc = suggestedSTO > 0 ? ((suggestedSTO - btcPrice) / suggestedSTO) * 100 : 0;

    if (netCroi >= minCroi && pc <= maxPc && btcPrice < suggestedSTO) {
      // This BTC qualifies — keep the highest one
      best = { btc: btcPrice, netProfit, netCroi, pc };
    }

    price += increment;
  }

  if (best) {
    return {
      btc: parseFloat(best.btc.toFixed(2)),
      netProfit: parseFloat(best.netProfit.toFixed(2)),
      netCroi: parseFloat(best.netCroi.toFixed(2)),
      pc: parseFloat(best.pc.toFixed(1)),
    };
  }
  return { btc: null, netProfit: 0, netCroi: 0, pc: 0 };
}

function spreadPct(bid: number, ask: number) {
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid * 100 : 999;
}

function volClass(v: number) {
  if (v >= 250) return 'Excellent'; if (v >= 100) return 'Very Good'; if (v >= 50) return 'Good';
  if (v >= 25) return 'Meaningful'; if (v >= 10) return 'Thin'; return 'Very Thin';
}

function isSectionOff(profile: Profile, key: keyof Profile): boolean {
  return profile[key] === false;
}

// ── Robust date parsing for expiration_date from Massive ──
// Handles ISO strings ("2026-09-19"), compact ("20260919"), timestamps, and more.
function parseExpirationDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  if (!s) return null;
  // ISO: 2026-09-19 or 2026-09-19T17:00:00-04:00
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  // Compact: 20260919
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    return isNaN(d.getTime()) ? null : d;
  }
  // Slash: 09/19/2026
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const parts = s.split('/');
    const d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// DTE using date-only comparison (strips time to avoid timezone off-by-one)
function calcDTE(expRaw: unknown, today: Date): number {
  const exp = parseExpirationDate(expRaw);
  if (!exp) return -1;
  const expDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((expDay.getTime() - todayDay.getTime()) / 86400000);
}

// ── Premium extraction: priority MID → LAST → DAY CLOSE → UNAVAILABLE ──
// Uses the Massive Options Chain Snapshot endpoint (no quote-history access needed).
// Never converts unavailable premium to 0 — returns null and source 'UNAVAILABLE'.
function extractPremium(c: any): {
  bid: number | null;
  ask: number | null;
  mid: number;
  suggestedSTO: number | null;
  premiumSource: 'MID' | 'LAST' | 'DAY CLOSE' | 'UNAVAILABLE';
} {
  const lq = c?.last_quote;
  const rawBid = lq?.bid != null ? Number(lq.bid) : null;
  const rawAsk = lq?.ask != null ? Number(lq.ask) : null;
  const bid = rawBid !== null && Number.isFinite(rawBid) ? rawBid : null;
  const ask = rawAsk !== null && Number.isFinite(rawAsk) ? rawAsk : null;

  // 1. MID: valid bid AND ask
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    const midpoint = lq?.midpoint != null ? Number(lq.midpoint) : 0;
    const sto = midpoint > 0 ? midpoint : (bid + ask) / 2;
    return { bid, ask, mid: sto, suggestedSTO: sto, premiumSource: 'MID' };
  }

  // 2. LAST: valid latest trade price
  const lastTrade = c?.last_trade;
  const lastPrice = lastTrade?.price != null ? Number(lastTrade.price) : null;
  if (lastPrice !== null && Number.isFinite(lastPrice) && lastPrice > 0) {
    return { bid, ask, mid: lastPrice, suggestedSTO: lastPrice, premiumSource: 'LAST' };
  }

  // 3. DAY CLOSE: valid day.close
  const dayClose = c?.day?.close != null ? Number(c.day.close) : null;
  if (dayClose !== null && Number.isFinite(dayClose) && dayClose > 0) {
    return { bid, ask, mid: dayClose, suggestedSTO: dayClose, premiumSource: 'DAY CLOSE' };
  }

  // 4. UNAVAILABLE
  return { bid, ask, mid: 0, suggestedSTO: null, premiumSource: 'UNAVAILABLE' };
}

// ── Log a sanitized raw contract (no API keys) ──
function logRawContract(label: string, symbol: string, c: any) {
  const safe: any = {};
  for (const k of Object.keys(c || {})) {
    if (k === 'last_quote' && c[k]) {
      safe.last_quote = { bid: c[k].bid, ask: c[k].ask, midpoint: c[k].midpoint };
    } else if (k === 'details' && c[k]) {
      safe.details = { contract_type: c[k].contract_type, strike_price: c[k].strike_price, expiration_date: c[k].expiration_date };
    } else if (k === 'greeks' && c[k]) {
      safe.greeks = { delta: c[k].delta, gamma: c[k].gamma, theta: c[k].theta, vega: c[k].vega };
    } else if (k === 'day' && c[k]) {
      safe.day = { volume: c[k].volume, close: c[k].close };
    } else if (typeof c[k] !== 'object') {
      safe[k] = c[k];
    }
  }
  console.log(`[RAW ${label}] ${symbol}: ${JSON.stringify(safe)}`);
}

// ── Per-symbol scan result ──
type StockSnapshot = {
  ticker: string;
  currentPrice: number | null;
  historicalBars: HistoryBar[];
  source: 'grouped_daily' | 'daily_aggregates' | 'previous_close' | 'underlying_asset' | 'none';
  error: string | null;
  historyHttpStatus?: number;
};

// Request-scoped state. Previously these were module-level globals, which a
// concurrent request (e.g. Analyze during a Rescan) could clear mid-scan.
type ScanContext = {
  stockCache: Map<string, StockSnapshot>;
  // Raw option-chain results per symbol, so the cache-warming re-evaluation
  // uses the SAME quotes as the first pass (no second chain fetch, no drift).
  chainCache: Map<string, { contracts: any[]; pages: number }>;
  // Latest completed trading date (YYYY-MM-DD). Cache is "fresh" if it has this bar.
  expectedLatestDate: string;
  // Once Massive returns 429 for stock history, stop asking in this request.
  historyRateLimited: boolean;
  historyFetchAttempts: number;
};

function newScanContext(expectedLatestDate: string): ScanContext {
  return { stockCache: new Map(), chainCache: new Map(), expectedLatestDate, historyRateLimited: false, historyFetchAttempts: 0 };
}

// Most recent weekday strictly before `today` (holidays are handled by the
// grouped-daily walk-back; here a holiday just costs one extra fetch in Analyze).
function lastCompletedBusinessDay(today: Date, fmt: (d: Date) => string): string {
  const d = new Date(today);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return fmt(d);
}

// Keep only the trailing run of bars without a data gap. A gap (2+ consecutive
// missing business days) means the cache skipped days — indicators computed
// across it would be wrong, so they must be treated as insufficient history.
function trailingContiguousBars(bars: HistoryBar[]): HistoryBar[] {
  if (bars.length < 2) return bars;
  for (let i = bars.length - 1; i > 0; i--) {
    const cur = new Date(bars[i].date + 'T00:00:00Z');
    const prev = new Date(bars[i - 1].date + 'T00:00:00Z');
    let missingBusinessDays = 0;
    const d = new Date(prev);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d < cur) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) missingBusinessDays++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    if (missingBusinessDays > 1) return bars.slice(i);
  }
  return bars;
}

function isWeekendDate(date: string): boolean {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

type TechnicalRejections = {
  rsi_below_min: number;
  rsi_above_max: number;
  ma20_not_above_ma50: number;
  ma50_not_above_ma200: number;
  price_not_above_ma200: number;
  downtrend_no_support: number;
  support_dist_below_min: number;
  support_dist_above_max: number;
  technical_data_missing: number;
};

type OrderStrikeRejections = {
  stock_below_min: number;
  stock_above_max: number;
  strike_above_max: number;
};

type SupportDistanceDebugEntry = {
  ticker: string;
  strike: number;
  primarySupport: number | null;
  supportDistancePct: number | null;
  passesMin: boolean;
  passesMax: boolean;
  finalSupportDistancePass: boolean;
  status: 'pass' | 'fail_below_min' | 'fail_above_max' | 'pending_missing_support';
};

type SupportDistanceDebug = {
  before: number;
  passed: number;
  below_min: number;
  above_max: number;
  missing_support: number;
  details: SupportDistanceDebugEntry[];
};

type ScanSymbolResult = {
  candidates: any[];
  chainStatus: ChainStatus;
  putsReturned: number;
  filteredByExpiration: number;
  filteredByStrike: number;
  missingStrike: number;
  missingExpiration: number;
  missingLastQuote: number;
  missingBid: number;
  zeroBid: number;
  missingAsk: number;
  zeroAsk: number;
  askLtBid: number;
  otherInvalid: number;
  validQuotes: number;
  contractsAwaitingQuotes: number;
  evaluated: number;
  qualified: number;
  rejected: number;
  pending: number;
  pagesFetched: number;
  rawSample?: any;
  analyses?: any[];
  stockPrice?: number | null;
  stockSource?: string;
  primarySupport?: number | null;
  secondarySupport?: number | null;
  resistance?: number | null;
  trendClass?: string;
  technicalDataAvailable?: boolean;
  historyStatus?: 'success' | 'partial' | 'fallback' | 'empty' | 'error';
  historyError?: string;
  technical?: { rsi: number | null; ma20: number | null; ma50: number | null; ma200: number | null; macd: number; macd_signal: number; macd_histogram: number; bb_upper: number; bb_middle: number; bb_lower: number; bb_position: string; volume_trend: string };
  techRejections?: TechnicalRejections;
  orderStrikeRejections?: OrderStrikeRejections;
  historyBarCount?: number;
  supportDistanceDebug?: SupportDistanceDebug;
  needsHistoryBars?: number; // bars required by the active rules
};

// ── Cache-first stock history fetcher ──
// 1. Load cached bars from Supabase stock_history_cache
// 2. Cache is fresh if it contains the latest completed trading day
//    (the grouped-daily bar saved at scan start keeps it fresh for free)
// 3. Only if live history is allowed AND the cache is stale/short/gapped,
//    fetch ~18 months of daily aggregates from Massive and save them back
// 4. Only the trailing gap-free run of bars is used for indicators
// Stock price comes from grouped daily (passed in) or the latest close.
// No retries on 401/403/429 — only one retry on network error or 5xx.
async function getStockSnapshot(
  ticker: string,
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
  bulkStockPrice: number | null,
  allowLiveHistory: boolean,
  minHistoryBarsForFetch: number,
  ctx: ScanContext,
): Promise<StockSnapshot> {
  const upper = ticker.toUpperCase();
  const cached = ctx.stockCache.get(upper);
  if (cached) {
    const cacheCoversRequest = cached.historicalBars.length >= minHistoryBarsForFetch || !allowLiveHistory;
    if (cacheCoversRequest && (cached.currentPrice !== null || cached.historicalBars.length > 0)) {
      if (bulkStockPrice !== null && Number.isFinite(bulkStockPrice) && bulkStockPrice > 0 && cached.currentPrice !== bulkStockPrice) {
        const refreshed: StockSnapshot = { ...cached, currentPrice: bulkStockPrice, source: 'grouped_daily', error: null };
        ctx.stockCache.set(upper, refreshed);
        return refreshed;
      }
      return cached;
    }
    ctx.stockCache.delete(upper);
  }

  let currentPrice: number | null = null;
  let source: StockSnapshot['source'] = 'none';
  let error: string | null = null;
  let historyHttpStatus: number | undefined;

  // 1. Bulk grouped daily price is the primary stock price
  if (bulkStockPrice !== null && bulkStockPrice > 0) {
    currentPrice = bulkStockPrice;
    source = 'grouped_daily';
  }

  // 2. Load cached bars from Supabase; use only the trailing gap-free run
  const todayStr = fmt(today);
  let bars = trailingContiguousBars((await loadCachedHistory(upper, 300)).filter((b) => b.date < todayStr));

  const latestCachedDate = bars.length > 0 ? bars.at(-1)!.date : null;
  const isStale = latestCachedDate === null || latestCachedDate < ctx.expectedLatestDate;
  const isShort = bars.length < minHistoryBarsForFetch;
  const wantsFetch = minHistoryBarsForFetch > 0 && (isShort || isStale);

  if (allowLiveHistory && wantsFetch && !ctx.historyRateLimited) {
    const start = new Date(today);
    start.setDate(start.getDate() - 548); // ~18 months: enough for MA200 with holidays
    const histPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/range/1/day/${fmt(start)}/${fmt(today)}?adjusted=true&sort=asc&limit=50000`;
    ctx.historyFetchAttempts++;
    let histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates');
    if (!histResult.ok && isRetryableStatus(histResult.status)) {
      histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates_retry');
    }
    historyHttpStatus = histResult.ok ? 200 : histResult.status;

    if (!histResult.ok && histResult.status === 429) {
      // Stocks Basic allows only a few calls per minute. Stop hammering it for
      // the rest of this request; remaining tickers stay Pending (honestly).
      ctx.historyRateLimited = true;
    }

    if (histResult.ok) {
      // Completed sessions only — a partial "today" bar would make RSI/support
      // change during the day and differ between Rescan and Analyze.
      const freshBars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
      })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0 && b.date < todayStr && !isWeekendDate(b.date));

      if (freshBars.length > 0) {
        const barMap = new Map<string, HistoryBar>();
        for (const b of bars) barMap.set(b.date, b);
        for (const b of freshBars) barMap.set(b.date, b); // fresh overrides cached
        bars = trailingContiguousBars(Array.from(barMap.values()).sort((a, b) => a.date.localeCompare(b.date)));
        await saveCachedHistory(upper, freshBars);
      }
    } else if (!error) {
      error = `Aggregates HTTP ${histResult.status}: ${histResult.body.slice(0, 200)}`;
    }
  } else if (allowLiveHistory && wantsFetch && ctx.historyRateLimited) {
    error = 'History fetch skipped — Massive rate limit reached earlier in this request';
  }

  if (currentPrice === null && bars.length > 0) {
    currentPrice = Number(bars.at(-1)!.close);
    source = 'daily_aggregates';
  }
  if (historyHttpStatus === undefined && bars.length > 0) historyHttpStatus = 200;

  // 4. Fallback: previous close — only if we still have NO price at all
  if (currentPrice === null && allowLiveHistory && !ctx.historyRateLimited) {
    const prevPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/prev?adjusted=true`;
    const prevResult = await massiveFetch(prevPath, apiKey, upper, 'stock_previous_close');
    if (prevResult.ok) {
      const prevBars = (prevResult.data?.results || []).map((b: any) => Number(b.c || 0)).filter((c: number) => Number.isFinite(c) && c > 0);
      if (prevBars.length) {
        currentPrice = Number(prevBars.at(-1));
        source = 'previous_close';
      }
    } else {
      if (prevResult.status === 429) ctx.historyRateLimited = true;
      if (!error) error = `Previous-close HTTP ${prevResult.status}: ${prevResult.body.slice(0, 200)}`;
    }
  }

  const snapshot: StockSnapshot = { ticker: upper, currentPrice, historicalBars: bars, source, error, historyHttpStatus };
  ctx.stockCache.set(upper, snapshot);
  return snapshot;
}

// ── One ranking used everywhere (Today's Candidates, Analyze best contract,
// per-ticker response cap). Must match src/lib/status.ts on the client. ──
// Qualified > Pending > Rejected, then higher option volume, lower Premium
// Capture (contracts without a premium rank last), higher Net CROI, higher OI.
function contractStatusRank(c: any): number {
  if (c.qualified && !c.technical_pending) return 0;
  if (c.technical_pending) return 1;
  return 2;
}
function compareContracts(a: any, b: any): number {
  const sa = contractStatusRank(a), sb = contractStatusRank(b);
  if (sa !== sb) return sa - sb;
  const va = Number(a.volume || 0), vb = Number(b.volume || 0);
  if (va !== vb) return vb - va;
  const pa = a.has_quotes ? Number(a.premium_capture ?? Infinity) : Infinity;
  const pb = b.has_quotes ? Number(b.premium_capture ?? Infinity) : Infinity;
  if (pa !== pb) return pa - pb;
  const ca = Number(a.net_croi || 0), cb = Number(b.net_croi || 0);
  if (ca !== cb) return cb - ca;
  return Number(b.open_interest || 0) - Number(a.open_interest || 0);
}

async function scanSymbol(
  symbol: string,
  companyName: string,
  profile: Profile,
  apiKey: string,
  openTickers: string[],
  noFilterMode: boolean,
  today: Date,
  fmt: (d: Date) => string,
  verbose: boolean,
  analyzeMode: boolean,
  bulkStockPrice: number | null,
  allowLiveHistory: boolean,
  ctx: ScanContext,
): Promise<ScanSymbolResult> {
  const r: ScanSymbolResult = {
    candidates: [],
    chainStatus: 'no_options',
    putsReturned: 0, filteredByExpiration: 0, filteredByStrike: 0,
    missingStrike: 0, missingExpiration: 0, missingLastQuote: 0,
    missingBid: 0, zeroBid: 0, missingAsk: 0, zeroAsk: 0, askLtBid: 0, otherInvalid: 0,
    validQuotes: 0, contractsAwaitingQuotes: 0, evaluated: 0, qualified: 0, rejected: 0, pending: 0, pagesFetched: 0,
    techRejections: { rsi_below_min: 0, rsi_above_max: 0, ma20_not_above_ma50: 0, ma50_not_above_ma200: 0, price_not_above_ma200: 0, downtrend_no_support: 0, support_dist_below_min: 0, support_dist_above_max: 0, technical_data_missing: 0 },
    orderStrikeRejections: { stock_below_min: 0, stock_above_max: 0, strike_above_max: 0 },
    historyBarCount: 0,
    supportDistanceDebug: { before: 0, passed: 0, below_min: 0, above_max: 0, missing_support: 0, details: [] },
  };

  // ── Which rules are active (single source of truth for this contract set) ──
  // The master Technical Rules toggle alone never requires data or changes
  // results; only individual rules that are actually set do.
  const technicalSectionOn = !noFilterMode && !isSectionOff(profile, 'technical_rules_enabled');
  const rsiActive = technicalSectionOn && (profile.rsi_min != null || profile.rsi_max != null);
  const ma20AboveMa50Active = technicalSectionOn && profile.require_ma20_above_ma50 === true;
  const ma50AboveMa200Active = technicalSectionOn && profile.require_ma50_above_ma200 === true;
  const priceAboveMa200Active = technicalSectionOn && profile.require_price_above_ma200 === true;
  const downtrendRuleActive = technicalSectionOn && profile.exclude_downtrend_no_support === true;
  const hasActiveTechnicalRule = rsiActive || ma20AboveMa50Active || ma50AboveMa200Active || priceAboveMa200Active || downtrendRuleActive;
  // Support Distance is its own section and only counts when a bound is set.
  const supportDistanceActive = !noFilterMode && !isSectionOff(profile, 'support_distance_enabled') &&
    (profile.minimum_support_distance_pct != null || profile.maximum_support_distance_pct != null);

  // Minimum bars needed to evaluate the ACTIVE rules only (0 if none).
  let minBarsRequired = 0;
  if (rsiActive) minBarsRequired = Math.max(minBarsRequired, 20);
  if (ma20AboveMa50Active) minBarsRequired = Math.max(minBarsRequired, 50);
  if (downtrendRuleActive || supportDistanceActive) minBarsRequired = Math.max(minBarsRequired, 60);
  if (ma50AboveMa200Active || priceAboveMa200Active) minBarsRequired = Math.max(minBarsRequired, 200);
  r.needsHistoryBars = minBarsRequired;

  // Analyze Ticker always tries to have 60 bars so it can DISPLAY technicals;
  // that never changes evaluation, which depends only on the active rules.
  const fetchBars = analyzeMode ? Math.max(minBarsRequired, 60) : minBarsRequired;
  const snapshot = await getStockSnapshot(symbol, apiKey, today, fmt, bulkStockPrice, analyzeMode || allowLiveHistory, fetchBars, ctx);
  const bars = snapshot.historicalBars;
  let stockPrice: number | null = snapshot.currentPrice;
  r.stockSource = snapshot.source;

  // Debug logging for specific tickers
  if (DEBUG_TICKERS.has(symbol.toUpperCase())) {
    const histClose = bars.length > 0 ? bars.at(-1)!.close : null;
    console.log(`[PRICE] ${symbol} | grouped=${bulkStockPrice} | historyStatus=${snapshot.historyHttpStatus || 'n/a'} | historyClose=${histClose} | optionUnderlying=pending | final=${stockPrice} | source=${snapshot.source}`);
  }

  if (snapshot.error && !bars.length) {
    r.historyStatus = 'error';
    r.historyError = snapshot.error;
  } else if (bars.length >= 200) {
    r.historyStatus = 'success';
  } else if (bars.length >= 60) {
    r.historyStatus = 'partial';
  } else if (bars.length > 0) {
    r.historyStatus = 'fallback';
  } else {
    r.historyStatus = 'empty';
  }

  const ma200DataAvailable = bars.length >= 200;
  const technicalDataAvailable = bars.length >= minBarsRequired;
  r.technicalDataAvailable = technicalDataAvailable;
  r.historyBarCount = bars.length;

  // Support/trend require 60 bars regardless of RSI-only rules.
  const supportDataAvailable = bars.length >= 60;
  let primarySupport: number | null = supportDataAvailable && stockPrice !== null && stockPrice > 0 ? calcPrimarySupport(bars, stockPrice) : null;
  let secondarySupport: number | null = supportDataAvailable && primarySupport !== null ? calcSecondarySupport(bars, primarySupport) : null;
  let resistance: number | null = supportDataAvailable && stockPrice !== null && stockPrice > 0 ? findResistance(bars, stockPrice) : null;
  const trendClass = supportDataAvailable ? trend(bars) : 'Pending';

  r.stockPrice = stockPrice;
  r.primarySupport = primarySupport;
  r.secondarySupport = secondarySupport;
  r.resistance = resistance;
  r.trendClass = trendClass;

  // Debug logging for technical data — comprehensive for debug tickers
  if (DEBUG_TICKERS.has(symbol.toUpperCase())) {
    const supportDistForLog = primarySupport !== null && primarySupport > 0 && stockPrice !== null
      ? ((primarySupport - stockPrice) / primarySupport * 100).toFixed(1)
      : 'n/a';
    console.log(`[TECH] ${symbol} | historyHTTP=${snapshot.historyHttpStatus || 'n/a'} | historyResults=${bars.length} | finalBars=${bars.length} | oldestDate=${bars.length > 0 ? bars[0].date : 'n/a'} | latestDate=${bars.length > 0 ? bars.at(-1)!.date : 'n/a'} | stockPrice=${stockPrice} | primarySupport=${primarySupport} | secondarySupport=${secondarySupport} | resistance=${resistance} | trend=${trendClass} | supportDist=${supportDistForLog} | technicalDataAvailable=${technicalDataAvailable}`);
  }


  // Compute technicals whenever we have enough bars for ANY indicator.
  // RSI needs 15, MA20 needs 20, MA50 needs 50, MA200 needs 200.
  // Compute what we can; missing indicators stay null/0.
  if (bars.length >= 20) {
    const closes = bars.map((b) => b.close);
    // Fixed 250-bar window so Rescan and Analyze get the identical RSI even if
    // one of them holds a longer history slice.
    const rsiValue = rsi(closes.slice(-250));
    const m = closes.length >= 26 ? macd(closes) : { macd: 0, signal: 0, histogram: 0 };
    const bb = closes.length >= 20 ? bollingerBands(closes) : { upper: 0, middle: 0, lower: 0, position: 'Insufficient data' };
    const has200 = closes.length >= 200;
    r.technical = {
      rsi: rsiValue !== null ? Number(rsiValue.toFixed(1)) : null,
      ma20: closes.length >= 20 ? Number(sma(closes, 20).toFixed(2)) : null,
      ma50: closes.length >= 50 ? Number(sma(closes, 50).toFixed(2)) : null,
      ma200: has200 ? Number(sma(closes, 200).toFixed(2)) : null,
      macd: m.macd,
      macd_signal: m.signal,
      macd_histogram: m.histogram,
      bb_upper: bb.upper,
      bb_middle: bb.middle,
      bb_lower: bb.lower,
      bb_position: bb.position,
      volume_trend: volumeTrend(bars),
    };
  }

  // Step 2: Options chain — build URL with server-side filters to reduce pages
  const chainParams = new URLSearchParams();
  chainParams.set('contract_type', 'put');

  // Server-side strike filter (if Order & Strike enabled)
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled') && profile.max_strike != null) {
    chainParams.set('strike_price.lte', String(profile.max_strike));
  }

  // Server-side expiration filter (if Expiration enabled)
  if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
    const minDte = profile.min_dte ?? 0;
    const minDate = new Date(today);
    minDate.setDate(minDate.getDate() + minDte);
    chainParams.set('expiration_date.gte', fmt(minDate));
  }

  const chainPath = `/v3/snapshot/options/${encodeURIComponent(symbol)}?${chainParams.toString()}`;
  const allRawContracts: any[] = [];
  let pageCount = 0;
  let currentPath = chainPath;
  let chainError: { status: number; body: string } | null = null;

  // Collect representative raw contracts for logging
  let sampleWithQuote: any = null;
  let sampleWithoutQuote: any = null;
  let sampleOtherInvalid: any = null;

  const cachedChain = ctx.chainCache.get(symbol.toUpperCase());
  if (cachedChain) {
    // Re-evaluation pass: reuse the exact chain from the first pass.
    allRawContracts.push(...cachedChain.contracts);
    pageCount = cachedChain.pages;
    currentPath = '';
  }

  while (currentPath && pageCount < MAX_CHAIN_PAGES) {
    pageCount++;
    r.pagesFetched++;
    const pageResult = await massiveFetch(currentPath, apiKey, symbol, `options_snapshot_p${pageCount}`);

    if (!pageResult.ok) {
      chainError = { status: pageResult.status, body: pageResult.body };
      if (verbose) console.log(`[VERBOSE] ${symbol} | options_snapshot FAILED | HTTP ${pageResult.status} | body: ${pageResult.body.slice(0, 200)}`);
      break;
    }

    const pageResults = pageResult.data?.results || [];
    allRawContracts.push(...pageResults);

    if (verbose && pageCount === 1) {
      console.log(`[VERBOSE] ${symbol} | options_snapshot OK | HTTP 200 | result_count=${pageResults.length}`);
      console.log(`[VERBOSE] ${symbol} | response keys: ${Object.keys(pageResult.data || {}).join(', ')}`);
    }

    // Collect representative samples
    for (const c of pageResults) {
      if (c?.details?.contract_type !== 'put') continue;
      if (!sampleWithQuote && c?.last_quote && Number(c.last_quote.bid || 0) > 0) {
        sampleWithQuote = c;
        logRawContract('WITH_QUOTE', symbol, c);
      }
      if (!sampleWithoutQuote && (!c?.last_quote || typeof c.last_quote !== 'object')) {
        sampleWithoutQuote = c;
        logRawContract('WITHOUT_QUOTE', symbol, c);
      }
      if (!sampleOtherInvalid && c?.last_quote && Number(c.last_quote.bid || 0) === 0 && Number(c.last_quote.ask || 0) > 0) {
        sampleOtherInvalid = c;
        logRawContract('ZERO_BID', symbol, c);
      }
    }

    const nextUrl = pageResult.data?.next_url;
    if (nextUrl && typeof nextUrl === 'string' && nextUrl.length > 0) {
      try { const parsed = new URL(nextUrl); currentPath = parsed.pathname + parsed.search; }
      catch { currentPath = ''; }
    } else { currentPath = ''; }
  }

  if (!chainError && !cachedChain) {
    ctx.chainCache.set(symbol.toUpperCase(), { contracts: allRawContracts, pages: pageCount });
  }

  // Determine chain status
  const contracts = allRawContracts.filter((c: any) => c?.details?.contract_type === 'put');
  r.putsReturned = contracts.length;

  // ── Tier 2: Option snapshot underlying_asset price ──
  // Always extract it (even if we already have a price) so we can save it to cache.
  if (allRawContracts.length) {
    const underlyingPrice = allRawContracts
      .map((c: any) => Number(c?.underlying_asset?.price || c?.underlying_asset?.value || 0))
      .find((v: number) => Number.isFinite(v) && v > 0) || 0;
    if (underlyingPrice > 0) {
      // Save to persistent price cache
      if (!cachedChain) void saveCachedStockPrice(symbol, underlyingPrice, 'option_snapshot', fmt(today));
      // Use as stock price if we don't already have one from grouped daily
      if (stockPrice === null || stockPrice <= 0) {
        stockPrice = underlyingPrice;
        r.stockPrice = stockPrice;
        r.stockSource = 'underlying_asset';
      }
    }
  }

  // ── Tier 3: Latest historical daily close (already handled in getStockSnapshot) ──
  // (bars.at(-1).close is used as a fallback inside getStockSnapshot)

  // ── Tier 4: Persistent stock_price_cache ──
  if ((stockPrice === null || stockPrice <= 0) && !analyzeMode) {
    const cached = await loadCachedStockPrice(symbol);
    if (cached && cached.price > 0) {
      stockPrice = cached.price;
      r.stockPrice = stockPrice;
      r.stockSource = 'cached';
    }
  }

  // ── Tier 5: Latest non-null candidate_scans.stock_price ──
  if (stockPrice === null || stockPrice <= 0) {
    const prevScanPrice = await fetchLatestCandidateStockPrice(symbol);
    if (prevScanPrice !== null && prevScanPrice > 0) {
      stockPrice = prevScanPrice;
      r.stockPrice = stockPrice;
      r.stockSource = 'previous_scan';
    }
  }

  // ── Save any valid final price to persistent cache (if not already saved from tier 2) ──
  if (stockPrice !== null && stockPrice > 0 && r.stockSource !== 'underlying_asset') {
    void saveCachedStockPrice(symbol, stockPrice, r.stockSource || 'unknown', fmt(today));
  }

  // If price was discovered only after the option snapshot arrived, recalculate
  // price-dependent technical levels now. Previously these stayed null forever.
  if (stockPrice !== null && stockPrice > 0 && supportDataAvailable) {
    if (primarySupport === null) primarySupport = calcPrimarySupport(bars, stockPrice);
    if (secondarySupport === null && primarySupport !== null) secondarySupport = calcSecondarySupport(bars, primarySupport);
    if (resistance === null) resistance = findResistance(bars, stockPrice);
    r.stockPrice = stockPrice;
    r.primarySupport = primarySupport;
    r.secondarySupport = secondarySupport;
    r.resistance = resistance;
    r.trendClass = trendClass;
  } else {
    r.stockPrice = stockPrice;
  }

  // Stock-price filter is applied at the contract level (as a rejection reason)
  // rather than aborting the whole symbol, so option chain availability is
  // reported accurately in scan counts.

  if (chainError) {
    if (chainError.status === 401 || chainError.status === 403) r.chainStatus = 'unauthorized';
    else if (chainError.status === 429) r.chainStatus = 'rate_limited';
    else if (chainError.status === 0) r.chainStatus = 'network_error';
    else r.chainStatus = 'api_error';
    if (verbose) console.log(`[VERBOSE] ${symbol} | chain_status=${r.chainStatus} | HTTP ${chainError.status} | puts=${contracts.length}`);
    return r;
  }

  r.chainStatus = contracts.length > 0 ? 'success' : 'no_options';

  if (verbose) {
    console.log(`[VERBOSE] ${symbol} | chain_status=${r.chainStatus} | total_contracts=${allRawContracts.length} | puts=${contracts.length} | pages=${pageCount}`);
  }

  // Store raw sample for response
  if (sampleWithQuote) r.rawSample = sampleWithQuote;

  // ── Pre-filtering: expiration ──
  let filteredContracts = contracts;
  if (noFilterMode || isSectionOff(profile, 'expiration_enabled')) {
    if (verbose) console.log(`[VERBOSE] ${symbol} | expiration filter: SKIPPED (section off or noFilter)`);
  } else {
    const before = filteredContracts.length;
    const minDte = profile.min_dte ?? 0;
    filteredContracts = filteredContracts.filter((c: any) => {
      const dte = calcDTE(c?.details?.expiration_date, today);
      return dte >= minDte;
    });

    r.filteredByExpiration = before - filteredContracts.length;
    if (verbose) {
      const sampleExp = contracts[0]?.details?.expiration_date;
      console.log(`[VERBOSE] ${symbol} | raw expiration_date sample: ${JSON.stringify(sampleExp)} | type: ${typeof sampleExp}`);
      console.log(`[VERBOSE] ${symbol} | expiration filter (DTE >= ${profile.min_dte}): ${before} -> ${filteredContracts.length} (removed ${r.filteredByExpiration})`);
    }
  }

  // ── Pre-filtering: strike (client-side safety net, server already filtered) ──
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled') && profile.max_strike != null) {
    const before = filteredContracts.length;
    filteredContracts = filteredContracts.filter((c: any) => {
      const s = Number(c.details.strike_price);
      if (s > profile.max_strike!) return false;
      return true;
    });
    r.filteredByStrike = before - filteredContracts.length;
    if (verbose) console.log(`[VERBOSE] ${symbol} | strike filter (max ${profile.max_strike}): ${before} -> ${filteredContracts.length} (removed ${r.filteredByStrike})`);
  }

  if (verbose) {
    console.log(`[VERBOSE] ${symbol} | contracts to evaluate: ${filteredContracts.length}`);
    console.log(`[VERBOSE] ${symbol} | pipeline: puts=${contracts.length} | filtExp=${r.filteredByExpiration} | filtStrike=${r.filteredByStrike} | remaining=${filteredContracts.length}`);
  }

  // ── Contract evaluation — premium estimated from Massive Options Chain Snapshot ──
  // Premium priority: MID (bid+ask)/2 → LAST (latest trade) → DAY CLOSE → UNAVAILABLE
  // CROI/PC qualification applies when a suggested STO is available.
  const analyses: any[] = [];

  for (const c of filteredContracts) {
    const strike = Number(c?.details?.strike_price || 0);
    const expiration = c?.details?.expiration_date as string;

    // Skip counting: strike
    if (!strike || strike <= 0 || !isFinite(strike)) { r.missingStrike++; continue; }
    // Skip counting: expiration
    if (!expiration) { r.missingExpiration++; continue; }

    const dte = Math.max(0, calcDTE(expiration, today));
    const volume = Number(c?.day?.volume || c?.volume || 0);
    const oi = Number(c?.open_interest || 0);
    const iv = Number(c?.implied_volatility || 0) * 100;
    const delta = Number(c?.greeks?.delta || 0);

    // Extract premium using priority: MID → LAST → DAY CLOSE → UNAVAILABLE
    const { bid, ask, mid, suggestedSTO, premiumSource } = extractPremium(c);
    const hasPremium = suggestedSTO !== null && suggestedSTO > 0;

    // Spread only calculable with valid bid+ask
    const hasBidAsk = bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid;
    const sp = hasBidAsk ? spreadPct(bid!, ask!) : 0;

    // ── Non-premium qualification rules (applied regardless of premium availability) ──
    // A contract can be: Qualified, Rejected (failed a rule), or Pending (data
    // needed to evaluate a rule is temporarily unavailable).
    // Pending contracts are NOT counted as rejected — they may qualify once
    // the missing data loads.
    const reasons: string[] = [];
    const pendingReasons: string[] = [];
    if (!noFilterMode) {
      if (profile.exclude_existing_positions && openTickers.includes(symbol)) reasons.push('Existing position');

      // ── ORDER & STRIKE SECTION ──
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        // Max Put Strike: null/undefined/"" means no strike maximum
        if (profile.max_strike != null && profile.max_strike !== undefined && strike > profile.max_strike) {
          reasons.push('Strike too high');
          r.orderStrikeRejections!.strike_above_max++;
        }
        // Stock price filters
        if (stockPrice !== null && stockPrice > 0) {
          if (profile.minimum_stock_price != null && profile.minimum_stock_price !== undefined && stockPrice < profile.minimum_stock_price) {
            if (!reasons.includes('Stock price below minimum')) reasons.push('Stock price below minimum');
            r.orderStrikeRejections!.stock_below_min++;
          }
          if (profile.maximum_stock_price != null && profile.maximum_stock_price !== undefined && stockPrice > profile.maximum_stock_price) {
            if (!reasons.includes('Stock price above maximum')) reasons.push('Stock price above maximum');
            r.orderStrikeRejections!.stock_above_max++;
          }
        } else {
          // Stock price unavailable — Pending, not Rejected
          if (profile.minimum_stock_price != null && profile.minimum_stock_price !== undefined) {
            if (!pendingReasons.includes('Stock price unavailable — minimum stock price rule not evaluated')) {
              pendingReasons.push('Stock price unavailable — minimum stock price rule not evaluated');
            }
          }
          if (profile.maximum_stock_price != null && profile.maximum_stock_price !== undefined) {
            if (!pendingReasons.includes('Stock price unavailable — maximum stock price rule not evaluated')) {
              pendingReasons.push('Stock price unavailable — maximum stock price rule not evaluated');
            }
          }
        }
      }

      // ── TECHNICAL RULES SECTION ──
      // Each rule is evaluated independently against its own data requirement.
      // RSI needs 15 bars, MA20>MA50 needs 50, MA200 rules need 200, downtrend needs 60.
      // Missing data for an OFF rule must NOT cause Pending.
      if (hasActiveTechnicalRule) {
        const tech = r.technical;
        const barsAvailable = bars.length;

        // RSI — needs 20 bars (RSI-14 plus safety margin)
        if (rsiActive) {
          if (barsAvailable >= 20 && tech && tech.rsi != null) {
            if (profile.rsi_min != null && tech.rsi < profile.rsi_min) {
              if (!reasons.includes('RSI below minimum')) reasons.push('RSI below minimum');
              r.techRejections!.rsi_below_min++;
            }
            if (profile.rsi_max != null && tech.rsi > profile.rsi_max) {
              if (!reasons.includes('RSI above maximum')) reasons.push('RSI above maximum');
              r.techRejections!.rsi_above_max++;
            }
          } else {
            if (!pendingReasons.includes('RSI unavailable')) {
              pendingReasons.push('RSI unavailable');
              r.techRejections!.technical_data_missing++;
            }
          }
        }

        // MA20 > MA50 — needs 50 bars
        if (ma20AboveMa50Active) {
          if (barsAvailable >= 50 && tech && tech.ma20 != null && tech.ma50 != null) {
            if (tech.ma20 <= tech.ma50) {
              if (!reasons.includes('MA20 not above MA50')) reasons.push('MA20 not above MA50');
              r.techRejections!.ma20_not_above_ma50++;
            }
          } else {
            if (!pendingReasons.includes('MA20 > MA50 not evaluated — insufficient history (need 50 bars)')) {
              pendingReasons.push('MA20 > MA50 not evaluated — insufficient history (need 50 bars)');
            }
          }
        }

        // MA50 > MA200 — needs 200 bars
        if (ma50AboveMa200Active) {
          if (ma200DataAvailable && tech && tech.ma200 != null && tech.ma50 != null) {
            if (tech.ma50 <= tech.ma200) {
              if (!reasons.includes('MA50 not above MA200')) reasons.push('MA50 not above MA200');
              r.techRejections!.ma50_not_above_ma200++;
            }
          } else {
            if (!pendingReasons.includes('MA50 > MA200 not evaluated — insufficient history (need 200 bars)')) {
              pendingReasons.push('MA50 > MA200 not evaluated — insufficient history (need 200 bars)');
            }
          }
        }

        // Price > MA200 — needs 200 bars
        if (priceAboveMa200Active) {
          if (ma200DataAvailable && tech && tech.ma200 != null) {
            if (stockPrice !== null && stockPrice > 0 && stockPrice <= tech.ma200) {
              if (!reasons.includes('Price not above MA200')) reasons.push('Price not above MA200');
              r.techRejections!.price_not_above_ma200++;
            }
          } else {
            if (!pendingReasons.includes('Price > MA200 not evaluated — insufficient history (need 200 bars)')) {
              pendingReasons.push('Price > MA200 not evaluated — insufficient history (need 200 bars)');
            }
          }
        }

        // Downtrend without support — needs 60 bars (for trend + support)
        if (downtrendRuleActive) {
          if (supportDataAvailable) {
            if (trendClass === 'Downtrend' && primarySupport !== null && primarySupport > 0 && strike >= primarySupport) {
              reasons.push('Downtrend without support');
              r.techRejections!.downtrend_no_support++;
            }
          } else {
            if (!pendingReasons.includes('Downtrend rule not evaluated — insufficient history (need 60 bars)')) {
              pendingReasons.push('Downtrend rule not evaluated — insufficient history (need 60 bars)');
            }
          }
        }
      }

      // ── SUPPORT DISTANCE SECTION (independent of technical_rules_enabled) ──
      // Missing support is ALWAYS Pending here — a contract can never qualify
      // with Support Dist = "--" while this rule is active.
      if (supportDistanceActive) {
        if (primarySupport !== null && primarySupport > 0) {
          const supportDistPct = ((primarySupport - strike) / primarySupport) * 100;
          const passesMin = profile.minimum_support_distance_pct == null || supportDistPct >= profile.minimum_support_distance_pct;
          const passesMax = profile.maximum_support_distance_pct == null || supportDistPct <= profile.maximum_support_distance_pct;
          const finalSupportDistancePass = passesMin && passesMax;
          if (!passesMin) {
            reasons.push('Support distance too low');
            r.techRejections!.support_dist_below_min++;
          }
          if (!passesMax) {
            reasons.push('Support distance too high');
            r.techRejections!.support_dist_above_max++;
          }
          r.supportDistanceDebug!.before++;
          if (finalSupportDistancePass) r.supportDistanceDebug!.passed++;
          else if (!passesMin) r.supportDistanceDebug!.below_min++;
          else if (!passesMax) r.supportDistanceDebug!.above_max++;
          if (r.supportDistanceDebug!.details.length < 25) r.supportDistanceDebug!.details.push({
            ticker: symbol, strike, primarySupport,
            supportDistancePct: Number(supportDistPct.toFixed(2)),
            passesMin, passesMax, finalSupportDistancePass,
            status: finalSupportDistancePass ? 'pass' : !passesMin ? 'fail_below_min' : 'fail_above_max',
          });
        } else {
          r.supportDistanceDebug!.before++;
          r.supportDistanceDebug!.missing_support++;
          if (r.supportDistanceDebug!.details.length < 25) r.supportDistanceDebug!.details.push({
            ticker: symbol, strike, primarySupport: null,
            supportDistancePct: null, passesMin: false, passesMax: false,
            finalSupportDistancePass: false, status: 'pending_missing_support',
          });
          if (!pendingReasons.includes('Primary support unavailable')) {
            pendingReasons.push('Primary support unavailable');
            r.techRejections!.technical_data_missing++;
          }
        }
      }

      // OI and volume rules are non-premium — they come from the contract itself
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        if (oi < profile.min_target_oi) reasons.push('OI too low');
        if (volume < profile.preferred_daily_volume) reasons.push('Insufficient liquidity');
      }
    }

    // Track premium availability
    if (hasPremium) {
      r.validQuotes++;
    } else {
      r.contractsAwaitingQuotes++;
    }

    // Financial calculations only when a suggested STO is available
    let stoPrice = 0, btcPrice: number | null = null, netProfit = 0, netCroi = 0, pc = 0, breakeven = 0;
    let croiOptimized = false;
    if (hasPremium) {
      stoPrice = suggestedSTO!;
      const btcResult = calcBtc(stoPrice, strike, profile);
      if (btcResult.btc !== null) {
        btcPrice = btcResult.btc;
        netProfit = btcResult.netProfit;
        netCroi = btcResult.netCroi;
        pc = btcResult.pc;
        croiOptimized = true;
      }
      breakeven = strike - stoPrice;

      // CROI & Premium Capture qualification (when section ON):
      // PASS only if netCROI >= min AND premiumCapture <= max AND BTC > 0
      if (!noFilterMode && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
        if (!croiOptimized || netCroi < profile.min_net_croi || pc > profile.max_premium_capture) {
          reasons.push('CROI too low');
        }
      }

      // Spread rule only applies when bid/ask exist
      if (!noFilterMode && !isSectionOff(profile, 'spread_enabled') && hasBidAsk && sp > profile.max_spread_pct) {
        if (!reasons.includes('Spread too wide')) {
          reasons.push('Spread too wide');
        }
      }
    } else if (!noFilterMode && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
      // No premium available and CROI filter is ON — required data missing, not a failure
      if (!pendingReasons.includes('Premium/quote unavailable for CROI calculation')) {
        pendingReasons.push('Premium/quote unavailable for CROI calculation');
      }
    }

    // A contract is Pending if it has no hard rejections but has pending reasons
    // (data needed to evaluate a rule is temporarily unavailable).
    const hasRejections = reasons.length > 0;
    const hasPending = pendingReasons.length > 0;
    const isPending = !hasRejections && hasPending;
    const qualified = !hasRejections && !isPending;
    r.evaluated++;
    if (qualified) r.qualified++;
    else if (isPending) r.pending++;
    else r.rejected++;

    // Debug logging for MARA and other specific tickers
    if (['MARA', 'CIFR', 'WULF'].includes(symbol.toUpperCase())) {
      const supportDistPct = primarySupport !== null && primarySupport > 0
        ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1))
        : null;
      console.log(`[UNIVERSE DEBUG] ${symbol} | strike=${strike} | exp=${expiration} | stockPrice=${stockPrice} | trend=${trendClass} | primarySupport=${primarySupport} | supportDist=${supportDistPct}% | netCROI=${netCroi} | PC=${pc} | qualified=${qualified} | isPending=${isPending} | reasons=${JSON.stringify(reasons)} | pendingReasons=${JSON.stringify(pendingReasons)}`);
    }

    const premiumSourceOut = premiumSource as string;

    // ── Build pass/fail rule checks for both scan and analyze modes ──
    const passFail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[] = [];
    if (!noFilterMode) {
      if (profile.exclude_existing_positions && openTickers.includes(symbol)) {
        passFail.push({ rule: 'No existing open position', pass: false, status: 'fail' });
      }
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        if (profile.max_strike != null) {
          passFail.push({ rule: `Strike <= ${profile.max_strike}`, pass: strike <= profile.max_strike, status: strike <= profile.max_strike ? 'pass' : 'fail' });
        }
        if (profile.minimum_stock_price != null || profile.maximum_stock_price != null) {
          if (stockPrice !== null && stockPrice > 0) {
            const minOk = profile.minimum_stock_price == null || stockPrice >= profile.minimum_stock_price;
            const maxOk = profile.maximum_stock_price == null || stockPrice <= profile.maximum_stock_price;
            passFail.push({ rule: `Stock price in range (${stockPrice.toFixed(2)})`, pass: minOk && maxOk, status: minOk && maxOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'Stock price range — price unavailable', pass: true, status: 'not_evaluated' });
          }
        }
      }
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        passFail.push({ rule: `OI >= ${profile.min_target_oi}`, pass: oi >= profile.min_target_oi, status: oi >= profile.min_target_oi ? 'pass' : 'fail' });
        passFail.push({ rule: `Sufficient liquidity (volume >= ${profile.preferred_daily_volume})`, pass: volume >= profile.preferred_daily_volume, status: volume >= profile.preferred_daily_volume ? 'pass' : 'fail' });
      }
      if (hasActiveTechnicalRule) {
        const tech = r.technical;
        const barsAvailable = bars.length;
        if (rsiActive) {
          if (barsAvailable >= 20 && tech && tech.rsi != null) {
            if (profile.rsi_min != null) {
              const rsiOk = tech.rsi >= profile.rsi_min;
              passFail.push({ rule: `RSI >= ${profile.rsi_min} (${tech.rsi})`, pass: rsiOk, status: rsiOk ? 'pass' : 'fail' });
            }
            if (profile.rsi_max != null) {
              const rsiOk = tech.rsi <= profile.rsi_max;
              passFail.push({ rule: `RSI <= ${profile.rsi_max} (${tech.rsi})`, pass: rsiOk, status: rsiOk ? 'pass' : 'fail' });
            }
          } else {
            passFail.push({ rule: `RSI — insufficient history (need 20 bars, have ${barsAvailable})`, pass: true, status: 'not_evaluated' });
          }
        }
        if (ma20AboveMa50Active) {
          if (barsAvailable >= 50 && tech && tech.ma20 != null && tech.ma50 != null) {
            const maOk = tech.ma20 > tech.ma50;
            passFail.push({ rule: `MA20 > MA50 (${tech.ma20} vs ${tech.ma50})`, pass: maOk, status: maOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'MA20 > MA50 — insufficient history (need 50 bars)', pass: true, status: 'not_evaluated' });
          }
        }
        if (ma50AboveMa200Active) {
          if (ma200DataAvailable && tech && tech.ma200 != null && tech.ma50 != null) {
            const maOk = tech.ma50 > tech.ma200;
            passFail.push({ rule: `MA50 > MA200 (${tech.ma50} vs ${tech.ma200})`, pass: maOk, status: maOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'MA50 > MA200 — insufficient history (need 200 bars)', pass: true, status: 'not_evaluated' });
          }
        }
        if (priceAboveMa200Active) {
          if (ma200DataAvailable && tech && tech.ma200 != null) {
            const priceOk = stockPrice !== null && stockPrice > 0 && stockPrice > tech.ma200;
            passFail.push({ rule: `Price > MA200 (${stockPrice} vs ${tech.ma200})`, pass: priceOk, status: priceOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'Price > MA200 — insufficient history (need 200 bars)', pass: true, status: 'not_evaluated' });
          }
        }
        if (downtrendRuleActive) {
          if (supportDataAvailable) {
            const trendOk = !(trendClass === 'Downtrend' && primarySupport !== null && primarySupport > 0 && strike >= primarySupport);
            passFail.push({ rule: `Trend acceptable (${trendClass})`, pass: trendOk, status: trendOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'Downtrend rule — insufficient history (need 60 bars)', pass: true, status: 'not_evaluated' });
          }
        }
      }
      if (supportDistanceActive) {
        if (primarySupport !== null && primarySupport > 0) {
          const supportDistPct = ((primarySupport - strike) / primarySupport) * 100;
          const distMinOk = profile.minimum_support_distance_pct == null || supportDistPct >= profile.minimum_support_distance_pct;
          const distMaxOk = profile.maximum_support_distance_pct == null || supportDistPct <= profile.maximum_support_distance_pct;
          const distOk = distMinOk && distMaxOk;
          const distLabel = `${profile.minimum_support_distance_pct != null ? profile.minimum_support_distance_pct + '%' : 'no min'}–${profile.maximum_support_distance_pct != null ? profile.maximum_support_distance_pct + '%' : 'no max'}`;
          passFail.push({ rule: `Support distance ${distLabel} (${supportDistPct.toFixed(1)}%)`, pass: distOk, status: distOk ? 'pass' : 'fail' });
        } else {
          passFail.push({ rule: 'Support distance not evaluated — support unavailable', pass: true, status: 'not_evaluated' });
        }
      }
      if (hasBidAsk && !isSectionOff(profile, 'spread_enabled')) {
        const spreadOk = sp <= profile.max_spread_pct;
        passFail.push({ rule: `Spread acceptable (<= ${profile.max_spread_pct}%)`, pass: spreadOk, status: spreadOk ? 'pass' : 'fail' });
      }
      if (hasPremium && !isSectionOff(profile, 'croi_pc_enabled')) {
        if (profile.filter_strikes_croi) {
          const croiOk = croiOptimized && netCroi >= profile.min_net_croi && pc <= profile.max_premium_capture;
          passFail.push({ rule: `Filter Strikes by CROI: Net CROI >= ${profile.min_net_croi}% & PC <= ${profile.max_premium_capture}%`, pass: croiOk, status: croiOk ? 'pass' : 'fail' });
        } else {
          // "Filter Strikes by CROI" is OFF, so CROI/PC do NOT decide status.
          // Show them as info only — previously they showed as hard "fail"
          // while the contract was Qualified, which looked inconsistent.
          passFail.push({ rule: `Net CROI ${croiOptimized ? netCroi.toFixed(2) + '%' : 'n/a'} (info — Filter Strikes by CROI is OFF)`, pass: true, status: 'not_evaluated' });
        }
      }
      if (!hasPremium && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
        passFail.push({ rule: 'Filter Strikes by CROI — Premium required', pass: true, status: 'not_evaluated' });
      }
      if (!hasPremium && !isSectionOff(profile, 'croi_pc_enabled') && !profile.filter_strikes_croi) {
        passFail.push({ rule: 'Premium data — enter manually for CROI / PC', pass: true, status: 'not_evaluated' });
      }
    }

    if (analyzeMode) {
      analyses.push({
        strike, expiration, dte,
        bid: hasBidAsk ? Number(bid!.toFixed(2)) : 0,
        ask: hasBidAsk ? Number(ask!.toFixed(2)) : 0,
        mid: hasPremium ? Number(mid.toFixed(2)) : 0,
        spread_pct: hasBidAsk ? Number(sp.toFixed(1)) : 0,
        iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        suggested_sto: hasPremium ? Number(stoPrice.toFixed(2)) : 0,
        suggested_btc: btcPrice !== null ? Number(btcPrice.toFixed(2)) : 0,
        net_profit: hasPremium ? Number(netProfit.toFixed(2)) : 0,
        net_croi: hasPremium ? Number(netCroi.toFixed(2)) : 0,
        premium_capture: hasPremium ? Number(pc.toFixed(1)) : 0,
        breakeven: hasPremium ? Number(breakeven.toFixed(2)) : 0,
        qualified, technical_pending: isPending, pass_fail: passFail,
        rejection_reasons: reasons, pending_reasons: pendingReasons,
        technical_snapshot: r.technical ? { rsi: r.technical.rsi, ma20: r.technical.ma20, ma50: r.technical.ma50, ma200: r.technical.ma200 } : null,
        history_bars: bars.length,
        has_quotes: hasPremium,
        premium_source: premiumSourceOut,
        strike_distance_from_stock: stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null,
        strike_distance_from_support: primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null,
      });
    } else {
      r.candidates.push({
        scan_date: fmt(today), ticker: symbol, company_name: companyName || symbol,
        stock_price: stockPrice !== null && stockPrice > 0 ? Number(stockPrice.toFixed(2)) : null,
        stock_source: r.stockSource || 'none',
        strike, expiration, dte,
        bid: hasBidAsk ? Number(bid!.toFixed(2)) : 0,
        ask: hasBidAsk ? Number(ask!.toFixed(2)) : 0,
        mid: hasPremium ? Number(mid.toFixed(2)) : 0,
        spread_pct: hasBidAsk ? Number(sp.toFixed(1)) : 0,
        iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        trend_classification: trendClass, primary_support: primarySupport !== null ? Number(primarySupport.toFixed(2)) : null,
        suggested_sto: hasPremium ? Number(stoPrice.toFixed(2)) : 0,
        suggested_btc: btcPrice !== null ? Number(btcPrice.toFixed(2)) : 0,
        net_profit: hasPremium ? Number(netProfit.toFixed(2)) : 0,
        net_croi: hasPremium ? Number(netCroi.toFixed(2)) : 0,
        premium_capture: hasPremium ? Number(pc.toFixed(1)) : 0,
        breakeven: hasPremium ? Number(breakeven.toFixed(2)) : 0,
        qualified, rejection_reasons: reasons,
        pending_reasons: pendingReasons,
        technical_pending: isPending,
        pass_fail: passFail,
        strategy_profile_id: profile.id,
        strike_distance_from_stock: stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null,
        strike_distance_from_support: primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null,
        has_quotes: hasPremium,
        premium_source: premiumSourceOut,
        secondary_support: secondarySupport !== null ? Number(secondarySupport.toFixed(2)) : null,
        resistance: resistance !== null ? Number(resistance.toFixed(2)) : null,
        technical_snapshot: r.technical ? { rsi: r.technical.rsi, ma20: r.technical.ma20, ma50: r.technical.ma50, ma200: r.technical.ma200 } : null,
        history_bars: bars.length,
      });
    }
  }

  if (analyzeMode) {
    // Same ranking as Today's Candidates (one shared definition).
    analyses.sort(compareContracts);
    r.analyses = analyses;
  }

  return r;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('market-scan started');
  console.log('MASSIVE_API_KEY exists:', Boolean(Deno.env.get('MASSIVE_API_KEY')));

  // All per-request caches live in a ScanContext created below, so warm
  // isolates and concurrent requests never share or clear each other's state.
  const requestStart = Date.now();

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) return json({ success: false, provider: 'Massive', error: 'MASSIVE_API_KEY is not configured.' });

    const body = await req.json().catch(() => ({}));
    const profile = body.profile as Profile | undefined;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());
    const mode: string = body.mode || 'discovery';
    const scanMode: 'discovery' | 'universe' = body.scanMode === 'universe' ? 'universe' : 'discovery';

    // ── CHART-BARS MODE: return OHLCV bars for TradingView charting ──
    // Does not require a strategy profile — just historical price data.
    if (mode === 'chart-bars') {
      const ticker = String(body.ticker || '').toUpperCase().trim();
      if (!ticker) return json({ success: false, error: 'Missing ticker for chart-bars mode' });

      const resolution: string = body.resolution || '1D';
      const from: number = Number(body.from) || 0;
      const to: number = Number(body.to) || 0;

      // Always work in DAILY bars and aggregate locally. Previously 1W/1M
      // requests fetched weekly/monthly bars from Massive and saved them into
      // the DAILY history cache, corrupting RSI/support for that ticker.
      const chartToday = new Date();
      const chartFmt = (d: Date) => d.toISOString().slice(0, 10);
      const chartTodayStr = chartFmt(chartToday);
      const chartExpected = lastCompletedBusinessDay(chartToday, chartFmt);
      let daily = (await loadCachedHistory(ticker, 500)).filter((b) => b.date < chartTodayStr);

      const chartNeedsFresh = daily.length < 60 || daily.at(-1)!.date < chartExpected;
      if (chartNeedsFresh) {
        const chartStart = new Date(chartToday);
        chartStart.setDate(chartStart.getDate() - 548);
        const histPath = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${chartFmt(chartStart)}/${chartTodayStr}?adjusted=true&sort=asc&limit=50000`;
        const histResult = await massiveFetch(histPath, apiKey, ticker, 'chart_bars');
        if (histResult.ok) {
          const freshBars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
            date: new Date(b.t).toISOString().slice(0, 10),
            open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
          })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0 && b.date < chartTodayStr && !isWeekendDate(b.date));
          if (freshBars.length > 0) {
            const barMap = new Map<string, HistoryBar>();
            for (const b of daily) barMap.set(b.date, b);
            for (const b of freshBars) barMap.set(b.date, b);
            daily = Array.from(barMap.values()).sort((a, b) => a.date.localeCompare(b.date));
            await saveCachedHistory(ticker, freshBars);
          }
        }
      }

      const bars: HistoryBar[] =
        resolution === '1W' ? aggregateWeeks(daily)
        : resolution === '1M' ? aggregateMonths(daily)
        : daily;

      const tvBars = bars
        .filter((b) => Number.isFinite(b.close) && b.close > 0)
        .map((b) => ({
          time: Math.floor(new Date(b.date + 'T00:00:00Z').getTime() / 1000),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        }))
        .sort((a, b) => a.time - b.time);

      const filtered = tvBars.filter((b) => {
        if (from && b.time < from) return false;
        if (to && b.time > to) return false;
        return true;
      });

      console.log(`[ChartBars] ${ticker} | resolution=${resolution} | bars=${filtered.length}`);

      return json({ success: true, ticker, resolution, bars: filtered });
    }

    if (!profile) return json({ success: false, error: 'Missing strategy profile' });

    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const ctx = newScanContext(lastCompletedBusinessDay(today, fmt));

    const noFilterMode =
      isSectionOff(profile, 'order_strike_enabled') &&
      isSectionOff(profile, 'expiration_enabled') &&
      isSectionOff(profile, 'croi_pc_enabled') &&
      isSectionOff(profile, 'cycle_liquidity_enabled') &&
      isSectionOff(profile, 'spread_enabled') &&
      isSectionOff(profile, 'short_interest_enabled') &&
      isSectionOff(profile, 'technical_rules_enabled') &&
      isSectionOff(profile, 'support_distance_enabled') &&
      profile.exclude_existing_positions === false;

    console.log(`mode=${mode}, scanMode=${scanMode}, noFilterMode=${noFilterMode}`);
    console.log(`[PROFILE] min_stock_price=${profile.minimum_stock_price}, max_stock_price=${profile.maximum_stock_price}, max_strike=${profile.max_strike}, min_dte=${profile.min_dte}, max_strikes_per_ticker=${profile.max_strikes_per_ticker}, order_strike_enabled=${profile.order_strike_enabled}, expiration_enabled=${profile.expiration_enabled}`);
    console.log(`[PROFILE TECH] technical_rules_enabled=${profile.technical_rules_enabled}, rsi_min=${profile.rsi_min}, rsi_max=${profile.rsi_max}, require_ma20_above_ma50=${profile.require_ma20_above_ma50}, require_ma50_above_ma200=${profile.require_ma50_above_ma200}, require_price_above_ma200=${profile.require_price_above_ma200}, exclude_downtrend_no_support=${profile.exclude_downtrend_no_support}`);

    // ── ANALYZE MODE: deep-analyze a single ticker ──
    if (mode === 'analyze') {
      const ticker = String(body.ticker || '').toUpperCase().trim();
      if (!ticker) return json({ success: false, error: 'Missing ticker for analyze mode' });

      console.log(`[Analyze] Analyzing ${ticker}`);

      // Reuse a price the client already knows from Today's Candidates whenever possible.
      // This avoids burning another Stocks Basic API request immediately after a scan.
      const bodyKnownPrice = Number(body.knownStockPrice);
      const clientKnownPrice =
        Number.isFinite(bodyKnownPrice) && bodyKnownPrice > 0 ? bodyKnownPrice : null;

      // Also reuse the latest persisted candidate price if the browser cache is empty.
      const persistedCandidatePrice =
        clientKnownPrice === null ? await fetchLatestCandidateStockPrice(ticker) : null;

      let analyzeBulkPrice = clientKnownPrice ?? persistedCandidatePrice;
      let analyzePriceSource =
        clientKnownPrice !== null ? 'client_scan_cache'
        : persistedCandidatePrice !== null ? 'candidate_scans'
        : 'none';

      // Only spend a grouped-market API call when we still have no usable price.
      if (analyzeBulkPrice === null) {
        const { priceMap: analyzePriceMap } = await fetchGroupedDailyPrices(apiKey, today, fmt);
        analyzeBulkPrice = analyzePriceMap.get(ticker) ?? null;
        if (analyzeBulkPrice !== null) analyzePriceSource = 'grouped_daily';
      }

      console.log(`[Analyze] ${ticker} | seed_price=${analyzeBulkPrice} | seed_source=${analyzePriceSource}`);

      const result = await scanSymbol(ticker, ticker, profile, apiKey, openTickers, noFilterMode, today, fmt, true, true, analyzeBulkPrice, true, ctx);

      if (result.chainStatus === 'api_error' || result.chainStatus === 'unauthorized' || result.chainStatus === 'rate_limited' || result.chainStatus === 'network_error') {
        return json({
          success: false, stage: 'options_snapshot', provider: 'Massive', symbol: ticker,
          massiveStatus: result.chainStatus === 'api_error' ? 500 : result.chainStatus === 'unauthorized' ? 401 : result.chainStatus === 'rate_limited' ? 429 : 0,
          massiveBody: `Chain status: ${result.chainStatus}`,
        });
      }

      if (DEBUG_TICKERS.has(ticker)) {
        const histClose = result.historyStatus === 'success' || result.historyStatus === 'fallback' ? 'available' : 'n/a';
        console.log(`[Analyze PRICE] ${ticker} | grouped=${analyzeBulkPrice} | historyClose=${histClose} | optionUnderlying=${result.stockSource === 'underlying_asset' ? result.stockPrice : 'n/a'} | final=${result.stockPrice} | source=${result.stockSource}`);
      }

      if (result.stockPrice === null && result.putsReturned === 0) {
        return json({
          success: false,
          error: `No usable stock price or put contracts returned for ${ticker}`,
          stage: 'stock_history_and_contract_discovery',
          history_status: result.historyStatus || 'empty',
          history_error: result.historyError || null,
        });
      }

      const analyses = result.analyses || [];
      const qualifying = analyses.filter((a) => a.qualified);
      const bestContract = qualifying[0] || null;

      console.log(`[Analyze] ${ticker} complete — ${analyses.length} analyzed, ${qualifying.length} qualified, puts=${result.putsReturned}, validQuotes=${result.validQuotes}`);

      return json({
        success: true,
        ticker,
        stock_price: result.stockPrice != null && result.stockPrice > 0 ? Number(result.stockPrice.toFixed(2)) : null,
        stock_source: result.stockSource || 'none',
        trend: result.trendClass || 'Unknown',
        primary_support: result.primarySupport != null ? Number(result.primarySupport.toFixed(2)) : null,
        secondary_support: result.secondarySupport != null ? Number(result.secondarySupport.toFixed(2)) : null,
        resistance: result.resistance != null ? Number(result.resistance.toFixed(2)) : null,
        technical_data_available: Boolean(result.technicalDataAvailable),
        history_bars: result.historyBarCount ?? 0,
        technical_warning: result.technicalDataAvailable ? null : 'Not enough price history for the active technical/support rules — affected contracts are Pending (not Rejected).',
        technical: result.technical || null,
        qualifies: qualifying.length > 0,
        best_contract: bestContract,
        other_qualifying_contracts: qualifying.slice(1),
        all_qualifying_contracts: qualifying,
        all_analyzed_contracts: analyses,
        all_contracts_count: analyses.length,
        qualifying_count: qualifying.length,
        // Diagnostic counts
        scan_counts: {
          puts_returned: result.putsReturned,
          filtered_by_expiration: result.filteredByExpiration,
          filtered_by_strike: result.filteredByStrike,
          valid_quotes: result.validQuotes,
          contracts_awaiting_quotes: result.contractsAwaitingQuotes,
          contracts_evaluated: result.evaluated,
          qualified: result.qualified,
          rejected: result.rejected,
        },
      });
    }

    // ── DISCOVERY / UNIVERSE MODE ──
    let symbolList: { ticker: string; company_name: string | null }[];
    if (scanMode === 'universe') {
      // Use client-supplied symbols if provided; otherwise load from database.
      const clientSymbols: string[] = Array.isArray(body.symbols)
        ? body.symbols.map((s: string) => String(s).toUpperCase().trim()).filter(Boolean)
        : [];
      if (clientSymbols.length > 0) {
        symbolList = clientSymbols.map((t) => ({ ticker: t, company_name: null }));
        console.log(`[UNIVERSE SCAN REQUEST] mode=universe, symbols=${JSON.stringify(clientSymbols)}`);
      } else {
        symbolList = await fetchScanUniverse();
        console.log(`[ScanMode=universe] Loaded ${symbolList.length} enabled symbols from database`);
      }
    } else {
      symbolList = await fetchMarketUniverse(MAX_DISCOVERY_SYMBOLS);
      console.log(`[ScanMode=discovery] Loaded ${symbolList.length} optionable symbols (cap ${MAX_DISCOVERY_SYMBOLS})`);
    }

    const emptyCounts = {
      symbols_in_universe: symbolList.length, symbols_requested: symbolList.length,
      symbols_returned: 0, symbols_failed: 0, symbols_with_chains: 0,
      puts_returned: 0, filtered_by_expiration: 0, filtered_by_strike: 0,
      valid_quotes: 0, contracts_awaiting_quotes: 0,
      contracts_evaluated: 0, qualified: 0, rejected: 0, pages_fetched: 0,
      contracts_found: 0,
    };

    if (symbolList.length === 0) {
      return json({ success: true, candidates: [], source: 'massive', scanned_at: new Date().toISOString(), scan_mode: scanMode, no_filter_mode: noFilterMode, scan_counts: emptyCounts });
    }

    // ── Bulk stock prices: one grouped daily request for all symbols ──
    // The same call also returns each ticker's OHLCV for the latest completed
    // session; we append that bar to the history cache so technicals stay
    // current every day without per-ticker (rate-limited) history requests.
    const allTickers = symbolList.map((s) => s.ticker.toUpperCase());
    const { priceMap: bulkPriceMap, barMap: groupedBarMap, tradingDate, httpStatus: bulkHttpStatus } = await fetchGroupedDailyPrices(apiKey, today, fmt);
    console.log(`[BulkPrices] ${bulkPriceMap.size} stock prices loaded from grouped daily (HTTP ${bulkHttpStatus}, date ${tradingDate})`);
    if (tradingDate) ctx.expectedLatestDate = tradingDate;
    let groupedBarsSaved = 0;
    if (groupedBarMap.size > 0) {
      groupedBarsSaved = await saveGroupedBarsToCache(groupedBarMap, allTickers);
      console.log(`[GroupedBars] appended ${groupedBarsSaved} daily bars (${tradingDate}) to stock_history_cache`);
    }

    let bulkCachedPrices = new Map<string, { price: number; source: string; tradeDate: string | null }>();
    if (bulkPriceMap.size === 0) {
      bulkCachedPrices = await bulkLoadCachedStockPrices(allTickers);
      console.log(`[BulkPrices] Grouped daily empty — persistent cache returned ${bulkCachedPrices.size} prices`);
    }
    const priceFor = (t: string) => bulkPriceMap.get(t) ?? bulkCachedPrices.get(t)?.price ?? null;

    // ── STAGE 1: evaluate every symbol from cache (no per-ticker history calls) ──
    // Every symbol is scanned — there is no early stop, so the scanned set is
    // the same on every Rescan.
    const resultsByTicker = new Map<string, ScanSymbolResult>();
    const companyByTicker = new Map<string, string>();
    let symbolsFailed = 0;
    let rawSample: any = null;
    let verboseCount = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((sym) => {
          const isVerbose = verboseCount < 3;
          if (isVerbose) verboseCount++;
          const upper = sym.ticker.toUpperCase();
          companyByTicker.set(upper, sym.company_name || '');
          return scanSymbol(upper, sym.company_name || '', profile, apiKey, openTickers, noFilterMode, today, fmt, isVerbose, false, priceFor(upper), false, ctx)
            .then((res) => ({ upper, res }))
            .catch((err) => {
              console.error(`[scanSymbol] ${upper} failed: ${err instanceof Error ? err.message : String(err)}`);
              return { upper, res: null as ScanSymbolResult | null };
            });
        }),
      );
      for (const { upper, res } of batchResults) {
        if (!res) { symbolsFailed++; continue; }
        resultsByTicker.set(upper, res);
        if (!rawSample && res.rawSample) rawSample = res.rawSample;
      }
    }

    // ── STAGE 2: fill missing history for tickers that are Pending because of it ──
    // One Rescan now does: find tickers whose contracts are Pending only for
    // lack of history → fetch history (sequentially, within Massive limits and
    // a time budget) → re-evaluate using the SAME option chain → final status.
    const WARM_DEADLINE_MS = 110_000; // keep well under the Edge Function wall-clock limit
    let historyFetchedThisScan = 0;
    let historyFetch403 = 0;
    let historyFetch429 = 0;
    let stillPendingHistory = 0;
    let warmingDeadlineHit = false;
    const warmDiagnostics: { ticker: string; cachedBars: number; requiredBars: number; fetchAttempted: boolean; fetchStatus: string; finalBars: number }[] = [];

    const warmQueue: { ticker: string; res: ScanSymbolResult; score: number }[] = [];
    for (const [ticker, res] of resultsByTicker) {
      const need = res.needsHistoryBars ?? 0;
      if (need <= 0 || (res.historyBarCount ?? 0) >= need) continue;
      // Only tickers with at least one contract that nothing else rejected.
      const pendingContracts = res.candidates.filter((c) => c.technical_pending);
      if (pendingContracts.length === 0) continue;
      const score = Math.max(...pendingContracts.map((c) => Number(c.net_croi || 0) * 1000 + Number(c.open_interest || 0) / 1000));
      warmQueue.push({ ticker, res, score });
    }
    warmQueue.sort((a, b) => b.score - a.score);
    console.log(`[CacheWarm] ${warmQueue.length} tickers need history for the active rules`);

    for (const item of warmQueue) {
      const need = item.res.needsHistoryBars ?? 0;
      const before = item.res.historyBarCount ?? 0;
      if (ctx.historyRateLimited) {
        stillPendingHistory++;
        warmDiagnostics.push({ ticker: item.ticker, cachedBars: before, requiredBars: need, fetchAttempted: false, fetchStatus: 'skipped_rate_limited', finalBars: before });
        continue;
      }
      if (Date.now() - requestStart > WARM_DEADLINE_MS) {
        warmingDeadlineHit = true;
        stillPendingHistory++;
        warmDiagnostics.push({ ticker: item.ticker, cachedBars: before, requiredBars: need, fetchAttempted: false, fetchStatus: 'skipped_time_budget', finalBars: before });
        continue;
      }
      ctx.stockCache.delete(item.ticker);
      const snap = await getStockSnapshot(item.ticker, apiKey, today, fmt, priceFor(item.ticker), true, need, ctx);
      const finalBars = snap.historicalBars.length;
      const fetchStatus = snap.historyHttpStatus === 200 ? 'ok' : `HTTP_${snap.historyHttpStatus ?? 'none'}`;
      if (snap.historyHttpStatus === 403) historyFetch403++;
      if (snap.historyHttpStatus === 429) historyFetch429++;
      warmDiagnostics.push({ ticker: item.ticker, cachedBars: before, requiredBars: need, fetchAttempted: true, fetchStatus, finalBars });

      if (finalBars > before) {
        historyFetchedThisScan++;
        // Re-evaluate with the new history. The chain comes from ctx.chainCache,
        // so quotes are identical to the first pass.
        try {
          const rerun = await scanSymbol(item.ticker, companyByTicker.get(item.ticker) || '', profile, apiKey, openTickers, noFilterMode, today, fmt, false, false, priceFor(item.ticker), false, ctx);
          resultsByTicker.set(item.ticker, rerun);
        } catch (err) {
          console.error(`[CacheWarm] re-evaluate ${item.ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (finalBars < need) stillPendingHistory++;
    }

    // ── Assemble results & counts from the FINAL evaluation only ──
    const candidates: any[] = [];
    let symbolsWithChains = 0, totalPutsReturned = 0, totalFilteredByExp = 0, totalFilteredByStrike = 0;
    let totalValidQuotes = 0, totalAwaitingQuotes = 0, totalPagesFetched = 0;
    let tickersWith60PlusBars = 0, tickersWith200PlusBars = 0, tickersMissingHistory = 0;
    const techRejTotals = { rsi_below_min: 0, rsi_above_max: 0, ma20_not_above_ma50: 0, ma50_not_above_ma200: 0, price_not_above_ma200: 0, downtrend_no_support: 0, support_dist_below_min: 0, support_dist_above_max: 0, technical_data_missing: 0 };
    const orderStrikeRejTotals = { stock_below_min: 0, stock_above_max: 0, strike_above_max: 0 };
    const supportDistanceDebugTotals = { before: 0, passed: 0, below_min: 0, above_max: 0, missing_support: 0, details: [] as any[] };

    for (const res of resultsByTicker.values()) {
      candidates.push(...res.candidates);
      totalPutsReturned += res.putsReturned;
      totalFilteredByExp += res.filteredByExpiration;
      totalFilteredByStrike += res.filteredByStrike;
      totalValidQuotes += res.validQuotes;
      totalAwaitingQuotes += res.contractsAwaitingQuotes;
      totalPagesFetched += res.pagesFetched;
      if (res.chainStatus === 'success') symbolsWithChains++;
      if (res.chainStatus === 'api_error' || res.chainStatus === 'unauthorized' || res.chainStatus === 'rate_limited' || res.chainStatus === 'network_error') symbolsFailed++;
      const barCount = res.historyBarCount ?? 0;
      if (barCount >= 200) tickersWith200PlusBars++;
      else if (barCount >= 60) tickersWith60PlusBars++;
      else tickersMissingHistory++;
      if (res.techRejections) for (const k of Object.keys(techRejTotals) as (keyof typeof techRejTotals)[]) techRejTotals[k] += res.techRejections[k];
      if (res.orderStrikeRejections) for (const k of Object.keys(orderStrikeRejTotals) as (keyof typeof orderStrikeRejTotals)[]) orderStrikeRejTotals[k] += res.orderStrikeRejections[k];
      if (res.supportDistanceDebug) {
        supportDistanceDebugTotals.before += res.supportDistanceDebug.before;
        supportDistanceDebugTotals.passed += res.supportDistanceDebug.passed;
        supportDistanceDebugTotals.below_min += res.supportDistanceDebug.below_min;
        supportDistanceDebugTotals.above_max += res.supportDistanceDebug.above_max;
        supportDistanceDebugTotals.missing_support += res.supportDistanceDebug.missing_support;
        if (supportDistanceDebugTotals.details.length < 200) supportDistanceDebugTotals.details.push(...res.supportDistanceDebug.details.slice(0, 200 - supportDistanceDebugTotals.details.length));
      }
    }

    const statusOf = (c: any) => (c.qualified && !c.technical_pending) ? 'qualified' : c.technical_pending ? 'pending' : 'rejected';
    let totalQualified = 0, totalPending = 0, totalRejected = 0;
    const rejectionBreakdown: Record<string, number> = {};
    const pendingBreakdown: Record<string, number> = {};
    const tickerStatus = new Map<string, number>(); // best status per ticker: 0 qualified, 1 pending, 2 rejected
    for (const c of candidates) {
      const st = statusOf(c);
      if (st === 'qualified') totalQualified++;
      else if (st === 'pending') totalPending++;
      else totalRejected++;
      for (const reason of (c.rejection_reasons || [])) rejectionBreakdown[reason] = (rejectionBreakdown[reason] || 0) + 1;
      for (const reason of (c.pending_reasons || [])) pendingBreakdown[reason] = (pendingBreakdown[reason] || 0) + 1;
      const rank = st === 'qualified' ? 0 : st === 'pending' ? 1 : 2;
      const prev = tickerStatus.get(c.ticker);
      if (prev === undefined || rank < prev) tickerStatus.set(c.ticker, rank);
    }
    let qualifiedTickerCount = 0, pendingTickerCount = 0, rejectedTickerCount = 0;
    for (const rank of tickerStatus.values()) {
      if (rank === 0) qualifiedTickerCount++;
      else if (rank === 1) pendingTickerCount++;
      else rejectedTickerCount++;
    }

    // Response cap PER TICKER (not a global slice), so every scanned ticker
    // keeps its best contracts in the response. The old global 500-contract
    // cap could silently drop a ticker's pending/rejected rows.
    const perTickerCap = Math.max(5, Number(profile.max_strikes_per_ticker || 1));
    const byTicker = new Map<string, any[]>();
    for (const c of candidates) {
      const arr = byTicker.get(c.ticker);
      if (arr) arr.push(c); else byTicker.set(c.ticker, [c]);
    }
    const capped: any[] = [];
    for (const [, arr] of [...byTicker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      arr.sort(compareContracts);
      capped.push(...arr.slice(0, perTickerCap));
    }
    capped.sort(compareContracts);

    let closestMatches: any[] = [];
    if (totalQualified === 0 && candidates.length > 0) {
      closestMatches = candidates
        .filter((c) => !c.qualified)
        .sort((a, b) => {
          const ar = (a.rejection_reasons || []).length, br = (b.rejection_reasons || []).length;
          if (ar !== br) return ar - br;
          return (b.net_croi || 0) - (a.net_croi || 0);
        })
        .slice(0, 20)
        .map((c) => ({
          ticker: c.ticker, price: c.stock_price, strike: c.strike,
          rsi: c.technical_snapshot?.rsi ?? null, ma20: c.technical_snapshot?.ma20 ?? null,
          ma50: c.technical_snapshot?.ma50 ?? null, ma200: c.technical_snapshot?.ma200 ?? null,
          primary_support: c.primary_support, support_distance: c.strike_distance_from_support,
          net_croi: c.net_croi, premium_capture: c.premium_capture,
          open_interest: c.open_interest, volume: c.volume,
          failed_rules: [...(c.rejection_reasons || []), ...(c.pending_reasons || [])],
        }));
    }

    const scan_counts = {
      symbols_in_universe: symbolList.length,
      symbols_returned: resultsByTicker.size,
      symbols_failed: symbolsFailed,
      symbols_with_chains: symbolsWithChains,
      puts_returned: totalPutsReturned,
      filtered_by_expiration: totalFilteredByExp,
      filtered_by_strike: totalFilteredByStrike,
      valid_quotes: totalValidQuotes,
      contracts_awaiting_quotes: totalAwaitingQuotes,
      contracts_evaluated: candidates.length,
      qualified: totalQualified,
      rejected: totalRejected,
      pending: totalPending,
      pages_fetched: totalPagesFetched,
      contracts_found: totalPutsReturned,
      rejection_breakdown: rejectionBreakdown,
      pending_breakdown: pendingBreakdown,
      unique_qualified_tickers: qualifiedTickerCount,
      unique_pending_tickers: pendingTickerCount,
      unique_rejected_tickers: rejectedTickerCount,
      technical_rejections: techRejTotals,
      order_strike_rejections: orderStrikeRejTotals,
      technical_cache: {
        tickers_with_60_plus_bars: tickersWith60PlusBars,
        tickers_with_200_plus_bars: tickersWith200PlusBars,
        tickers_missing_history: tickersMissingHistory,
        history_fetched_this_scan: historyFetchedThisScan,
        still_pending_history: stillPendingHistory,
        massive_history_403: historyFetch403,
        massive_history_429: historyFetch429,
        history_rate_limited: ctx.historyRateLimited,
        warming_time_budget_hit: warmingDeadlineHit,
        grouped_bars_saved: groupedBarsSaved,
        latest_trading_date: ctx.expectedLatestDate,
        cache_save_failures: 0,
        warm_diagnostics: warmDiagnostics,
      },
      closest_matches: closestMatches,
      support_distance_debug: supportDistanceDebugTotals,
    };

    console.log(`[SCAN SUMMARY] mode=${scanMode} symbols=${resultsByTicker.size} contracts=${candidates.length} Q=${totalQualified} P=${totalPending} R=${totalRejected} | tickers Q=${qualifiedTickerCount} P=${pendingTickerCount} R=${rejectedTickerCount} | historyFetched=${historyFetchedThisScan} stillPendingHistory=${stillPendingHistory} rateLimited=${ctx.historyRateLimited} | ${Date.now() - requestStart}ms`);
    console.log(`[SCAN SUMMARY] rejection reasons: ${JSON.stringify(rejectionBreakdown)} | pending reasons: ${JSON.stringify(pendingBreakdown)}`);

    return json({
      success: true, candidates: capped, source: 'massive',
      scanned_at: new Date().toISOString(),
      scan_mode: scanMode, no_filter_mode: noFilterMode,
      scan_counts, raw_sample: rawSample,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Market scan failed';
    console.error(`market-scan fatal error: ${msg}`);
    return json({ success: false, provider: 'Massive', error: msg });
  }
});
// redeploy trigger Sat Sep 26 14:47:12 UTC 2026
// redeploy 1790434327
