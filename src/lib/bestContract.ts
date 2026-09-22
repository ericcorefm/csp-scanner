import type { CandidateScan } from '@/types';

type StatusPriority = 0 | 1 | 2;

function statusPriority(c: CandidateScan): StatusPriority {
  if (c.qualified && !c.technical_pending) return 0;
  if (c.qualified && c.technical_pending) return 1;
  return 2;
}

/**
 * Groups contracts by ticker and returns exactly one best contract per ticker.
 *
 * Sort order within each ticker group:
 *   1. Qualification status: qualified > pending > rejected
 *   2. Highest option volume
 *   3. Lowest Premium Capture %
 *   4. Highest Net CROI
 *   5. Highest Open Interest
 *
 * All contracts are kept in state for Analyze Ticker / Detail — this helper
 * only controls which single contract is displayed on Today's Candidates.
 */
export function selectBestContractPerTicker(contracts: CandidateScan[]): CandidateScan[] {
  const grouped = new Map<string, CandidateScan[]>();

  for (const contract of contracts) {
    const ticker = contract.ticker;
    const arr = grouped.get(ticker);
    if (arr) {
      arr.push(contract);
    } else {
      grouped.set(ticker, [contract]);
    }
  }

  const result: CandidateScan[] = [];

  for (const group of grouped.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const sorted = [...group].sort((a, b) => {
      const spA = statusPriority(a);
      const spB = statusPriority(b);
      if (spA !== spB) return spA - spB;

      const volA = a.volume ?? 0;
      const volB = b.volume ?? 0;
      if (volA !== volB) return volB - volA;

      const pcA = a.premium_capture ?? Infinity;
      const pcB = b.premium_capture ?? Infinity;
      if (pcA !== pcB) return pcA - pcB;

      const croiA = a.net_croi ?? 0;
      const croiB = b.net_croi ?? 0;
      if (croiA !== croiB) return croiB - croiA;

      const oiA = a.open_interest ?? 0;
      const oiB = b.open_interest ?? 0;
      return oiB - oiA;
    });

    result.push(sorted[0]);
  }

  return result;
}
