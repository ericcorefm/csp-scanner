// Supabase Edge Function: analyze-ticker
// Requires secret: MASSIVE_API_KEY
// Analyzes a single ticker through the active CSP profile rules.
// Reuses the same Massive API endpoints and CSP screening logic as market-scan.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';

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
};

type HistoryBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function massiveFetch(path: string, apiKey: string, symbol: string, stage: string): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const url = `${MASSIVE_API}${path}`;
  const ts = new Date().toISOString();
  console.log(`[Massive] ${symbol} | stage=${stage} | type=GET | url=${url} | ts=${ts}`);

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

function findResistance(bars: HistoryBar[]): number {
  const recent = bars.slice(-50);
  let max = 0;
  for (const b of recent) { if (b.high > max) max = b.high; }
  return max;
}

function calcPrimarySupport(bars: HistoryBar[], price: number): number {
  const lows = findSwingLows(bars);
  const below = lows.filter((x) => x < price);
  return below[0] || Math.min(...bars.slice(-20).map((b) => b.low));
}

function calcSecondarySupport(bars: HistoryBar[], primarySupport: number): number {
  const lows = findSwingLows(bars);
  const below = lows.filter((x) => x < primarySupport);
  return below[0] || primarySupport * 0.95;
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

function spreadPct(bid: number, ask: number) {
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid * 100 : 999;
}

function volClass(v: number) {
  if (v >= 250) return 'Excellent'; if (v >= 100) return 'Very Good'; if (v >= 50) return 'Good';
  if (v >= 25) return 'Meaningful'; if (v >= 10) return 'Thin'; return 'Very Thin';
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

type ContractAnalysis = {
  strike: number;
  expiration: string;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  spread_pct: number;
  iv: number;
  delta: number;
  volume: number;
  open_interest: number;
  volume_classification: string;
  suggested_sto: number;
  suggested_btc: number;
  net_profit: number;
  net_croi: number;
  premium_capture: number;
  breakeven: number;
  qualified: boolean;
  pass_fail: { rule: string; pass: boolean }[];
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  console.log('analyze-ticker started');
  console.log('MASSIVE_API_KEY exists:', Boolean(Deno.env.get('MASSIVE_API_KEY')));

  try {
    const apiKey = Deno.env.get('MASSIVE_API_KEY');
    if (!apiKey) {
      return json({ success: false, error: 'MASSIVE_API_KEY is not configured' });
    }

    const body = await req.json().catch(() => ({}));
    const ticker = String(body.ticker || '').toUpperCase().trim();
    const profile = body.profile as Profile | undefined;

    if (!ticker) return json({ success: false, error: 'Missing ticker' });
    if (!profile) return json({ success: false, error: 'Missing strategy profile' });

    console.log(`Analyzing ticker: ${ticker}`);

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 420);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // Step 1: Stock aggregates
    const histPath = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fmt(start)}/${fmt(today)}`;
    const histResult = await massiveFetch(histPath, apiKey, ticker, 'stock_aggregates');

    if (!histResult.ok) {
      return json({
        success: false,
        stage: 'stock_aggregates',
        provider: 'Massive',
        symbol: ticker,
        massiveStatus: histResult.status,
        massiveBody: histResult.body,
      });
    }

    const bars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
      date: new Date(b.t).toISOString().slice(0, 10),
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
    }));

    if (!bars.length) {
      return json({ success: false, error: `No price history returned for ${ticker}` });
    }

    const stockPrice = Number(bars.at(-1)!.close);
    const primarySupport = calcPrimarySupport(bars, stockPrice);
    const secondarySupport = calcSecondarySupport(bars, primarySupport);
    const resistance = findResistance(bars);
    const trendClass = trend(bars);

    // Step 2: Options chain snapshot
    const chainPath = `/v3/snapshot/options/${encodeURIComponent(ticker)}?contract_type=put`;
    const chainResult = await massiveFetch(chainPath, apiKey, ticker, 'options_snapshot');

    if (!chainResult.ok) {
      return json({
        success: false,
        stage: 'options_snapshot',
        provider: 'Massive',
        symbol: ticker,
        massiveStatus: chainResult.status,
        massiveBody: chainResult.body,
      });
    }

    const contracts = (chainResult.data?.results || []).filter(
      (c: any) => c?.details?.contract_type === 'put',
    );

    // ── Expiration filtering ──
    const allExpirations = [...new Set(contracts.map((c: any) => c.details.expiration_date))].sort();
    let chosenExpirations: string[];

    if (profile.preferred_expirations && profile.preferred_expirations.length > 0) {
      chosenExpirations = allExpirations.filter((e) => profile.preferred_expirations.includes(e));
      console.log(`[Massive] ${ticker} — filtering to preferred expirations: ${chosenExpirations.join(', ')}`);
    } else {
      chosenExpirations = allExpirations.filter((e) => {
        const dte = Math.ceil((new Date(e).getTime() - today.getTime()) / 86400000);
        return dte >= (profile.min_dte || 0) && dte <= (profile.max_dte || 9999);
      });
      console.log(`[Massive] ${ticker} — filtering to DTE ${profile.min_dte}-${profile.max_dte}: ${chosenExpirations.length} expirations`);
    }

    let filteredContracts = contracts.filter((c: any) =>
      chosenExpirations.includes(c.details.expiration_date),
    );

    // ── Strike filtering ──
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

    console.log(`[Massive] ${ticker} — ${contracts.length} put contracts, ${filteredContracts.length} in chosen expirations`);

    const analyses: ContractAnalysis[] = [];

    for (const c of filteredContracts) {
      const strike = Number(c.details.strike_price || 0);
      const bid = Number(c.last_quote?.bid || 0);
      const ask = Number(c.last_quote?.ask || 0);
      if (!strike || !bid || !ask) continue;

      const expiration = c.details.expiration_date as string;
      const dte = Math.max(0, Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86400000));
      const mid = (bid + ask) / 2;
      const sp = spreadPct(bid, ask);
      const volume = Number(c.volume || 0);
      const oi = Number(c.open_interest || 0);
      const iv = Number(c.implied_volatility || 0) * 100;
      const delta = Number(c.greeks?.delta || 0);
      const best = optimize(mid, strike, profile, true);

      const btc = best?.btc || 0.01;
      const netProfit = best?.netProfit ?? ((mid - btc) * 100 - profile.round_trip_commission);
      const netCroi = best?.netCroi ?? netProfit / (strike * 100) * 100;
      const pc = best?.pc ?? (mid - btc) / mid * 100;

      // Build pass/fail list — same rules as market-scan
      const passFail: { rule: string; pass: boolean }[] = [
        { rule: `Strike <= $${profile.max_strike}`, pass: strike <= profile.max_strike },
        { rule: `Net CROI >= ${profile.min_net_croi}%`, pass: netCroi >= profile.min_net_croi },
        { rule: `Premium Capture <= ${profile.max_premium_capture}%`, pass: pc <= profile.max_premium_capture },
        { rule: `OI >= ${profile.min_target_oi}`, pass: oi >= profile.min_target_oi },
        { rule: `Spread acceptable (<= ${profile.max_spread_pct}%)`, pass: sp <= profile.max_spread_pct },
        { rule: `Strike below support ($${primarySupport.toFixed(2)})`, pass: strike < primarySupport },
        { rule: `Trend acceptable (${trendClass})`, pass: !(profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && strike >= primarySupport) },
        { rule: `Sufficient liquidity (volume >= 10)`, pass: volume >= 10 },
      ];

      const qualified = passFail.every((r) => r.pass);

      analyses.push({
        strike, expiration, dte, bid, ask, mid: Number(mid.toFixed(2)),
        spread_pct: Number(sp.toFixed(1)), iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
        volume, open_interest: oi, volume_classification: volClass(volume),
        suggested_sto: Number(mid.toFixed(2)), suggested_btc: Number(btc.toFixed(2)),
        net_profit: Number(netProfit.toFixed(2)), net_croi: Number(netCroi.toFixed(2)),
        premium_capture: Number(pc.toFixed(1)), breakeven: Number((strike - mid).toFixed(2)),
        qualified, pass_fail: passFail,
      });
    }

    // Choose the best qualifying contract:
    // 1. Meets CROI, PC, strike <= max, spread acceptable
    // 2. Prefer strike below support
    // 3. Tighter spread
    // 4. Stronger OI
    // 5. Better daily volume
    // 6. Lower delta when otherwise similar
    const qualifying = analyses.filter((a) => a.qualified);
    qualifying.sort((a, b) => {
      const aBelowSupport = a.strike < primarySupport ? 0 : 1;
      const bBelowSupport = b.strike < primarySupport ? 0 : 1;
      if (aBelowSupport !== bBelowSupport) return aBelowSupport - bBelowSupport;
      if (a.spread_pct !== b.spread_pct) return a.spread_pct - b.spread_pct;
      if (a.open_interest !== b.open_interest) return b.open_interest - a.open_interest;
      if (a.volume !== b.volume) return b.volume - a.volume;
      return Math.abs(a.delta) - Math.abs(b.delta);
    });

    const bestContract = qualifying[0] || null;
    const otherContracts = qualifying.slice(1);
    const anyQualified = qualifying.length > 0;

    // Return all qualifying contracts for frontend grouping by expiration
    const allQualifyingContracts = qualifying;

    console.log(`analyze-ticker complete — ${analyses.length} contracts analyzed, ${qualifying.length} qualified`);

    return json({
      success: true,
      ticker,
      stock_price: Number(stockPrice.toFixed(2)),
      trend: trendClass,
      primary_support: Number(primarySupport.toFixed(2)),
      secondary_support: Number(secondarySupport.toFixed(2)),
      resistance: Number(resistance.toFixed(2)),
      qualifies: anyQualified,
      best_contract: bestContract,
      other_qualifying_contracts: otherContracts,
      all_qualifying_contracts: allQualifyingContracts,
      all_contracts_count: analyses.length,
      qualifying_count: qualifying.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Analyze ticker failed';
    console.error(`analyze-ticker fatal error: ${msg}`);
    return json({ success: false, error: msg });
  }
});
