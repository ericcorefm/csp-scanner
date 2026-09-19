import { FunctionsHttpError } from '@supabase/supabase-js';
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
  provider: 'Massive';
  symbol?: string;
  endpoint?: string;
  status: number;
  error: string;
}

function isMassiveApiError(data: unknown): data is MassiveApiError {
  return typeof data === 'object' && data !== null && (data as any).success === false && (data as any).provider === 'Massive';
}

function formatMassiveError(err: MassiveApiError): string {
  const symbol = err.symbol || 'unknown';
  return `Massive ${symbol} HTTP ${err.status}:\n${err.error}`;
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
        if (parseErr instanceof Error && parseErr.message.startsWith('Massive ')) {
          throw parseErr;
        }
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

  if (error) {
    throw new Error(error.message || 'Live market scan failed');
  }

  if (isMassiveApiError(data)) {
    throw new Error(formatMassiveError(data));
  }

  if (!data || !Array.isArray(data.candidates)) {
    throw new Error('Live market scan returned an invalid response');
  }

  return data as LiveScanResponse;
}
