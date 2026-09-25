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
      const body = await resp.text().catch(() => 'unreadable');
      console.log(`[Cache SAVE FAIL] ${ticker} | HTTP ${resp.status} | body: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`[Cache SAVE ERROR] ${ticker} | ${e instanceof Error ? e.message : String(e)}`);
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
  historyStatus?: 'success' | 'fallback' | 'empty' | 'error';
  historyError?: string;
  technical?: { rsi: number; ma20: number; ma50: number; ma200: number | null; macd: number; macd_signal: number; macd_histogram: number; bb_upper: number; bb_middle: number; bb_lower: number; bb_position: string; volume_trend: string };
  techRejections?: TechnicalRejections;
  orderStrikeRejections?: OrderStrikeRejections;
  historyBarCount?: number;
  supportDistanceDebug?: SupportDistanceDebug;
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
    validQuotes: 0, contractsAwaitingQuotes: 0, evaluated: 0, qualified: 0, rejected: 0, pending: 0, pagesFetched: 0,
    techRejections: { rsi_below_min: 0, rsi_above_max: 0, ma20_not_above_ma50: 0, ma50_not_above_ma200: 0, price_not_above_ma200: 0, downtrend_no_support: 0, support_dist_below_min: 0, support_dist_above_max: 0, technical_data_missing: 0 },
    orderStrikeRejections: { stock_below_min: 0, stock_above_max: 0, strike_above_max: 0 },
    historyBarCount: 0,
    supportDistanceDebug: { before: 0, passed: 0, below_min: 0, above_max: 0, missing_support: 0, details: [] },
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
  } else if (bars.length >= 200) {
    r.historyStatus = 'success';
  } else if (bars.length >= 60) {
    r.historyStatus = 'partial';
  } else if (bars.length > 0) {
    r.historyStatus = 'fallback';
  } else {
    r.historyStatus = 'empty';
  }

  // Determine if any individual technical rule is actually active.
  // The master toggle alone must NOT require history or affect qualification.
  const hasActiveTechnicalRule =
    !noFilterMode &&
    !isSectionOff(profile, 'technical_rules_enabled') &&
    (
      profile.rsi_min != null ||
      profile.rsi_max != null ||
      profile.require_ma20_above_ma50 === true ||
      profile.require_ma50_above_ma200 === true ||
      profile.require_price_above_ma200 === true ||
      profile.exclude_downtrend_no_support === true
    );

  // Required bars depends only on the actual enabled rules, not the master toggle.
  let requiredHistoryBars = 0;
  if (hasActiveTechnicalRule) {
    if (
      profile.rsi_min != null ||
      profile.rsi_max != null ||
      profile.require_ma20_above_ma50 ||
      profile.exclude_downtrend_no_support
    ) {
      requiredHistoryBars = Math.max(requiredHistoryBars, 60);
    }
    if (
      profile.require_ma50_above_ma200 ||
      profile.require_price_above_ma200
    ) {
      requiredHistoryBars = Math.max(requiredHistoryBars, 200);
    }
  }

  const needsMA200 = hasActiveTechnicalRule && (profile.require_ma50_above_ma200 || profile.require_price_above_ma200);

  // Base technicals (RSI, MA20, MA50, MACD, BB, support/trend) need 60 bars.
  // MA200-dependent rules need 200 bars. We track both separately.
  const baseTechnicalDataAvailable = bars.length >= 60;
  const ma200DataAvailable = bars.length >= 200;
  const technicalDataAvailable = hasActiveTechnicalRule ? (needsMA200 ? ma200DataAvailable : baseTechnicalDataAvailable) : baseTechnicalDataAvailable;
  r.technicalDataAvailable = technicalDataAvailable;
  r.historyBarCount = bars.length;

  // If we have 60+ bars but not 200, we can still compute base technicals
  // (RSI, MA20, MA50, support, trend) but MA200 will be 0 and MA200-dependent
  // rules must be Pending, not Rejected.
  const canComputeBaseTechnicals = baseTechnicalDataAvailable;

  let primarySupport: number | null = canComputeBaseTechnicals && stockPrice !== null && stockPrice > 0 ? calcPrimarySupport(bars, stockPrice) : null;
  let secondarySupport: number | null = canComputeBaseTechnicals && primarySupport !== null ? calcSecondarySupport(bars, primarySupport) : null;
  let resistance: number | null = canComputeBaseTechnicals && stockPrice !== null && stockPrice > 0 ? findResistance(bars, stockPrice) : null;
  let trendClass = canComputeBaseTechnicals ? trend(bars) : 'Pending';

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


  if (canComputeBaseTechnicals) {
    const closes = bars.map((b) => b.close);
    const m = macd(closes);
    const bb = bollingerBands(closes);
    const has200 = closes.length >= 200;
    r.technical = {
      rsi: Number(rsi(closes).toFixed(1)),
      ma20: Number(sma(closes, 20).toFixed(2)),
      ma50: Number(sma(closes, 50).toFixed(2)),
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
  if (stockPrice !== null && stockPrice > 0 && canComputeBaseTechnicals) {
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
      // Only apply if at least one individual rule is active (not just the master toggle).
      // Base technicals (RSI, MA20, MA50, support, trend) need 60 bars.
      // MA200-dependent rules (MA50>MA200, Price>MA200) need 200 bars.
      // When bars >= 60 but < 200 and MA200 rules are enabled, those rules
      // are Pending, not Rejected.
      if (hasActiveTechnicalRule) {
        if (canComputeBaseTechnicals) {
          const tech = r.technical;
          // RSI: use null-safe checks
          if (tech) {
            if (profile.rsi_min != null && tech.rsi < profile.rsi_min) {
              if (!reasons.includes('RSI below minimum')) reasons.push('RSI below minimum');
              r.techRejections!.rsi_below_min++;
            }
            if (profile.rsi_max != null && tech.rsi > profile.rsi_max) {
              if (!reasons.includes('RSI above maximum')) reasons.push('RSI above maximum');
              r.techRejections!.rsi_above_max++;
            }
            // MA20 > MA50 — only if toggle ON
            if (profile.require_ma20_above_ma50 && tech.ma20 > 0 && tech.ma50 > 0 && tech.ma20 <= tech.ma50) {
              if (!reasons.includes('MA20 not above MA50')) reasons.push('MA20 not above MA50');
              r.techRejections!.ma20_not_above_ma50++;
            }
            // MA50 > MA200 — only if toggle ON. Needs 200 bars.
            if (profile.require_ma50_above_ma200) {
              if (ma200DataAvailable && tech!.ma200 !== null) {
                if (tech!.ma50 <= tech!.ma200) {
                  if (!reasons.includes('MA50 not above MA200')) reasons.push('MA50 not above MA200');
                  r.techRejections!.ma50_not_above_ma200++;
                }
              } else {
                if (!pendingReasons.includes('MA50 > MA200 not evaluated — insufficient history (need 200 bars)')) {
                  pendingReasons.push('MA50 > MA200 not evaluated — insufficient history (need 200 bars)');
                }
              }
            }
            // Price > MA200 — only if toggle ON. Needs 200 bars.
            if (profile.require_price_above_ma200) {
              if (ma200DataAvailable && tech!.ma200 !== null) {
                if (stockPrice !== null && stockPrice > 0 && stockPrice <= tech!.ma200) {
                  if (!reasons.includes('Price not above MA200')) reasons.push('Price not above MA200');
                  r.techRejections!.price_not_above_ma200++;
                }
              } else {
                if (!pendingReasons.includes('Price > MA200 not evaluated — insufficient history (need 200 bars)')) {
                  pendingReasons.push('Price > MA200 not evaluated — insufficient history (need 200 bars)');
                }
              }
            }
          }
          // Downtrend without support — only if toggle ON
          if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && primarySupport !== null && primarySupport > 0 && strike >= primarySupport) {
            reasons.push('Downtrend without support');
            r.techRejections!.downtrend_no_support++;
          }
        } else {
          // Technical data (history bars) unavailable — Pending
          if (!pendingReasons.includes('Missing technical data')) {
            pendingReasons.push('Missing technical data');
            r.techRejections!.technical_data_missing++;
          }
        }
      }

      // ── SUPPORT DISTANCE SECTION (independent of technical_rules_enabled) ──
      if (!isSectionOff(profile, 'support_distance_enabled')) {
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
          r.supportDistanceDebug!.details.push({
            ticker: symbol, strike, primarySupport,
            supportDistancePct: Number(supportDistPct.toFixed(2)),
            passesMin, passesMax, finalSupportDistancePass,
            status: finalSupportDistancePass ? 'pass' : !passesMin ? 'fail_below_min' : 'fail_above_max',
          });
          console.log(`[SUPPORT_DIST] ${symbol} | strike=${strike} | primarySupport=${primarySupport.toFixed(2)} | supportDistPct=${supportDistPct.toFixed(2)}% | passesMin=${passesMin} | passesMax=${passesMax} | finalPass=${finalSupportDistancePass}`);
        } else {
          r.supportDistanceDebug!.before++;
          r.supportDistanceDebug!.missing_support++;
          r.supportDistanceDebug!.details.push({
            ticker: symbol, strike, primarySupport: null,
            supportDistancePct: null, passesMin: false, passesMax: false,
            finalSupportDistancePass: false, status: 'pending_missing_support',
          });
          if (canComputeBaseTechnicals) {
            if (!pendingReasons.includes('Support distance not evaluated — support unavailable')) {
              pendingReasons.push('Support distance not evaluated — support unavailable');
            }
          }
          console.log(`[SUPPORT_DIST] ${symbol} | strike=${strike} | primarySupport=null | supportDistPct=null | status=Pending — Support unavailable`);
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
      // No premium available and CROI filter is ON — cannot qualify
      reasons.push('CROI too low');
    }

    // A contract is Pending if it has no hard rejections but has pending reasons
    // (data needed to evaluate a rule is temporarily unavailable).
    const hasRejections = reasons.length > 0;
    const hasPending = pendingReasons.length > 0;
    const supportDistanceActive = !noFilterMode && !isSectionOff(profile, 'support_distance_enabled') && (profile.minimum_support_distance_pct != null || profile.maximum_support_distance_pct != null);
    const historyDependentRulePending = (hasActiveTechnicalRule || supportDistanceActive) && !canComputeBaseTechnicals;
    const isPending = !hasRejections && (hasPending || historyDependentRulePending);
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
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        if (profile.max_strike != null) {
          passFail.push({ rule: `Strike <= ${profile.max_strike}`, pass: strike <= profile.max_strike, status: strike <= profile.max_strike ? 'pass' : 'fail' });
        }
        if (primarySupport !== null && primarySupport > 0) {
          const belowSupport = strike < primarySupport;
          passFail.push({ rule: `Strike below support (${primarySupport.toFixed(2)})`, pass: belowSupport, status: belowSupport ? 'pass' : 'fail' });
        } else {
          passFail.push({ rule: 'Support rule not evaluated — historical data unavailable', pass: true, status: 'not_evaluated' });
        }
      }
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        passFail.push({ rule: `OI >= ${profile.min_target_oi}`, pass: oi >= profile.min_target_oi, status: oi >= profile.min_target_oi ? 'pass' : 'fail' });
        passFail.push({ rule: `Sufficient liquidity (volume >= ${profile.preferred_daily_volume})`, pass: volume >= profile.preferred_daily_volume, status: volume >= profile.preferred_daily_volume ? 'pass' : 'fail' });
      }
      if (hasActiveTechnicalRule) {
        if (canComputeBaseTechnicals) {
          const tech = r.technical;
          if (tech) {
            if (profile.rsi_min != null) {
              const rsiOk = tech.rsi >= profile.rsi_min;
              passFail.push({ rule: `RSI >= ${profile.rsi_min} (${tech.rsi})`, pass: rsiOk, status: rsiOk ? 'pass' : 'fail' });
            }
            if (profile.rsi_max != null) {
              const rsiOk = tech.rsi <= profile.rsi_max;
              passFail.push({ rule: `RSI <= ${profile.rsi_max} (${tech.rsi})`, pass: rsiOk, status: rsiOk ? 'pass' : 'fail' });
            }
            if (profile.require_ma20_above_ma50) {
              const maOk = tech.ma20 > 0 && tech.ma50 > 0 && tech.ma20 > tech.ma50;
              passFail.push({ rule: `MA20 > MA50 (${tech.ma20} vs ${tech.ma50})`, pass: maOk, status: maOk ? 'pass' : 'fail' });
            }
            if (profile.require_ma50_above_ma200) {
              if (ma200DataAvailable && tech.ma200 !== null) {
                const maOk = tech.ma50 > tech.ma200;
                passFail.push({ rule: `MA50 > MA200 (${tech.ma50} vs ${tech.ma200})`, pass: maOk, status: maOk ? 'pass' : 'fail' });
              } else {
                passFail.push({ rule: 'MA50 > MA200 — insufficient history (need 200 bars)', pass: true, status: 'not_evaluated' });
              }
            }
            if (profile.require_price_above_ma200) {
              if (ma200DataAvailable && tech.ma200 !== null) {
                const priceOk = stockPrice !== null && stockPrice > 0 && stockPrice > tech.ma200;
                passFail.push({ rule: `Price > MA200 (${stockPrice} vs ${tech.ma200})`, pass: priceOk, status: priceOk ? 'pass' : 'fail' });
              } else {
                passFail.push({ rule: 'Price > MA200 — insufficient history (need 200 bars)', pass: true, status: 'not_evaluated' });
              }
            }
          }
          if (profile.exclude_downtrend_no_support) {
            const trendOk = !(trendClass === 'Downtrend' && primarySupport !== null && primarySupport > 0 && strike >= primarySupport);
            passFail.push({ rule: `Trend acceptable (${trendClass})`, pass: trendOk, status: trendOk ? 'pass' : 'fail' });
          }
        } else {
          passFail.push({ rule: 'Technical history unavailable', pass: true, status: 'not_evaluated' });
        }
      }
      if (!isSectionOff(profile, 'support_distance_enabled')) {
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

    // ── AB-TEST MODE: deterministic A/B regression test ──
    // Scans the same symbols with two profiles and compares results.
    // Profile A: technical_rules_enabled = false
    // Profile B: technical_rules_enabled = true, all individual rules null/false
    // Both profiles share the same stock price cache (intra-request), so
    // stock data is identical. Option chains are fetched fresh per scan but
    // are effectively identical seconds apart.
    if (mode === 'ab-test') {
      const abScanMode: 'discovery' | 'universe' = body.scanMode === 'universe' ? 'universe' : 'discovery';
      const abSymbols: string[] = Array.isArray(body.symbols)
        ? body.symbols.map((s: string) => String(s).toUpperCase().trim()).filter(Boolean)
        : [];

      let abSymbolList: { ticker: string; company_name: string | null }[];
      if (abScanMode === 'universe' && abSymbols.length > 0) {
        abSymbolList = abSymbols.map((t) => ({ ticker: t, company_name: null }));
      } else if (abScanMode === 'universe') {
        abSymbolList = await fetchScanUniverse();
      } else {
        abSymbolList = await fetchMarketUniverse(MAX_DISCOVERY_SYMBOLS);
      }

      if (abSymbolList.length === 0) {
        return json({ success: false, error: 'No symbols to scan for A/B test' });
      }

      // Clone the active profile exactly — never use defaults or new objects.
      const abTechFields = [
        'technical_rules_enabled', 'rsi_min', 'rsi_max',
        'require_ma20_above_ma50', 'require_ma50_above_ma200',
        'require_price_above_ma200', 'exclude_downtrend_no_support',
      ];
      const profileA: Profile = structuredClone(profile);
      profileA.technical_rules_enabled = false;
      const profileB: Profile = structuredClone(profile);
      profileB.technical_rules_enabled = true;
      profileB.rsi_min = null;
      profileB.rsi_max = null;
      profileB.require_ma20_above_ma50 = false;
      profileB.require_ma50_above_ma200 = false;
      profileB.require_price_above_ma200 = false;
      profileB.exclude_downtrend_no_support = false;

      // Assert all non-technical fields are identical between A and B.
      const abMismatches: string[] = [];
      for (const key of Object.keys(profileA) as (keyof Profile)[]) {
        if (abTechFields.includes(key)) continue;
        const va = profileA[key];
        const vb = profileB[key];
        if (JSON.stringify(va) !== JSON.stringify(vb)) {
          abMismatches.push(`${key}: A=${JSON.stringify(va)} B=${JSON.stringify(vb)}`);
        }
      }
      if (abMismatches.length > 0) {
        console.error(`[AB-TEST] Profile construction mismatch: ${abMismatches.join(', ')}`);
        return json({
          success: false,
          error: 'Profile construction mismatch',
          mismatches: abMismatches,
        });
      }
      console.log('[AB-TEST] All non-technical fields identical between Profile A and B');

      // Support distance must be identical — log assertions.
      console.assert(profileA.support_distance_enabled === profileB.support_distance_enabled,
        `[AB-TEST] support_distance_enabled mismatch: A=${profileA.support_distance_enabled} B=${profileB.support_distance_enabled}`);
      console.assert(profileA.minimum_support_distance_pct === profileB.minimum_support_distance_pct,
        `[AB-TEST] minimum_support_distance_pct mismatch: A=${profileA.minimum_support_distance_pct} B=${profileB.minimum_support_distance_pct}`);
      console.assert(profileA.maximum_support_distance_pct === profileB.maximum_support_distance_pct,
        `[AB-TEST] maximum_support_distance_pct mismatch: A=${profileA.maximum_support_distance_pct} B=${profileB.maximum_support_distance_pct}`);

      // hasActiveTechnicalRule assertion for Profile B
      const abHasActiveRule =
        profileB.technical_rules_enabled &&
        (profileB.rsi_min != null ||
          profileB.rsi_max != null ||
          profileB.require_ma20_above_ma50 === true ||
          profileB.require_ma50_above_ma200 === true ||
          profileB.require_price_above_ma200 === true ||
          profileB.exclude_downtrend_no_support === true);
      console.log(`[AB-TEST] hasActiveTechnicalRule(Profile B) = ${abHasActiveRule}`);
      console.assert(!abHasActiveRule, 'AB-TEST: Profile B incorrectly detects an active technical rule');

      // Both profiles must use the SAME noFilterMode as the live scan.
      // Computing it per-profile would make noFilterA != noFilterB because
      // isSectionOff(profileB, 'technical_rules_enabled') is false.
      // The live scan computes noFilterMode from the original active profile,
      // so we reuse that exact value.
      console.log(`[AB-TEST] Using live noFilterMode=${noFilterMode} for both profiles`);

      // Bulk stock prices (shared between both scans)
      const abAllTickers = abSymbolList.map((s) => s.ticker.toUpperCase());
      const { priceMap: abBulkPriceMap } = await fetchGroupedDailyPrices(apiKey, today, fmt);
      let abBulkCachedPrices = new Map<string, { price: number; source: string; tradeDate: string | null }>();
      if (abBulkPriceMap.size === 0) {
        abBulkCachedPrices = await bulkLoadCachedStockPrices(abAllTickers);
      }

      const AB_BATCH = 5;
      const candidatesA: any[] = [];
      const candidatesB: any[] = [];

      for (let i = 0; i < abSymbolList.length; i += AB_BATCH) {
        const batch = abSymbolList.slice(i, i + AB_BATCH);
        console.log(`[AB-TEST] Batch ${Math.floor(i / AB_BATCH) + 1}/${Math.ceil(abSymbolList.length / AB_BATCH)}: ${batch.map((b) => b.ticker).join(', ')}`);

        // Scan with Profile A
        const resultsA = await Promise.all(
          batch.map((sym) => {
            const upper = sym.ticker.toUpperCase();
            const price = abBulkPriceMap.get(upper) ?? abBulkCachedPrices.get(upper)?.price ?? null;
            return scanSymbol(sym.ticker, sym.company_name || '', profileA, apiKey, openTickers, noFilterMode, today, fmt, false, false, price, abScanMode === 'universe')
              .catch((err) => { console.error(`[AB-TEST A] ${sym.ticker} failed: ${err}`); return null; });
          })
        );
        for (const r of resultsA) { if (r) candidatesA.push(...r.candidates); }

        // Scan with Profile B (same stockCache, same bulk prices)
        const resultsB = await Promise.all(
          batch.map((sym) => {
            const upper = sym.ticker.toUpperCase();
            const price = abBulkPriceMap.get(upper) ?? abBulkCachedPrices.get(upper)?.price ?? null;
            return scanSymbol(sym.ticker, sym.company_name || '', profileB, apiKey, openTickers, noFilterMode, today, fmt, false, false, price, abScanMode === 'universe')
              .catch((err) => { console.error(`[AB-TEST B] ${sym.ticker} failed: ${err}`); return null; });
          })
        );
        for (const r of resultsB) { if (r) candidatesB.push(...r.candidates); }
      }

      // ── STAGE 2 for A/B: Cache warming (mirrors live scan logic) ──
      // Both profiles get the same cache-warming treatment so pending tickers
      // have their history fetched and re-scanned, exactly like the live scan.
      const AB_MAX_HISTORY_FETCHES = 4;

      async function abWarmPending(
        candidates: any[],
        prof: Profile,
        noFilter: boolean,
        label: string,
      ): Promise<void> {
        const hasActiveTech =
          !noFilter &&
          !isSectionOff(prof, 'technical_rules_enabled') &&
          (prof.rsi_min != null || prof.rsi_max != null ||
            prof.require_ma20_above_ma50 === true || prof.require_ma50_above_ma200 === true ||
            prof.require_price_above_ma200 === true || prof.exclude_downtrend_no_support === true);
        const supportDistNeedsHistory = !noFilter &&
          !isSectionOff(prof, 'support_distance_enabled') &&
          (prof.minimum_support_distance_pct != null || prof.maximum_support_distance_pct != null);
        const historyNeeded = hasActiveTech || supportDistNeedsHistory;
        if (!historyNeeded) return;

        const pendingTickers = new Map<string, { ticker: string; bestCroi: number; bestOi: number; bestVolume: number; cachedBars: number }>();
        for (const c of candidates) {
          if (c.technical_pending && (!c.rejection_reasons || c.rejection_reasons.length === 0)) {
            const existing = pendingTickers.get(c.ticker);
            const croi = c.net_croi || 0;
            const oi = c.open_interest || 0;
            const vol = c.volume || 0;
            if (!existing || croi > existing.bestCroi) {
              pendingTickers.set(c.ticker, { ticker: c.ticker, bestCroi: croi, bestOi: Math.max(oi, existing?.bestOi || 0), bestVolume: Math.max(vol, existing?.bestVolume || 0), cachedBars: 0 });
            }
          }
        }

        const needsFetch: { ticker: string; bestCroi: number; bestOi: number; bestVolume: number; cachedBars: number }[] = [];
        for (const info of pendingTickers.values()) {
          const upper = info.ticker.toUpperCase();
          const cachedBars = await loadCachedHistory(upper, 260);
          info.cachedBars = cachedBars.length;
          const needsMA200 = hasActiveTech && (prof.require_ma50_above_ma200 || prof.require_price_above_ma200);
          const requiredBars = needsMA200 ? 200 : 60;
          if (cachedBars.length < requiredBars) {
            needsFetch.push(info);
          }
        }

        needsFetch.sort((a, b) => {
          const aHasCroi = a.bestCroi > 0 ? 1 : 0;
          const bHasCroi = b.bestCroi > 0 ? 1 : 0;
          if (aHasCroi !== bHasCroi) return bHasCroi - aHasCroi;
          if (a.bestOi !== b.bestOi) return b.bestOi - a.bestOi;
          return b.bestVolume - a.bestVolume;
        });

        const toFetch = needsFetch.slice(0, AB_MAX_HISTORY_FETCHES);
        console.log(`[AB-TEST ${label}] ${needsFetch.length} tickers need history, fetching top ${toFetch.length}`);

        for (const info of toFetch) {
          const upper = info.ticker.toUpperCase();
          stockCache.delete(upper);
          const snapshot = await getStockSnapshot(upper, apiKey, today, fmt, abBulkPriceMap.get(upper) ?? abBulkCachedPrices.get(upper)?.price ?? null, true);
          const finalBars = snapshot.historicalBars.length;

          if (finalBars >= 60) {
            console.log(`[AB-TEST ${label}] ${upper} | fetched ${finalBars} bars, re-scanning`);
            const price = abBulkPriceMap.get(upper) ?? abBulkCachedPrices.get(upper)?.price ?? null;
            const rerunResult = await scanSymbol(upper, '', prof, apiKey, openTickers, noFilter, today, fmt, false, false, price, false);
            if (rerunResult.chainStatus === 'success' || rerunResult.candidates.length > 0) {
              for (let ci = candidates.length - 1; ci >= 0; ci--) {
                if (candidates[ci].ticker === upper) candidates.splice(ci, 1);
              }
              candidates.push(...rerunResult.candidates);
            }
          } else {
            console.log(`[AB-TEST ${label}] ${upper} | fetch returned only ${finalBars} bars — still pending`);
          }
        }
      }

      await abWarmPending(candidatesA, profileA, noFilterMode, 'A');
      await abWarmPending(candidatesB, profileB, noFilterMode, 'B');

      // Log SOFI specifically if present in either profile
      const sofiA = candidatesA.find((c) => c.ticker === 'SOFI');
      const sofiB = candidatesB.find((c) => c.ticker === 'SOFI');
      if (sofiA || sofiB) {
        console.log(`[AB-TEST SOFI] A: qualified=${sofiA?.qualified ?? 'N/A'}, pending=${sofiA?.technical_pending ?? 'N/A'}, reasons=${JSON.stringify(sofiA?.rejection_reasons ?? [])}, pendingReasons=${JSON.stringify(sofiA?.pending_reasons ?? [])}, netCROI=${sofiA?.net_croi ?? 'N/A'}, PC=${sofiA?.premium_capture ?? 'N/A'}, OI=${sofiA?.open_interest ?? 'N/A'}, vol=${sofiA?.volume ?? 'N/A'}, supportDist=${sofiA?.strike_distance_from_support ?? 'N/A'}`);
        console.log(`[AB-TEST SOFI] B: qualified=${sofiB?.qualified ?? 'N/A'}, pending=${sofiB?.technical_pending ?? 'N/A'}, reasons=${JSON.stringify(sofiB?.rejection_reasons ?? [])}, pendingReasons=${JSON.stringify(sofiB?.pending_reasons ?? [])}, netCROI=${sofiB?.net_croi ?? 'N/A'}, PC=${sofiB?.premium_capture ?? 'N/A'}, OI=${sofiB?.open_interest ?? 'N/A'}, vol=${sofiB?.volume ?? 'N/A'}, supportDist=${sofiB?.strike_distance_from_support ?? 'N/A'}`);
      }

      // Build comparison maps keyed by ticker|strike|expiration
      const keyOf = (c: any) => `${c.ticker}|${c.strike}|${c.expiration}`;
      const mapA = new Map<string, any>();
      const mapB = new Map<string, any>();
      for (const c of candidatesA) mapA.set(keyOf(c), c);
      for (const c of candidatesB) mapB.set(keyOf(c), c);

      const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
      const diffs: any[] = [];
      let identical = 0;

      for (const key of allKeys) {
        const cA = mapA.get(key);
        const cB = mapB.get(key);
        const qA = cA?.qualified ?? false;
        const qB = cB?.qualified ?? false;
        const pA = cA?.technical_pending ?? false;
        const pB = cB?.technical_pending ?? false;
        const rA = cA?.rejection_reasons ?? [];
        const rB = cB?.rejection_reasons ?? [];
        const pendingA = cA?.pending_reasons ?? [];
        const pendingB = cB?.pending_reasons ?? [];

        const reasonsMatch = JSON.stringify(rA) === JSON.stringify(rB);
        const pendingMatch = JSON.stringify(pendingA) === JSON.stringify(pendingB);
        const statusMatch = qA === qB && pA === pB && reasonsMatch && pendingMatch;

        if (statusMatch) {
          identical++;
        } else {
          diffs.push({
            key,
            ticker: cA?.ticker ?? cB?.ticker,
            strike: cA?.strike ?? cB?.strike,
            expiration: cA?.expiration ?? cB?.expiration,
            profile_a: {
              qualified: qA,
              pending: pA,
              rejection_reasons: rA,
              pending_reasons: pendingA,
              net_croi: cA?.net_croi ?? null,
              premium_capture: cA?.premium_capture ?? null,
            },
            profile_b: {
              qualified: qB,
              pending: pB,
              rejection_reasons: rB,
              pending_reasons: pendingB,
              net_croi: cB?.net_croi ?? null,
              premium_capture: cB?.premium_capture ?? null,
            },
          });
        }
      }

      const qualifiedA = candidatesA.filter((c) => c.qualified);
      const qualifiedB = candidatesB.filter((c) => c.qualified);
      const qualifiedTickersA = new Set(qualifiedA.map((c) => c.ticker));
      const qualifiedTickersB = new Set(qualifiedB.map((c) => c.ticker));

      console.log(`[AB-TEST] Profile A: ${qualifiedA.length} qualified contracts, ${qualifiedTickersA.size} tickers`);
      console.log(`[AB-TEST] Profile B: ${qualifiedB.length} qualified contracts, ${qualifiedTickersB.size} tickers`);
      console.log(`[AB-TEST] Identical: ${identical}, Diffs: ${diffs.length}`);

      return json({
        success: true,
        mode: 'ab-test',
        has_active_technical_rule_profile_b: abHasActiveRule,
        assertion_passed: !abHasActiveRule,
        profile_a: {
          technical_rules_enabled: false,
          qualified_contracts: qualifiedA.length,
          qualified_tickers: Array.from(qualifiedTickersA).sort(),
          total_candidates: candidatesA.length,
        },
        profile_b: {
          technical_rules_enabled: true,
          rsi_min: null,
          rsi_max: null,
          require_ma20_above_ma50: false,
          require_ma50_above_ma200: false,
          require_price_above_ma200: false,
          exclude_downtrend_no_support: false,
          qualified_contracts: qualifiedB.length,
          qualified_tickers: Array.from(qualifiedTickersB).sort(),
          total_candidates: candidatesB.length,
        },
        identical_contracts: identical,
        different_contracts: diffs.length,
        diffs: diffs.slice(0, 50),
        test_passed: diffs.length === 0 && qualifiedTickersA.size === qualifiedTickersB.size,
        scanned_at: new Date().toISOString(),
      });
    }

    // ── RULE-ISOLATION MODE: deterministic rule testing on one finalized dataset ──
    // Runs one baseline scan (all technical + support distance OFF), captures the
    // enriched contracts + per-ticker technicals, then re-evaluates the SAME
    // contracts with 5 different rule profiles — no additional API calls.
    if (mode === 'rule-isolation') {
      const riScanMode: 'discovery' | 'universe' = body.scanMode === 'universe' ? 'universe' : 'discovery';
      const riSymbols: string[] = Array.isArray(body.symbols)
        ? body.symbols.map((s: string) => String(s).toUpperCase().trim()).filter(Boolean)
        : [];

      let riSymbolList: { ticker: string; company_name: string | null }[];
      if (riScanMode === 'universe' && riSymbols.length > 0) {
        riSymbolList = riSymbols.map((t) => ({ ticker: t, company_name: null }));
      } else if (riScanMode === 'universe') {
        riSymbolList = await fetchScanUniverse();
      } else {
        riSymbolList = await fetchMarketUniverse(MAX_DISCOVERY_SYMBOLS);
      }

      if (riSymbolList.length === 0) {
        return json({ success: false, error: 'No symbols to scan for rule isolation test' });
      }

      // Baseline profile: clone active profile, turn OFF technical rules + support distance
      const baselineProfile: Profile = structuredClone(profile);
      baselineProfile.technical_rules_enabled = false;
      baselineProfile.rsi_min = null;
      baselineProfile.rsi_max = null;
      baselineProfile.require_ma20_above_ma50 = false;
      baselineProfile.require_ma50_above_ma200 = false;
      baselineProfile.require_price_above_ma200 = false;
      baselineProfile.exclude_downtrend_no_support = false;
      baselineProfile.support_distance_enabled = false;

      // noFilterMode for the baseline: recompute with technical + support distance OFF
      const riNoFilter =
        isSectionOff(baselineProfile, 'order_strike_enabled') &&
        isSectionOff(baselineProfile, 'expiration_enabled') &&
        isSectionOff(baselineProfile, 'croi_pc_enabled') &&
        isSectionOff(baselineProfile, 'cycle_liquidity_enabled') &&
        isSectionOff(baselineProfile, 'spread_enabled') &&
        isSectionOff(baselineProfile, 'short_interest_enabled') &&
        isSectionOff(baselineProfile, 'technical_rules_enabled') &&
        isSectionOff(baselineProfile, 'support_distance_enabled') &&
        baselineProfile.exclude_existing_positions === false;

      console.log(`[RULE-ISOLATION] Baseline scan with ${riSymbolList.length} symbols, noFilter=${riNoFilter}`);

      // Bulk stock prices
      const riAllTickers = riSymbolList.map((s) => s.ticker.toUpperCase());
      const { priceMap: riBulkPriceMap } = await fetchGroupedDailyPrices(apiKey, today, fmt);
      let riBulkCachedPrices = new Map<string, { price: number; source: string; tradeDate: string | null }>();
      if (riBulkPriceMap.size === 0) {
        riBulkCachedPrices = await bulkLoadCachedStockPrices(riAllTickers);
      }

      // Run baseline scan
      const baselineCandidates: any[] = [];
      const tickerTechnicals = new Map<string, {
        rsi: number | null; ma20: number | null; ma50: number | null; ma200: number | null;
        trend: string; primarySupport: number | null; barCount: number;
      }>();

      const RI_BATCH = 5;
      for (let i = 0; i < riSymbolList.length; i += RI_BATCH) {
        const batch = riSymbolList.slice(i, i + RI_BATCH);
        const results = await Promise.all(
          batch.map((sym) => {
            const upper = sym.ticker.toUpperCase();
            const price = riBulkPriceMap.get(upper) ?? riBulkCachedPrices.get(upper)?.price ?? null;
            return scanSymbol(sym.ticker, sym.company_name || '', baselineProfile, apiKey, openTickers, riNoFilter, today, fmt, false, false, price, riScanMode === 'universe')
              .catch((err) => { console.error(`[RULE-ISOLATION] ${sym.ticker} failed: ${err}`); return null; });
          })
        );
        for (const r of results) {
          if (!r) continue;
          baselineCandidates.push(...r.candidates);
          // Capture per-ticker technical data
          if (r.candidates.length > 0 || r.chainStatus === 'success') {
            const ticker = r.candidates[0]?.ticker || batch.find((s) => s.ticker.toUpperCase() === (r.stockPrice != null ? r.candidates[0]?.ticker : ''))?.ticker;
            // Get ticker from the first candidate or from the batch
            const techTicker = r.candidates[0]?.ticker;
            if (techTicker) {
              tickerTechnicals.set(techTicker.toUpperCase(), {
                rsi: r.technical?.rsi ?? null,
                ma20: r.technical?.ma20 ?? null,
                ma50: r.technical?.ma50 ?? null,
                ma200: r.technical?.ma200 ?? null,
                trend: r.trendClass || 'Unknown',
                primarySupport: r.primarySupport ?? null,
                barCount: r.historyBarCount ?? 0,
              });
            }
          }
        }
      }

      // Cache warming: fetch history for pending tickers so we have technicals
      const RI_MAX_FETCHES = 4;
      const pendingTickersRI = new Map<string, { ticker: string; bestCroi: number }>();
      for (const c of baselineCandidates) {
        if (c.technical_pending && (!c.rejection_reasons || c.rejection_reasons.length === 0)) {
          const existing = pendingTickersRI.get(c.ticker);
          if (!existing || (c.net_croi || 0) > existing.bestCroi) {
            pendingTickersRI.set(c.ticker, { ticker: c.ticker, bestCroi: c.net_croi || 0 });
          }
        }
      }
      const riNeedsFetch = Array.from(pendingTickersRI.values()).sort((a, b) => b.bestCroi - a.bestCroi).slice(0, RI_MAX_FETCHES);
      for (const info of riNeedsFetch) {
        const upper = info.ticker.toUpperCase();
        stockCache.delete(upper);
        const snapshot = await getStockSnapshot(upper, apiKey, today, fmt, riBulkPriceMap.get(upper) ?? riBulkCachedPrices.get(upper)?.price ?? null, true);
        if (snapshot.historicalBars.length >= 60) {
          const price = riBulkPriceMap.get(upper) ?? riBulkCachedPrices.get(upper)?.price ?? null;
          const rerun = await scanSymbol(upper, '', baselineProfile, apiKey, openTickers, riNoFilter, today, fmt, false, false, price, false);
          if (rerun.candidates.length > 0) {
            for (let ci = baselineCandidates.length - 1; ci >= 0; ci--) {
              if (baselineCandidates[ci].ticker === upper) baselineCandidates.splice(ci, 1);
            }
            baselineCandidates.push(...rerun.candidates);
            tickerTechnicals.set(upper, {
              rsi: rerun.technical?.rsi ?? null,
              ma20: rerun.technical?.ma20 ?? null,
              ma50: rerun.technical?.ma50 ?? null,
              ma200: rerun.technical?.ma200 ?? null,
              trend: rerun.trendClass || 'Unknown',
              primarySupport: rerun.primarySupport ?? null,
              barCount: rerun.historyBarCount ?? 0,
            });
          }
        }
      }

      console.log(`[RULE-ISOLATION] Baseline: ${baselineCandidates.length} candidates, ${tickerTechnicals.size} tickers with technicals`);

      // Build finalized contract dataset for re-evaluation
      interface RuleTestContract {
        ticker: string;
        strike: number;
        expiration: string;
        stock_price: number | null;
        dte: number;
        net_croi: number | null;
        premium_capture: number | null;
        open_interest: number;
        volume: number;
        iv: number | null;
        rsi: number | null;
        ma20: number | null;
        ma50: number | null;
        ma200: number | null;
        trend: string;
        primary_support: number | null;
        support_distance: number | null;
        base_qualified: boolean;
        base_rejection_reasons: string[];
        base_pending_reasons: string[];
      }

      const ruleTestContracts: RuleTestContract[] = baselineCandidates.map((c) => {
        const tech = tickerTechnicals.get(c.ticker?.toUpperCase());
        return {
          ticker: c.ticker,
          strike: c.strike,
          expiration: c.expiration,
          stock_price: c.stock_price ?? null,
          dte: c.dte ?? 0,
          net_croi: c.net_croi ?? null,
          premium_capture: c.premium_capture ?? null,
          open_interest: c.open_interest ?? 0,
          volume: c.volume ?? 0,
          iv: c.iv ?? null,
          rsi: tech?.rsi ?? null,
          ma20: tech?.ma20 ?? null,
          ma50: tech?.ma50 ?? null,
          ma200: tech?.ma200 ?? null,
          trend: tech?.trend ?? 'Unknown',
          primary_support: c.primary_support ?? tech?.primarySupport ?? null,
          support_distance: c.strike_distance_from_support ?? null,
          base_qualified: c.qualified,
          base_rejection_reasons: c.rejection_reasons ?? [],
          base_pending_reasons: c.pending_reasons ?? [],
        };
      });

      // Pure re-evaluation function — no API calls
      function evaluateRulesPure(
        contract: RuleTestContract,
        prof: Profile,
      ): { qualified: boolean; pending: boolean; rejection_reasons: string[]; pending_reasons: string[] } {
        const rejection_reasons: string[] = [];
        const pending_reasons: string[] = [];

        // Start from base state: if already rejected by non-technical rules, keep those
        for (const r of contract.base_rejection_reasons) {
          // Filter out technical/support reasons — we'll re-evaluate those
          if (r === 'Downtrend without support' || r === 'Support distance too high' || r === 'Support distance too low' || r === 'Technical data missing') continue;
          rejection_reasons.push(r);
        }

        const techEnabled = !isSectionOff(prof, 'technical_rules_enabled');
        const hasActiveTech = techEnabled && (
          prof.rsi_min != null || prof.rsi_max != null ||
          prof.require_ma20_above_ma50 === true || prof.require_ma50_above_ma200 === true ||
          prof.require_price_above_ma200 === true || prof.exclude_downtrend_no_support === true
        );

        if (hasActiveTech) {
          const hasData = contract.rsi != null && contract.ma20 != null && contract.ma50 != null;
          const needsMA200 = prof.require_ma50_above_ma200 || prof.require_price_above_ma200;
          const hasMA200 = contract.ma200 != null;
          const dataComplete = needsMA200 ? (hasData && hasMA200) : hasData;

          if (!dataComplete) {
            pending_reasons.push('Technical data missing');
          } else {
            if (prof.rsi_min != null && contract.rsi! < prof.rsi_min) {
              rejection_reasons.push('RSI below minimum');
            }
            if (prof.rsi_max != null && contract.rsi! > prof.rsi_max) {
              rejection_reasons.push('RSI above maximum');
            }
            if (prof.require_ma20_above_ma50 && contract.ma20! <= contract.ma50!) {
              rejection_reasons.push('MA20 not above MA50');
            }
            if (prof.require_ma50_above_ma200 && contract.ma200 != null && contract.ma50! <= contract.ma200) {
              rejection_reasons.push('MA50 not above MA200');
            }
            if (prof.require_price_above_ma200 && contract.ma200 != null && contract.stock_price! <= contract.ma200) {
              rejection_reasons.push('Price not above MA200');
            }
            if (prof.exclude_downtrend_no_support) {
              const isDowntrend = contract.trend === 'Downtrend' || contract.trend === 'Strong Downtrend';
              const hasSupport = contract.primary_support != null && contract.primary_support > 0;
              if (isDowntrend && !hasSupport) {
                rejection_reasons.push('Downtrend without support');
              }
            }
          }
        }

        // Support distance
        const sdEnabled = !isSectionOff(prof, 'support_distance_enabled');
        const hasSD = sdEnabled && (prof.minimum_support_distance_pct != null || prof.maximum_support_distance_pct != null);
        if (hasSD) {
          if (contract.primary_support == null || contract.support_distance == null) {
            pending_reasons.push('Missing support data');
          } else {
            if (prof.minimum_support_distance_pct != null && contract.support_distance < prof.minimum_support_distance_pct) {
              rejection_reasons.push('Support distance too low');
            }
            if (prof.maximum_support_distance_pct != null && contract.support_distance > prof.maximum_support_distance_pct) {
              rejection_reasons.push('Support distance too high');
            }
          }
        }

        const isPending = pending_reasons.length > 0 && rejection_reasons.length === 0;
        const isQualified = rejection_reasons.length === 0 && pending_reasons.length === 0;

        return { qualified: isQualified, pending: isPending, rejection_reasons, pending_reasons };
      }

      // Define 5 test profiles
      function makeTestProfile(overrides: Partial<Profile>): Profile {
        const p: Profile = structuredClone(baselineProfile);
        return Object.assign(p, overrides);
      }

      const testProfiles: { name: string; profile: Profile }[] = [
        { name: 'Baseline', profile: makeTestProfile({}) },
        { name: 'RSI 35-65', profile: makeTestProfile({
          technical_rules_enabled: true, rsi_min: 35, rsi_max: 65,
        })},
        { name: 'Downtrend only', profile: makeTestProfile({
          technical_rules_enabled: true, exclude_downtrend_no_support: true,
        })},
        { name: 'RSI + Downtrend', profile: makeTestProfile({
          technical_rules_enabled: true, rsi_min: 35, rsi_max: 65, exclude_downtrend_no_support: true,
        })},
        { name: 'Support 15-50%', profile: makeTestProfile({
          support_distance_enabled: true, minimum_support_distance_pct: 15, maximum_support_distance_pct: 50,
        })},
      ];

      // Run all tests
      const testResults = testProfiles.map(({ name, profile: tp }) => {
        let qualified = 0, pending = 0, rejected = 0;
        const qualifiedTickers = new Set<string>();
        const changes: { ticker: string; strike: number; expiration: string; baseline_status: string; test_status: string; reason: string }[] = [];

        for (const contract of ruleTestContracts) {
          const result = evaluateRulesPure(contract, tp);
          const key = `${contract.ticker}|${contract.strike}|${contract.expiration}`;
          const baseStatus = contract.base_qualified ? 'Qualified' : (contract.base_pending_reasons.length > 0 ? 'Pending' : 'Rejected');
          const testStatus = result.qualified ? 'Qualified' : (result.pending ? 'Pending' : 'Rejected');

          if (result.qualified) { qualified++; qualifiedTickers.add(contract.ticker); }
          else if (result.pending) pending++;
          else rejected++;

          if (baseStatus !== testStatus || JSON.stringify(contract.base_rejection_reasons) !== JSON.stringify(result.rejection_reasons)) {
            const baseReasons = contract.base_rejection_reasons.filter(r => r !== 'Technical data missing').join(', ');
            const testReasons = result.rejection_reasons.join(', ');
            const reason = testReasons !== baseReasons ? testReasons : (result.pending_reasons.join(', ') || '');
            changes.push({
              ticker: contract.ticker,
              strike: contract.strike,
              expiration: contract.expiration,
              baseline_status: baseStatus,
              test_status: testStatus,
              reason: reason || (baseStatus !== testStatus ? `Status changed: ${baseStatus} -> ${testStatus}` : ''),
            });
          }
        }

        // Bug check: a filter must never create MORE qualified than baseline
        const baselineQualified = testResults[0]?.qualified ?? 0;
        if (name !== 'Baseline' && qualified > baselineQualified) {
          changes.unshift({
            ticker: 'BUG', strike: 0, expiration: '',
            baseline_status: `${baselineQualified} qualified`,
            test_status: `${qualified} qualified`,
            reason: 'BUG: filter changed unrelated qualification state — filter produced MORE qualified candidates than baseline',
          });
        }

        return { name, qualified, pending, rejected, qualified_tickers: Array.from(qualifiedTickers).sort(), changes };
      });

      // Bug check after all results computed
      const baselineQualified = testResults[0].qualified;
      for (let i = 1; i < testResults.length; i++) {
        if (testResults[i].qualified > baselineQualified) {
          console.error(`[RULE-ISOLATION] BUG: ${testResults[i].name} produced ${testResults[i].qualified} qualified vs baseline ${baselineQualified}`);
        }
      }

      console.log(`[RULE-ISOLATION] Results: ${JSON.stringify(testResults.map(t => ({ name: t.name, qualified: t.qualified, pending: t.pending, rejected: t.rejected })))}`);

      return json({
        success: true,
        mode: 'rule-isolation',
        contracts_captured: ruleTestContracts.length,
        tickers_with_technicals: tickerTechnicals.size,
        tests: testResults,
        scanned_at: new Date().toISOString(),
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
    let totalEvaluated = 0, totalQualified = 0, totalRejected = 0, totalPending = 0, totalPagesFetched = 0;
    let totalContractsFound = 0;
    let rawSample: any = null;
    let verboseCount = 0;
    const techRejTotals = { rsi_below_min: 0, rsi_above_max: 0, ma20_not_above_ma50: 0, ma50_not_above_ma200: 0, price_not_above_ma200: 0, downtrend_no_support: 0, support_dist_below_min: 0, support_dist_above_max: 0, technical_data_missing: 0 };
    const supportDistanceDebugTotals = { before: 0, passed: 0, below_min: 0, above_max: 0, missing_support: 0, details: [] as any[] };
    const orderStrikeRejTotals = { stock_below_min: 0, stock_above_max: 0, strike_above_max: 0 };
    // Technical cache diagnostics
    let tickersWith60PlusBars = 0, tickersWith200PlusBars = 0, tickersMissingHistory = 0;

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
        totalPending += result.pending || 0;
        totalPagesFetched += result.pagesFetched;
        totalContractsFound += result.putsReturned;
        if (result.techRejections) {
          techRejTotals.rsi_below_min += result.techRejections.rsi_below_min;
          techRejTotals.rsi_above_max += result.techRejections.rsi_above_max;
          techRejTotals.ma20_not_above_ma50 += result.techRejections.ma20_not_above_ma50;
          techRejTotals.ma50_not_above_ma200 += result.techRejections.ma50_not_above_ma200;
          techRejTotals.price_not_above_ma200 += result.techRejections.price_not_above_ma200;
          techRejTotals.downtrend_no_support += result.techRejections.downtrend_no_support;
          techRejTotals.support_dist_below_min += result.techRejections.support_dist_below_min;
          techRejTotals.support_dist_above_max += result.techRejections.support_dist_above_max;
          techRejTotals.technical_data_missing += result.techRejections.technical_data_missing;
        }
        if (result.orderStrikeRejections) {
          orderStrikeRejTotals.stock_below_min += result.orderStrikeRejections.stock_below_min;
          orderStrikeRejTotals.stock_above_max += result.orderStrikeRejections.stock_above_max;
          orderStrikeRejTotals.strike_above_max += result.orderStrikeRejections.strike_above_max;
        }
        if (result.supportDistanceDebug) {
          supportDistanceDebugTotals.before += result.supportDistanceDebug.before;
          supportDistanceDebugTotals.passed += result.supportDistanceDebug.passed;
          supportDistanceDebugTotals.below_min += result.supportDistanceDebug.below_min;
          supportDistanceDebugTotals.above_max += result.supportDistanceDebug.above_max;
          supportDistanceDebugTotals.missing_support += result.supportDistanceDebug.missing_support;
          supportDistanceDebugTotals.details.push(...result.supportDistanceDebug.details);
        }
        // Track technical cache stats
        const barCount = result.historyBarCount ?? 0;
        if (barCount >= 200) tickersWith200PlusBars++;
        else if (barCount >= 60) tickersWith60PlusBars++;
        else tickersMissingHistory++;

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

    // ── STAGE 2: Technical cache warming ──
    // After the main scan, identify tickers that are Pending only because
    // technical history was unavailable. Fetch history for the best ones,
    // save to cache, and re-scan them so they get real technical evaluations.
    // This progressively warms the cache without hammering the Massive API.
    const MAX_HISTORY_FETCHES_PER_SCAN = 4;
    let historyFetchedThisScan = 0;
    let historyFetch403 = 0;
    let historyFetch429 = 0;
    let cacheSaveFailures = 0;
    let stillPendingHistory = 0;
    const warmDiagnostics: { ticker: string; cachedBars: number; requiredBars: number; fetchAttempted: boolean; fetchStatus: string; finalBars: number }[] = [];

    const hasActiveTechnicalRuleForWarming =
      !noFilterMode &&
      !isSectionOff(profile, 'technical_rules_enabled') &&
      (
        profile.rsi_min != null ||
        profile.rsi_max != null ||
        profile.require_ma20_above_ma50 === true ||
        profile.require_ma50_above_ma200 === true ||
        profile.require_price_above_ma200 === true ||
        profile.exclude_downtrend_no_support === true
      );
    const technicalRulesNeedHistory = hasActiveTechnicalRuleForWarming;
    const supportDistanceNeedsHistory = !noFilterMode &&
      !isSectionOff(profile, 'support_distance_enabled') &&
      (profile.minimum_support_distance_pct != null || profile.maximum_support_distance_pct != null);
    const historyNeeded = technicalRulesNeedHistory || supportDistanceNeedsHistory;
    if (historyNeeded && scanMode !== 'analyze') {
      // Find tickers with pending technical data — candidates that have
      // technical_pending=true and no hard rejections (only pending reasons).
      // Only fetch history for tickers that survived non-technical screening.
      const pendingTickers = new Map<string, { ticker: string; bestCroi: number; bestOi: number; bestVolume: number; cachedBars: number }>();

      for (const c of candidates) {
        if (c.technical_pending && (!c.rejection_reasons || c.rejection_reasons.length === 0)) {
          const existing = pendingTickers.get(c.ticker);
          const croi = c.net_croi || 0;
          const oi = c.open_interest || 0;
          const vol = c.volume || 0;
          if (!existing || croi > existing.bestCroi) {
            pendingTickers.set(c.ticker, {
              ticker: c.ticker,
              bestCroi: croi,
              bestOi: Math.max(oi, existing?.bestOi || 0),
              bestVolume: Math.max(vol, existing?.bestVolume || 0),
              cachedBars: 0,
            });
          }
        }
      }

      // Check cache for each pending ticker to determine which actually need fetching
      const needsFetch: { ticker: string; bestCroi: number; bestOi: number; bestVolume: number; cachedBars: number }[] = [];
      for (const info of pendingTickers.values()) {
        const upper = info.ticker.toUpperCase();
        const cachedBars = await loadCachedHistory(upper, 260);
        info.cachedBars = cachedBars.length;
        const needsMA200 = technicalRulesNeedHistory && (profile.require_ma50_above_ma200 || profile.require_price_above_ma200);
        const requiredBars = needsMA200 ? 200 : 60;
        if (cachedBars.length < requiredBars) {
          needsFetch.push(info);
        } else {
          // Already has enough cache — shouldn't be pending, but log anyway
          warmDiagnostics.push({ ticker: upper, cachedBars: cachedBars.length, requiredBars, fetchAttempted: false, fetchStatus: 'cache_sufficient', finalBars: cachedBars.length });
        }
      }

      // Rank: tickers with CROI > 0 first (passing CROI/PC), then by OI, then volume
      needsFetch.sort((a, b) => {
        const aHasCroi = a.bestCroi > 0 ? 1 : 0;
        const bHasCroi = b.bestCroi > 0 ? 1 : 0;
        if (aHasCroi !== bHasCroi) return bHasCroi - aHasCroi;
        if (a.bestOi !== b.bestOi) return b.bestOi - a.bestOi;
        return b.bestVolume - a.bestVolume;
      });

      const toFetch = needsFetch.slice(0, MAX_HISTORY_FETCHES_PER_SCAN);
      const skippedPending = needsFetch.length - toFetch.length;
      stillPendingHistory = skippedPending;

      console.log(`[CacheWarm] ${needsFetch.length} tickers need history, fetching top ${toFetch.length}, ${skippedPending} will remain pending`);

      // Fetch history sequentially (respect Massive rate limits)
      for (const info of toFetch) {
        const upper = info.ticker.toUpperCase();
        const needsMA200 = technicalRulesNeedHistory && (profile.require_ma50_above_ma200 || profile.require_price_above_ma200);
        const requiredBars = needsMA200 ? 200 : 60;

        // Invalidate in-memory cache so getStockSnapshot actually fetches
        stockCache.delete(upper);

        // Fetch history with allowLiveHistory = true
        const snapshot = await getStockSnapshot(upper, apiKey, today, fmt, bulkPriceMap.get(upper) ?? bulkCachedPrices.get(upper)?.price ?? null, true);
        const fetchStatus = snapshot.historyHttpStatus === 200 ? 'ok' : `HTTP_${snapshot.historyHttpStatus ?? 'none'}`;
        const finalBars = snapshot.historicalBars.length;

        if (snapshot.historyHttpStatus === 403) historyFetch403++;
        if (snapshot.historyHttpStatus === 429) historyFetch429++;

        warmDiagnostics.push({ ticker: upper, cachedBars: info.cachedBars, requiredBars, fetchAttempted: true, fetchStatus, finalBars });

        if (finalBars >= 60) {
          historyFetchedThisScan++;
          console.log(`[CacheWarm] ${upper} | fetched ${finalBars} bars, re-scanning`);

          // Re-scan this ticker with the now-cached history.
          // The in-memory stockCache was populated by the getStockSnapshot call
          // above, so scanSymbol will find the bars without another Massive call.
          // Pass allowLiveHistory=false to avoid any further API calls.
          const price = bulkPriceMap.get(upper) ?? bulkCachedPrices.get(upper)?.price ?? null;
          const rerunResult = await scanSymbol(upper, '', profile, apiKey, openTickers, noFilterMode, today, fmt, false, false, price, false);

          if (rerunResult.chainStatus === 'success' || rerunResult.candidates.length > 0) {
            // Remove old candidates for this ticker and add the new ones
            for (let ci = candidates.length - 1; ci >= 0; ci--) {
              if (candidates[ci].ticker === upper) candidates.splice(ci, 1);
            }
            candidates.push(...rerunResult.candidates);

            // Update totals
            totalQualified += rerunResult.qualified;
            totalRejected += rerunResult.rejected;
            totalPending += rerunResult.pending;
            totalEvaluated += rerunResult.evaluated;
            if (rerunResult.historyBarCount && rerunResult.historyBarCount >= 200) tickersWith200PlusBars++;
            else if (rerunResult.historyBarCount && rerunResult.historyBarCount >= 60) tickersWith60PlusBars++;
          }
        } else {
          console.log(`[CacheWarm] ${upper} | fetch returned only ${finalBars} bars — still pending`);
          stillPendingHistory++;
        }
      }

      if (warmDiagnostics.length > 0) {
        console.log(`[CacheWarm] Diagnostics: ${JSON.stringify(warmDiagnostics)}`);
      }
    }

    // Send all contracts to the client. The client's selectBestContractPerTicker
    // helper handles one-contract-per-ticker display logic. Keeping all contracts
    // preserves them for Analyze Ticker / Candidate Detail views.
    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);
    const capped = candidates.slice(0, MAX_CANDIDATES * 10);

    // Build rejection reason breakdown from all candidates
    const rejectionBreakdown: Record<string, number> = {};
    for (const c of candidates) {
      if (c.rejection_reasons && Array.isArray(c.rejection_reasons)) {
        for (const reason of c.rejection_reasons) {
          rejectionBreakdown[reason] = (rejectionBreakdown[reason] || 0) + 1;
        }
      }
    }

    // Count unique qualified tickers
    const qualifiedTickers = new Set<string>();
    for (const c of candidates) {
      if (c.qualified) qualifiedTickers.add(c.ticker);
    }

    // Build closest-match debug: 20 nearest-miss contracts when qualified tickers = 0
    let closestMatches: any[] = [];
    if (totalQualified === 0 && capped.length > 0) {
      const notQualified = capped.filter((c) => !c.qualified);
      notQualified.sort((a, b) => {
        // Sort by fewest rejection reasons, then by highest net_croi
        const aReasons = (a.rejection_reasons || []).length;
        const bReasons = (b.rejection_reasons || []).length;
        if (aReasons !== bReasons) return aReasons - bReasons;
        return (b.net_croi || 0) - (a.net_croi || 0);
      });
      closestMatches = notQualified.slice(0, 20).map((c) => ({
        ticker: c.ticker,
        price: c.stock_price,
        strike: c.strike,
        rsi: null,
        ma20: null,
        ma50: null,
        ma200: null,
        primary_support: c.primary_support,
        support_distance: c.strike_distance_from_support,
        net_croi: c.net_croi,
        premium_capture: c.premium_capture,
        open_interest: c.open_interest,
        volume: c.volume,
        failed_rules: [...(c.rejection_reasons || []), ...(c.pending_reasons || [])],
      }));
    }

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
      pending: totalPending,
      pages_fetched: totalPagesFetched,
      contracts_found: totalContractsFound,
      rejection_breakdown: rejectionBreakdown,
      unique_qualified_tickers: qualifiedTickers.size,
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
        cache_save_failures: cacheSaveFailures,
        warm_diagnostics: warmDiagnostics,
      },
      closest_matches: closestMatches,
      support_distance_debug: supportDistanceDebugTotals,
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
