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
  min_strike: number | null;
  min_dte: number;
  max_dte: number;
  preferred_expirations: string[];
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
  order_strike_enabled: boolean;
  expiration_enabled: boolean;
  croi_pc_enabled: boolean;
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
type ScanSymbolResult = {
  candidates: any[];
  chainStatus: ChainStatus;
  putsReturned: number;
  filteredByExpiration: number;
  filteredByStrike: number;
  // Granular skip counters (must sum to filteredContracts.length)
  missingStrike: number;
  missingExpiration: number;
  missingLastQuote: number;
  missingBid: number;   // last_quote exists but bid field absent
  zeroBid: number;      // bid = 0 (illiquid)
  missingAsk: number;   // last_quote exists but ask field absent
  zeroAsk: number;      // ask = 0
  askLtBid: number;
  otherInvalid: number;
  // Valid contracts
  validQuotes: number;
  contractsAwaitingQuotes: number;
  evaluated: number;
  qualified: number;
  rejected: number;
  pagesFetched: number;
  rawSample?: any;
  // For analyze mode
  analyses?: any[];
  stockPrice?: number;
  primarySupport?: number;
  secondarySupport?: number;
  resistance?: number;
  trendClass?: string;
};

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

  const start = new Date(today); start.setDate(start.getDate() - 420);

  // Step 1: Stock aggregates
  const histPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmt(start)}/${fmt(today)}`;
  const histResult = await massiveFetch(histPath, apiKey, symbol, 'stock_aggregates');
  if (!histResult.ok) return r;

  const bars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
  }));
  if (!bars.length) return r;
  const stockPrice = Number(bars.at(-1)!.close);
  if (!stockPrice) return r;

  const primarySupport = calcPrimarySupport(bars, stockPrice);
  const secondarySupport = calcSecondarySupport(bars, primarySupport);
  const resistance = findResistance(bars);
  const trendClass = trend(bars);

  r.stockPrice = stockPrice;
  r.primarySupport = primarySupport;
  r.secondarySupport = secondarySupport;
  r.resistance = resistance;
  r.trendClass = trendClass;

  // Step 2: Options chain — build URL with server-side filters to reduce pages
  const chainParams = new URLSearchParams();
  chainParams.set('contract_type', 'put');

  // Server-side strike filter (if Order & Strike enabled)
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
    chainParams.set('strike_price.lte', String(profile.max_strike));
    if (profile.min_strike !== null && profile.min_strike !== undefined) {
      chainParams.set('strike_price.gte', String(profile.min_strike));
    }
  }

  // Server-side expiration filter (if Expiration enabled)
  // When preferred_expirations has dates, skip DTE range server-side so
  // contracts matching those exact dates aren't excluded. The client-side
  // filter below handles exact-date matching.
  if (!noFilterMode && !isSectionOff(profile, 'expiration_enabled')) {
    const preferred = profile.preferred_expirations || [];
    if (preferred.length === 0) {
      const minDte = profile.min_dte ?? 0;
      const maxDte = profile.max_dte ?? 9999;
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + minDte);
      const maxDate = new Date(today);
      maxDate.setDate(maxDate.getDate() + maxDte);
      chainParams.set('expiration_date.gte', fmt(minDate));
      chainParams.set('expiration_date.lte', fmt(maxDate));
    }
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
    const preferred = profile.preferred_expirations || [];
    const before = filteredContracts.length;

    if (preferred.length > 0) {
      filteredContracts = filteredContracts.filter((c: any) => {
        const expRaw = c?.details?.expiration_date;
        const expStr = expRaw != null ? String(expRaw).slice(0, 10) : '';
        return preferred.some((p: string) => p.slice(0, 10) === expStr);
      });
    } else {
      const minDte = profile.min_dte ?? 0;
      const maxDte = profile.max_dte ?? 9999;
      filteredContracts = filteredContracts.filter((c: any) => {
        const dte = calcDTE(c?.details?.expiration_date, today);
        return dte >= minDte && dte <= maxDte;
      });
    }

    r.filteredByExpiration = before - filteredContracts.length;
    if (verbose) {
      const sampleExp = contracts[0]?.details?.expiration_date;
      console.log(`[VERBOSE] ${symbol} | raw expiration_date sample: ${JSON.stringify(sampleExp)} | type: ${typeof sampleExp}`);
      const filterDesc = preferred.length > 0
        ? `preferred dates [${preferred.join(', ')}]`
        : `DTE ${profile.min_dte}-${profile.max_dte}`;
      console.log(`[VERBOSE] ${symbol} | expiration filter (${filterDesc}): ${before} -> ${filteredContracts.length} (removed ${r.filteredByExpiration})`);
    }
  }

  // ── Pre-filtering: strike (client-side safety net, server already filtered) ──
  if (!noFilterMode && !isSectionOff(profile, 'order_strike_enabled')) {
    const before = filteredContracts.length;
    filteredContracts = filteredContracts.filter((c: any) => {
      const s = Number(c.details.strike_price);
      if (s > profile.max_strike) return false;
      if (profile.min_strike !== null && profile.min_strike !== undefined && s < profile.min_strike) return false;
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
      if (!isSectionOff(profile, 'technical_rules_enabled')) {
        if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && strike >= primarySupport) reasons.push('Downtrend without support');
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
    if (hasValidQuote) {
      sp = spreadPct(bid!, ask!);
      stoPrice = mid;
      const best = optimize(mid, strike, profile, true);
      if (best) {
        btcPrice = best.btc;
        netProfit = best.netProfit;
        netCroi = best.netCroi;
        pc = best.pc;
      }
      breakeven = strike - mid;

      // Spread rule only applies when a quote exists
      if (!noFilterMode && !isSectionOff(profile, 'spread_enabled') && sp > profile.max_spread_pct) {
        if (!reasons.includes('Spread too wide')) {
          reasons.push('Spread too wide');
          // Re-evaluate qualified status
          if (qualified) { r.qualified--; r.rejected++; }
        }
      }
    }

    if (analyzeMode) {
      const passFail: { rule: string; pass: boolean }[] = [];
      if (!isSectionOff(profile, 'order_strike_enabled')) {
        passFail.push({ rule: `Strike <= ${profile.max_strike}`, pass: strike <= profile.max_strike });
        passFail.push({ rule: `Strike below support (${primarySupport.toFixed(2)})`, pass: strike < primarySupport });
      }
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        passFail.push({ rule: `OI >= ${profile.min_target_oi}`, pass: oi >= profile.min_target_oi });
        passFail.push({ rule: `Sufficient liquidity (volume >= 10)`, pass: volume >= 10 });
      }
      if (!isSectionOff(profile, 'technical_rules_enabled')) {
        passFail.push({ rule: `Trend acceptable (${trendClass})`, pass: !(profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && strike >= primarySupport) });
      }
      if (hasValidQuote && !isSectionOff(profile, 'spread_enabled')) {
        passFail.push({ rule: `Spread acceptable (<= ${profile.max_spread_pct}%)`, pass: sp <= profile.max_spread_pct });
      }
      if (hasValidQuote && !isSectionOff(profile, 'croi_pc_enabled')) {
        passFail.push({ rule: `Net CROI >= ${profile.min_net_croi}%`, pass: netCroi >= profile.min_net_croi });
        passFail.push({ rule: `Premium Capture <= ${profile.max_premium_capture}%`, pass: pc <= profile.max_premium_capture });
      }
      if (!hasValidQuote) {
        passFail.push({ rule: 'Quote data — enter manually', pass: false });
      }
      const finalQualified = passFail.every((pf) => pf.pass);

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
      });
    } else {
      r.candidates.push({
        scan_date: fmt(today), ticker: symbol, company_name: companyName || symbol,
        stock_price: Number(stockPrice.toFixed(2)),
        strike, expiration, dte,
        bid: hasValidQuote ? Number(bid!.toFixed(2)) : 0,
        ask: hasValidQuote ? Number(ask!.toFixed(2)) : 0,
        mid: hasValidQuote ? Number(mid.toFixed(2)) : 0,
        spread_pct: hasValidQuote ? Number(sp.toFixed(1)) : 0,
        iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        trend_classification: trendClass, primary_support: Number(primarySupport.toFixed(2)),
        suggested_sto: hasValidQuote ? Number(stoPrice.toFixed(2)) : 0,
        suggested_btc: hasValidQuote ? Number(btcPrice.toFixed(2)) : 0,
        net_profit: hasValidQuote ? Number(netProfit.toFixed(2)) : 0,
        net_croi: hasValidQuote ? Number(netCroi.toFixed(2)) : 0,
        premium_capture: hasValidQuote ? Number(pc.toFixed(1)) : 0,
        breakeven: hasValidQuote ? Number(breakeven.toFixed(2)) : 0,
        qualified, rejection_reasons: reasons,
        strategy_profile_id: profile.id,
        strike_distance_from_stock: Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)),
        strike_distance_from_support: Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)),
        has_quotes: hasValidQuote,
      });
    }
  }

  // In analyze mode, sort qualifying contracts and pick best
  if (analyzeMode && analyses.length > 0) {
    const qualifying = analyses.filter((a) => a.qualified);
    qualifying.sort((a, b) => {
      const aBelow = a.strike < primarySupport ? 0 : 1;
      const bBelow = b.strike < primarySupport ? 0 : 1;
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

    // ── LIST-EXPIRATIONS MODE: collect all unique PUT expiration dates ──
    // Uses contract metadata only (details.expiration_date). No quote/IV/OI/volume
    // data required. No DTE/strike/CROI/liquidity/technical filters applied.
    if (mode === 'list-expirations') {
      let symbolList: { ticker: string; company_name: string | null }[];
      if (scanMode === 'universe') {
        symbolList = await fetchScanUniverse();
      } else {
        symbolList = await fetchMarketUniverse(50);
      }

      // For analyze mode, use the specific ticker if provided
      const analyzeTicker = String(body.ticker || '').toUpperCase().trim();
      if (analyzeTicker) {
        symbolList = [{ ticker: analyzeTicker, company_name: null }];
      }

      console.log(`[list-expirations] scanMode=${scanMode}, symbols=${symbolList.length}, ticker=${analyzeTicker || 'none'}`);

      const today = new Date();
      const todayStr = fmt(today);
      const allExpirations = new Set<string>();
      let symbolsWithChains = 0;
      let symbolsFailed = 0;

      const BATCH = 5;
      for (let i = 0; i < symbolList.length; i += BATCH) {
        const batch = symbolList.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map(async (sym) => {
            // No filters — just fetch PUT contracts and read expiration_date metadata
            const chainParams = new URLSearchParams();
            chainParams.set('contract_type', 'put');
            const chainPath = `/v3/snapshot/options/${encodeURIComponent(sym.ticker)}?${chainParams.toString()}`;
            const pageResult = await massiveFetch(chainPath, apiKey, sym.ticker, 'list_expirations');
            if (!pageResult.ok) {
              console.log(`[list-expirations] ${sym.ticker} failed: HTTP ${pageResult.status}`);
              return { exps: [] as string[], ok: false };
            }
            const contracts = (pageResult.data?.results || []).filter((c: any) => c?.details?.contract_type === 'put');
            // Paginate through all results to collect every expiration date
            let nextUrl = pageResult.data?.next_url;
            let allContracts = [...contracts];
            let pageCount = 1;
            while (nextUrl && typeof nextUrl === 'string' && pageCount < MAX_CHAIN_PAGES) {
              pageCount++;
              let nextPath: string;
              try { const parsed = new URL(nextUrl); nextPath = parsed.pathname + parsed.search; }
              catch { break; }
              const nextPage = await massiveFetch(nextPath, apiKey, sym.ticker, `list_expirations_p${pageCount}`);
              if (!nextPage.ok) break;
              const moreContracts = (nextPage.data?.results || []).filter((c: any) => c?.details?.contract_type === 'put');
              allContracts.push(...moreContracts);
              nextUrl = nextPage.data?.next_url;
            }
            const exps = allContracts.map((c: any) => {
              const expRaw = c?.details?.expiration_date;
              if (!expRaw) return '';
              const d = parseExpirationDate(expRaw);
              if (!d) return '';
              return fmt(d);
            }).filter(Boolean);
            return { exps, ok: true };
          }),
        );
        for (const r of results) {
          if (r.ok) symbolsWithChains++;
          else symbolsFailed++;
          for (const e of r.exps) allExpirations.add(e);
        }
      }

      const sorted = [...allExpirations].filter((d) => d >= todayStr).sort();
      console.log(`[list-expirations] Found ${sorted.length} unique expiration dates from ${symbolsWithChains} symbols (${symbolsFailed} failed)`);

      // Return success even if empty — the frontend handles empty gracefully
      return json({ success: true, expirations: sorted, symbols_scanned: symbolList.length, symbols_with_chains: symbolsWithChains, symbols_failed: symbolsFailed });
    }

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

      if (!result.stockPrice) {
        return json({ success: false, error: `No price history returned for ${ticker}` });
      }

      const analyses = result.analyses || [];
      const qualifying = analyses.filter((a) => a.qualified);
      const bestContract = qualifying[0] || null;

      console.log(`[Analyze] ${ticker} complete — ${analyses.length} analyzed, ${qualifying.length} qualified, puts=${result.putsReturned}, validQuotes=${result.validQuotes}`);

      return json({
        success: true,
        ticker,
        stock_price: Number(result.stockPrice.toFixed(2)),
        trend: result.trendClass || 'Unknown',
        primary_support: Number((result.primarySupport || 0).toFixed(2)),
        secondary_support: Number((result.secondarySupport || 0).toFixed(2)),
        resistance: Number((result.resistance || 0).toFixed(2)),
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
