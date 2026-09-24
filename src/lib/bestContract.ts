import type { CandidateScan } from '@/types';
import type { StrategyProfile } from '@/types';

type StatusPriority = 0 | 1 | 2;

function statusPriority(c: CandidateScan): StatusPriority {
  if (c.qualified && !c.technical_pending) return 0;
  if (c.qualified && c.technical_pending) return 1;
  return 2;
}

/**
 * Re-applies hard filters from the current active profile to a list of
 * candidate contracts. Contracts that definitively violate a hard filter
 * (stock price, max strike, min DTE) are marked as rejected.
 *
 * This is used when loading saved scan results from the database to ensure
 * stale contracts from a previous scan (with different settings) don't
 * appear as qualified under the current profile.
 */
export function reapplyHardFilters(contracts: CandidateScan[], profile: StrategyProfile): CandidateScan[] {
  return contracts.map((c) => {
    const reasons = [...(c.rejection_reasons || [])];
    const pendingReasons: string[] = [];

    if (profile.order_strike_enabled) {
      if (profile.max_strike != null && c.strike > profile.max_strike && !reasons.includes('Strike too high')) {
        reasons.push('Strike too high');
      }
      if (profile.minimum_stock_price != null && c.stock_price != null && c.stock_price > 0) {
        if (c.stock_price < profile.minimum_stock_price && !reasons.includes('Stock price below minimum')) {
          reasons.push('Stock price below minimum');
        }
      }
      if (profile.minimum_stock_price != null && (c.stock_price == null || c.stock_price <= 0)) {
        if (!pendingReasons.includes('Stock price unavailable — minimum stock price rule not evaluated')) {
          pendingReasons.push('Stock price unavailable — minimum stock price rule not evaluated');
        }
      }
      if (profile.maximum_stock_price != null && c.stock_price != null && c.stock_price > 0) {
        if (c.stock_price > profile.maximum_stock_price && !reasons.includes('Stock price above maximum')) {
          reasons.push('Stock price above maximum');
        }
      }
    }

    if (profile.expiration_enabled && c.dte < profile.min_dte) {
      if (!reasons.includes('DTE below minimum')) {
        reasons.push('DTE below minimum');
      }
    }

    const hasRejections = reasons.length > 0;
    const hasPending = pendingReasons.length > 0 || c.technical_pending;
    const isPending = !hasRejections && hasPending;
    const qualified = !hasRejections && !isPending;

    return {
      ...c,
      rejection_reasons: reasons,
      qualified,
      technical_pending: isPending,
    };
  });
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
