// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY (https://massive.com dashboard)
// Optional env var (NOT a secret): CSP_SCAN_SYMBOLS — override the default scan universe.
//
// TEMPORARY DIAGNOSTIC MODE: scans SOFI only and always returns HTTP 200
// with diagnostic JSON so the frontend can display the exact Massive error.
// Full ticker list will be re-enabled once SOFI succeeds.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';

const DIAGNOSTIC_SYMBOL = 'SOFI';

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Fetch from Massive API with full diagnostics.
 * - Uses Authorization: Bearer header (NOT query param).
 * - Logs symbol, URL (without key), request type, timestamp before each request.
 * - Logs HTTP status and response body after each request.
 * - Never logs the API key.
 * - On failure, returns a diagnostic object (does not throw).
 */
async function massiveFetch(
  path: string,
  apiKey: string,
  symbol: string,
  stage: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const url = `${MASSIVE_API}${path}`;
  const ts = new Date().toISOString();

  console.log(`[Massive] ${symbol} | stage=${stage} | type=GET | url=${url} | ts=${ts}`);

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

  const status = response.status;
  const ok = response.ok;

  if (!ok) {
    const bodyText = await response.text();
    const truncated = bodyText.slice(0, 500);
    console.error(`[Massive] ${symbol} | stage=${stage} | HTTP ${status} | body: ${truncated}`);
    return { ok: false, status, body: truncated || response.statusText };
  }

  console.log(`[Massive] ${symbol} | stage=${stage} | HTTP ${status} | OK`);

  try {
    const data = await response.json();
    return { ok: true, data };
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[Massive] ${symbol} | stage=${stage} | JSON PARSE ERROR: ${msg}`);
    return { ok: false, status, body: `JSON parse error: ${msg}` };
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
  console.log('MASSIVE_API_KEY exists:', Boolean(Deno.env.get('MASSIVE_API_KEY')));

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) {
      console.error('MASSIVE_API_KEY is not configured');
      return json({
        success: false,
        provider: 'Massive',
        error: 'MASSIVE_API_KEY is not configured. Add it as an Edge Function secret in your Supabase dashboard.',
      });
    }

    const body = await req.json().catch(() => ({}));
    const profile = body.profile as Profile | undefined;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());

    // TEMPORARY: scan SOFI only until the diagnostic confirms both endpoints work.
    const symbols = [DIAGNOSTIC_SYMBOL];
    console.log(`CSP_SCAN_SYMBOLS (diagnostic): ${symbols.join(', ')}`);

    if (!profile) {
      return json({ success: false, error: 'Missing strategy profile' });
    }

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 420);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const candidates: any[] = [];
    let contractCount = 0;

    for (const symbol of symbols) {
      // ── Step 1: Stock aggregates ──
      const histPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmt(start)}/${fmt(today)}`;
      const histResult = await massiveFetch(histPath, apiKey, symbol, 'stock_aggregates');

      if (!histResult.ok) {
        return json({
          success: false,
          stage: 'stock_aggregates',
          provider: 'Massive',
          symbol,
          massiveStatus: histResult.status,
          massiveBody: histResult.body,
        });
      }

      const bars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
      }));
      if (!bars.length) {
        console.warn(`[Massive] ${symbol} — no history bars returned`);
        return json({
          success: false,
          stage: 'stock_aggregates',
          provider: 'Massive',
          symbol,
          massiveStatus: 200,
          massiveBody: 'Request succeeded but returned 0 results',
        });
      }
      const stockPrice = Number(bars.at(-1)!.close);
      if (!stockPrice) {
        console.warn(`[Massive] ${symbol} — stock price is 0`);
        return json({
          success: false,
          stage: 'stock_aggregates',
          provider: 'Massive',
          symbol,
          massiveStatus: 200,
          massiveBody: 'Stock price returned as 0',
        });
      }

      const primarySupport = support(bars, stockPrice);
      const trendClass = trend(bars);

      // ── Step 2: Options chain snapshot ──
      const chainPath = `/v3/snapshot/options/${encodeURIComponent(symbol)}?contract_type=put`;
      const chainResult = await massiveFetch(chainPath, apiKey, symbol, 'options_snapshot');

      if (!chainResult.ok) {
        return json({
          success: false,
          stage: 'options_snapshot',
          provider: 'Massive',
          symbol,
          massiveStatus: chainResult.status,
          massiveBody: chainResult.body,
        });
      }

      const contracts = (chainResult.data?.results || []).filter(
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
    }

    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);
    console.log(`market-scan complete — ${candidates.length} candidates from ${contractCount} contracts`);
    return json({ success: true, candidates, source: 'massive', scanned_at: new Date().toISOString(), symbols_scanned: symbols.length, contracts_scanned: contractCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Market scan failed';
    console.error(`market-scan fatal error: ${msg}`);
    return json({ success: false, provider: 'Massive', error: msg });
  }
});
