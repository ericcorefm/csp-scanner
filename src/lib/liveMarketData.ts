import {
  FunctionsHttpError,
  FunctionsFetchError,
  FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { CandidateScan, StrategyProfile } from '@/types';

export interface LiveScanResponse {
  success: true;
  candidates: CandidateScan[];
  source: 'massive';
  scanned_at: string;
  symbols_scanned: number;
  contracts_scanned: number;
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

export async function scanCandidatesLive(
  profile: StrategyProfile,
  openTickers: string[],
): Promise<LiveScanResponse> {
  const { data, error } = await supabase.functions.invoke('market-scan', {
    body: {
      profile,
      openTickers,
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
