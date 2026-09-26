import type { CandidateScan } from '@/types';
import { compareContracts, isQualified } from '@/lib/status';

/**
 * Groups contracts by ticker and returns the best contract(s) per ticker.
 *
 * Ranking (shared with the edge function, see src/lib/status.ts):
 *   1. Status: Qualified > Pending > Rejected
 *   2. Highest option volume
 *   3. Lowest Premium Capture % (contracts without a premium rank last)
 *   4. Highest Net CROI
 *   5. Highest Open Interest
 *
 * If a ticker has qualified contracts, up to `maxPerTicker` of them are
 * returned. Otherwise its single best Pending/Rejected contract is returned so
 * the user can see why it did not qualify. All contracts stay in state for
 * Analyze Ticker / Candidate Detail.
 */
export function selectBestContractPerTicker(contracts: CandidateScan[], maxPerTicker = 1): CandidateScan[] {
  const grouped = new Map<string, CandidateScan[]>();
  for (const contract of contracts) {
    const arr = grouped.get(contract.ticker);
    if (arr) arr.push(contract);
    else grouped.set(contract.ticker, [contract]);
  }

  const limit = Math.max(1, maxPerTicker);
  const result: CandidateScan[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort(compareContracts);
    const qualified = sorted.filter(isQualified);
    if (qualified.length > 0) result.push(...qualified.slice(0, limit));
    else result.push(sorted[0]);
  }
  return result;
}
