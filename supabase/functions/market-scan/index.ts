// Supabase Edge Function: market-scan
// Requires secret: BARCHART_API_KEY
// Modes:
//   "discovery" — scan broad universe via Barchart getOptionsScreener
//   "universe"  — scan user's enabled scan_universe tickers via getEquityOptions
//   "analyze"   — deep-analyze a single ticker

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const BARCHART_BASE = 'https://ondemand.websol.barchart.com';
const MAX_SCREENER_PAGES = 10;
const MAX_CANDIDATES = 50;
const MAX_HISTORY_TICKERS = 4;

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

// ── Barchart API fetch helper ──
async function barchartFetch(
  endpoint: string,
  apiKey: string,
  params: Record<string, string>,
  symbol: string,
  stage: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const url = new URL(`${BARCHART_BASE}/${endpoint}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const ts = new Date().toISOString();
  console.log(`[Barchart] ${symbol} | stage=${stage} | GET ${endpoint} | ts=${ts}`);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    console.error(`[Barchart] ${symbol} | stage=${stage} | NETWORK ERROR: ${msg}`);
    return { ok: false, status: 0, body: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const bodyText = await response.text();
    const truncated = bodyText.slice(0, 500);
    console.error(`[Barchart] ${symbol} | stage=${stage} | HTTP ${response.status} | body: ${truncated}`);
    return { ok: false, status: response.status, body: truncated || response.statusText };
  }

  console.log(`[Barchart] ${symbol} | stage=${stage} | HTTP ${response.status} | OK`);

  try {
    const data = await response.json();
    const bcStatus = data?.status;
    if (bcStatus && bcStatus.code && bcStatus.code !== 200) {
      console.error(`[Barchart] ${symbol} | stage=${stage} | Barchart status ${bcStatus.code}: ${bcStatus.message || ''}`);
      if (bcStatus.code === 204) {
        return { ok: true, data: { status: bcStatus, results: [] } };
      }
      return { ok: false, status: response.status, body: `Barchart ${bcStatus.code}: ${bcStatus.message || ''}` };
    }
    return { ok: true, data };
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[Barchart] ${symbol} | stage=${stage} | JSON PARSE ERROR: ${msg}`);
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

// ── Date helpers ──
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtBarchartDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseExpirationDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const parts = s.split('/');
    const d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function calcDTE(expRaw: unknown, today: Date): number {
  const exp = parseExpirationDate(expRaw);
  if (!exp) return -1;
  const expDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((expDay.getTime() - todayDay.getTime()) / 86400000);
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

// ── Barchart getQuote: batch stock quotes ──
async function barchartGetQuote(
  apiKey: string,
  symbols: string[],
): Promise<{ priceMap: Map<string, { price: number; name: string | null }>; error: string | null }> {
  const priceMap = new Map<string, { price: number; name: string | null }>();
  // Barchart getQuote supports comma-separated symbols
  const symbolsCsv = symbols.join(',');
  const result = await barchartFetch('getQuote.json', apiKey, { symbols: symbolsCsv }, 'BATCH', 'getQuote');

  if (!result.ok) {
    return { priceMap, error: `getQuote HTTP ${result.status}: ${result.body.slice(0, 200)}` };
  }

  const results = result.data?.results || [];
  for (const q of results) {
    const symbol = String(q.symbol || '').toUpperCase();
    const lastPrice = Number(q.lastPrice);
    if (symbol && Number.isFinite(lastPrice) && lastPrice > 0) {
      priceMap.set(symbol, { price: lastPrice, name: q.name || null });
    }
  }

  console.log(`[getQuote] ${symbols.length} symbols requested, ${priceMap.size} prices returned`);
  return { priceMap, error: null };
}

// ── Barchart getHistory: fetch daily OHLCV bars for one ticker ──
async function barchartGetHistory(
  ticker: string,
  apiKey: string,
  today: Date,
): Promise<HistoryBar[]> {
  const upper = ticker.toUpperCase();
  const start = new Date(today);
  start.setDate(start.getDate() - 420); // ~290 trading days for 200 DMA
  const params = {
    symbol: upper,
    type: 'daily',
    startDate: fmtBarchartDate(start),
    endDate: fmtBarchartDate(today),
    order: 'asc',
    maxRecords: '500',
  };
  const result = await barchartFetch('getHistory.json', apiKey, params, upper, 'getHistory');

  if (!result.ok) {
    console.log(`[History] ${upper} | HTTP ${result.status} — no retry`);
    return [];
  }

  const results = result.data?.results || [];
  const bars: HistoryBar[] = results.map((r: any) => ({
    date: String(r.tradingDay || r.timestamp || '').slice(0, 10),
    open: Number(r.open || 0),
    high: Number(r.high || 0),
    low: Number(r.low || 0),
    close: Number(r.close || 0),
    volume: Number(r.volume || 0),
  })).filter((b: HistoryBar) => Number.isFinite(b.close) && b.close > 0 && b.date.length >= 10);

  supabaseUpsert(upper, bars).catch((e) => console.error(`[History] ${upper} cache save failed: ${e}`));
  return bars;
}

// ── Barchart getEquityOptions: fetch put option chain for one underlying ──
async function barchartGetEquityOptions(
  ticker: string,
  apiKey: string,
  profile: Profile,
  today: Date,
  noFilterMode: boolean,
): Promise<{ contracts: any[]; status: ChainStatus; error: string | null }> {
  const upper = ticker.toUpperCase();
  const params: Record<string, string> = {
    underlying_symbols: upper,
    type: 'Put',
    fields: 'bid,bidSize,ask,askSize,volume,openInterest,volatility,delta,gamma,theta,vega',
  };

  // Server-side expiration filter
  if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
    const minDte = profile.min_dte ?? 0;
    const minDate = new Date(today);
    minDate.setDate(minDate.getDate() + minDte);
    params.expirationDate = fmtDate(minDate);
  }

  const result = await barchartFetch('getEquityOptions.json', apiKey, params, upper, 'getEquityOptions');

  if (!result.ok) {
    const status = result.status === 401 || result.status === 403 ? 'unauthorized'
      : result.status === 429 ? 'rate_limited'
      : result.status === 0 ? 'network_error'
      : 'api_error';
    return { contracts: [], status, error: result.body };
  }

  const results = result.data?.results || [];
  // Barchart returns both calls and puts if type not filtered server-side; ensure puts only
  const puts = results.filter((r: any) => {
    const typeStr = String(r.type || '').toLowerCase();
    return typeStr === 'put' || typeStr === 'p';
  });

  console.log(`[getEquityOptions] ${upper} | results=${results.length} | puts=${puts.length}`);
  return { contracts: puts, status: puts.length > 0 ? 'success' : 'no_options', error: null };
}

// ── Barchart getOptionsScreener: market discovery ──
async function barchartGetOptionsScreener(
  apiKey: string,
  profile: Profile,
  today: Date,
  noFilterMode: boolean,
): Promise<{ options: any[]; error: string | null }> {
  const allOptions: any[] = [];
  const params: Record<string, string> = {
    instrumentType: 'stocks',
    optionType: 'put',
    fields: 'bid,ask,volume,openInterest,volatility,delta,gamma,theta,vega',
  };

  // Server-side DTE filter if Expiration section is ON
  if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
    const minDte = profile.min_dte ?? 0;
    params.minDTE = String(minDte);
  }

  // Server-side liquidity filters if Cycle & Liquidity is ON
  if (!noFilterMode && !isSectionOff(profile, 'cycle_liquidity_enabled')) {
    params.minOpenInterest = String(profile.min_target_oi);
    params.minVolume = '10';
  }

  params.limit = '100';

  for (let page = 1; page <= MAX_SCREENER_PAGES; page++) {
    params.page = String(page);
    const result = await barchartFetch('getOptionsScreener.json', apiKey, params, 'SCREENER', `screener_p${page}`);

    if (!result.ok) {
      if (allOptions.length > 0) {
        console.log(`[Screener] Page ${page} failed, returning ${allOptions.length} results so far`);
        break;
      }
      return { options: [], error: `Screener HTTP ${result.status}: ${result.body.slice(0, 200)}` };
    }

    const results = result.data?.results || [];
    if (results.length === 0) {
      console.log(`[Screener] Page ${page} returned 0 results, stopping`);
      break;
    }

    allOptions.push(...results);
    console.log(`[Screener] Page ${page} returned ${results.length} results (total: ${allOptions.length})`);

    if (results.length < 100) {
      console.log(`[Screener] Page ${page} returned < 100, last page`);
      break;
    }
    if (allOptions.length >= MAX_CANDIDATES * 5) {
      console.log(`[Screener] Reached ${allOptions.length} options, stopping pagination`);
      break;
    }
  }

  return { options: allOptions, error: null };
}

// ── Normalize Barchart option contract ──
function normalizeOptionContract(c: any, today: Date): {
  ticker: string;
  optionSymbol: string;
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
} {
  const ticker = String(c.underlyingSymbol || c.symbol || '').toUpperCase();
  const optionSymbol = String(c.symbol || '');
  const strike = Number(c.strike || 0);
  const expiration = String(c.expirationDate || '');
  const dte = Math.max(0, calcDTE(c.expirationDate, today));

  const rawBid = c.bid;
  const rawAsk = c.ask;
  const bid = (rawBid === undefined || rawBid === null || rawBid === '') ? null : Number(rawBid);
  const ask = (rawAsk === undefined || rawAsk === null || rawAsk === '') ? null : Number(rawAsk);

  let mid = 0;
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    mid = (bid + ask) / 2;
  }

  const volume = Number(c.volume || 0);
  const openInterest = Number(c.openInterest || 0);
  const iv = Number(c.volatility || 0);
  const delta = Number(c.delta || 0);
  const gamma = (c.gamma === undefined || c.gamma === null) ? null : Number(c.gamma);
  const theta = (c.theta === undefined || c.theta === null) ? null : Number(c.theta);
  const vega = (c.vega === undefined || c.vega === null) ? null : Number(c.vega);

  return { ticker, optionSymbol, strike, expiration, dte, bid, ask, mid, volume, openInterest, iv, delta, gamma, theta, vega };
}

// ── Determine which tickers need history refresh ──
function needsHistoryRefresh(ticker: string, cachedBars: HistoryBar[] | undefined): boolean {
  if (!cachedBars || cachedBars.length < 20) return true;
  const latest = cachedBars.at(-1)!;
  const latestDate = new Date(latest.date);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  return latestDate < twoDaysAgo;
}

// ── Evaluate a normalized contract through the CSP rule engine ──
function evaluateContract(
  c: ReturnType<typeof normalizeOptionContract>,
  profile: Profile,
  noFilterMode: boolean,
  symbol: string,
  openTickers: string[],
  stockPrice: number | null,
  primarySupport: number | null,
  trendClass: string,
  technicalDataAvailable: boolean,
  today: Date,
  fmt: (d: Date) => string,
  companyName: string,
  analyzeMode: boolean,
  secondarySupport: number | null,
  resistance: number | null,
): { candidate: any; analysis: any | null } {
  const { strike, expiration, dte, bid, ask, mid, volume, openInterest: oi, iv, delta } = c;

  const hasValidQuote = bid !== null && bid > 0 && ask !== null && ask > 0 && ask >= bid;

  // ── Non-quote qualification rules ──
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
    if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
      if (oi < profile.min_target_oi) reasons.push('OI too low');
      if (volume < 10) reasons.push('Insufficient liquidity');
    }
  }
  let qualified = reasons.length === 0;

  // ── Financial calculations only when real bid/ask exist ──
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

    if (!noFilterMode && !isSectionOff(profile, 'croi_pc_enabled') && profile.filter_strikes_croi) {
      if (!croiOptimized) {
        reasons.push('CROI too low');
        if (qualified) qualified = false;
      }
    }

    if (!noFilterMode && !isSectionOff(profile, 'spread_enabled') && sp > profile.max_spread_pct) {
      if (!reasons.includes('Spread too wide')) {
        reasons.push('Spread too wide');
        if (qualified) qualified = false;
      }
    }
  }

  const strikeDistFromStock = stockPrice !== null && stockPrice > 0 ? Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)) : null;
  const strikeDistFromSupport = primarySupport !== null && primarySupport > 0 ? Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)) : null;

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
          const minOk = supportDistPct >= profile.minimum_support_distance_pct;
          const maxOk = supportDistPct <= profile.maximum_support_distance_pct;
          passFail.push({ rule: `Minimum support distance >= ${profile.minimum_support_distance_pct}% (${supportDistPct.toFixed(1)}%)`, pass: minOk, status: minOk ? 'pass' : 'fail' });
          passFail.push({ rule: `Maximum support distance <= ${profile.maximum_support_distance_pct}% (${supportDistPct.toFixed(1)}%)`, pass: maxOk, status: maxOk ? 'pass' : 'fail' });
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

    const analysis = {
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
      qualified, pass_fail: passFail,
      has_quotes: hasValidQuote,
      strike_distance_from_stock: strikeDistFromStock,
      strike_distance_from_support: strikeDistFromSupport,
    };
    return { candidate: null, analysis };
  }

  const candidate = {
    scan_date: fmt(today), ticker: symbol, company_name: companyName || symbol,
    stock_price: stockPrice !== null && stockPrice > 0 ? Number(stockPrice.toFixed(2)) : null,
    stock_source: 'Barchart',
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
    strike_distance_from_stock: strikeDistFromStock,
    strike_distance_from_support: strikeDistFromSupport,
    has_quotes: hasValidQuote,
    secondary_support: secondarySupport !== null ? Number(secondarySupport.toFixed(2)) : null,
    resistance: resistance !== null ? Number(resistance.toFixed(2)) : null,
  };
  return { candidate, analysis: null };
}

// ── Compute technicals from bars + stock price ──
function computeTechnicals(bars: HistoryBar[], stockPrice: number | null) {
  const technicalDataAvailable = bars.length >= 20;
  const primarySupport = technicalDataAvailable && stockPrice !== null && stockPrice > 0 ? calcPrimarySupport(bars, stockPrice) : null;
  const secondarySupport = technicalDataAvailable && primarySupport !== null ? calcSecondarySupport(bars, primarySupport) : null;
  const resistance = technicalDataAvailable ? findResistance(bars) : null;
  const trendClass = technicalDataAvailable ? trend(bars) : 'Pending History';

  let technical: any = null;
  if (technicalDataAvailable) {
    const closes = bars.map((b) => b.close);
    const m = macd(closes);
    const bb = bollingerBands(closes);
    technical = {
      rsi: Number(rsi(closes).toFixed(1)),
      ma20: Number(sma(closes, 20).toFixed(2)),
      ma50: Number(sma(closes, 50).toFixed(2)),
      ma200: Number(sma(closes, 200).toFixed(2)),
      macd: m.macd, macd_signal: m.signal, macd_histogram: m.histogram,
      bb_upper: bb.upper, bb_middle: bb.middle, bb_lower: bb.lower, bb_position: bb.position,
      volume_trend: volumeTrend(bars),
    };
  }

  return { technicalDataAvailable, primarySupport, secondarySupport, resistance, trendClass, technical };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('market-scan started');
  console.log('BARCHART_API_KEY exists:', Boolean(Deno.env.get('BARCHART_API_KEY')));

  try {
    const apiKey = Deno.env.get('BARCHART_API_KEY');
    if (!apiKey) return json({ success: false, provider: 'Barchart', error: 'Barchart data unavailable — API key not configured.' });

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

      // 1. getQuote for stock price
      let stockPrice: number | null = null;
      let stockSource = 'none';
      const { priceMap } = await barchartGetQuote(apiKey, [ticker]);
      if (priceMap.has(ticker)) {
        stockPrice = priceMap.get(ticker)!.price;
        stockSource = 'Barchart';
      }

      // 2. getHistory for technicals + fallback price
      let bars: HistoryBar[] = [];
      try {
        bars = await barchartGetHistory(ticker, apiKey, today);
      } catch (e) {
        console.error(`[Analyze] history fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (stockPrice === null && bars.length) {
        stockPrice = Number(bars.at(-1)!.close);
        stockSource = 'Barchart';
      }

      // 3. Try cached history from Supabase if API didn't return enough
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

      const techData = computeTechnicals(bars, stockPrice);

      // Stock price filter
      if (stockPrice !== null && stockPrice > 0 && !noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
        if (profile.minimum_stock_price !== null && stockPrice < profile.minimum_stock_price) {
          return json({ success: false, error: `${ticker} stock price $${stockPrice} below minimum $${profile.minimum_stock_price}` });
        }
        if (profile.maximum_stock_price !== null && stockPrice > profile.maximum_stock_price) {
          return json({ success: false, error: `${ticker} stock price $${stockPrice} above maximum $${profile.maximum_stock_price}` });
        }
      }

      // 4. getEquityOptions for put chain
      const chainResult = await barchartGetEquityOptions(ticker, apiKey, profile, today, noFilterMode);

      if (chainResult.status === 'api_error' || chainResult.status === 'unauthorized' || chainResult.status === 'rate_limited' || chainResult.status === 'network_error') {
        return json({
          success: false, stage: 'options_chain', provider: 'Barchart', symbol: ticker,
          barchartStatus: chainResult.status === 'api_error' ? 500 : chainResult.status === 'unauthorized' ? 401 : chainResult.status === 'rate_limited' ? 429 : 0,
          barchartBody: chainResult.error || `Chain status: ${chainResult.status}`,
        });
      }

      if (stockPrice === null && chainResult.contracts.length === 0) {
        return json({
          success: false,
          error: `No usable stock price or put contracts returned for ${ticker}`,
          stage: 'stock_and_options',
        });
      }

      // 5. Run CSP rule engine on each contract
      const analyses: any[] = [];
      for (const rawContract of chainResult.contracts) {
        const normalized = normalizeOptionContract(rawContract, today);
        if (!normalized.strike || normalized.strike <= 0 || !normalized.expiration) continue;

        // Client-side DTE filter
        if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
          const minDte = profile.min_dte ?? 0;
          if (normalized.dte < minDte) continue;
        }

        // Client-side strike filter
        if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
          if (normalized.strike > profile.max_strike) continue;
        }

        const { analysis } = evaluateContract(
          normalized, profile, noFilterMode, ticker, openTickers,
          stockPrice, techData.primarySupport, techData.trendClass, techData.technicalDataAvailable,
          today, fmt, ticker, true, techData.secondarySupport, techData.resistance,
        );
        if (analysis) analyses.push(analysis);
      }

      const qualifying = analyses.filter((a) => a.qualified);
      qualifying.sort((a, b) => {
        const aBelow = techData.primarySupport !== null && a.strike < techData.primarySupport ? 0 : 1;
        const bBelow = techData.primarySupport !== null && b.strike < techData.primarySupport ? 0 : 1;
        if (aBelow !== bBelow) return aBelow - bBelow;
        if (a.spread_pct !== b.spread_pct) return a.spread_pct - b.spread_pct;
        if (a.open_interest !== b.open_interest) return b.open_interest - a.open_interest;
        if (a.volume !== b.volume) return b.volume - a.volume;
        return Math.abs(a.delta) - Math.abs(b.delta);
      });

      console.log(`[Analyze] ${ticker} complete — ${analyses.length} analyzed, ${qualifying.length} qualified`);

      return json({
        success: true,
        ticker,
        stock_price: stockPrice !== null && stockPrice > 0 ? Number(stockPrice.toFixed(2)) : null,
        stock_source: stockSource,
        trend: techData.trendClass || 'Unknown',
        primary_support: techData.primarySupport !== null ? Number(techData.primarySupport.toFixed(2)) : null,
        secondary_support: techData.secondarySupport !== null ? Number(techData.secondarySupport.toFixed(2)) : null,
        resistance: techData.resistance !== null ? Number(techData.resistance.toFixed(2)) : null,
        technical_data_available: Boolean(techData.technicalDataAvailable),
        technical_warning: techData.technicalDataAvailable ? null : 'Historical price data is still being loaded. Trend and support will show once history is available.',
        technical: techData.technical || null,
        qualifies: qualifying.length > 0,
        best_contract: qualifying[0] || null,
        other_qualifying_contracts: qualifying.slice(1),
        all_qualifying_contracts: qualifying,
        all_contracts_count: analyses.length,
        qualifying_count: qualifying.length,
      });
    }

    // ── DISCOVERY MODE: use getOptionsScreener ──
    if (scanMode === 'discovery') {
      console.log('[Discovery] Fetching options from Barchart screener...');
      const screenerResult = await barchartGetOptionsScreener(apiKey, profile, today, noFilterMode);

      if (screenerResult.error && screenerResult.options.length === 0) {
        return json({ success: false, provider: 'Barchart', error: 'Barchart data unavailable' });
      }

      const rawOptions = screenerResult.options;
      console.log(`[Discovery] Screener returned ${rawOptions.length} put options`);

      if (rawOptions.length === 0) {
        const emptyCounts = {
          symbols_in_universe: 0, symbols_returned: 0, symbols_failed: 0, symbols_with_chains: 0,
          puts_returned: 0, filtered_by_expiration: 0, filtered_by_strike: 0,
          valid_quotes: 0, contracts_awaiting_quotes: 0, contracts_evaluated: 0,
          qualified: 0, rejected: 0, pages_fetched: 0, contracts_found: 0,
        };
        return json({ success: true, candidates: [], source: 'barchart', scanned_at: new Date().toISOString(), scan_mode: scanMode, no_filter_mode: noFilterMode, scan_counts: emptyCounts });
      }

      // Extract unique underlying symbols
      const uniqueTickers = [...new Set(rawOptions.map((o: any) => String(o.underlyingSymbol || '').toUpperCase()).filter(Boolean))];
      console.log(`[Discovery] ${uniqueTickers.length} unique underlyings`);

      // Batch stock quotes for all underlyings
      const { priceMap } = await barchartGetQuote(apiKey, uniqueTickers.slice(0, 50));
      console.log(`[Discovery] Stock quotes: ${priceMap.size} prices returned`);

      // Load cached history batch
      const historyCache = await supabaseLoadHistoryBatch(uniqueTickers.slice(0, 50));

      // Refresh history for up to MAX_HISTORY_TICKERS tickers that need it
      const tickersNeedingRefresh = uniqueTickers.slice(0, 50).filter((t) => needsHistoryRefresh(t, historyCache.get(t)));
      const refreshBatch = tickersNeedingRefresh.slice(0, MAX_HISTORY_TICKERS);
      console.log(`[Discovery] ${tickersNeedingRefresh.length} tickers need history, refreshing ${refreshBatch.length}`);

      if (refreshBatch.length > 0) {
        const refreshPromise = (async () => {
          for (const ticker of refreshBatch) {
            try {
              const bars = await barchartGetHistory(ticker, apiKey, today);
              if (bars.length > 0) historyCache.set(ticker, bars);
            } catch (e) {
              console.error(`[Discovery] History refresh failed for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        })();
        try {
          await Promise.race([refreshPromise, new Promise((r) => setTimeout(r, 3000))]);
        } catch { /* timeout is fine */ }
      }

      // Evaluate each option contract through the CSP rule engine
      const candidates: any[] = [];
      let evaluated = 0, qualified = 0, rejected = 0;
      let validQuotes = 0, awaitingQuotes = 0;
      let filteredByExp = 0, filteredByStrike = 0;

      for (const rawOption of rawOptions) {
        const normalized = normalizeOptionContract(rawOption, today);
        if (!normalized.strike || normalized.strike <= 0 || !normalized.expiration) continue;
        if (!normalized.ticker) continue;

        // Client-side DTE filter
        if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
          const minDte = profile.min_dte ?? 0;
          if (normalized.dte < minDte) { filteredByExp++; continue; }
        }

        // Client-side strike filter
        if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
          if (normalized.strike > profile.max_strike) { filteredByStrike++; continue; }
        }

        const upperTicker = normalized.ticker.toUpperCase();
        const stockPrice = priceMap.get(upperTicker)?.price ?? null;
        const bars = historyCache.get(upperTicker) || [];
        const techData = computeTechnicals(bars, stockPrice);

        // Stock price filter
        if (stockPrice !== null && stockPrice > 0 && !noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
          if (profile.minimum_stock_price !== null && stockPrice < profile.minimum_stock_price) continue;
          if (profile.maximum_stock_price !== null && stockPrice > profile.maximum_stock_price) continue;
        }

        const { candidate } = evaluateContract(
          normalized, profile, noFilterMode, upperTicker, openTickers,
          stockPrice, techData.primarySupport, techData.trendClass, techData.technicalDataAvailable,
          today, fmt, priceMap.get(upperTicker)?.name || upperTicker, false, techData.secondarySupport, techData.resistance,
        );

        if (candidate) {
          evaluated++;
          if (candidate.qualified) { qualified++; validQuotes += candidate.has_quotes ? 1 : 0; }
          else { rejected++; }
          if (!candidate.has_quotes) awaitingQuotes++;
          candidates.push(candidate);
        }
      }

      candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);
      const capped = candidates.slice(0, MAX_CANDIDATES * 2);

      const scan_counts = {
        symbols_in_universe: uniqueTickers.length,
        symbols_returned: uniqueTickers.length,
        symbols_failed: 0,
        symbols_with_chains: uniqueTickers.length,
        puts_returned: rawOptions.length,
        filtered_by_expiration: filteredByExp,
        filtered_by_strike: filteredByStrike,
        valid_quotes: validQuotes,
        contracts_awaiting_quotes: awaitingQuotes,
        contracts_evaluated: evaluated,
        qualified,
        rejected,
        pages_fetched: Math.min(MAX_SCREENER_PAGES, Math.ceil(rawOptions.length / 100)),
        contracts_found: rawOptions.length,
      };

      console.log(`market-scan complete — discovery mode, ${capped.length} candidates`, JSON.stringify(scan_counts));

      return json({
        success: true, candidates: capped, source: 'barchart',
        scanned_at: new Date().toISOString(),
        scan_mode: scanMode, no_filter_mode: noFilterMode,
        scan_counts,
      });
    }

    // ── UNIVERSE MODE: scan user's saved tickers ──
    const symbolList = await fetchScanUniverse();
    console.log(`[ScanMode=universe] Loaded ${symbolList.length} enabled symbols`);

    const emptyCounts = {
      symbols_in_universe: symbolList.length, symbols_returned: 0, symbols_failed: 0, symbols_with_chains: 0,
      puts_returned: 0, filtered_by_expiration: 0, filtered_by_strike: 0,
      valid_quotes: 0, contracts_awaiting_quotes: 0, contracts_evaluated: 0,
      qualified: 0, rejected: 0, pages_fetched: 0, contracts_found: 0,
    };

    if (symbolList.length === 0) {
      return json({ success: true, candidates: [], source: 'barchart', scanned_at: new Date().toISOString(), scan_mode: scanMode, no_filter_mode: noFilterMode, scan_counts: emptyCounts });
    }

    const allTickers = symbolList.map((s) => s.ticker.toUpperCase());

    // Batch stock quotes
    const { priceMap } = await barchartGetQuote(apiKey, allTickers);
    console.log(`[Universe] Stock quotes: ${priceMap.size}/${allTickers.length} prices returned`);

    // Load cached history
    const historyCache = await supabaseLoadHistoryBatch(allTickers);

    // Refresh history for tickers that need it
    const tickersNeedingRefresh = allTickers.filter((t) => needsHistoryRefresh(t, historyCache.get(t)));
    const refreshBatch = tickersNeedingRefresh.slice(0, MAX_HISTORY_TICKERS);
    console.log(`[Universe] ${tickersNeedingRefresh.length} tickers need history, refreshing ${refreshBatch.length}`);

    if (refreshBatch.length > 0) {
      const refreshPromise = (async () => {
        for (const ticker of refreshBatch) {
          try {
            const bars = await barchartGetHistory(ticker, apiKey, today);
            if (bars.length > 0) historyCache.set(ticker, bars);
          } catch (e) {
            console.error(`[Universe] History refresh failed for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })();
      try {
        await Promise.race([refreshPromise, new Promise((r) => setTimeout(r, 3000))]);
      } catch { /* timeout is fine */ }
    }

    // Scan each ticker: fetch put options + evaluate
    const candidates: any[] = [];
    let symbolsScanned = 0, symbolsFailed = 0, symbolsWithChains = 0;
    let totalPutsReturned = 0, totalFilteredByExp = 0, totalFilteredByStrike = 0;
    let totalValidQuotes = 0, totalAwaitingQuotes = 0;
    let totalEvaluated = 0, totalQualified = 0, totalRejected = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbolList.length / BATCH_SIZE)}: ${batch.map((b) => b.ticker).join(', ')}`);

      const batchResults = await Promise.all(
        batch.map(async (sym) => {
          const upperTicker = sym.ticker.toUpperCase();
          const stockPrice = priceMap.get(upperTicker)?.price ?? null;
          const stockName = priceMap.get(upperTicker)?.name || sym.company_name || upperTicker;
          const bars = historyCache.get(upperTicker) || [];
          const techData = computeTechnicals(bars, stockPrice);

          // Stock price filter
          if (stockPrice !== null && stockPrice > 0 && !noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
            if (profile.minimum_stock_price !== null && stockPrice < profile.minimum_stock_price) return { skipped: true, candidates: [], putsReturned: 0 };
            if (profile.maximum_stock_price !== null && stockPrice > profile.maximum_stock_price) return { skipped: true, candidates: [], putsReturned: 0 };
          }

          // Fetch put options
          const chainResult = await barchartGetEquityOptions(upperTicker, apiKey, profile, today, noFilterMode);

          if (chainResult.status !== 'success' && chainResult.status !== 'no_options') {
            console.error(`[Universe] ${upperTicker} chain status: ${chainResult.status}`);
            return { skipped: true, candidates: [], putsReturned: 0, chainError: true };
          }

          const symCandidates: any[] = [];
          let symFilteredByExp = 0, symFilteredByStrike = 0;

          for (const rawContract of chainResult.contracts) {
            const normalized = normalizeOptionContract(rawContract, today);
            if (!normalized.strike || normalized.strike <= 0 || !normalized.expiration) continue;

            if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
              const minDte = profile.min_dte ?? 0;
              if (normalized.dte < minDte) { symFilteredByExp++; continue; }
            }

            if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
              if (normalized.strike > profile.max_strike) { symFilteredByStrike++; continue; }
            }

            const { candidate } = evaluateContract(
              normalized, profile, noFilterMode, upperTicker, openTickers,
              stockPrice, techData.primarySupport, techData.trendClass, techData.technicalDataAvailable,
              today, fmt, stockName, false, techData.secondarySupport, techData.resistance,
            );
            if (candidate) symCandidates.push(candidate);
          }

          return {
            skipped: false, candidates: symCandidates, putsReturned: chainResult.contracts.length,
            filteredByExp: symFilteredByExp, filteredByStrike: symFilteredByStrike,
            chainStatus: chainResult.status, techData,
          };
        }),
      );

      for (const result of batchResults) {
        if (result.skipped) { if ((result as any).chainError) symbolsFailed++; continue; }
        symbolsScanned++;
        totalPutsReturned += result.putsReturned;
        totalFilteredByExp += result.filteredByExp || 0;
        totalFilteredByStrike += result.filteredByStrike || 0;

        if (result.candidates.length > 0 || result.putsReturned > 0) symbolsWithChains++;

        for (const candidate of result.candidates) {
          totalEvaluated++;
          if (candidate.qualified) { totalQualified++; totalValidQuotes += candidate.has_quotes ? 1 : 0; }
          else { totalRejected++; }
          if (!candidate.has_quotes) totalAwaitingQuotes++;
          candidates.push(candidate);
        }
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
      pages_fetched: 0,
      contracts_found: totalPutsReturned,
    };

    console.log(`market-scan complete — universe mode, ${capped.length} candidates`, JSON.stringify(scan_counts));

    return json({
      success: true, candidates: capped, source: 'barchart',
      scanned_at: new Date().toISOString(),
      scan_mode: scanMode, no_filter_mode: noFilterMode,
      scan_counts,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Market scan failed';
    console.error(`market-scan fatal error: ${msg}`);
    return json({ success: false, provider: 'Barchart', error: 'Barchart data unavailable' });
  }
});
