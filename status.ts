import type { CandidateScan } from '@/types';

/**
 * Single definition of a contract's status, used by every page.
 *
 * The backend guarantees Qualified and Pending are mutually exclusive:
 *   Rejected  — at least one enabled rule definitely failed
 *   Pending   — nothing failed, but data for an enabled rule is missing
 *   Qualified — every enabled rule had data and passed
 */
export type ContractStatus = 'qualified' | 'pending' | 'rejected';

type StatusFields = Pick<CandidateScan, 'qualified' | 'technical_pending'>;

export function getContractStatus(c: StatusFields): ContractStatus {
  if (c.qualified && !c.technical_pending) return 'qualified';
  if (c.technical_pending) return 'pending';
  return 'rejected';
}

export const isQualified = (c: StatusFields) => getContractStatus(c) === 'qualified';
export const isPending = (c: StatusFields) => getContractStatus(c) === 'pending';
export const isRejected = (c: StatusFields) => getContractStatus(c) === 'rejected';

const STATUS_RANK: Record<ContractStatus, number> = { qualified: 0, pending: 1, rejected: 2 };

/**
 * One ranking for "best contract" everywhere (must match compareContracts in
 * supabase/functions/market-scan/index.ts):
 *   Qualified > Pending > Rejected, then higher option volume, lower Premium
 *   Capture (no premium ranks last), higher Net CROI, higher Open Interest.
 */
export function compareContracts(a: CandidateScan, b: CandidateScan): number {
  const sa = STATUS_RANK[getContractStatus(a)];
  const sb = STATUS_RANK[getContractStatus(b)];
  if (sa !== sb) return sa - sb;

  const volA = a.volume ?? 0;
  const volB = b.volume ?? 0;
  if (volA !== volB) return volB - volA;

  const pcA = a.has_quotes ? a.premium_capture ?? Infinity : Infinity;
  const pcB = b.has_quotes ? b.premium_capture ?? Infinity : Infinity;
  if (pcA !== pcB) return pcA - pcB;

  const croiA = a.net_croi ?? 0;
  const croiB = b.net_croi ?? 0;
  if (croiA !== croiB) return croiB - croiA;

  return (b.open_interest ?? 0) - (a.open_interest ?? 0);
}

export const PREMIUM_PENDING_REASON = 'Premium/quote unavailable for CROI calculation';
