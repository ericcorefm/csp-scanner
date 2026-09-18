// Supabase Edge Function: market-scan
// Configure secret: TRADIER_TOKEN
// Optional: CSP_SCAN_SYMBOLS="SOFI,CIFR,WULF,RIVN,RIOT,RGTI,QBTS,IREN,APLD"

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

const API = 'https://api.tradier.com/v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function tradier(path: string, token: string) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tradier ${response.status}: ${text.slice(0, 250)}`);
  }
  return response.json();
}

function arr<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = Deno.env.get('TRADIER_TOKEN');
    if (!token) return json({ error: 'TRADIER_TOKEN is not configured' }, 503);

    const body = await req.json();
    const profile = body.profile as Profile;
    const openTickers: string[] = (body.openTickers || []).map((x: string) => x.toUpperCase());
    if (!profile) return json({ error: 'Missing strategy profile' }, 400);

    const symbols = (Deno.env.get('CSP_SCAN_SYMBOLS') || 'SOFI,CIFR,WULF,RIVN,RIOT,RGTI,QBTS,IREN,APLD')
      .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 420);
    const fmt = (d: Date) => d.toISOString().slice(0,10);
    const candidates: any[] = [];
    let contractCount = 0;

    for (const symbol of symbols) {
      try {
        const [quoteJson, histJson, expJson] = await Promise.all([
          tradier(`/markets/quotes?symbols=${encodeURIComponent(symbol)}&greeks=false`, token),
          tradier(`/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${fmt(start)}&end=${fmt(today)}`, token),
          tradier(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true&strikes=false`, token),
        ]);

        const q = quoteJson?.quotes?.quote;
        const stockPrice = Number(q?.last || q?.close || 0);
        if (!stockPrice) continue;
        const bars: HistoryBar[] = arr(histJson?.history?.day).map((b: any) => ({
          date: b.date, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume || 0),
        }));
        const primarySupport = support(bars, stockPrice);
        const trendClass = trend(bars);

        const expirations = arr<string>(expJson?.expirations?.date);
        // Favor longer-dated options for the user's 120-day recycle approach without limiting DTE to 120.
        const chosen = expirations.slice(-3);

        for (const expiration of chosen) {
          const chainJson = await tradier(`/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`, token);
          const options = arr<any>(chainJson?.options?.option).filter((o) => o.option_type === 'put');
          for (const o of options) {
            contractCount++;
            const strike = Number(o.strike || 0), bid = Number(o.bid || 0), ask = Number(o.ask || 0);
            if (!strike || !bid || !ask) continue;
            const dte = Math.max(0, Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86400000));
            const mid = (bid + ask) / 2;
            const sp = spreadPct(bid, ask);
            const volume = Number(o.volume || 0), oi = Number(o.open_interest || 0);
            const iv = Number(o.greeks?.mid_iv || o.greeks?.smv_vol || 0) * (Number(o.greeks?.mid_iv || o.greeks?.smv_vol || 0) <= 3 ? 100 : 1);
            const delta = Number(o.greeks?.delta || 0);
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
            const netProfit = best?.netProfit ?? ((mid-btc)*100-profile.round_trip_commission);
            const netCroi = best?.netCroi ?? netProfit/(strike*100)*100;
            const pc = best?.pc ?? (mid-btc)/mid*100;
            if (pc > profile.max_premium_capture && !reasons.includes('PC too high')) reasons.push('PC too high');

            candidates.push({
              scan_date: fmt(today), ticker: symbol, company_name: q?.description || symbol, stock_price: Number(stockPrice.toFixed(2)),
              strike, expiration, dte, bid, ask, mid: Number(mid.toFixed(2)), spread_pct: Number(sp.toFixed(1)), iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
              volume, open_interest: oi, volume_classification: volClass(volume), trend_classification: trendClass, primary_support: Number(primarySupport.toFixed(2)),
              suggested_sto: Number(mid.toFixed(2)), suggested_btc: Number(btc.toFixed(2)), net_profit: Number(netProfit.toFixed(2)), net_croi: Number(netCroi.toFixed(2)),
              premium_capture: Number(pc.toFixed(1)), breakeven: Number((strike-mid).toFixed(2)), qualified: reasons.length === 0, rejection_reasons: reasons,
              strategy_profile_id: profile.id,
              strike_distance_from_stock: Number(((stockPrice-strike)/stockPrice*100).toFixed(1)),
              strike_distance_from_support: Number(((primarySupport-strike)/primarySupport*100).toFixed(1)),
            });
          }
        }
      } catch (e) {
        console.error(`scan failed for ${symbol}`, e);
      }
    }

    candidates.sort((a,b) => Number(b.qualified)-Number(a.qualified) || a.spread_pct-b.spread_pct || b.net_croi-a.net_croi);
    return json({ candidates, source: 'tradier', scanned_at: new Date().toISOString(), symbols_scanned: symbols.length, contracts_scanned: contractCount });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Market scan failed' }, 500);
  }
});
