// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY
// Modes:
//   "discovery" — scan broad universe from market_universe table
//   "universe"  — scan user's enabled scan_universe tickers
//   "analyze"   — deep-analyze a single ticker (replaces analyze-ticker)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';
const MAX_CHAIN_PAGES = 10;
const MAX_DISCOVERY_SYMBOLS = 250;
const MAX_CANDIDATES = 50;

type Profile = {
  id: string;
  max_strike: number;
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
  minimum_support_distance_pct: number;
  maximum_support_distance_pct: number;
  order_strike_enabled: boolean;
  expiration_enabled: boolean;
  croi_pc_enabled: boolean;
  filter_strikes_croi: boolean;
  cycle_liquidity_enabled: boolean;
  spread_enabled: boolean;
  short_interest_enabled: boolean;
  technical_rules_enabled: boolean;
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
): Promise<{ priceMap: Map<string, number>; tradingDate: string | null; httpStatus: number | null }> {
  const priceMap = new Map<string, number>();
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
      }
    }

    if (priceMap.size > 0) {
      console.log(`[GroupedDaily] Found ${priceMap.size} stock prices for completed trading date ${dateStr}`);
      console.log(`[PRICE BULK] HTTP ${lastHttpStatus} | trading_date=${dateStr} | prices_returned=${priceMap.size}`);
      return { priceMap, tradingDate: dateStr, httpStatus: lastHttpStatus };
    }
  }

  console.log(`[PRICE BULK] HTTP ${lastHttpStatus} | trading_date=null | prices_returned=0 — GROUPED FAILED, using fallbacks`);
  console.log('[GroupedDaily] No completed grouped daily response available');
  return { priceMap, tradingDate: null, httpStatus: lastHttpStatus };
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
  const shuffled = mapped.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
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
    })).filter((b) => Number.isFinite(b.close) && b.close > 0).reverse();
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
      console.log(`[Cache] ${ticker} | save failed: HTTP ${resp.status}`);
    }
  } catch (e) {
    console.log(`[Cache] ${ticker} | save error: ${e instanceof Error ? e.message : String(e)}`);
  }
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

function rsi(values: number[], period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 70;
  const rs = (gains / period) / (losses / period);
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
  const rr = rsi(closes);
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

// Per-request cache: ticker -> StockSnapshot. Avoids re-fetching history
// for symbols that appear multiple times (e.g. HUT with 20 contracts).
const stockCache = new Map<string, StockSnapshot>();

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
  historyStatus?: 'success' | 'fallback' | 'empty' | 'error';
  historyError?: string;
  technical?: { rsi: number; ma20: number; ma50: number; ma200: number; macd: number; macd_signal: number; macd_histogram: number; bb_upper: number; bb_middle: number; bb_lower: number; bb_position: string; volume_trend: string };
};

// ── Cache-first stock history fetcher ──
// 1. Load cached bars from Supabase stock_history_cache
// 2. If cache has enough recent bars, use them directly
// 3. If cache is stale or incomplete, fetch from Massive daily aggregates
// 4. Save new bars back to cache
// Stock price comes from the bulk grouped daily (passed in) or from the
// latest historical close. History is only for technicals.
// No retries on 401/403/429 — only one retry on network error or 5xx.
async function getStockSnapshot(
  ticker: string,
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
  bulkStockPrice: number | null,
  allowLiveHistory = true,
): Promise<StockSnapshot> {
  const upper = ticker.toUpperCase();
  const cached = stockCache.get(upper);
  if (cached) {
    // Edge Function isolates can stay warm across multiple HTTP requests.
    // Never let an old/empty snapshot poison a later Analyze request.
    if (bulkStockPrice !== null && Number.isFinite(bulkStockPrice) && bulkStockPrice > 0) {
      const refreshed: StockSnapshot = {
        ...cached,
        currentPrice: bulkStockPrice,
        source: 'grouped_daily',
        error: null,
      };
      stockCache.set(upper, refreshed);
      return refreshed;
    }
    if (cached.currentPrice !== null || cached.historicalBars.length > 0) {
      return cached;
    }
    // Empty cached snapshot: discard it and try live/persistent fallbacks again.
    stockCache.delete(upper);
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

  // 2. Load cached bars from Supabase
  let bars = await loadCachedHistory(upper, 260);

  // Determine the latest cached date to decide if we need fresh data
  const latestCachedDate = bars.length > 0 ? bars.at(-1)!.date : null;
  const todayStr = fmt(today);
  const needsFresh = latestCachedDate === null || latestCachedDate < todayStr;

  // 3. If cache is insufficient or stale, fetch from Massive daily aggregates
  // Use ~18 calendar months of history (enough for 200 DMA with holidays)
  const start = new Date(today);
  start.setDate(start.getDate() - 548); // ~18 months

  if (allowLiveHistory && (needsFresh || bars.length < 60)) {
    const histPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/range/1/day/${fmt(start)}/${fmt(today)}?adjusted=true&sort=asc&limit=50000`;
    let histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates');

    // Only retry on network error (status 0) or 5xx — NOT on 401/403/429
    if (!histResult.ok && isRetryableStatus(histResult.status)) {
      histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates_retry');
    }
    historyHttpStatus = histResult.ok ? 200 : histResult.status;

    // Explicitly log 403/429 for debug tickers without retrying
    if (!histResult.ok && (histResult.status === 403 || histResult.status === 429)) {
      console.log(`[History] ${upper} | HTTP ${histResult.status} — NOT retrying (non-retryable)`);
    }

    if (histResult.ok) {
      const freshBars = (histResult.data?.results || []).map((b: any) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
      })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);

      if (freshBars.length > 0) {
        // Merge fresh bars with cached bars (dedup by date)
        const barMap = new Map<string, HistoryBar>();
        for (const b of bars) barMap.set(b.date, b);
        for (const b of freshBars) barMap.set(b.date, b); // fresh overrides cached
        bars = Array.from(barMap.values()).sort((a, b) => a.date.localeCompare(b.date));

        // Save fresh bars to cache (only the new ones to minimize writes)
        const cachedDates = new Set(bars.filter(b => b.date <= (latestCachedDate || '')).map(b => b.date));
        const newBars = freshBars.filter(b => !cachedDates.has(b.date));
        if (newBars.length > 0) {
          await saveCachedHistory(upper, freshBars); // upsert all fresh bars
          if (DEBUG_TICKERS.has(upper)) {
            console.log(`[Cache] ${upper} | saved ${freshBars.length} bars to cache`);
          }
        }

        // Use latest close as price fallback if no bulk price
        if (currentPrice === null) {
          currentPrice = Number(bars.at(-1)!.close);
          source = 'daily_aggregates';
        }
      }
    } else {
      if (!error) {
        error = `Aggregates HTTP ${histResult.status}: ${histResult.body.slice(0, 200)}`;
      }
      // If we have cached bars but fresh fetch failed, still use cached bars
      if (bars.length > 0 && currentPrice === null) {
        currentPrice = Number(bars.at(-1)!.close);
        source = 'daily_aggregates';
      }
    }
  } else if (!allowLiveHistory && (needsFresh || bars.length < 60)) {
    // Broad Market Discovery / Scan Universe runs on Stocks Basic.
    // Never make one stock-history request per symbol; use the grouped close for
    // Price and any already-cached bars for technicals. Analyze Ticker can fetch
    // fresh history for a single symbol.
    historyHttpStatus = bars.length > 0 ? 200 : undefined;
    if (currentPrice === null && bars.length > 0) {
      currentPrice = Number(bars.at(-1)!.close);
      source = 'daily_aggregates';
    }
  } else {
    // Cache is sufficient — use cached bars, no Massive call needed
    historyHttpStatus = 200;
    if (currentPrice === null && bars.length > 0) {
      currentPrice = Number(bars.at(-1)!.close);
      source = 'daily_aggregates';
    }
    if (DEBUG_TICKERS.has(upper)) {
      console.log(`[Cache] ${upper} | using ${bars.length} cached bars (no Massive call needed)`);
    }
  }

  // 4. Fallback: previous close — only if we still have NO price at all
  if (currentPrice === null) {
    const prevPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/prev?adjusted=true`;
    const prevResult = await massiveFetch(prevPath, apiKey, upper, 'stock_previous_close');
    // No retry on 401/403/429
    if (prevResult.ok) {
      const prevBars = (prevResult.data?.results || []).map((b: any) => ({
        date: b.t ? new Date(b.t).toISOString().slice(0, 10) : fmt(today),
        open: Number(b.o || b.c || 0), high: Number(b.h || b.c || 0), low: Number(b.l || b.c || 0), close: Number(b.c || 0), volume: Number(b.v || 0),
      })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);
      if (prevBars.length) {
        currentPrice = Number(prevBars.at(-1)!.close);
        source = 'previous_close';
      }
    } else if (!error) {
      error = `Previous-close HTTP ${prevResult.status}: ${prevResult.body.slice(0, 200)}`;
    }
  }

  const snapshot: StockSnapshot = { ticker: upper, currentPrice, historicalBars: bars, source, error, historyHttpStatus };
  stockCache.set(upper, snapshot);
  return snapshot;
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
  bulkStockPrice: number | null = null,
  allowLiveHistory: boolean = false,
): Promise<ScanSymbolResult> {
  const r: ScanSymbolResult = {
    candidates: [],
    chainStatus: 'no_options',
    putsReturned: 0, filteredByExpiration: 0, filteredByStrike: 0,
    missingStrike: 0, missingExpiration: 0, missingLastQuote: 0,
    missingBid: 0, zeroBid: 0, missingAsk: 0, zeroAsk: 0, askLtBid: 0, otherInvalid: 0,
    validQuotes: 0, contractsAwaitingQuotes: 0, evaluated: 0, qualified: 0, rejected: 0, pagesFetched: 0,
  };

  // Step 1: Stock snapshot via shared function (cached per ticker)
  // For discovery/universe mode, bulkStockPrice from grouped daily is passed in.
  // For analyze mode, bulkStockPrice is null so getStockSnapshot falls back to history.
  const snapshot = await getStockSnapshot(symbol, apiKey, today, fmt, bulkStockPrice, analyzeMode || allowLiveHistory);
  let bars = snapshot.historicalBars;
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
  } else if (bars.length >= 60) {
    r.historyStatus = 'success';
  } else if (bars.length > 0) {
    r.historyStatus = 'fallback';
  } else {
    r.historyStatus = 'empty';
  }

  const technicalDataAvailable = bars.length >= 60;
  r.technicalDataAvailable = technicalDataAvailable;

  // Stock price filter is NOT applied here as a symbol-level early return.
  // It is applied as a contract-level rejection reason after option chains are
  // retrieved, so that "With Option Chains" reflects actual chain availability.

  let primarySupport: number | null = technicalDataAvailable && stockPrice !== null && stockPrice > 0 ? calcPrimarySupport(bars, stockPrice) : null;
  let secondarySupport: number | null = technicalDataAvailable && primarySupport !== null ? calcSecondarySupport(bars, primarySupport) : null;
  let resistance: number | null = technicalDataAvailable && stockPrice !== null && stockPrice > 0 ? findResistance(bars, stockPrice) : null;
  let trendClass = technicalDataAvailable ? trend(bars) : 'Pending';

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


  if (technicalDataAvailable) {
    const closes = bars.map((b) => b.close);
    const m = macd(closes);
    const bb = bollingerBands(closes);
    const has200 = closes.length >= 200;
    r.technical = {
      rsi: Number(rsi(closes).toFixed(1)),
      ma20: Number(sma(closes, 20).toFixed(2)),
      ma50: Number(sma(closes, 50).toFixed(2)),
      ma200: has200 ? Number(sma(closes, 200).toFixed(2)) : 0,
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
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
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

  // Determine chain status
  const contracts = allRawContracts.filter((c: any) => c?.details?.contract_type === 'put');
  r.putsReturned = contracts.length;

  // ── Tier 2: Option snapshot underlying_asset price ──
  // Always extract it (even if we already have a price) so we can save it to cache.
  let optionUnderlyingPrice: number | null = null;
  if (allRawContracts.length) {
    const underlyingPrice = allRawContracts
      .map((c: any) => Number(c?.underlying_asset?.price || c?.underlying_asset?.value || 0))
      .find((v: number) => Number.isFinite(v) && v > 0) || 0;
    if (underlyingPrice > 0) {
      optionUnderlyingPrice = underlyingPrice;
      // Save to persistent price cache
      void saveCachedStockPrice(symbol, underlyingPrice, 'option_snapshot', fmt(today));
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
  if (stockPrice !== null && stockPrice > 0 && technicalDataAvailable) {
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

  // Per-ticker price resolution logging for debug tickers
  const PRICE_LOG_TICKERS = new Set(['PLUG', 'LCID', 'NIO', 'MARA', 'NVAX', 'SOFI', 'RIOT', 'RGTI', 'CIFR']);
  if (DEBUG_TICKERS.has(symbol.toUpperCase()) || PRICE_LOG_TICKERS.has(symbol.toUpperCase())) {
    const cachedPrice = await loadCachedStockPrice(symbol);
    const candidateScanPrice = await fetchLatestCandidateStockPrice(symbol);
    console.log(`[PRICE RESOLUTION] ${symbol} | grouped=${bulkStockPrice} | optionUnderlying=${optionUnderlyingPrice} | cached=${cachedPrice?.price ?? null} | previousScan=${candidateScanPrice} | final=${stockPrice} | source=${r.stockSource}`);
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
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
    const before = filteredContracts.length;
    filteredContracts = filteredContracts.filter((c: any) => {
      const s = Number(c.details.strike_price);
      if (s > profile.max_strike) return false;
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
    const reasons: string[] = [];
    if (!noFilterMode) {
      if (profile.exclude_existing_positions && openTickers.includes(symbol)) reasons.push('Existing position');
      if (!isSectionOff(profile, 'order_strike_enabled') && strike > profile.max_strike) reasons.push('Strike too high');
      if (!isSectionOff(profile, 'technical_rules_enabled') && technicalDataAvailable) {
        if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && primarySupport !== null && strike >= primarySupport) reasons.push('Downtrend without support');
        if (primarySupport !== null && primarySupport > 0) {
          const supportDistPct = ((primarySupport - strike) / primarySupport) * 100;
          if (supportDistPct < profile.minimum_support_distance_pct) reasons.push('Support distance too low');
          if (supportDistPct > profile.maximum_support_distance_pct) reasons.push('Support distance too high');
        }
      }
      // OI and volume rules are non-premium — they come from the contract itself
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        if (oi < profile.min_target_oi) reasons.push('OI too low');
        if (volume < 10) reasons.push('Insufficient liquidity');
      }
      // Stock-price filter applied at contract level (not as a symbol-level abort)
      // so that option chain availability is accurately reflected in scan counts.
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        if (stockPrice !== null && stockPrice > 0) {
          if (profile.minimum_stock_price !== null && profile.minimum_stock_price !== undefined && stockPrice < profile.minimum_stock_price) {
            if (!reasons.includes('Stock price below minimum')) reasons.push('Stock price below minimum');
          }
          if (profile.maximum_stock_price !== null && profile.maximum_stock_price !== undefined && stockPrice > profile.maximum_stock_price) {
            if (!reasons.includes('Stock price above maximum')) reasons.push('Stock price above maximum');
          }
        } else {
          // Stock price unavailable and a stock-price rule is active — cannot evaluate.
          // Mark as pending so it does NOT appear as qualified in Today's Candidates.
          if (profile.minimum_stock_price !== null && profile.minimum_stock_price !== undefined) {
            if (!reasons.includes('Stock price unavailable — minimum stock price rule not evaluated')) {
              reasons.push('Stock price unavailable — minimum stock price rule not evaluated');
            }
          }
          if (profile.maximum_stock_price !== null && profile.maximum_stock_price !== undefined) {
            if (!reasons.includes('Stock price unavailable — maximum stock price rule not evaluated')) {
              reasons.push('Stock price unavailable — maximum stock price rule not evaluated');
            }
          }
        }
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
      // No premium available and CROI filter is ON — cannot qualify
      reasons.push('CROI too low');
    }

    const qualified = reasons.length === 0;
    const technicalPending = !noFilterMode && !isSectionOff(profile, 'technical_rules_enabled') && !technicalDataAvailable;
    r.evaluated++;
    if (qualified && !technicalPending) r.qualified++; else r.rejected++;

    // Debug logging for specific tickers in scan mode (universe/discovery)
    if (['CIFR', 'WULF'].includes(symbol.toUpperCase()) && !analyzeMode) {
      const supportDistPct = primarySupport !== null && primarySupport > 0
        ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1))
        : null;
      console.log(`[UNIVERSE DEBUG] ${symbol} | strike=${strike} | exp=${expiration} | stockPrice=${stockPrice} | trend=${trendClass} | primarySupport=${primarySupport} | supportDist=${supportDistPct}% | netCROI=${netCroi} | PC=${pc} | qualified=${qualified} | technicalPending=${technicalPending} | reasons=${JSON.stringify(reasons)}`);
    }

    const premiumSourceOut = premiumSource as string;

    // ── Build pass/fail rule checks for both scan and analyze modes ──
    const passFail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[] = [];
    if (!noFilterMode) {
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        passFail.push({ rule: `Strike <= ${profile.max_strike}`, pass: strike <= profile.max_strike, status: strike <= profile.max_strike ? 'pass' : 'fail' });
        if (primarySupport !== null && primarySupport > 0) {
          const belowSupport = strike < primarySupport;
          passFail.push({ rule: `Strike below support (${primarySupport.toFixed(2)})`, pass: belowSupport, status: belowSupport ? 'pass' : 'fail' });
        } else {
          passFail.push({ rule: 'Support rule not evaluated — historical data unavailable', pass: true, status: 'not_evaluated' });
        }
      }
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        passFail.push({ rule: `OI >= ${profile.min_target_oi}`, pass: oi >= profile.min_target_oi, status: oi >= profile.min_target_oi ? 'pass' : 'fail' });
        passFail.push({ rule: `Sufficient liquidity (volume >= 10)`, pass: volume >= 10, status: volume >= 10 ? 'pass' : 'fail' });
      }
      if (!isSectionOff(profile, 'technical_rules_enabled')) {
        if (technicalDataAvailable) {
          const trendOk = !(profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && primarySupport !== null && strike >= primarySupport);
          passFail.push({ rule: `Trend acceptable (${trendClass})`, pass: trendOk, status: trendOk ? 'pass' : 'fail' });
          if (primarySupport !== null && primarySupport > 0) {
            const supportDistPct = ((primarySupport - strike) / primarySupport) * 100;
            const distMinOk = supportDistPct >= profile.minimum_support_distance_pct;
            const distMaxOk = supportDistPct <= profile.maximum_support_distance_pct;
            const distOk = distMinOk && distMaxOk;
            passFail.push({ rule: `Support distance ${profile.minimum_support_distance_pct}%–${profile.maximum_support_distance_pct}% (${supportDistPct.toFixed(1)}%)`, pass: distOk, status: distOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'Support distance not evaluated — support unavailable', pass: true, status: 'not_evaluated' });
          }
        } else {
          passFail.push({ rule: 'Technical history unavailable — not used to reject contract', pass: true, status: 'not_evaluated' });
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
          const croiOk = netCroi >= profile.min_net_croi;
          const pcOk = pc <= profile.max_premium_capture;
          passFail.push({ rule: `Net CROI >= ${profile.min_net_croi}%`, pass: croiOk, status: croiOk ? 'pass' : 'fail' });
          passFail.push({ rule: `Premium Capture <= ${profile.max_premium_capture}%`, pass: pcOk, status: pcOk ? 'pass' : 'fail' });
        }
      }
      if (!hasPremium && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
        passFail.push({ rule: 'Filter Strikes by CROI — Premium required', pass: true, status: 'not_evaluated' });
      }
      if (!hasPremium) {
        passFail.push({ rule: 'Premium data — enter manually for CROI / PC', pass: true, status: 'not_evaluated' });
      }
    }

    if (analyzeMode) {
      const finalQualified = reasons.length === 0 && !technicalPending;

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
        qualified: finalQualified, technical_pending: technicalPending, pass_fail: passFail,
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
        technical_pending: technicalPending,
        pass_fail: passFail,
        strategy_profile_id: profile.id,
        strike_distance_from_stock: stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null,
        strike_distance_from_support: primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null,
        has_quotes: hasPremium,
        premium_source: premiumSourceOut,
        secondary_support: secondarySupport !== null ? Number(secondarySupport.toFixed(2)) : null,
        resistance: resistance !== null ? Number(resistance.toFixed(2)) : null,
      });
    }
  }

  // In analyze mode, sort qualifying contracts and pick best
  if (analyzeMode && analyses.length > 0) {
    const qualifying = analyses.filter((a) => a.qualified);
    qualifying.sort((a, b) => {
      const aBelow = primarySupport !== null && a.strike < primarySupport ? 0 : 1;
      const bBelow = primarySupport !== null && b.strike < primarySupport ? 0 : 1;
      if (aBelow !== bBelow) return aBelow - bBelow;
      if (a.spread_pct !== b.spread_pct) return a.spread_pct - b.spread_pct;
      if (a.open_interest !== b.open_interest) return b.open_interest - a.open_interest;
      if (a.volume !== b.volume) return b.volume - a.volume;
      return Math.abs(a.delta) - Math.abs(b.delta);
    });
    r.analyses = analyses;
  }

  return r;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('market-scan started');
  console.log('MASSIVE_API_KEY exists:', Boolean(Deno.env.get('MASSIVE_API_KEY')));

  // stockCache is intentionally only an intra-request dedupe cache.
  // Supabase is the persistent cache. Warm Edge Function instances must not
  // carry null/stale stock snapshots into later Analyze requests.
  stockCache.clear();

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

      const rangeMap: Record<string, string> = {
        '1D': 'day',
        '1W': 'week',
        '1M': 'month',
      };
      const rangeUnit = rangeMap[resolution] || 'day';

      let bars: HistoryBar[] = [];
      const cachedBars = await loadCachedHistory(ticker, 500);

      if (cachedBars.length > 0) {
        if (resolution === '1D') {
          bars = cachedBars;
        } else if (resolution === '1W') {
          bars = aggregateWeeks(cachedBars);
        } else if (resolution === '1M') {
          bars = aggregateMonths(cachedBars);
        }
      }

      const chartToday = new Date();
      const chartFmt = (d: Date) => d.toISOString().slice(0, 10);
      const chartStart = new Date(chartToday);
      chartStart.setDate(chartStart.getDate() - 548);

      const needsFresh = bars.length < 60 ||
        (bars.length > 0 && bars.at(-1)!.date < chartFmt(chartToday));

      if (needsFresh || bars.length === 0) {
        const histPath = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/${rangeUnit}/${chartFmt(chartStart)}/${chartFmt(chartToday)}?adjusted=true&sort=asc&limit=50000`;
        const histResult = await massiveFetch(histPath, apiKey, ticker, 'chart_bars');

        if (histResult.ok) {
          const freshBars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
            date: new Date(b.t).toISOString().slice(0, 10),
            open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
          })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);

          if (freshBars.length > 0) {
            if (resolution === '1D') {
              const barMap = new Map<string, HistoryBar>();
              for (const b of cachedBars) barMap.set(b.date, b);
              for (const b of freshBars) barMap.set(b.date, b);
              bars = Array.from(barMap.values()).sort((a, b) => a.date.localeCompare(b.date));
            } else if (resolution === '1W') {
              const all = [...cachedBars, ...freshBars];
              const dedup = new Map<string, HistoryBar>();
              for (const b of all) dedup.set(b.date, b);
              bars = aggregateWeeks(Array.from(dedup.values()).sort((a, b) => a.date.localeCompare(b.date)));
            } else if (resolution === '1M') {
              const all = [...cachedBars, ...freshBars];
              const dedup = new Map<string, HistoryBar>();
              for (const b of all) dedup.set(b.date, b);
              bars = aggregateMonths(Array.from(dedup.values()).sort((a, b) => a.date.localeCompare(b.date)));
            }
            await saveCachedHistory(ticker, freshBars);
          }
        }
      }

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

    const noFilterMode =
      isSectionOff(profile, 'order_strike_enabled') &&
      isSectionOff(profile, 'expiration_enabled') &&
      isSectionOff(profile, 'croi_pc_enabled') &&
      isSectionOff(profile, 'cycle_liquidity_enabled') &&
      isSectionOff(profile, 'spread_enabled') &&
      isSectionOff(profile, 'short_interest_enabled') &&
      isSectionOff(profile, 'technical_rules_enabled') &&
      profile.exclude_existing_positions === false;

    console.log(`mode=${mode}, scanMode=${scanMode}, noFilterMode=${noFilterMode}`);
    console.log(`[PROFILE] min_stock_price=${profile.minimum_stock_price}, max_stock_price=${profile.maximum_stock_price}, max_strike=${profile.max_strike}, min_dte=${profile.min_dte}, max_strikes_per_ticker=${profile.max_strikes_per_ticker}, order_strike_enabled=${profile.order_strike_enabled}, expiration_enabled=${profile.expiration_enabled}`);

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

      const result = await scanSymbol(ticker, ticker, profile, apiKey, openTickers, noFilterMode, today, fmt, true, true, analyzeBulkPrice);

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
        stock_price: result.stockPrice !== null && result.stockPrice > 0 ? Number(result.stockPrice.toFixed(2)) : null,
        stock_source: result.stockSource || 'none',
        trend: result.trendClass || 'Unknown',
        primary_support: result.primarySupport !== null ? Number(result.primarySupport.toFixed(2)) : null,
        secondary_support: result.secondarySupport !== null ? Number(result.secondarySupport.toFixed(2)) : null,
        resistance: result.resistance !== null ? Number(result.resistance.toFixed(2)) : null,
        technical_data_available: Boolean(result.technicalDataAvailable),
        technical_warning: result.technicalDataAvailable ? null : 'Historical price data was unavailable or insufficient; support/trend rules were not used to reject contracts.',
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
    // If grouped daily fails (429/401/403/empty), bulkLoadCachedStockPrices
    // provides the last valid price for each ticker so they don't go Unavailable.
    const allTickers = symbolList.map((s) => s.ticker.toUpperCase());
    const { priceMap: bulkPriceMap, httpStatus: bulkHttpStatus } = await fetchGroupedDailyPrices(apiKey, today, fmt);
    console.log(`[BulkPrices] ${bulkPriceMap.size} stock prices loaded from grouped daily (HTTP ${bulkHttpStatus})`);

    // If grouped daily returned nothing, bulk-load persistent price cache as fallback
    let bulkCachedPrices = new Map<string, { price: number; source: string; tradeDate: string | null }>();
    if (bulkPriceMap.size === 0) {
      console.log(`[BulkPrices] Grouped daily returned 0 prices — loading persistent price cache for ${allTickers.length} tickers`);
      bulkCachedPrices = await bulkLoadCachedStockPrices(allTickers);
      console.log(`[BulkPrices] Persistent cache returned ${bulkCachedPrices.size} prices`);
    }

    // ── Main scan ──
    const candidates: any[] = [];
    let symbolsScanned = 0, symbolsFailed = 0, symbolsWithChains = 0;
    let totalPutsReturned = 0, totalFilteredByExp = 0, totalFilteredByStrike = 0;
    let totalValidQuotes = 0, totalAwaitingQuotes = 0;
    let totalEvaluated = 0, totalQualified = 0, totalRejected = 0, totalPagesFetched = 0;
    let totalContractsFound = 0;
    let rawSample: any = null;
    let verboseCount = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbolList.length / BATCH_SIZE)}: ${batch.map((b) => b.ticker).join(', ')}`);

      const batchResults = await Promise.all(
        batch.map((sym) => {
          const isVerbose = verboseCount < 3;
          if (isVerbose) verboseCount++;
          const upper = sym.ticker.toUpperCase();
          // Use grouped daily price; if missing, use persistent cache fallback
          const price = bulkPriceMap.get(upper) ?? bulkCachedPrices.get(upper)?.price ?? null;
          return scanSymbol(sym.ticker, sym.company_name || '', profile, apiKey, openTickers, noFilterMode, today, fmt, isVerbose, false, price, scanMode === 'universe')
            .catch((err) => {
              console.error(`[scanSymbol] ${sym.ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
              return null;
            });
        })
      );

      for (const result of batchResults) {
        if (!result) { symbolsFailed++; continue; }
        symbolsScanned++;
        totalPutsReturned += result.putsReturned;
        totalFilteredByExp += result.filteredByExpiration;
        totalFilteredByStrike += result.filteredByStrike;
        totalValidQuotes += result.validQuotes;
        totalAwaitingQuotes += result.contractsAwaitingQuotes;
        totalEvaluated += result.evaluated;
        totalQualified += result.qualified;
        totalRejected += result.rejected;
        totalPagesFetched += result.pagesFetched;
        totalContractsFound += result.putsReturned;

        if (result.chainStatus === 'success') symbolsWithChains++;
        if (result.chainStatus === 'api_error' || result.chainStatus === 'unauthorized' || result.chainStatus === 'rate_limited' || result.chainStatus === 'network_error') symbolsFailed++;

        if (!rawSample && result.rawSample) rawSample = result.rawSample;
        candidates.push(...result.candidates);
      }

      const qualifiedCount = candidates.filter((c) => c.qualified).length;
      if (qualifiedCount >= MAX_CANDIDATES) {
        console.log(`Reached ${MAX_CANDIDATES} qualified candidates, stopping early at ${symbolsScanned} symbols`);
        break;
      }
    }

    // Send all contracts to the client. The client's selectBestContractPerTicker
    // helper handles one-contract-per-ticker display logic. Keeping all contracts
    // preserves them for Analyze Ticker / Candidate Detail views.
    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);
    const capped = candidates.slice(0, MAX_CANDIDATES * 10);

    const scan_counts = {
      symbols_in_universe: symbolList.length,
      symbols_returned: symbolsScanned,
      symbols_failed: symbolsFailed,
      symbols_with_chains: symbolsWithChains,
      puts_returned: totalPutsReturned,
      filtered_by_expiration: totalFilteredByExp,
      filtered_by_strike: totalFilteredByStrike,
      valid_quotes: totalValidQuotes,
      contracts_awaiting_quotes: totalAwaitingQuotes,
      contracts_evaluated: totalEvaluated,
      qualified: totalQualified,
      rejected: totalRejected,
      pages_fetched: totalPagesFetched,
      contracts_found: totalContractsFound,
    };

    console.log(`market-scan complete — mode=${scanMode}, ${capped.length} candidates`, JSON.stringify(scan_counts));

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
