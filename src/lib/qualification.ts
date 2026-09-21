import type { StrategyProfile, CandidateScan } from '@/types';
import type { TechnicalSnapshot } from '@/lib/technicalCache';

export type QualificationStatus = 'qualified' | 'pending' | 'rejected';

/**
 * Derive qualification purely from the pass_fail array — the same evaluator
 * result used by Analyze Ticker.
 *
 * - Any enabled rule with status 'fail'  → rejected
 * - No failures, but some 'not_evaluated' → pending
 * - All evaluated and pass                → qualified
 */
export function deriveQualification(
  passFail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[] | undefined,
): QualificationStatus {
  if (!passFail || passFail.length === 0) return 'pending';
  const hasFail = passFail.some((pf) => pf.status === 'fail');
  if (hasFail) return 'rejected';
  const hasNotEvaluated = passFail.some((pf) => pf.status === 'not_evaluated');
  if (hasNotEvaluated) return 'pending';
  return 'qualified';
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

  return {
    ...candidate,
    trend_classification: snap.trend !== 'Pending' ? snap.trend : candidate.trend_classification,
    primary_support: snap.primary_support ?? candidate.primary_support,
    secondary_support: snap.secondary_support ?? candidate.secondary_support,
    resistance: snap.resistance ?? candidate.resistance,
    stock_price: snap.stock_price ?? candidate.stock_price,
    strike_distance_from_support: supportDist ?? candidate.strike_distance_from_support,
    technical_pending: false,
    pass_fail: updatedPassFail,
  };
}
