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

  if (error) {
    throw new Error(error.message || 'Live market scan failed');
  }

  if (isMassiveApiError(data)) {
    const detail = data.symbol
      ? `Massive API error for ${data.symbol} (HTTP ${data.status}): ${data.error}`
      : `Massive API error (HTTP ${data.status}): ${data.error}`;
    throw new Error(detail);
  }

  if (!data || !Array.isArray(data.candidates)) {
    throw new Error('Live market scan returned an invalid response');
  }

  return data as LiveScanResponse;
}
