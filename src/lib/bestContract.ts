import type { CandidateScan } from '@/types';

type StatusPriority = 0 | 1 | 2;

function statusPriority(c: CandidateScan): StatusPriority {
  if (c.qualified && !c.technical_pending) return 0;
  if (c.technical_pending) return 1;
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
export function selectBestContractPerTicker(contracts: CandidateScan[], maxPerTicker = 1): CandidateScan[] {
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

  const limit = Math.max(1, maxPerTicker);
  const result: CandidateScan[] = [];

  for (const group of grouped.values()) {
    // QUALIFY FIRST: only fully-qualified contracts are eligible for ranking.
    // Rejected and technical-pending contracts can never win the best slot.
    const qualifiedOnly = group.filter(
      (c) => c.qualified && !c.technical_pending,
    );

    if (qualifiedOnly.length === 0) {
      // No qualified contracts — return the best non-qualified for display
      // (so the user can see why it failed), but it will show as rejected.
      const sorted = [...group].sort((a, b) => {
        const spA = statusPriority(a);
        const spB = statusPriority(b);
        if (spA !== spB) return spA - spB;
        const volA = a.volume ?? 0;
        const volB = b.volume ?? 0;
        return volB - volA;
      });
      result.push(sorted[0]);
      continue;
    }

    if (qualifiedOnly.length === 1) {
      result.push(qualifiedOnly[0]);
      continue;
    }

    // RANK SECOND: among qualified contracts only, then take top N
    const sorted = [...qualifiedOnly].sort((a, b) => {
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

    result.push(...sorted.slice(0, limit));
  }

  return result;
}
