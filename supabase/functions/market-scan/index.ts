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

// ── BTC calculation: round DOWN to BTC increment so CROI stays at or above target ──
// collateral = strike * 100
// minimumRequiredNetProfit = collateral * (minimumNetCROI / 100)
// requiredGrossProfit = minimumRequiredNetProfit + roundTripCommission
// requiredPremiumCapturePerShare = requiredGrossProfit / 100
// highestBTC = suggestedSTO - requiredPremiumCapturePerShare
// Round BTC DOWN to the configured BTC increment.
function calcBtc(suggestedSTO: number, strike: number, p: Profile): {
  btc: number | null;
  netProfit: number;
  netCroi: number;
  pc: number;
} {
  const collateral = strike * 100;
  const minimumRequiredNetProfit = collateral * (p.min_net_croi / 100);
  const requiredGrossProfit = minimumRequiredNetProfit + p.round_trip_commission;
  const requiredPremiumCapturePerShare = requiredGrossProfit / 100;
  const highestBtc = suggestedSTO - requiredPremiumCapturePerShare;

  const increment = p.allow_penny_increments ? 0.01 : Math.max(0.01, p.btc_increment || 0.05);

  // Round DOWN to the increment
  let btc = Math.floor(highestBtc / increment) * increment;
  btc = parseFloat(btc.toFixed(2));

  // BTC must be > 0 to qualify
  if (btc <= 0) {
    return { btc: null, netProfit: 0, netCroi: 0, pc: 0 };
  }

  const netProfit = (suggestedSTO - btc) * 100 - p.round_trip_commission;
  const netCroi = collateral > 0 ? (netProfit / collateral) * 100 : 0;
  const pc = suggestedSTO > 0 ? ((suggestedSTO - btc) / suggestedSTO) * 100 : 0;

  return { btc, netProfit, netCroi, pc };
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
  source: 'ticker_snapshot' | 'daily_aggregates' | 'previous_close' | 'underlying_asset' | 'none';
  error: string | null;
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

// ── Shared stock snapshot: fetches history + current price with fallback order ──
// Fallback order:
//   1. Single-ticker snapshot endpoint (day.close — latest completed daily close)
//   2. Daily aggregates (range/1/day — historical OHLCV for technicals)
//   3. Previous-close endpoint
//   4. Newest valid cached daily close (from any source that returned bars)
// Only shows Unavailable if all sources fail. Never uses $0.00.
// Retries once on failure. Cached per-request.
async function getStockSnapshot(
  ticker: string,
  apiKey: string,
  today: Date,
  fmt: (d: Date) => string,
): Promise<StockSnapshot> {
  const upper = ticker.toUpperCase();
  const cached = stockCache.get(upper);
  if (cached) return cached;

  const start = new Date(today);
  start.setDate(start.getDate() - 420); // ~290 trading days, enough for 200 DMA

  let bars: HistoryBar[] = [];
  let currentPrice: number | null = null;
  let source: StockSnapshot['source'] = 'none';
  let error: string | null = null;

  // 1. Single-ticker snapshot — latest completed daily close + prevDay
  const snapPath = `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(upper)}`;
  let snapResult = await massiveFetch(snapPath, apiKey, upper, 'stock_ticker_snapshot');
  if (!snapResult.ok) {
    snapResult = await massiveFetch(snapPath, apiKey, upper, 'stock_ticker_snapshot_retry');
  }
  if (snapResult.ok) {
    const day = snapResult.data?.ticker?.day;
    const prevDay = snapResult.data?.ticker?.prevDay;
    // day.close = latest completed daily close
    if (day && Number(day.c) > 0) {
      currentPrice = Number(day.c);
      source = 'ticker_snapshot';
    } else if (prevDay && Number(prevDay.c) > 0) {
      currentPrice = Number(prevDay.c);
      source = 'ticker_snapshot';
    }
    // Build a minimal bar from the snapshot day for technical fallback if aggregates fail
    if (day && Number(day.c) > 0) {
      const d = day;
      bars = [{
        date: d.t ? new Date(d.t).toISOString().slice(0, 10) : fmt(today),
        open: Number(d.o || d.c || 0), high: Number(d.h || d.c || 0),
        low: Number(d.l || d.c || 0), close: Number(d.c), volume: Number(d.v || 0),
      }];
    }
  } else {
    error = `Snapshot HTTP ${snapResult.status}: ${snapResult.body.slice(0, 200)}`;
  }

  // 2. Daily aggregates — historical OHLCV for technical calculations
  const histPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/range/1/day/${fmt(start)}/${fmt(today)}?adjusted=true&sort=asc&limit=50000`;
  let histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates');
  if (!histResult.ok) {
    histResult = await massiveFetch(histPath, apiKey, upper, 'stock_aggregates_retry');
  }
  if (histResult.ok) {
    const histBars = (histResult.data?.results || []).map((b: any) => ({
      date: new Date(b.t).toISOString().slice(0, 10),
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
    })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);
    if (histBars.length) {
      bars = histBars; // Replace snapshot-only bar with full history
      // If snapshot didn't give a price, use latest aggregate close
      if (currentPrice === null) {
        currentPrice = Number(histBars.at(-1)!.close);
        source = 'daily_aggregates';
      }
    }
  } else if (!error) {
    error = `Aggregates HTTP ${histResult.status}: ${histResult.body.slice(0, 200)}`;
  }

  // 3. Fallback: previous-close endpoint (if still no price or bars)
  if (currentPrice === null || bars.length < 20) {
    const prevPath = `/v2/aggs/ticker/${encodeURIComponent(upper)}/prev?adjusted=true`;
    let prevResult = await massiveFetch(prevPath, apiKey, upper, 'stock_previous_close');
    if (!prevResult.ok) {
      prevResult = await massiveFetch(prevPath, apiKey, upper, 'stock_previous_close_retry');
    }
    if (prevResult.ok) {
      const prevBars = (prevResult.data?.results || []).map((b: any) => ({
        date: b.t ? new Date(b.t).toISOString().slice(0, 10) : fmt(today),
        open: Number(b.o || b.c || 0), high: Number(b.h || b.c || 0), low: Number(b.l || b.c || 0), close: Number(b.c || 0), volume: Number(b.v || 0),
      })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0);
      if (prevBars.length && currentPrice === null) {
        currentPrice = Number(prevBars.at(-1)!.close);
        source = 'previous_close';
      }
      // Merge any additional bars (won't help 200 DMA but ensures some data)
      if (prevBars.length && bars.length < 20) {
        const existingDates = new Set(bars.map((b) => b.date));
        for (const pb of prevBars) {
          if (!existingDates.has(pb.date)) bars.push(pb);
        }
      }
    } else if (!error) {
      error = `Previous-close HTTP ${prevResult.status}: ${prevResult.body.slice(0, 200)}`;
    }
  }

  // 4. Final fallback: newest cached valid daily close (already captured above)
  if (currentPrice === null && bars.length) {
    currentPrice = Number(bars.at(-1)!.close);
    source = source === 'none' ? 'daily_aggregates' : source;
  }

  const snapshot: StockSnapshot = { ticker: upper, currentPrice, historicalBars: bars, source, error };
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
  const snapshot = await getStockSnapshot(symbol, apiKey, today, fmt);
  let bars = snapshot.historicalBars;
  let stockPrice: number | null = snapshot.currentPrice;
  r.stockSource = snapshot.source;

  if (snapshot.error && !bars.length) {
    r.historyStatus = 'error';
    r.historyError = snapshot.error;
  } else if (bars.length >= 20) {
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
  let trendClass = technicalDataAvailable ? trend(bars) : 'Unavailable';

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
    r.evaluated++;
    if (qualified) r.qualified++; else r.rejected++;

    const premiumSourceOut = premiumSource as string;

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
      const finalQualified = reasons.length === 0;

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
        qualified: finalQualified, pass_fail: passFail,
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
    if (mode === 'analyze') {
      const ticker = String(body.ticker || '').toUpperCase().trim();
      if (!ticker) return json({ success: false, error: 'Missing ticker for analyze mode' });

      console.log(`[Analyze] Analyzing ${ticker}`);
      const result = await scanSymbol(ticker, ticker, profile, apiKey, openTickers, noFilterMode, today, fmt, true, true);

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
        technical_warning: result.technicalDataAvailable ? null : 'Historical price data was unavailable or insufficient; support/trend rules were not used to reject contracts.',
        technical: result.technical || null,
        qualifies: qualifying.length > 0,
        best_contract: bestContract,
        other_qualifying_contracts: qualifying.slice(1),
        all_qualifying_contracts: qualifying,
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
          return scanSymbol(sym.ticker, sym.company_name || '', profile, apiKey, openTickers, noFilterMode, today, fmt, isVerbose, false)
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

    // ── Apply max strikes per ticker limit ──
    // Each ticker's candidates are ranked (qualified first, then by spread, then CROI)
    // and only the top N are kept. This ensures diversity across tickers in the results.
    const maxStrikesPerTicker = Math.max(1, Math.floor(profile.max_strikes_per_ticker || 1));
    if (maxStrikesPerTicker < candidates.length) {
      const byTicker = new Map<string, any[]>();
      for (const c of candidates) {
        const arr = byTicker.get(c.ticker) || [];
        arr.push(c);
        byTicker.set(c.ticker, arr);
      }
      const limited: any[] = [];
      for (const [, arr] of byTicker) {
        arr.sort((a, b) =>
          Number(b.qualified) - Number(a.qualified) ||
          a.spread_pct - b.spread_pct ||
          b.net_croi - a.net_croi
        );
        limited.push(...arr.slice(0, maxStrikesPerTicker));
      }
      candidates.length = 0;
      candidates.push(...limited);
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
