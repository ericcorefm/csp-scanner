// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY (https://massive.com dashboard)
// Optional env var (NOT a secret): CSP_SCAN_SYMBOLS — override the default scan universe.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';

const DEFAULT_SCAN_SYMBOLS = 'SOFI,CIFR,WULF,RIOT,RGTI,QBTS,RIVN,IREN,APLD';

type Profile = {
  id: string;
  max_strike: number;
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
};

type HistoryBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

/** Structured error returned to the frontend when a Massive API call fails. */
type MassiveError = {
  success: false;
  provider: 'Massive';
  symbol: string;
  endpoint: string;
  status: number;
  error: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function massiveError(symbol: string, endpoint: string, status: number, error: string, httpStatus = 502): MassiveError & { _httpStatus: number } {
  const payload: MassiveError = { success: false, provider: 'Massive', symbol, endpoint, status, error };
  return { ...payload, _httpStatus: httpStatus };
}

/**
 * Fetch from Massive API with full diagnostics.
 * - Logs the symbol, endpoint URL (without API key), HTTP status, and response body on failure.
 * - Never logs the API key.
 * - On non-2xx, throws a structured MassiveError so the caller can return it directly.
 */
async function massiveFetch(path: string, apiKey: string, symbol: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MASSIVE_API}${path}${sep}apiKey=***`;

  console.log(`[Massive] ${symbol} → GET ${url}`);

  let response: Response;
  try {
    response = await fetch(`${MASSIVE_API}${path}${sep}apiKey=${encodeURIComponent(apiKey)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    console.error(`[Massive] ${symbol} NETWORK ERROR → ${url} → ${msg}`);
    throw massiveError(symbol, url, 0, `Network error: ${msg}`);
  }

  console.log(`[Massive] ${symbol} ← ${response.status} ${response.statusText} from ${url}`);

  if (!response.ok) {
    const bodyText = await response.text();
    const truncated = bodyText.slice(0, 500);
    console.error(`[Massive] ${symbol} HTTP ${response.status} from ${url} — body: ${truncated}`);
    throw massiveError(symbol, url, response.status, truncated || response.statusText);
  }

  try {
    return await response.json();
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[Massive] ${symbol} JSON PARSE ERROR from ${url} — ${msg}`);
    throw massiveError(symbol, url, response.status, `JSON parse error: ${msg}`);
  }
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('market-scan started');

  const hasApiKey = !!Deno.env.get('MASSIVE_API_KEY');
  console.log(`MASSIVE_API_KEY exists: ${hasApiKey}`);

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) {
      console.error('MASSIVE_API_KEY is not configured');
      return json({
        success: false,
        provider: 'Massive',
        error: 'MASSIVE_API_KEY is not configured. Add it as an Edge Function secret in your Supabase dashboard.',
      }, 503);
    }

    const body = await req.json();
    const profile = body.profile as Profile;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());
    if (!profile) return json({ success: false, error: 'Missing strategy profile' }, 400);

    const symbols = (Deno.env.get('CSP_SCAN_SYMBOLS') || DEFAULT_SCAN_SYMBOLS)
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

    console.log(`CSP_SCAN_SYMBOLS: ${symbols.join(', ')}`);

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 420);
    const fmt = (d: Date) => d.toISOString().slice(0,10);
    const candidates: any[] = [];
    let contractCount = 0;

    for (const symbol of symbols) {
      try {
        const histPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmt(start)}/${fmt(today)}`;
        const histJson = await massiveFetch(histPath, apiKey, symbol);
        const bars: HistoryBar[] = (histJson?.results || []).map((b: any) => ({
          date: new Date(b.t).toISOString().slice(0, 10),
          open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
        }));
        if (!bars.length) {
          console.warn(`[Massive] ${symbol} — no history bars returned, skipping`);
          continue;
        }
        const stockPrice = Number(bars.at(-1)!.close);
        if (!stockPrice) {
          console.warn(`[Massive] ${symbol} — stock price is 0, skipping`);
          continue;
        }

        const primarySupport = support(bars, stockPrice);
        const trendClass = trend(bars);

        const chainPath = `/v3/snapshot/options/${encodeURIComponent(symbol)}?contract_type=put`;
        const chainJson = await massiveFetch(chainPath, apiKey, symbol);
        const contracts = (chainJson?.results || []).filter(
          (c: any) => c?.details?.contract_type === 'put',
        );

        const expirations = [...new Set(contracts.map((c: any) => c.details.expiration_date))].sort();
        const chosenExpirations = expirations.slice(-3);
        const filteredContracts = contracts.filter((c: any) =>
          chosenExpirations.includes(c.details.expiration_date),
        );

        console.log(`[Massive] ${symbol} — ${contracts.length} put contracts, ${filteredContracts.length} in chosen expirations`);

        for (const c of filteredContracts) {
          contractCount++;
          const strike = Number(c.details.strike_price || 0);
          const bid = Number(c.last_quote?.bid || 0);
          const ask = Number(c.last_quote?.ask || 0);
          if (!strike || !bid || !ask) continue;
          const expiration = c.details.expiration_date as string;
          const dte = Math.max(0, Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86400000));
          const mid = (bid + ask) / 2;
          const sp = spreadPct(bid, ask);
          const volume = Number(c.volume || 0), oi = Number(c.open_interest || 0);
          const iv = Number(c.implied_volatility || 0) * 100;
          const delta = Number(c.greeks?.delta || 0);
          const best = optimize(mid, strike, profile, true);
          const reasons: string[] = [];

          if (profile.exclude_existing_positions && openTickers.includes(symbol)) reasons.push('Existing position');
          if (strike > profile.max_strike) reasons.push('Strike too high');
          if (!best) reasons.push('CROI too low');
          if (sp > profile.max_spread_pct) reasons.push('Spread too wide');
          if (oi < profile.min_target_oi) reasons.push('OI too low');
          if (volume < 10) reasons.push('Insufficient liquidity');
          if (profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && strike >= primarySupport) reasons.push('Downtrend without support');

          const btc = best?.btc || 0.01;
          const netProfit = best?.netProfit ?? ((mid - btc) * 100 - profile.round_trip_commission);
          const netCroi = best?.netCroi ?? netProfit / (strike * 100) * 100;
          const pc = best?.pc ?? (mid - btc) / mid * 100;
          if (pc > profile.max_premium_capture && !reasons.includes('PC too high')) reasons.push('PC too high');

          candidates.push({
            scan_date: fmt(today), ticker: symbol, company_name: symbol, stock_price: Number(stockPrice.toFixed(2)),
            strike, expiration, dte, bid, ask, mid: Number(mid.toFixed(2)), spread_pct: Number(sp.toFixed(1)), iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
            volume, open_interest: oi, volume_classification: volClass(volume), trend_classification: trendClass, primary_support: Number(primarySupport.toFixed(2)),
            suggested_sto: Number(mid.toFixed(2)), suggested_btc: Number(btc.toFixed(2)), net_profit: Number(netProfit.toFixed(2)), net_croi: Number(netCroi.toFixed(2)),
            premium_capture: Number(pc.toFixed(1)), breakeven: Number((strike - mid).toFixed(2)), qualified: reasons.length === 0, rejection_reasons: reasons,
            strategy_profile_id: profile.id,
            strike_distance_from_stock: Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)),
            strike_distance_from_support: Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)),
          });
        }
      } catch (e) {
        // Structured error from massiveFetch — return directly to the frontend.
        // No silent fallback to demo data.
        if (e && typeof e === 'object' && 'success' in e && e.success === false) {
          const err = e as MassiveError & { _httpStatus: number };
          console.error(`[Massive] SCAN ABORTED for ${err.symbol} — status ${err.status}: ${err.error}`);
          return json({
            success: false,
            provider: 'Massive',
            symbol: err.symbol,
            endpoint: err.endpoint,
            status: err.status,
            error: err.error,
          }, err._httpStatus || 502);
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`scan failed for ${symbol}: ${msg}`);
        return json({
          success: false,
          provider: 'Massive',
          symbol,
          status: 0,
          error: msg,
        }, 502);
      }
    }

    candidates.sort((a,b) => Number(b.qualified)-Number(a.qualified) || a.spread_pct-b.spread_pct || b.net_croi-a.net_croi);
    console.log(`market-scan complete — ${candidates.length} candidates from ${contractCount} contracts`);
    return json({ success: true, candidates, source: 'massive', scanned_at: new Date().toISOString(), symbols_scanned: symbols.length, contracts_scanned: contractCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Market scan failed';
    console.error(`market-scan fatal error: ${msg}`);
    return json({ success: false, provider: 'Massive', error: msg }, 500);
  }
});
