import { supabase } from '@/lib/supabase';
import type { CandidateScan, StrategyProfile } from '@/types';

export interface LiveScanResponse {
  candidates: CandidateScan[];
  source: 'massive';
  scanned_at: string;
  symbols_scanned: number;
  contracts_scanned: number;
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

  if (!data || !Array.isArray(data.candidates)) {
    throw new Error('Live market scan returned an invalid response');
  }

  return data as LiveScanResponse;
}
