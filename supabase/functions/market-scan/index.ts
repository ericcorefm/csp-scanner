// Supabase Edge Function: market-scan
// Requires secret: MASSIVE_API_KEY (https://massive.com dashboard)
// Scans all tickers in the scan_universe table (passed from the frontend)
// and returns CSP candidates filtered by the active strategy profile.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MASSIVE_API = 'https://api.massive.com';
const MAX_CHAIN_PAGES = 10;

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

function isSectionOff(profile: Profile, key: keyof Profile): boolean {
  return profile[key] === false;
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
    const scanUniverse: string[] = (body.scanUniverse || []).map((x: string) => x.toUpperCase());

    if (!profile) {
      return json({ success: false, error: 'Missing strategy profile' });
    }

    const symbols = scanUniverse;
    console.log(`Scan universe (${symbols.length} symbols): ${symbols.join(', ')}`);

    // Determine if NO FILTER MODE is active: all strategy sections OFF + exclude existing positions OFF
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

    if (symbols.length === 0) {
      return json({
        success: true,
        candidates: [],
        source: 'massive',
        scanned_at: new Date().toISOString(),
        no_filter_mode: noFilterMode,
        scan_counts: {
          symbols_in_universe: 0,
          symbols_requested: 0,
          symbols_returned: 0,
          symbols_failed: 0,
          puts_returned: 0,
          contracts_valid_quote: 0,
          contracts_skipped_invalid: 0,
          contracts_evaluated: 0,
          qualified: 0,
          rejected: 0,
          pages_fetched: 0,
        },
      });
    }

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 420);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const candidates: any[] = [];

    let symbolsScanned = 0;
    let symbolsFailed = 0;
    let totalPutsReturned = 0;
    let totalValidQuote = 0;
    let totalSkippedInvalid = 0;
    let totalEvaluated = 0;
    let totalQualified = 0;
    let totalRejected = 0;
    let totalPagesFetched = 0;

    for (const symbol of symbols) {
      // ── Step 1: Stock aggregates ──
      const histPath = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmt(start)}/${fmt(today)}`;
      const histResult = await massiveFetch(histPath, apiKey, symbol, 'stock_aggregates');

      if (!histResult.ok) {
        console.error(`[Massive] ${symbol} — stock_aggregates failed, skipping. HTTP ${histResult.status}`);
        symbolsFailed++;
        continue;
      }

      const bars: HistoryBar[] = (histResult.data?.results || []).map((b: any) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v || 0),
      }));
      if (!bars.length) {
        console.warn(`[Massive] ${symbol} — no history bars, skipping`);
        symbolsFailed++;
        continue;
      }
      const stockPrice = Number(bars.at(-1)!.close);
      if (!stockPrice) {
        console.warn(`[Massive] ${symbol} — stock price is 0, skipping`);
        symbolsFailed++;
        continue;
      }

      const primarySupport = support(bars, stockPrice);
      const trendClass = trend(bars);

      // ── Step 2: Options chain snapshot (with pagination) ──
      let chainPath = `/v3/snapshot/options/${encodeURIComponent(symbol)}?contract_type=put`;
      const allRawContracts: any[] = [];
      let pageCount = 0;

      while (chainPath && pageCount < MAX_CHAIN_PAGES) {
        pageCount++;
        totalPagesFetched++;
        const pageResult = await massiveFetch(chainPath, apiKey, symbol, `options_snapshot_p${pageCount}`);

        if (!pageResult.ok) {
          console.error(`[Massive] ${symbol} — options_snapshot page ${pageCount} failed (HTTP ${pageResult.status}), using ${allRawContracts.length} contracts so far`);
          break;
        }

        const pageResults = pageResult.data?.results || [];
        allRawContracts.push(...pageResults);
        console.log(`[Massive] ${symbol} — page ${pageCount}: ${pageResults.length} contracts (total: ${allRawContracts.length})`);

        const nextUrl = pageResult.data?.next_url;
        if (nextUrl && typeof nextUrl === 'string' && nextUrl.length > 0) {
          try {
            const parsed = new URL(nextUrl);
            chainPath = parsed.pathname + parsed.search;
          } catch {
            chainPath = '';
          }
        } else {
          chainPath = '';
        }
      }

      const contracts = allRawContracts.filter(
        (c: any) => c?.details?.contract_type === 'put',
      );
      totalPutsReturned += contracts.length;
      console.log(`[Massive] ${symbol} — ${contracts.length} put contracts from ${pageCount} page(s)`);

      // ── Pre-filtering: expiration and strike ──
      // In NO FILTER MODE, skip ALL pre-filtering
      let filteredContracts = contracts;

      if (!noFilterMode) {
        // Expiration filtering
        const allExpirations = [...new Set(contracts.map((c: any) => c.details.expiration_date))].sort();
        let chosenExpirations: string[];

        if (isSectionOff(profile, 'expiration_enabled')) {
          chosenExpirations = allExpirations;
          console.log(`[Massive] ${symbol} — expiration section OFF, using all ${chosenExpirations.length} expirations`);
        } else if (profile.preferred_expirations && profile.preferred_expirations.length > 0) {
          chosenExpirations = allExpirations.filter((e) => profile.preferred_expirations.includes(e));
          console.log(`[Massive] ${symbol} — filtering to preferred expirations: ${chosenExpirations.join(', ')}`);
        } else {
          chosenExpirations = allExpirations.filter((e) => {
            const dte = Math.ceil((new Date(e).getTime() - today.getTime()) / 86400000);
            return dte >= (profile.min_dte || 0) && dte <= (profile.max_dte || 9999);
          });
          console.log(`[Massive] ${symbol} — filtering to DTE ${profile.min_dte}-${profile.max_dte}: ${chosenExpirations.length} expirations`);
        }

        filteredContracts = contracts.filter((c: any) =>
          chosenExpirations.includes(c.details.expiration_date),
        );

        // Strike filtering
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
        } else {
          console.log(`[Massive] ${symbol} — order/strike section OFF, not filtering by strike`);
        }
      } else {
        console.log(`[Massive] ${symbol} — NO FILTER MODE: skipping all pre-filtering`);
      }

      console.log(`[Massive] ${symbol} — ${filteredContracts.length} contracts after pre-filtering (no_filter=${noFilterMode})`);

      // ── Contract evaluation loop ──
      for (const c of filteredContracts) {
        const strike = Number(c.details.strike_price || 0);
        const bid = Number(c.last_quote?.bid || 0);
        const ask = Number(c.last_quote?.ask || 0);
        const expiration = c.details.expiration_date as string;

        // ── DATA VALIDATION (always applied, regardless of filter mode) ──
        // Only reject if essential data is unusable
        const invalidReasons: string[] = [];
        if (!strike || strike <= 0) invalidReasons.push('Missing strike');
        if (!expiration) invalidReasons.push('Missing expiration');
        if (bid <= 0) invalidReasons.push('Bid <= 0');
        if (ask <= 0) invalidReasons.push('Ask <= 0');
        if (bid > 0 && ask > 0 && ask < bid) invalidReasons.push('Ask < bid');

        if (invalidReasons.length > 0) {
          totalSkippedInvalid++;
          console.log(`[Massive] ${symbol} — skipped contract: ${invalidReasons.join(', ')} (strike=${strike}, bid=${bid}, ask=${ask})`);
          continue;
        }

        // ── Passed data validation ──
        totalValidQuote++;
        totalEvaluated++;

        const dte = Math.max(0, Math.ceil((new Date(expiration).getTime() - today.getTime()) / 86400000));
        const mid = (bid + ask) / 2;
        const sp = spreadPct(bid, ask);
        const volume = Number(c.volume || 0), oi = Number(c.open_interest || 0);
        const iv = Number(c.implied_volatility || 0) * 100;
        const delta = Number(c.greeks?.delta || 0);

        // Calculate BTC optimization (for display only — not used for rejection in no-filter mode)
        const best = optimize(mid, strike, profile, true);

        // Fallback values when no optimal BTC found
        const btc = best?.btc || 0.01;
        const netProfit = best?.netProfit ?? ((mid - btc) * 100 - profile.round_trip_commission);
        const netCroi = best?.netCroi ?? netProfit / (strike * 100) * 100;
        const pc = best?.pc ?? (mid - btc) / mid * 100;

        // ── STRATEGY FILTERING (skipped entirely in NO FILTER MODE) ──
        const reasons: string[] = [];

        if (!noFilterMode) {
          // Exclude Existing Positions — independent of section toggles
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
        if (qualified) totalQualified++; else totalRejected++;

        candidates.push({
          scan_date: fmt(today), ticker: symbol, company_name: symbol, stock_price: Number(stockPrice.toFixed(2)),
          strike, expiration, dte, bid, ask, mid: Number(mid.toFixed(2)), spread_pct: Number(sp.toFixed(1)), iv: Number(iv.toFixed(1)), delta: Number(delta.toFixed(2)),
          volume, open_interest: oi, volume_classification: volClass(volume), trend_classification: trendClass, primary_support: Number(primarySupport.toFixed(2)),
          suggested_sto: Number(mid.toFixed(2)), suggested_btc: Number(btc.toFixed(2)), net_profit: Number(netProfit.toFixed(2)), net_croi: Number(netCroi.toFixed(2)),
          premium_capture: Number(pc.toFixed(1)), breakeven: Number((strike - mid).toFixed(2)), qualified, rejection_reasons: reasons,
          strategy_profile_id: profile.id,
          strike_distance_from_stock: Number(((stockPrice - strike) / stockPrice * 100).toFixed(1)),
          strike_distance_from_support: Number(((primarySupport - strike) / primarySupport * 100).toFixed(1)),
        });
      }

      symbolsScanned++;
    }

    candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.spread_pct - b.spread_pct || b.net_croi - a.net_croi);

    const scan_counts = {
      symbols_in_universe: symbols.length,
      symbols_requested: symbols.length,
      symbols_returned: symbolsScanned,
      symbols_failed: symbolsFailed,
      puts_returned: totalPutsReturned,
      contracts_valid_quote: totalValidQuote,
      contracts_skipped_invalid: totalSkippedInvalid,
      contracts_evaluated: totalEvaluated,
      qualified: totalQualified,
      rejected: totalRejected,
      pages_fetched: totalPagesFetched,
    };

    console.log(`market-scan complete — ${candidates.length} candidates, no_filter_mode=${noFilterMode}`, JSON.stringify(scan_counts));
    return json({ success: true, candidates, source: 'massive', scanned_at: new Date().toISOString(), no_filter_mode: noFilterMode, scan_counts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Market scan failed';
    console.error(`market-scan fatal error: ${msg}`);
    return json({ success: false, provider: 'Massive', error: msg });
  }
});
