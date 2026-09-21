import type { StrategyProfile, CandidateScan } from '@/types';
import type { TechnicalSnapshot } from '@/lib/technicalCache';

export type QualificationStatus = 'qualified' | 'pending' | 'rejected';

/**
 * Derive qualification using the same final rule evaluator used by Analyze Ticker.
 *
 * Priority (fail ALWAYS overrides pending):
 * 1. Any enabled rule with status 'fail' → rejected
 * 2. Any rejection_reasons entry           → rejected (fallback when pass_fail is empty)
 * 3. No fails, but some 'not_evaluated'    → pending
 * 4. technical_pending with no fails       → pending (fallback when pass_fail is empty)
 * 5. All evaluated and pass                → qualified
 */
export function deriveQualification(
  passFail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[] | undefined,
  rejectionReasons?: string[],
  technicalPending?: boolean,
): QualificationStatus {
  const failCount = passFail?.filter((pf) => pf.status === 'fail').length ?? 0;
  const notEvaluatedCount = passFail?.filter((pf) => pf.status === 'not_evaluated').length ?? 0;
  const rejectionCount = rejectionReasons?.length ?? 0;

  // Step 1-2: any fail (from pass_fail or rejection_reasons) → rejected
  if (failCount > 0 || rejectionCount > 0) return 'rejected';

  // Step 3-4: no fails, but some not-evaluated or technical_pending → pending
  if (notEvaluatedCount > 0 || technicalPending) return 'pending';

  // Step 5: all evaluated and passed
  return 'qualified';
}

/**
 * Convenience wrapper that pulls all fields from a CandidateScan.
 * Prefers the server-provided `qualification` field; falls back to
 * deriving from pass_fail for older cached rows.
 */
export function deriveCandidateQualification(c: {
  qualification?: 'qualified' | 'pending' | 'rejected';
  pass_fail?: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[];
  rejection_reasons?: string[];
  technical_pending?: boolean;
  qualified?: boolean;
}): QualificationStatus {
  if (c.qualification === 'qualified' || c.qualification === 'pending' || c.qualification === 'rejected') {
    return c.qualification;
  }
  return deriveQualification(c.pass_fail, c.rejection_reasons, c.technical_pending);
}

/**
 * Re-evaluate a candidate's pass_fail entries after fresh technical data
 * arrives (e.g. from Analyze Ticker).  Updates technical-dependent rules
 * in-place and recomputes strike_distance_from_support.
 */
export function reevaluatePassFailWithTechnical(
  candidate: CandidateScan,
  snap: TechnicalSnapshot,
  profile: StrategyProfile,
): CandidateScan {
  const technicalAvailable =
    snap.primary_support != null || snap.trend !== 'Pending' || snap.technical != null;

  const strike = candidate.strike;
  const primarySupport = snap.primary_support;
  const trendClass = snap.trend;

  const supportDist =
    primarySupport != null && primarySupport > 0
      ? parseFloat(((primarySupport - strike) / primarySupport * 100).toFixed(1))
      : null;

  const updatedPassFail = (candidate.pass_fail ?? []).map((pf) => {
    // Strike below support — was not_evaluated when support was unavailable
    if (pf.rule.startsWith('Support rule not evaluated') && primarySupport != null && primarySupport > 0) {
      const belowSupport = strike < primarySupport;
      return { rule: `Strike below support (${primarySupport.toFixed(2)})`, pass: belowSupport, status: belowSupport ? 'pass' as const : 'fail' as const };
    }
    // Trend acceptable — was not_evaluated when technical history was unavailable
    if (pf.rule.startsWith('Technical history unavailable') && technicalAvailable) {
      const trendOk = !(profile.exclude_downtrend_no_support && trendClass === 'Downtrend' && primarySupport !== null && strike >= primarySupport);
      return { rule: `Trend acceptable (${trendClass})`, pass: trendOk, status: trendOk ? 'pass' as const : 'fail' as const };
    }
    // Support distance — was not_evaluated when support was unavailable
    if (pf.rule.startsWith('Support distance not evaluated') && primarySupport != null && primarySupport > 0 && supportDist != null) {
      const distMinOk = supportDist >= profile.minimum_support_distance_pct;
      const distMaxOk = supportDist <= profile.maximum_support_distance_pct;
      const distOk = distMinOk && distMaxOk;
      return { rule: `Support distance ${profile.minimum_support_distance_pct}%\u2013${profile.maximum_support_distance_pct}% (${supportDist}%)`, pass: distOk, status: distOk ? 'pass' as const : 'fail' as const };
    }
    return pf;
  });

  // Re-derive qualification from the updated pass_fail (same logic as edge function)
  const failRules = updatedPassFail.filter((r) => r.status === 'fail');
  const pendingRules = updatedPassFail.filter((r) => r.status === 'not_evaluated');
  let newQualification: 'qualified' | 'pending' | 'rejected';
  if (failRules.length > 0) {
    newQualification = 'rejected';
  } else if (pendingRules.length > 0) {
    newQualification = 'pending';
  } else {
    newQualification = 'qualified';
  }

  return {
    ...candidate,
    trend_classification: snap.trend !== 'Pending' ? snap.trend : candidate.trend_classification,
    primary_support: snap.primary_support ?? candidate.primary_support,
    secondary_support: snap.secondary_support ?? candidate.secondary_support,
    resistance: snap.resistance ?? candidate.resistance,
    stock_price: snap.stock_price ?? candidate.stock_price,
    strike_distance_from_support: supportDist ?? candidate.strike_distance_from_support,
    technical_pending: newQualification === 'pending',
    qualified: newQualification === 'qualified',
    qualification: newQualification,
    rejection_reasons: failRules.map((r) => r.rule),
    pass_fail: updatedPassFail,
  };
}
