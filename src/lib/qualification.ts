export type Qualification = 'qualified' | 'pending' | 'rejected';

interface PassFailEntry {
  rule: string;
  pass: boolean;
  status: 'pass' | 'fail' | 'not_evaluated';
}

/**
 * Determine qualification from the pass_fail array.
 *
 * - Any active rule with status 'fail'       → rejected
 * - Any active rule with status 'not_evaluated' → pending
 * - All active rules with status 'pass'      → qualified
 *
 * When pass_fail is empty (e.g. NO FILTER MODE), fall back to the
 * edge function's `qualified` flag.
 */
export function computeQualification(
  qualified: boolean,
  passFail?: PassFailEntry[],
): Qualification {
  if (!passFail || passFail.length === 0) {
    return qualified ? 'qualified' : 'rejected';
  }

  const hasFail = passFail.some((r) => r.status === 'fail');
  const hasPending = passFail.some((r) => r.status === 'not_evaluated');

  if (hasFail) return 'rejected';
  if (hasPending) return 'pending';
  return 'qualified';
}

export const qualificationConfig: Record<Qualification, {
  label: string;
  symbol: string;
  textColor: string;
  badgeClass: string;
  dotClass: string;
}> = {
  qualified: {
    label: 'Qualified',
    symbol: '\u2713',
    textColor: 'text-emerald-400',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    dotClass: 'bg-emerald-400',
  },
  pending: {
    label: 'Pending',
    symbol: '\u26A0',
    textColor: 'text-amber-400',
    badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotClass: 'bg-amber-400',
  },
  rejected: {
    label: 'Rejected',
    symbol: '\u2715',
    textColor: 'text-red-400',
    badgeClass: 'bg-red-500/10 text-red-400 border-red-500/30',
    dotClass: 'bg-red-400',
  },
};

export const qualificationSortRank: Record<Qualification, number> = {
  qualified: 0,
  pending: 1,
  rejected: 2,
};
