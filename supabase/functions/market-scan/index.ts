// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY (https://massive.com dashboard)
// Supports two scan modes:
//   "discovery" — scans a broad universe of U.S. optionable stocks from market_universe table
//   "universe"  — scans only the user's enabled scan_universe tickers

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
  preferred_strikes: number[];
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

// Chain status categories
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
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
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

function extractQuote(c: any): { bid: number; ask: number; mid: number } {
  const bid = Number(c?.last_quote?.bid || 0);
  const ask = Number(c?.last_quote?.ask || 0);
  const lqMid = Number(c?.last_quote?.midpoint || 0);
  const mid = lqMid > 0 ? lqMid : (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
  return { bid, ask, mid };
}

// ── Supabase REST helper ──
async function supabaseSelect(table: string, columns: string, filter?: string): Promise<any[]> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error(`[Supabase] Missing URL or service key for ${table}`);
    return [];
  }
  let url = `${supabaseUrl}/rest/v1/${table}?select=${columns}`;
  if (filter) url += `&${filter}`;
  const resp = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    console.error(`[Supabase] ${table} select failed: HTTP ${resp.status}`);
    return [];
  }
  return await resp.json();
}

async function fetchScanUniverse(): Promise<{ ticker: string; company_name: string | null }[]> {
  const rows = await supabaseSelect('scan_universe', 'symbol,company_name', 'enabled=eq.true&order=symbol');
  return (rows || []).map((r: any) => ({
    ticker: String(r.symbol).toUpperCase(),
    company_name: r.company_name || null,
  }));
}

async function fetchMarketUniverse(limit: number): Promise<{ ticker: string; company_name: string | null }[]> {
  const rows = await supabaseSelect('market_universe', 'ticker,company_name', 'active=eq.true&optionable=eq.true&order=ticker');
  const mapped = (rows || []).map((r: any) => ({
    ticker: String(r.ticker).toUpperCase(),
    company_name: r.company_name || null,
  }));
  // Shuffle for variety across scans, then cap at limit
  const shuffled = mapped.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
}

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

function support(bars: HistoryBar[], price: number) {
  const recent = bars.slice(-90);
  if (!recent.length) return price * 0.9;
  const lows: number[] = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].low <= recent[i-1].low && recent[i].low <= recent[i-2].low && recent[i].low <= recent[i+1].low && recent[i].low <= recent[i+2].low) {
      lows.push(recent[i].low);
    }
  }
  const below = lows.filter((x) => x < price).sort((a,b) => b-a);
  return below[0] || Math.min(...recent.slice(-20).map((b) => b.low));
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
  if (v >= 250) return 'Excellent'; if (v >= 100) return 'Very Good'; if (v >= 50) return 'Good'; if (v >= 25) return 'Meaningful'; if (v >= 10) return 'Thin'; return 'Very Thin';
}

function isSectionOff(profile: Profile, key: keyof Profile): boolean {
  return profile[key] === false;
}

function logRawContract(symbol: string, c: any) {
  const safe: any = {};
  for (const k of Object.keys(c || {})) {
    if (k === 'last_quote' && c[k]) {
      safe.last_quote = { bid: c[k].bid, ask: c[k].ask, midpoint: c[k].midpoint };
    } else if (k === 'details' && c[k]) {
      safe.details = { contract_type: c[k].contract_type, strike_price: c[k].strike_price, expiration_date: c[k].expiration_date };
    } else if (k === 'greeks' && c[k]) {
      safe.greeks = { delta: c[k].delta };
    } else if (k === 'day' && c[k]) {
      safe.day = { volume: c[k].volume, close: c[k].close };
    } else if (typeof c[k] !== 'object') {
      safe[k] = c[k];
    }
  }
  console.log(`[Massive] RAW CONTRACT ${symbol}: ${JSON.stringify(safe)}`);
}

// ── Process a single symbol: fetch stock data + option chain, return candidates ──
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
): Promise<{
  candidates: any[];
  chainStatus: ChainStatus;
  putsReturned: number;
  missingBid: number;
  missingAsk: number;
  zeroBid: number;
  zeroAsk: number;
  missingStrike: number;
  missingExpiration: number;
  validQuotes: number;
  evaluated: number;
  qualified: number;
  rejected: number;
  pagesFetched: number;
  rawSample?: any;
}> {
  const counts = {
    candidates: [] as any[],
    chainStatus: 'no_options' as ChainStatus,
    putsReturned: 0, missingBid: 0, missingAsk: 0, zeroBid: 0, zeroAsk: 0,
    missingStrike: 0, missingExpiration: 0, validQuotes: 0, evaluated: 0,
    qualified: 0, rejected: 0, pagesFetched: 0, rawSample: undefined as any,
  };

  const start = new Date(today); start.setDate(start.getDate() - 420);

  // Step 1: Stock aggregates
  const histPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmt(start)}/${fmt(today)}`;
  const histResult = await massiveFetch(histPath, apiKey, symbol, 'stock_aggregates');
  if (!histResult.ok) return counts;

  const bars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
  }));
  if (!bars.length) return counts;
  const stockPrice = Number(bars.at(-1)!.close);
  if (!stockPrice) return counts;

  const primarySupport = support(bars, stockPrice);
  const trendClass = trend(bars);

  // Step 2: Options chain — match the analyze-ticker endpoint exactly
  // No limit param: analyze-ticker uses ?contract_type=put only
  const chainPath = `/v3/snapshot/options/${encodeURIComponent(symbol)}?contract_type=put`;
  const allRawContracts: any[] = [];
  let pageCount = 0;
  let currentPath = chainPath;
  let chainError: { status: number; body: string } | null = null;

  while (currentPath && pageCount < MAX_CHAIN_PAGES) {
    pageCount++;
    counts.pagesFetched++;
    const pageResult = await massiveFetch(currentPath, apiKey, symbol, `options_snapshot_p${pageCount}`);

    if (!pageResult.ok) {
      chainError = { status: pageResult.status, body: pageResult.body };
      if (verbose) {
        console.log(`[VERBOSE] ${symbol} | options_snapshot FAILED | HTTP ${pageResult.status} | body: ${pageResult.body.slice(0, 200)}`);
      }
      break;
    }

    const pageResults = pageResult.data?.results || [];
    allRawContracts.push(...pageResults);

    if (verbose && pageCount === 1) {
      console.log(`[VERBOSE] ${symbol} | options_snapshot OK | HTTP 200 | result_count=${pageResults.length}`);
      console.log(`[VERBOSE] ${symbol} | response keys: ${Object.keys(pageResult.data || {}).join(', ')}`);
    }

    if (!counts.rawSample && pageResults.length > 0) {
      counts.rawSample = pageResults[0];
      logRawContract(symbol, pageResults[0]);
    }

    // Follow pagination via next_url
    const nextUrl = pageResult.data?.next_url;
    if (nextUrl && typeof nextUrl === 'string' && nextUrl.length > 0) {
      try {
        const parsed = new URL(nextUrl);
        currentPath = parsed.pathname + parsed.search;
      } catch { currentPath = ''; }
    } else { currentPath = ''; }
  }

  // Determine chain status
  const contracts = allRawContracts.filter((c: any) => c?.details?.contract_type === 'put');
  counts.putsReturned = contracts.length;

  if (chainError) {
    if (chainError.status === 401 || chainError.status === 403) {
      counts.chainStatus = 'unauthorized';
    } else if (chainError.status === 429) {
      counts.chainStatus = 'rate_limited';
    } else if (chainError.status === 0) {
      counts.chainStatus = 'network_error';
    } else {
      counts.chainStatus = 'api_error';
    }
    if (verbose) {
      console.log(`[VERBOSE] ${symbol} | chain_status=${counts.chainStatus} | HTTP ${chainError.status} | puts=${contracts.length}`);
    }
    return counts;
  }

  if (contracts.length > 0) {
    counts.chainStatus = 'success';
  } else {
    counts.chainStatus = 'no_options';
  }

  if (verbose) {
    console.log(`[VERBOSE] ${symbol} | chain_status=${counts.chainStatus} | total_contracts=${allRawContracts.length} | puts=${contracts.length} | pages=${pageCount}`);
  }

  // Pre-filtering
  let filteredContracts = contracts;
  if (!noFilterMode) {
    if (!isSectionOff(profile, 'expiration_enabled')) {
      const allExpirations = [...new Set(contracts.map((c: any) => c.details.expiration_date))].sort();
      let chosenExpirations: string[];
      if (profile.preferred_expirations && profile.preferred_expirations.length > 0) {
        chosenExpirations = allExpirations.filter((e) => profile.preferred_expirations.includes(e));
      } else {
        chosenExpirations = allExpirations.filter((e) => {
          const dte = Math.ceil((new Date(e).getTime() - today.getTime()) / 86400000);
          return dte >= (profile.min_dte || 0) && dte <= (profile.max_dte || 9999);
        });
      }
      filteredContracts = contracts.filter((c: any) => chosenExpirations.includes(c.details.expiration_date));
    }

    if (!isSectionOff(profile, 'order_strike_enabled')) {
      const preferredStrikes = profile.preferred_strikes || [];
      if (preferredStrikes.length > 0) {
        filteredContracts = filteredContracts.filter((c: any) =>
          preferredStrikes.includes(Number(c.details.strike_price)),
        );
      } else {
        filteredContracts = filteredContracts.filter((c: any) => {
          const s = Number(c.details.strike_price);
          if (s > profile.max_strike) return false;
          if (profile.min_strike !== null && profile.min_strike !== undefined && s < profile.min_strike) return false;
          return true;
        });
      }
    }
  }

  // Contract evaluation
  for (const c of filteredContracts) {
    const strike = Number(c?.details?.strike_price || 0);
    const expiration = c?.details?.expiration_date as string;

    if (!strike || strike <= 0) { counts.missingStrike++; continue; }
    if (!expiration) { counts.missingExpiration++; continue; }

    const { bid, ask, mid } = extractQuote(c);
    if (bid <= 0) { counts.missingBid++; counts.zeroBid++; continue; }
    if (ask <= 0) { counts.missingAsk++; counts.zeroAsk++; continue; }
    if (ask < bid) { counts.missingAsk++; continue; }

    counts.validQuotes++;
    counts.evaluated++;

    const dte = Math.max(0, Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86400000));
    const sp = spreadPct(bid, ask);
    const volume = Number(c?.day?.volume || c?.volume || 0);
    const oi = Number(c?.open_interest || 0);
    const iv = Number(c?.implied_volatility || 0) * 100;
    const delta = Number(c?.greeks?.delta || 0);

    const best = optimize(mid, strike, profile, true);
    const btc = best?.btc || 0.01;
    const netProfit = best?.netProfit ?? ((mid - btc) * 100 - profile.round_trip_commission);
    const netCroi = best?.netCroi ?? netProfit / (strike * 100) * 100;
    const pc = best?.pc ?? (mid - btc) / mid * 100;

    const reasons: string[] = [];
    if (!noFilterMode) {
      if (profile.exclude_existing_positions && openTickers.includes(symbol)) reasons.push('Existing position');
      if (!isSectionOff(profile, 'order_strike_enabled') && strike > profile.max_strike) reasons.push('Strike too high');
      if (!isSectionOff(profile, 'croi_pc_enabled')) {
        if (!best) reasons.push('CROI too low');
        if (pc > profile.max_premium_capture && !reasons.includes('PC too high')) reasons.push('PC too high');
      }
      if (!isSectionOff(profile, 'spread_enabled') && sp > profile.max_spread_pct) reasons.push('Spread too wide');
      if (!isSectionOff(profile, 'cycle_liquidity_enabled')) {
        if (oi < profile.min_target_oi) reasons.push('OI too low');
        if (volume < 10) reasons.push('Insufficient liquidity');
      }
      if (!isSectionOff(profile, 'technical_rules_enabled')) {
        if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && strike >= primarySupport) reasons.push('Downtrend without support');
      }
    }

    const qualified = reasons.length === 0;
    if (qualified) counts.qualified++; else counts.rejected++;

    counts.candidates.push({
      scan_date: fmt(today), ticker: symbol, company_name: companyName || symbol, stock_price: Number(stockPrice.toFixed(2)),
      strike, expiration, dte, bid, ask, mid: Number(mid.toFixed(2)), spread_pct: Number(sp.toFixed(1)),
      iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
      volume, open_interest: oi, volume_classification: volClass(volume),
      trend_classification: trendClass, primary_support: Number(primarySupport.toFixed(2)),
      suggested_sto: Number(mid.toFixed(2)), suggested_btc: Number(btc.toFixed(2)),
      net_profit: Number(netProfit.toFixed(2)), net_croi: Number(netCroi.toFixed(2)),
      premium_capture: Number(pc.toFixed(1)), breakeven: Number((strike - mid).toFixed(2)),
      qualified, rejection_reasons: reasons,
      strategy_profile_id: profile.id,
      strike_distance_from_stock: Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)),
      strike_distance_from_support: Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)),
    });
  }

  return counts;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('market-scan started');
  console.log('MASSIVE_API_KEY exists:', Boolean(Deno.env.get('MASSIVE_API_KEY')));

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) {
      return json({
        success: false, provider: 'Massive',
        error: 'MASSIVE_API_KEY is not configured.',
      });
    }

    const body = await req.json().catch(() => ({}));
    const profile = body.profile as Profile | undefined;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());
    const scanMode: 'discovery' | 'universe' = body.scanMode === 'universe' ? 'universe' : 'discovery';

    if (!profile) {
      return json({ success: false, error: 'Missing strategy profile' });
    }

    // Load symbols based on scan mode
    let symbolList: { ticker: string; company_name: string | null }[];
    if (scanMode === 'universe') {
      symbolList = await fetchScanUniverse();
      console.log(`[ScanMode=universe] Loaded ${symbolList.length} enabled symbols from scan_universe`);
    } else {
      symbolList = await fetchMarketUniverse(MAX_DISCOVERY_SYMBOLS);
      console.log(`[ScanMode=discovery] Loaded ${symbolList.length} optionable symbols from market_universe (cap ${MAX_DISCOVERY_SYMBOLS})`);
    }

    const noFilterMode =
      isSectionOff(profile, 'order_strike_enabled') &&
      isSectionOff(profile, 'expiration_enabled') &&
      isSectionOff(profile, 'croi_pc_enabled') &&
      isSectionOff(profile, 'cycle_liquidity_enabled') &&
      isSectionOff(profile, 'spread_enabled') &&
      isSectionOff(profile, 'short_interest_enabled') &&
      isSectionOff(profile, 'technical_rules_enabled') &&
      profile.exclude_existing_positions === false;

    console.log(`NO FILTER MODE: ${noFilterMode}`);
    console.log(`Profile toggles: order_strike=${profile.order_strike_enabled}, expiration=${profile.expiration_enabled}, croi_pc=${profile.croi_pc_enabled}, cycle_liq=${profile.cycle_liquidity_enabled}, spread=${profile.spread_enabled}, short_int=${profile.short_interest_enabled}, technical=${profile.technical_rules_enabled}, exclude_existing=${profile.exclude_existing_positions}`);

    const emptyCounts = {
      symbols_in_universe: symbolList.length, symbols_requested: symbolList.length,
      symbols_returned: 0, symbols_failed: 0, symbols_with_chains: 0,
      chain_success: 0, chain_no_options: 0, chain_api_error: 0, chain_unauthorized: 0, chain_rate_limited: 0,
      puts_returned: 0, missing_bid: 0, missing_ask: 0, zero_bid: 0, zero_ask: 0,
      missing_strike: 0, missing_expiration: 0,
      valid_quotes: 0, contracts_evaluated: 0, qualified: 0, rejected: 0, pages_fetched: 0,
    };

    if (symbolList.length === 0) {
      return json({
        success: true, candidates: [], source: 'massive',
        scanned_at: new Date().toISOString(),
        scan_mode: scanMode, no_filter_mode: noFilterMode,
        scan_counts: emptyCounts,
      });
    }

    const today = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const candidates: any[] = [];

    let symbolsScanned = 0, symbolsFailed = 0, symbolsWithChains = 0;
    let chainSuccess = 0, chainNoOptions = 0, chainApiError = 0, chainUnauthorized = 0, chainRateLimited = 0;
    let totalPutsReturned = 0, totalMissingBid = 0, totalMissingAsk = 0;
    let totalZeroBid = 0, totalZeroAsk = 0, totalMissingStrike = 0, totalMissingExpiration = 0;
    let totalValidQuotes = 0, totalEvaluated = 0, totalQualified = 0, totalRejected = 0, totalPagesFetched = 0;
    let rawSample: any = null;
    let verboseCount = 0;

    // Process symbols in batches of 5 to reduce rate-limit risk
    const BATCH_SIZE = 5;
    for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
      const batch = symbolList.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbolList.length / BATCH_SIZE)}: ${batch.map((b) => b.ticker).join(', ')}`);

      const batchResults = await Promise.all(
        batch.map((sym) => {
          // Verbose logging for first 3 symbols total
          const isVerbose = verboseCount < 3;
          if (isVerbose) verboseCount++;
          return scanSymbol(sym.ticker, sym.company_name || '', profile, apiKey, openTickers, noFilterMode, today, fmt, isVerbose)
            .catch((err) => {
              console.error(`[scanSymbol] ${sym.ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
              return null;
            });
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (!result) { symbolsFailed++; continue; }
        symbolsScanned++;
        totalPutsReturned += result.putsReturned;
        totalMissingBid += result.missingBid;
        totalMissingAsk += result.missingAsk;
        totalZeroBid += result.zeroBid;
        totalZeroAsk += result.zeroAsk;
        totalMissingStrike += result.missingStrike;
        totalMissingExpiration += result.missingExpiration;
        totalValidQuotes += result.validQuotes;
        totalEvaluated += result.evaluated;
        totalQualified += result.qualified;
        totalRejected += result.rejected;
        totalPagesFetched += result.pagesFetched;

        // Track chain status separately
        switch (result.chainStatus) {
          case 'success': chainSuccess++; symbolsWithChains++; break;
          case 'no_options': chainNoOptions++; break;
          case 'api_error': chainApiError++; symbolsFailed++; break;
          case 'unauthorized': chainUnauthorized++; symbolsFailed++; break;
          case 'rate_limited': chainRateLimited++; symbolsFailed++; break;
          case 'network_error': symbolsFailed++; break;
        }

        if (!rawSample && result.rawSample) rawSample = result.rawSample;
        candidates.push(...result.candidates);
      }

      // Early exit if we already have enough qualified candidates
      const qualifiedCount = candidates.filter((c) => c.qualified).length;
      if (qualifiedCount >= MAX_CANDIDATES) {
        console.log(`Reached ${MAX_CANDIDATES} qualified candidates, stopping early at ${symbolsScanned} symbols`);
        break;
      }
    }

    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);

    // Cap total candidates returned
    const capped = candidates.slice(0, MAX_CANDIDATES * 2);

    const scan_counts = {
      symbols_in_universe: symbolList.length,
      symbols_requested: symbolList.length,
      symbols_returned: symbolsScanned,
      symbols_failed: symbolsFailed,
      symbols_with_chains: symbolsWithChains,
      chain_success: chainSuccess,
      chain_no_options: chainNoOptions,
      chain_api_error: chainApiError,
      chain_unauthorized: chainUnauthorized,
      chain_rate_limited: chainRateLimited,
      puts_returned: totalPutsReturned,
      missing_bid: totalMissingBid,
      missing_ask: totalMissingAsk,
      zero_bid: totalZeroBid,
      zero_ask: totalZeroAsk,
      missing_strike: totalMissingStrike,
      missing_expiration: totalMissingExpiration,
      valid_quotes: totalValidQuotes,
      contracts_evaluated: totalEvaluated,
      qualified: totalQualified,
      rejected: totalRejected,
      pages_fetched: totalPagesFetched,
    };

    console.log(`market-scan complete — mode=${scanMode}, ${capped.length} candidates, no_filter_mode=${noFilterMode}`, JSON.stringify(scan_counts));
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
