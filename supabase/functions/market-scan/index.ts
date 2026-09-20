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
  const rows = await supabaseSelect('scan_universe', 'symbol,company_name', 'enabled=eq.true&order=symbol');
  return (rows || []).map((r: any) => ({ ticker: String(r.symbol).toUpperCase(), company_name: r.company_name || null }));
}

async function fetchMarketUniverse(limit: number): Promise<{ ticker: string; company_name: string | null }[]> {
  const rows = await supabaseSelect('market_universe', 'ticker,company_name', 'active=eq.true&optionable=eq.true&order=ticker');
  const mapped = (rows || []).map((r: any) => ({ ticker: String(r.ticker).toUpperCase(), company_name: r.company_name || null }));
  const shuffled = mapped.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
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
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low <= bars[i-1].low && bars[i].low <= bars[i-2].low && bars[i].low <= bars[i+1].low && bars[i].low <= bars[i+2].low) {
      lows.push(bars[i].low);
    }
  }
  return lows.sort((a, b) => b - a);
}

function calcPrimarySupport(bars: HistoryBar[], price: number): number {
  const lows = findSwingLows(bars.slice(-90));
  const below = lows.filter((x) => x < price);
  return below[0] || Math.min(...bars.slice(-20).map((b) => b.low));
}

function calcSecondarySupport(bars: HistoryBar[], primarySupport: number): number {
  const lows = findSwingLows(bars.slice(-90));
  const below = lows.filter((x) => x < primarySupport);
  return below[0] || primarySupport * 0.95;
}

function findResistance(bars: HistoryBar[]): number {
  const recent = bars.slice(-50);
  let max = 0;
  for (const b of recent) { if (b.high > max) max = b.high; }
  return max;
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
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
  const rr = rsi(closes);
  if (price > ma20 && ma20 > ma50 && ma50 > ma200) return 'Bullish';
  if (price > ma20 && ma20 >= ma50) return 'Improving';
  if (price > ma20 && rr >= 40) return 'Rebound';
  if (Math.abs(price - ma20) / Math.max(price, 0.01) < 0.03) return 'Stabilizing';
  if (price >= ma50 * 0.98) return 'Sideways';
  return 'Downtrend';
}

function optimize(sto: number, strike: number, p: Profile, penny = true) {
  const increment = penny && p.allow_penny_increments ? 0.01 : Math.max(0.01, p.btc_increment || 0.05);
  let best: null | { btc: number; netProfit: number; netCroi: number; pc: number } = null;
  for (let btc = increment; btc < sto; btc += increment) {
    const px = Number(btc.toFixed(2));
    const netProfit = (sto - px) * 100 - p.round_trip_commission;
    const netCroi = netProfit / (strike * 100) * 100;
    const pc = (sto - px) / sto * 100;
    if (netCroi >= p.min_net_croi && pc <= p.max_premium_capture) {
      if (!best || px > best.btc) best = { btc: px, netProfit, netCroi, pc };
    }
  }
  return best;
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

// ── Quote extraction: precisely categorize what's missing ──
function extractQuote(c: any): {
  hasLastQuote: boolean;
  bid: number | null;  // null = field missing, 0 = illiquid
  ask: number | null;  // null = field missing, 0 = illiquid
  mid: number;
} {
  const lq = c?.last_quote;
  const hasLastQuote = lq != null && typeof lq === 'object';
  const rawBid = hasLastQuote ? lq.bid : undefined;
  const rawAsk = hasLastQuote ? lq.ask : undefined;
  const bid = (rawBid === undefined || rawBid === null) ? null : Number(rawBid);
  const ask = (rawAsk === undefined || rawAsk === null) ? null : Number(rawAsk);

  // Calculate midpoint: prefer Massive's midpoint, fall back to (bid+ask)/2
  let mid = 0;
  const lqMid = hasLastQuote ? Number(lq.midpoint) : 0;
  if (lqMid > 0) {
    mid = lqMid;
  } else if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    mid = (bid + ask) / 2;
  }
  return { hasLastQuote, bid, ask, mid };
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
  source: 'grouped_daily' | 'daily_aggregates' | 'previous_close' | 'underlying_asset' | 'cached_history' | 'none';
  error: string | null;
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

// ── Bulk grouped stock prices ──
// One Massive API call for ALL U.S. stock prices for the latest trading day.
// Returns Map<ticker, {open, high, low, close, volume}>. Falls back up to 7 days.
async function fetchGroupedStockPrices(
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
): Promise<{ priceMap: Map<string, { open: number; high: number; low: number; close: number; volume: number }>; tradingDate: string | null; error: string | null }> {
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = fmt(d);
    const path = `/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`;
    const result = await massiveFetch(path, apiKey, 'GROUPED', `stock_grouped_${dateStr}`);

    if (result.ok) {
      const results = result.data?.results || [];
      if (results.length > 0) {
        console.log(`[Grouped] date=${dateStr} | stocks=${results.length} | SOFI=${results.some((r: any) => r.T === 'SOFI')} | CMCSA=${results.some((r: any) => r.T === 'CMCSA')} | HUT=${results.some((r: any) => r.T === 'HUT')}`);
        const priceMap = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
        for (const r of results) {
          const close = Number(r.c);
          if (Number.isFinite(close) && close > 0) {
            priceMap.set(String(r.T).toUpperCase(), {
              open: Number(r.o || 0), high: Number(r.h || 0), low: Number(r.l || 0),
              close, volume: Number(r.v || 0),
            });
          }
        }
        return { priceMap, tradingDate: dateStr, error: null };
      }
    } else if (result.status === 429) {
      console.log(`[Grouped] HTTP 429 on ${dateStr}, stopping (rate limited)`);
      return { priceMap: new Map(), tradingDate: null, error: `Grouped HTTP 429: rate limited` };
    } else if (result.status === 401 || result.status === 403) {
      console.log(`[Grouped] HTTP ${result.status} on ${dateStr}, stopping (entitlement)`);
      return { priceMap: new Map(), tradingDate: null, error: `Grouped HTTP ${result.status}: ${result.body.slice(0, 200)}` };
    }
    // No results for this date (weekend/holiday) — try previous day
  }
  return { priceMap: new Map(), tradingDate: null, error: 'No grouped stock data found in last 7 days' };
}

// ── Supabase stock_history_cache helpers ──
async function supabaseUpsert(ticker: string, bars: HistoryBar[]): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey || bars.length === 0) return;
  const rows = bars.map((b) => ({
    ticker: ticker.toUpperCase(), trade_date: b.date,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    updated_at: new Date().toISOString(),
  }));
  // Upsert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    try {
      await fetch(`${supabaseUrl}/rest/v1/stock_history_cache?on_conflict=ticker,trade_date`, {
        method: 'POST',
        headers: {
          apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,upsert=true',
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      console.error(`[StockCache] upsert failed for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function supabaseLoadHistory(ticker: string): Promise<HistoryBar[]> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return [];
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/stock_history_cache?select=trade_date,open,high,low,close,volume&ticker=eq.${ticker.toUpperCase()}&order=trade_date.asc&limit=500`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!resp.ok) return [];
    const rows = await resp.json();
    return (rows || []).map((r: any) => ({
      date: r.trade_date, open: Number(r.open || 0), high: Number(r.high || 0),
      low: Number(r.low || 0), close: Number(r.close), volume: Number(r.volume || 0),
    })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);
  } catch {
    return [];
  }
}

async function supabaseLoadHistoryBatch(tickers: string[]): Promise<Map<string, HistoryBar[]>> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const result = new Map<string, HistoryBar[]>();
  if (!supabaseUrl || !serviceKey || tickers.length === 0) return result;
  try {
    // Use `in` filter for batch select
    const tickersCsv = tickers.map((t) => `'${t.toUpperCase()}'`).join(',');
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/stock_history_cache?select=ticker,trade_date,open,high,low,close,volume&ticker=in.(${tickersCsv})&order=ticker,trade_date.asc&limit=10000`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!resp.ok) return result;
    const rows = await resp.json();
    for (const r of rows || []) {
      const t = String(r.ticker).toUpperCase();
      if (!result.has(t)) result.set(t, []);
      const close = Number(r.close);
      if (Number.isFinite(close) && close > 0) {
        result.get(t)!.push({
          date: r.trade_date, open: Number(r.open || 0), high: Number(r.high || 0),
          low: Number(r.low || 0), close, volume: Number(r.volume || 0),
        });
      }
    }
  } catch (e) {
    console.error(`[StockCache] batch load failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

// ── Fetch historical aggregates for a single ticker (1 Massive API call) ──
// No retries on 401/403/429. Saves results to stock_history_cache.
async function fetchAndCacheHistory(
  ticker: string,
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
): Promise<HistoryBar[]> {
  const upper = ticker.toUpperCase();
  const start = new Date(today);
  start.setDate(start.getDate() - 420); // ~290 trading days for 200 DMA
  const path = `/v2/aggs/ticker/${encodeURIComponent(upper)}/range/1/day/${fmt(start)}/${fmt(today)}?adjusted=true&sort=asc&limit=50000`;
  const result = await massiveFetch(path, apiKey, upper, 'stock_aggregates');

  if (!result.ok) {
    console.log(`[History] ${upper} | HTTP ${result.status} — no retry (${result.status === 429 ? 'rate limited' : result.status === 403 ? 'entitlement' : 'error'})`);
    return [];
  }

  const bars = (result.data?.results || []).map((b: any) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
  })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);

  // Persist to Supabase cache (fire and forget)
  supabaseUpsert(upper, bars).catch((e) => console.error(`[History] ${upper} cache save failed: ${e}`));

  return bars;
}

// ── Determine which tickers need history refresh ──
// A ticker needs refresh if: no cached data, or latest cached bar is older than 2 days.
function needsHistoryRefresh(ticker: string, cachedBars: HistoryBar[] | undefined): boolean {
  if (!cachedBars || cachedBars.length < 20) return true;
  const latest = cachedBars.at(-1)!;
  const latestDate = new Date(latest.date);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  return latestDate < twoDaysAgo;
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
  stockPrice: number | null,
  bars: HistoryBar[],
  stockSource: string,
): Promise<ScanSymbolResult> {
  const r: ScanSymbolResult = {
    candidates: [],
    chainStatus: 'no_options',
    putsReturned: 0, filteredByExpiration: 0, filteredByStrike: 0,
    missingStrike: 0, missingExpiration: 0, missingLastQuote: 0,
    missingBid: 0, zeroBid: 0, missingAsk: 0, zeroAsk: 0, askLtBid: 0, otherInvalid: 0,
    validQuotes: 0, contractsAwaitingQuotes: 0, evaluated: 0, qualified: 0, rejected: 0, pagesFetched: 0,
  };

  r.stockSource = stockSource;

  if (bars.length >= 20) {
    r.historyStatus = 'success';
  } else if (bars.length > 0) {
    r.historyStatus = 'fallback';
  } else {
    r.historyStatus = 'empty';
  }

  const technicalDataAvailable = bars.length >= 20;
  r.technicalDataAvailable = technicalDataAvailable;

  // Stock price filter (if Order & Strike section enabled). If even the previous
  // close is unavailable, defer this filter until an underlying price can be read
  // from the option-chain snapshot.
  // This filters the underlying stock price, independent of put strike price.
  // A $71 stock with max put strike $25 is still allowed — stock price and
  // strike price are separate filters.
  if (stockPrice !== null && stockPrice > 0 && !noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
    if (profile.minimum_stock_price !== null && profile.minimum_stock_price !== undefined && stockPrice < profile.minimum_stock_price) {
      if (verbose) console.log(`[VERBOSE] ${symbol} | stock price ${stockPrice} < minimum ${profile.minimum_stock_price}, skipping symbol`);
      r.chainStatus = 'no_options';
      return r;
    }
    if (profile.maximum_stock_price !== null && profile.maximum_stock_price !== undefined && stockPrice > profile.maximum_stock_price) {
      if (verbose) console.log(`[VERBOSE] ${symbol} | stock price ${stockPrice} > maximum ${profile.maximum_stock_price}, skipping symbol`);
      r.chainStatus = 'no_options';
      return r;
    }
  }

  let primarySupport: number | null = technicalDataAvailable && stockPrice !== null && stockPrice > 0 ? calcPrimarySupport(bars, stockPrice) : null;
  let secondarySupport: number | null = technicalDataAvailable && primarySupport !== null ? calcSecondarySupport(bars, primarySupport) : null;
  let resistance: number | null = technicalDataAvailable ? findResistance(bars) : null;
  let trendClass = technicalDataAvailable ? trend(bars) : 'Pending History';

  r.stockPrice = stockPrice;
  r.primarySupport = primarySupport;
  r.secondarySupport = secondarySupport;
  r.resistance = resistance;
  r.trendClass = trendClass;

  if (technicalDataAvailable) {
    const closes = bars.map((b) => b.close);
    const m = macd(closes);
    const bb = bollingerBands(closes);
    r.technical = {
      rsi: Number(rsi(closes).toFixed(1)),
      ma20: Number(sma(closes, 20).toFixed(2)),
      ma50: Number(sma(closes, 50).toFixed(2)),
      ma200: Number(sma(closes, 200).toFixed(2)),
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

  // Final stock-price fallback from the option snapshot's underlying_asset object.
  // This is contract-discovery data, not an invented price.
  if (stockPrice === null && allRawContracts.length) {
    const underlyingPrice = allRawContracts
      .map((c: any) => Number(c?.underlying_asset?.price || c?.underlying_asset?.value || 0))
      .find((v: number) => Number.isFinite(v) && v > 0) || 0;
    if (underlyingPrice > 0) {
      stockPrice = underlyingPrice;
      r.stockPrice = stockPrice;
      r.stockSource = 'underlying_asset';
    }
  }

  // Apply deferred underlying-price filters after all real price fallbacks were tried.
  if (stockPrice !== null && stockPrice > 0 && !noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
    if (profile.minimum_stock_price !== null && profile.minimum_stock_price !== undefined && stockPrice < profile.minimum_stock_price) {
      r.chainStatus = 'no_options';
      return r;
    }
    if (profile.maximum_stock_price !== null && profile.maximum_stock_price !== undefined && stockPrice > profile.maximum_stock_price) {
      r.chainStatus = 'no_options';
      return r;
    }
  }

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

  // ── Contract evaluation — Massive is discovery-only, quotes are optional ──
  // Qualification uses only non-quote rules (strike, DTE, trend, support, OI, existing position).
  // Quote fields (bid/ask/mid/spread/STO/BTC/CROI/PC) are included when available but
  // never required — contracts without quotes are still listed as candidates.
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

    // Extract quote data if available (never fabricated)
    const { hasLastQuote, bid, ask, mid } = extractQuote(c);
    const hasValidQuote = hasLastQuote && bid !== null && bid > 0 && ask !== null && ask > 0 && ask >= bid;

    // ── Non-quote qualification rules (applied regardless of quote availability) ──
    const reasons: string[] = [];
    if (!noFilterMode) {
      if (profile.exclude_existing_positions && openTickers.includes(symbol)) reasons.push('Existing position');
      if (!isSectionOff(profile, 'order_strike_enabled') && strike > profile.max_strike) reasons.push('Strike too high');
      if (!isSectionOff(profile, 'technical_rules_enabled') && technicalDataAvailable) {
        if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && primarySupport !== null && strike >= primarySupport) reasons.push('Downtrend without support');
        if (primarySupport !== null && primarySupport > 0) {
          const supportDistPct = ((primarySupport - strike) / primarySupport) * 100;
          if (supportDistPct < profile.minimum_support_distance_pct) reasons.push('Support distance too low');
        }
      }
      // OI and volume rules are non-quote — they come from the contract itself
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        if (oi < profile.min_target_oi) reasons.push('OI too low');
        if (volume < 10) reasons.push('Insufficient liquidity');
      }
    }
    const qualified = reasons.length === 0;
    r.evaluated++;
    if (qualified) r.qualified++; else r.rejected++;

    // Track quote availability
    if (hasValidQuote) {
      r.validQuotes++;
    } else {
      r.contractsAwaitingQuotes++;
    }

    // Financial calculations only when real bid/ask exist
    let sp = 0, stoPrice = 0, btcPrice = 0, netProfit = 0, netCroi = 0, pc = 0, breakeven = 0;
    let croiOptimized = false;
    if (hasValidQuote) {
      sp = spreadPct(bid!, ask!);
      stoPrice = mid;
      const best = optimize(mid, strike, profile, true);
      if (best) {
        btcPrice = best.btc;
        netProfit = best.netProfit;
        netCroi = best.netCroi;
        pc = best.pc;
        croiOptimized = true;
      }
      breakeven = strike - mid;

      // Filter Strikes by CROI: when ON and a quote is available, reject strikes
      // where no BTC exit satisfies both Minimum Net CROI and Maximum Premium Capture.
      // preferred_croi_max is informational only — never used to reject.
      if (!noFilterMode && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
        if (!croiOptimized) {
          reasons.push('CROI too low');
          if (qualified) { r.qualified--; r.rejected++; }
        }
      }

      // Spread rule only applies when a quote exists
      if (!noFilterMode && !isSectionOff(profile, 'spread_enabled') && sp > profile.max_spread_pct) {
        if (!reasons.includes('Spread too wide')) {
          reasons.push('Spread too wide');
          if (qualified) { r.qualified--; r.rejected++; }
        }
      }
    }

    if (analyzeMode) {
      const passFail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[] = [];
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
            const distOk = supportDistPct >= profile.minimum_support_distance_pct;
            passFail.push({ rule: `Support distance >= ${profile.minimum_support_distance_pct}% (${supportDistPct.toFixed(1)}%)`, pass: distOk, status: distOk ? 'pass' : 'fail' });
          } else {
            passFail.push({ rule: 'Support distance not evaluated — support unavailable', pass: true, status: 'not_evaluated' });
          }
        } else {
          passFail.push({ rule: 'Technical history unavailable — not used to reject contract', pass: true, status: 'not_evaluated' });
          passFail.push({ rule: 'Support distance not evaluated — support unavailable', pass: true, status: 'not_evaluated' });
        }
      }
      if (hasValidQuote && !isSectionOff(profile, 'spread_enabled')) {
        const spreadOk = sp <= profile.max_spread_pct;
        passFail.push({ rule: `Spread acceptable (<= ${profile.max_spread_pct}%)`, pass: spreadOk, status: spreadOk ? 'pass' : 'fail' });
      }
      if (hasValidQuote && !isSectionOff(profile, 'croi_pc_enabled')) {
        if (profile.filter_strikes_croi) {
          const croiOk = croiOptimized;
          passFail.push({ rule: `Filter Strikes by CROI: Net CROI >= ${profile.min_net_croi}% & PC <= ${profile.max_premium_capture}%`, pass: croiOk, status: croiOk ? 'pass' : 'fail' });
        } else {
          const croiOk = netCroi >= profile.min_net_croi;
          const pcOk = pc <= profile.max_premium_capture;
          passFail.push({ rule: `Net CROI >= ${profile.min_net_croi}%`, pass: croiOk, status: croiOk ? 'pass' : 'fail' });
          passFail.push({ rule: `Premium Capture <= ${profile.max_premium_capture}%`, pass: pcOk, status: pcOk ? 'pass' : 'fail' });
        }
      }
      if (!hasValidQuote && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
        passFail.push({ rule: 'Filter Strikes by CROI — Quote required', pass: true, status: 'not_evaluated' });
      }
      if (!hasValidQuote) {
        passFail.push({ rule: 'Quote data — enter manually for CROI / PC', pass: true, status: 'not_evaluated' });
      }
      // Massive is used for contract discovery. Missing quote data is not a failure.
      // Quote-dependent rules become pending until the user enters a quote.
      const finalQualified = reasons.length === 0;

      analyses.push({
        strike, expiration, dte,
        bid: hasValidQuote ? Number(bid!.toFixed(2)) : 0,
        ask: hasValidQuote ? Number(ask!.toFixed(2)) : 0,
        mid: hasValidQuote ? Number(mid.toFixed(2)) : 0,
        spread_pct: hasValidQuote ? Number(sp.toFixed(1)) : 0,
        iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        suggested_sto: hasValidQuote ? Number(stoPrice.toFixed(2)) : 0,
        suggested_btc: hasValidQuote ? Number(btcPrice.toFixed(2)) : 0,
        net_profit: hasValidQuote ? Number(netProfit.toFixed(2)) : 0,
        net_croi: hasValidQuote ? Number(netCroi.toFixed(2)) : 0,
        premium_capture: hasValidQuote ? Number(pc.toFixed(1)) : 0,
        breakeven: hasValidQuote ? Number(breakeven.toFixed(2)) : 0,
        qualified: finalQualified, pass_fail: passFail,
        has_quotes: hasValidQuote,
        strike_distance_from_stock: stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null,
        strike_distance_from_support: primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null,
      });
    } else {
      r.candidates.push({
        scan_date: fmt(today), ticker: symbol, company_name: companyName || symbol,
        stock_price: stockPrice !== null && stockPrice > 0 ? Number(stockPrice.toFixed(2)) : null,
        stock_source: r.stockSource || 'none',
        strike, expiration, dte,
        bid: hasValidQuote ? Number(bid!.toFixed(2)) : 0,
        ask: hasValidQuote ? Number(ask!.toFixed(2)) : 0,
        mid: hasValidQuote ? Number(mid.toFixed(2)) : 0,
        spread_pct: hasValidQuote ? Number(sp.toFixed(1)) : 0,
        iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        trend_classification: trendClass, primary_support: primarySupport !== null ? Number(primarySupport.toFixed(2)) : null,
        suggested_sto: hasValidQuote ? Number(stoPrice.toFixed(2)) : 0,
        suggested_btc: hasValidQuote ? Number(btcPrice.toFixed(2)) : 0,
        net_profit: hasValidQuote ? Number(netProfit.toFixed(2)) : 0,
        net_croi: hasValidQuote ? Number(netCroi.toFixed(2)) : 0,
        premium_capture: hasValidQuote ? Number(pc.toFixed(1)) : 0,
        breakeven: hasValidQuote ? Number(breakeven.toFixed(2)) : 0,
        qualified, rejection_reasons: reasons,
        strategy_profile_id: profile.id,
        strike_distance_from_stock: stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null,
        strike_distance_from_support: primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null,
        has_quotes: hasValidQuote,
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

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) return json({ success: false, provider: 'Massive', error: 'MASSIVE_API_KEY is not configured.' });

    const body = await req.json().catch(() => ({}));
    const profile = body.profile as Profile | undefined;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());
    const mode: string = body.mode || 'discovery';
    const scanMode: 'discovery' | 'universe' = body.scanMode === 'universe' ? 'universe' : 'discovery';

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

    // ── ANALYZE MODE: deep-analyze a single ticker ──
    // Single ticker: OK to make 1 historical aggregates API call.
    // No stock snapshot call. Use grouped cache if available, else aggregates.
    if (mode === 'analyze') {
      const ticker = String(body.ticker || '').toUpperCase().trim();
      if (!ticker) return json({ success: false, error: 'Missing ticker for analyze mode' });

      console.log(`[Analyze] Analyzing ${ticker}`);

      // 1. Try grouped bulk prices (1 API call, cached from discovery if available)
      let stockPrice: number | null = null;
      let stockSource = 'none';
      const grouped = await fetchGroupedStockPrices(apiKey, today, fmt);
      if (grouped.priceMap.has(ticker)) {
        stockPrice = grouped.priceMap.get(ticker)!.close;
        stockSource = 'grouped_daily';
      }

      // 2. Fetch historical aggregates (1 API call) for technicals + fallback price
      let bars: HistoryBar[] = [];
      try {
        bars = await fetchAndCacheHistory(ticker, apiKey, today, fmt);
      } catch (e) {
        console.error(`[Analyze] history fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // If no grouped price, use latest aggregate close
      if (stockPrice === null && bars.length) {
        stockPrice = Number(bars.at(-1)!.close);
        stockSource = 'daily_aggregates';
      }

      // 3. Try cached history from Supabase if aggregates didn't return enough
      if (bars.length < 20) {
        const cachedBars = await supabaseLoadHistory(ticker);
        if (cachedBars.length > bars.length) {
          bars = cachedBars;
          if (stockPrice === null && bars.length) {
            stockPrice = Number(bars.at(-1)!.close);
            stockSource = 'cached_history';
          }
        }
      }

      const result = await scanSymbol(ticker, ticker, profile, apiKey, openTickers, noFilterMode, today, fmt, true, true, stockPrice, bars, stockSource);

      if (result.chainStatus === 'api_error' || result.chainStatus === 'unauthorized' || result.chainStatus === 'rate_limited' || result.chainStatus === 'network_error') {
        return json({
          success: false, stage: 'options_snapshot', provider: 'Massive', symbol: ticker,
          massiveStatus: result.chainStatus === 'api_error' ? 500 : result.chainStatus === 'unauthorized' ? 401 : result.chainStatus === 'rate_limited' ? 429 : 0,
          massiveBody: `Chain status: ${result.chainStatus}`,
        });
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
        technical_warning: result.technicalDataAvailable ? null : 'Historical price data is still being loaded. Trend and support will show once history is available.',
        technical: result.technical || null,
        qualifies: qualifying.length > 0,
        best_contract: bestContract,
        other_qualifying_contracts: qualifying.slice(1),
        all_qualifying_contracts: qualifying,
        all_contracts_count: analyses.length,
        qualifying_count: qualifying.length,
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
    // Architecture for Stocks Basic (5 API calls/min):
    //   1. ONE grouped request for all stock prices
    //   2. Load cached historical bars from Supabase (no API calls)
    //   3. Calculate technicals where cache exists
    //   4. Return candidates immediately with stock prices populated
    //   5. Queue max 4 history refreshes (leaving 1 call for other operations)
    // Stock price never depends on history. Trend/Support show 'Pending History' if no cache.
    let symbolList: { ticker: string; company_name: string | null }[];
    if (scanMode === 'universe') {
      symbolList = await fetchScanUniverse();
      console.log(`[ScanMode=universe] Loaded ${symbolList.length} enabled symbols`);
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

    // Step 1: Bulk grouped stock prices — ONE API call for all tickers
    console.log('[Discovery] Fetching bulk grouped stock prices...');
    const grouped = await fetchGroupedStockPrices(apiKey, today, fmt);
    console.log(`[Discovery] Grouped prices: ${grouped.priceMap.size} stocks | tradingDate=${grouped.tradingDate} | error=${grouped.error || 'none'}`);

    // Step 2: Load cached historical bars from Supabase (no API calls)
    const allTickers = symbolList.map((s) => s.ticker.toUpperCase());
    console.log(`[Discovery] Loading cached history for ${allTickers.length} tickers from Supabase...`);
    const historyCache = await supabaseLoadHistoryBatch(allTickers);
    console.log(`[Discovery] Cached history loaded: ${historyCache.size} tickers have data`);

    // Step 3: Determine which tickers need history refresh (max 4 API calls)
    const tickersNeedingRefresh: string[] = [];
    for (const ticker of allTickers) {
      const cached = historyCache.get(ticker);
      if (needsHistoryRefresh(ticker, cached)) {
        tickersNeedingRefresh.push(ticker);
      }
    }
    // Limit to 4 refreshes per request (Stocks Basic: 5 calls/min, 1 reserved for grouped)
    const refreshBatch = tickersNeedingRefresh.slice(0, 4);
    console.log(`[Discovery] ${tickersNeedingRefresh.length} tickers need history refresh, refreshing ${refreshBatch.length} this request`);

    // Step 4: Refresh history for the selected batch (fire-and-forget, don't block the scan)
    if (refreshBatch.length > 0) {
      // Use EdgeRuntime.waitUntil if available, otherwise just fire
      const refreshPromise = (async () => {
        for (const ticker of refreshBatch) {
          try {
            const bars = await fetchAndCacheHistory(ticker, apiKey, today, fmt);
            console.log(`[Discovery] History refresh: ${ticker} -> ${bars.length} bars`);
            // Update the in-memory cache map so this scan benefits
            if (bars.length > 0) {
              historyCache.set(ticker, bars);
            }
          } catch (e) {
            console.error(`[Discovery] History refresh failed for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })();
      // Don't await — let it run in background. But wait a short time for first ticker
      // so at least one ticker gets fresh data in this scan.
      try {
        await Promise.race([refreshPromise, new Promise((r) => setTimeout(r, 3000))]);
      } catch { /* timeout is fine */ }
    }

    // Step 5: Main scan — pass pre-fetched stock price + cached bars to each scanSymbol
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
          const upperTicker = sym.ticker.toUpperCase();
          const groupedPrice = grouped.priceMap.get(upperTicker);
          const stockPrice = groupedPrice ? groupedPrice.close : null;
          const stockSource = groupedPrice ? 'grouped_daily' : 'none';
          const bars = historyCache.get(upperTicker) || [];
          return scanSymbol(sym.ticker, sym.company_name || '', profile, apiKey, openTickers, noFilterMode, today, fmt, isVerbose, false, stockPrice, bars, stockSource)
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

    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);
    const capped = candidates.slice(0, MAX_CANDIDATES * 2);

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
