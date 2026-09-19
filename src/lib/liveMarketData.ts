import {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { CandidateScan, StrategyProfile } from '@/types';

export interface ScanCounts {
  symbols_in_universe: number;
  symbols_requested: number;
  symbols_returned: number;
  symbols_failed: number;
  puts_returned: number;
  missing_bid: number;
  missing_ask: number;
  zero_bid: number;
  zero_ask: number;
  missing_strike: number;
  missing_expiration: number;
  valid_quotes: number;
  contracts_evaluated: number;
  qualified: number;
  rejected: number;
  pages_fetched: number;
}

export interface LiveScanResponse {
  success: true;
  candidates: CandidateScan[];
  source: 'massive';
  scanned_at: string;
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

export interface AnalyzeTickerResponse {
  success: true;
  ticker: string;
  stock_price: number;
  trend: string;
  primary_support: number;
  secondary_support: number;
  resistance: number;
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
  pass_fail: { rule: string; pass: boolean }[];
}

export async function analyzeTicker(
  ticker: string,
  profile: StrategyProfile,
): Promise<AnalyzeTickerResponse> {
  const { data, error } = await supabase.functions.invoke('analyze-ticker', {
    body: { ticker, profile },
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

  return data as AnalyzeTickerResponse;
}

export async function scanCandidatesLive(
  profile: StrategyProfile,
  openTickers: string[],
  scanUniverse: string[],
): Promise<LiveScanResponse> {
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: {
      profile,
      openTickers,
      scanUniverse,
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

  return data as LiveScanResponse;
}
