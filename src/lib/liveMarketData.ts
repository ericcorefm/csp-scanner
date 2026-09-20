import {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { CandidateScan, StrategyProfile } from '@/types';

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
  pages_fetched: number;
  contracts_found: number;
}

export interface LiveScanResponse {
  success: true;
  candidates: CandidateScan[];
  source: 'barchart';
  scanned_at: string;
  scan_mode: ScanMode;
  no_filter_mode: boolean;
  scan_counts: ScanCounts;
  raw_sample?: unknown;
}

export interface BarchartApiError {
  success: false;
  provider?: string;
  stage?: string;
  symbol?: string;
  endpoint?: string;
  status?: number;
  barchartStatus?: number;
  barchartBody?: string;
  error?: string;
}

function isBarchartApiError(data: unknown): data is BarchartApiError {
  return typeof data === 'object' && data !== null && (data as any).success === false;
}

function formatBarchartError(d: BarchartApiError): string {
  const symbol = d.symbol || 'unknown';
  const stage = d.stage ? ` [${d.stage}]` : '';
  const status = d.barchartStatus ?? d.status ?? 0;
  const body = d.barchartBody || d.error || 'Unknown error';
  return `Barchart ${symbol}${stage} HTTP ${status}:\n${body}`;
}

export interface TechnicalData {
  rsi: number;
  ma20: number;
  ma50: number;
  ma200: number;
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
  pass_fail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[];
  has_quotes?: boolean;
  strike_distance_from_stock?: number | null;
  strike_distance_from_support?: number | null;
}


export async function analyzeTicker(
  ticker: string,
  profile: StrategyProfile,
): Promise<AnalyzeTickerResponse> {
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: { mode: 'analyze', ticker, profile },
  });

  if (error instanceof FunctionsHttpError) {
    const ctx = (error as any).context as Response | undefined;
    if (ctx) {
      try {
        const body = await ctx.json();
        if (body && body.success === false) {
          const symbol = body.symbol || ticker;
          const stage = body.stage ? ` [${body.stage}]` : '';
          const status = body.barchartStatus || body.status || 0;
          const msg = body.barchartBody || body.error || 'Unknown error';
          throw new Error(`Barchart ${symbol}${stage} HTTP ${status}:\n${msg}`);
        }
        const msg = (body as any)?.error || (body as any)?.message || JSON.stringify(body);
        throw new Error(`Barchart HTTP ${ctx.status}:\n${msg}`);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith('Barchart ')) throw parseErr;
        try {
          const text = await ctx.text();
          throw new Error(`Barchart HTTP ${ctx.status}:\n${text}`);
        } catch {
          throw new Error(`Barchart HTTP ${ctx.status}:\n${error.message}`);
        }
      }
    }
    throw new Error(`Barchart HTTP error: ${error.message}`);
  }

  if (error instanceof FunctionsRelayError) {
    throw new Error(`Barchart relay error: ${error.message}`);
  }

  if (error instanceof FunctionsFetchError) {
    throw new Error(`Barchart fetch error: ${error.message}`);
  }

  if (error) {
    throw new Error(error.message || 'Analyze ticker failed');
  }

  if (!data || data.success === false) {
    const msg = (data as any)?.error || 'Analyze ticker returned an error';
    throw new Error(msg);
  }

  return data as AnalyzeTickerResponse;
}

export async function scanCandidatesLive(
  profile: StrategyProfile,
  openTickers: string[],
  scanMode: ScanMode,
): Promise<LiveScanResponse> {
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: {
      profile,
      openTickers,
      scanMode,
    },
  });

  if (error instanceof FunctionsRelayError) {
    throw new Error(`Barchart relay error: ${error.message}`);
  }

  if (error instanceof FunctionsFetchError) {
    throw new Error(`Barchart fetch error: ${error.message}`);
  }

  if (error instanceof FunctionsHttpError) {
    const ctx = (error as any).context as Response | undefined;
    if (ctx) {
      try {
        const body = await ctx.json();
        if (isBarchartApiError(body)) {
          throw new Error(formatBarchartError(body));
        }
        const msg = (body as any)?.error || (body as any)?.message || JSON.stringify(body);
        throw new Error(`Barchart HTTP ${ctx.status}:\n${msg}`);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith('Barchart ')) {
          throw parseErr;
        }
        try {
          const text = await ctx.text();
          throw new Error(`Barchart HTTP ${ctx.status}:\n${text}`);
        } catch {
          throw new Error(`Barchart HTTP ${ctx.status}:\n${error.message}`);
        }
      }
    }
    throw new Error(`Barchart HTTP error: ${error.message}`);
  }

  if (error) {
    throw new Error(error.message || 'Live market scan failed');
  }

  if (isBarchartApiError(data)) {
    throw new Error(formatBarchartError(data));
  }

  if (!data || !Array.isArray(data.candidates)) {
    throw new Error('Live market scan returned an invalid response');
  }

  return data as LiveScanResponse;
}
