import {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { CandidateScan, StrategyProfile, PremiumSource } from '@/types';

export type ScanMode = 'discovery' | 'universe';

export interface ScanCounts {
  symbols_in_universe: number;
  symbols_returned: number;
  symbols_failed: number;
  symbols_with_chains: number;
  puts_returned: number;
  filtered_by_expiration: number;
  filtered_by_strike: number;
  valid_quotes: number;
  contracts_awaiting_quotes: number;
  contracts_evaluated: number;
  qualified: number;
  rejected: number;
  pending?: number;
  pages_fetched: number;
  contracts_found: number;
  rejection_breakdown?: Record<string, number>;
  unique_qualified_tickers?: number;
  technical_rejections?: {
    rsi_below_min: number;
    rsi_above_max: number;
    ma20_not_above_ma50: number;
    ma50_not_above_ma200: number;
    price_not_above_ma200: number;
    downtrend_no_support: number;
    support_dist_below_min: number;
    support_dist_above_max: number;
    technical_data_missing: number;
  };
  order_strike_rejections?: {
    stock_below_min: number;
    stock_above_max: number;
    strike_above_max: number;
  };
  technical_cache?: {
    tickers_with_60_plus_bars: number;
    tickers_with_200_plus_bars: number;
    tickers_missing_history: number;
    history_fetched_this_scan?: number;
    still_pending_history?: number;
    massive_history_403?: number;
    massive_history_429?: number;
    cache_save_failures?: number;
    warm_diagnostics?: { ticker: string; cachedBars: number; requiredBars: number; fetchAttempted: boolean; fetchStatus: string; finalBars: number }[];
  };
  closest_matches?: ClosestMatch[];
  support_distance_debug?: SupportDistanceDebugCounts;
}

export interface SupportDistanceDebugCounts {
  before: number;
  passed: number;
  below_min: number;
  above_max: number;
  missing_support: number;
  details: SupportDistanceDebugEntry[];
}

export interface SupportDistanceDebugEntry {
  ticker: string;
  strike: number;
  primarySupport: number | null;
  supportDistancePct: number | null;
  passesMin: boolean;
  passesMax: boolean;
  finalSupportDistancePass: boolean;
  status: 'pass' | 'fail_below_min' | 'fail_above_max' | 'pending_missing_support';
}

export interface ClosestMatch {
  ticker: string;
  price: number | null;
  strike: number;
  rsi: number | null;
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  primary_support: number | null;
  support_distance: number | null;
  net_croi: number;
  premium_capture: number;
  open_interest: number;
  volume: number;
  failed_rules: string[];
}

export interface LiveScanResponse {
  success: true;
  candidates: CandidateScan[];
  source: 'massive';
  scanned_at: string;
  scan_mode: ScanMode;
  no_filter_mode: boolean;
  scan_counts: ScanCounts;
  raw_sample?: unknown;
}

export interface MassiveApiError {
  success: false;
  provider?: string;
  stage?: string;
  symbol?: string;
  endpoint?: string;
  status?: number;
  massiveStatus?: number;
  massiveBody?: string;
  error?: string;
}

function isMassiveApiError(data: unknown): data is MassiveApiError {
  return typeof data === 'object' && data !== null && (data as any).success === false;
}

function formatMassiveError(d: MassiveApiError): string {
  const symbol = d.symbol || 'unknown';
  const stage = d.stage ? ` [${d.stage}]` : '';
  const status = d.massiveStatus ?? d.status ?? 0;
  const body = d.massiveBody || d.error || 'Unknown error';
  return `Massive ${symbol}${stage} HTTP ${status}:\n${body}`;
}

export interface TechnicalData {
  rsi: number;
  ma20: number;
  ma50: number;
  ma200: number | null;
  macd: number;
  macd_signal: number;
  macd_histogram: number;
  bb_upper: number;
  bb_middle: number;
  bb_lower: number;
  bb_position: string;
  volume_trend: string;
}

export interface AnalyzeTickerResponse {
  success: true;
  ticker: string;
  stock_price: number | null;
  stock_source?: string;
  trend: string;
  primary_support: number | null;
  secondary_support: number | null;
  resistance: number | null;
  technical_data_available?: boolean;
  technical_warning?: string | null;
  technical?: TechnicalData | null;
  qualifies: boolean;
  best_contract: ContractAnalysis | null;
  other_qualifying_contracts: ContractAnalysis[];
  all_qualifying_contracts: ContractAnalysis[];
  all_analyzed_contracts?: ContractAnalysis[];
  all_contracts_count: number;
  qualifying_count: number;
}

export interface ContractAnalysis {
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
  technical_pending?: boolean;
  pass_fail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[];
  has_quotes?: boolean;
  premium_source?: PremiumSource;
  strike_distance_from_stock?: number | null;
  strike_distance_from_support?: number | null;
}


// ── Normalize API responses: convert undefined/NaN numeric fields to null ──
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function normalizeContract(c: any): ContractAnalysis {
  return {
    strike: typeof c?.strike === 'number' ? c.strike : 0,
    expiration: c?.expiration ?? '',
    dte: typeof c?.dte === 'number' ? c.dte : 0,
    bid: num(c?.bid) ?? 0,
    ask: num(c?.ask) ?? 0,
    mid: num(c?.mid) ?? 0,
    spread_pct: num(c?.spread_pct) ?? 0,
    iv: num(c?.iv) ?? 0,
    delta: num(c?.delta) ?? 0,
    volume: typeof c?.volume === 'number' ? c.volume : 0,
    open_interest: typeof c?.open_interest === 'number' ? c.open_interest : 0,
    volume_classification: c?.volume_classification ?? 'Very Thin',
    suggested_sto: num(c?.suggested_sto) ?? 0,
    suggested_btc: num(c?.suggested_btc) ?? 0,
    net_profit: num(c?.net_profit) ?? 0,
    net_croi: num(c?.net_croi) ?? 0,
    premium_capture: num(c?.premium_capture) ?? 0,
    breakeven: num(c?.breakeven) ?? 0,
    qualified: !!c?.qualified,
    technical_pending: c?.technical_pending,
    pass_fail: Array.isArray(c?.pass_fail) ? c.pass_fail : [],
    has_quotes: c?.has_quotes,
    premium_source: c?.premium_source,
    strike_distance_from_stock: num(c?.strike_distance_from_stock),
    strike_distance_from_support: num(c?.strike_distance_from_support),
  };
}

function normalizeAnalyzeResponse(data: any): AnalyzeTickerResponse {
  const technical: TechnicalData | null = data.technical ? {
    rsi: num(data.technical.rsi) ?? 0,
    ma20: num(data.technical.ma20) ?? 0,
    ma50: num(data.technical.ma50) ?? 0,
    ma200: num(data.technical.ma200),
    macd: num(data.technical.macd) ?? 0,
    macd_signal: num(data.technical.macd_signal) ?? 0,
    macd_histogram: num(data.technical.macd_histogram) ?? 0,
    bb_upper: num(data.technical.bb_upper) ?? 0,
    bb_middle: num(data.technical.bb_middle) ?? 0,
    bb_lower: num(data.technical.bb_lower) ?? 0,
    bb_position: data.technical.bb_position ?? 'Insufficient data',
    volume_trend: data.technical.volume_trend ?? 'Insufficient data',
  } : null;

  return {
    success: true,
    ticker: data.ticker ?? '',
    stock_price: num(data.stock_price),
    stock_source: data.stock_source,
    trend: data.trend ?? 'Pending',
    primary_support: num(data.primary_support),
    secondary_support: num(data.secondary_support),
    resistance: num(data.resistance),
    technical_data_available: data.technical_data_available,
    technical_warning: data.technical_warning,
    technical,
    qualifies: !!data.qualifies,
    best_contract: data.best_contract ? normalizeContract(data.best_contract) : null,
    other_qualifying_contracts: Array.isArray(data.other_qualifying_contracts)
      ? data.other_qualifying_contracts.map(normalizeContract) : [],
    all_qualifying_contracts: Array.isArray(data.all_qualifying_contracts)
      ? data.all_qualifying_contracts.map(normalizeContract) : [],
    all_analyzed_contracts: Array.isArray(data.all_analyzed_contracts)
      ? data.all_analyzed_contracts.map(normalizeContract)
      : Array.isArray(data.all_qualifying_contracts)
        ? data.all_qualifying_contracts.map(normalizeContract) : [],
    all_contracts_count: typeof data.all_contracts_count === 'number' ? data.all_contracts_count : 0,
    qualifying_count: typeof data.qualifying_count === 'number' ? data.qualifying_count : 0,
  };
}

export async function analyzeTicker(
  ticker: string,
  profile: StrategyProfile,
  knownStockPrice?: number | null,
): Promise<AnalyzeTickerResponse> {
  // Route through market-scan edge function with mode=analyze.
  // Pass any price already known from Today's Candidates so Analyze does not
  // need another Stocks Basic request just to rediscover the same daily close.
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: {
      mode: 'analyze',
      ticker,
      profile,
      knownStockPrice:
        typeof knownStockPrice === 'number' && Number.isFinite(knownStockPrice) && knownStockPrice > 0
          ? knownStockPrice
          : null,
    },
  });

  if (error instanceof FunctionsHttpError) {
    const ctx = (error as any).context as Response | undefined;
    if (ctx) {
      try {
        const body = await ctx.json();
        if (body && body.success === false) {
          const symbol = body.symbol || ticker;
          const stage = body.stage ? ` [${body.stage}]` : '';
          const status = body.massiveStatus || body.status || 0;
          const msg = body.massiveBody || body.error || 'Unknown error';
          throw new Error(`Massive ${symbol}${stage} HTTP ${status}:\n${msg}`);
        }
        const msg = (body as any)?.error || (body as any)?.message || JSON.stringify(body);
        throw new Error(`Massive HTTP ${ctx.status}:\n${msg}`);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith('Massive ')) throw parseErr;
        try {
          const text = await ctx.text();
          throw new Error(`Massive HTTP ${ctx.status}:\n${text}`);
        } catch {
          throw new Error(`Massive HTTP ${ctx.status}:\n${error.message}`);
        }
      }
    }
    throw new Error(`Massive HTTP error: ${error.message}`);
  }

  if (error instanceof FunctionsRelayError) {
    throw new Error(`Massive relay error: ${error.message}`);
  }

  if (error instanceof FunctionsFetchError) {
    throw new Error(`Massive fetch error: ${error.message}`);
  }

  if (error) {
    throw new Error(error.message || 'Analyze ticker failed');
  }

  if (!data || data.success === false) {
    const msg = (data as any)?.error || 'Analyze ticker returned an error';
    throw new Error(msg);
  }

  return normalizeAnalyzeResponse(data);
}

function normalizeCandidateScan(c: any): CandidateScan {
  return {
    id: c?.id,
    scan_date: c?.scan_date ?? new Date().toISOString().split('T')[0],
    ticker: c?.ticker ?? '',
    company_name: c?.company_name ?? '',
    stock_price: num(c?.stock_price),
    stock_source: c?.stock_source,
    strike: typeof c?.strike === 'number' ? c.strike : 0,
    expiration: c?.expiration ?? '',
    dte: typeof c?.dte === 'number' ? c.dte : 0,
    bid: num(c?.bid) ?? 0,
    ask: num(c?.ask) ?? 0,
    mid: num(c?.mid) ?? 0,
    spread_pct: num(c?.spread_pct) ?? 0,
    iv: num(c?.iv) ?? 0,
    delta: num(c?.delta) ?? 0,
    volume: typeof c?.volume === 'number' ? c.volume : 0,
    open_interest: typeof c?.open_interest === 'number' ? c.open_interest : 0,
    volume_classification: c?.volume_classification ?? 'Very Thin',
    trend_classification: c?.trend_classification ?? 'Pending',
    primary_support: num(c?.primary_support),
    secondary_support: num(c?.secondary_support),
    resistance: num(c?.resistance),
    suggested_sto: num(c?.suggested_sto) ?? 0,
    suggested_btc: num(c?.suggested_btc) ?? 0,
    net_profit: num(c?.net_profit) ?? 0,
    net_croi: num(c?.net_croi) ?? 0,
    premium_capture: num(c?.premium_capture) ?? 0,
    breakeven: num(c?.breakeven) ?? 0,
    qualified: !!c?.qualified,
    technical_pending: c?.technical_pending,
    rejection_reasons: Array.isArray(c?.rejection_reasons) ? c.rejection_reasons : [],
    pending_reasons: Array.isArray(c?.pending_reasons) ? c.pending_reasons : [],
    pass_fail: Array.isArray(c?.pass_fail) ? c.pass_fail : [],
    strategy_profile_id: c?.strategy_profile_id,
    strike_distance_from_stock: num(c?.strike_distance_from_stock),
    strike_distance_from_support: num(c?.strike_distance_from_support),
    has_quotes: !!c?.has_quotes,
    premium_source: c?.premium_source,
  };
}

export async function scanCandidatesLive(
  profile: StrategyProfile,
  openTickers: string[],
  scanMode: ScanMode,
  symbols?: string[],
): Promise<LiveScanResponse> {
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: {
      profile,
      openTickers,
      scanMode,
      ...(scanMode === 'universe' && symbols && symbols.length > 0 ? { symbols } : {}),
    },
  });

  // FunctionsRelayError — Supabase relay layer failed
  if (error instanceof FunctionsRelayError) {
    throw new Error(`Massive relay error: ${error.message}`);
  }

  // FunctionsFetchError — network-level failure to reach the edge function
  if (error instanceof FunctionsFetchError) {
    throw new Error(`Massive fetch error: ${error.message}`);
  }

  // FunctionsHttpError — edge function returned a non-2xx status.
  // Read the actual response body from error.context instead of the generic message.
  if (error instanceof FunctionsHttpError) {
    const ctx = (error as any).context as Response | undefined;
    if (ctx) {
      try {
        const body = await ctx.json();
        if (isMassiveApiError(body)) {
          throw new Error(formatMassiveError(body));
        }
        const msg = (body as any)?.error || (body as any)?.message || JSON.stringify(body);
        throw new Error(`Massive HTTP ${ctx.status}:\n${msg}`);
      } catch (parseErr) {
        // Re-throw if we already formatted a Massive error above
        if (parseErr instanceof Error && parseErr.message.startsWith('Massive ')) {
          throw parseErr;
        }
        // JSON parse failed — try reading as plain text
        try {
          const text = await ctx.text();
          throw new Error(`Massive HTTP ${ctx.status}:\n${text}`);
        } catch {
          throw new Error(`Massive HTTP ${ctx.status}:\n${error.message}`);
        }
      }
    }
    throw new Error(`Massive HTTP error: ${error.message}`);
  }

  // Generic error fallback
  if (error) {
    throw new Error(error.message || 'Live market scan failed');
  }

  // Edge function always returns HTTP 200 now, so errors come through as data.
  if (isMassiveApiError(data)) {
    throw new Error(formatMassiveError(data));
  }

  if (!data || !Array.isArray(data.candidates)) {
    throw new Error('Live market scan returned an invalid response');
  }

  return {
    ...data,
    candidates: data.candidates.map(normalizeCandidateScan),
  } as LiveScanResponse;
}
