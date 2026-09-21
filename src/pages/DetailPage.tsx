import { useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Minus, ArrowUpRight, BarChart3, Building2,
  CandlestickChart, Calculator, Target, Plus, Check, XCircle, AlertTriangle,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import { calcRecycleDate } from '@/lib/calculations';
import { Badge, Card, StatRow, MetricIndicator, formatPct, formatNum } from '@/components/ui';
import { BackButton } from '@/components/Layout';
import type { Page } from '@/components/Layout';

const trendIcons: Record<string, typeof TrendingUp> = {
  Bullish: TrendingUp,
  Rebound: ArrowUpRight,
  Improving: TrendingUp,
  Sideways: Minus,
  Stabilizing: Minus,
  Downtrend: TrendingDown,
};

const trendColors: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  Bullish: 'success',
  Rebound: 'success',
  Improving: 'success',
  Sideways: 'neutral',
  Stabilizing: 'neutral',
  Downtrend: 'error',
};

function volClassColor(cls: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (cls === 'Excellent' || cls === 'Very Good' || cls === 'Good') return 'success';
  if (cls === 'Meaningful') return 'neutral';
  if (cls === 'Thin') return 'warning';
  return 'error';
}

function displayPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'Unavailable';
  return `$${formatNum(v)}`;
}

function displayTrend(v: string | null | undefined): string {
  if (!v || v === 'Unavailable') return 'Unavailable';
  return v;
}

export function DetailPage({
  ticker,
  strike,
  expiration,
  state,
  onNavigate,
}: {
  ticker: string;
  strike: number | null;
  expiration: string | null;
  state: AppState;
  onNavigate: (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => void;
}) {
  const candidate = useMemo(() => {
    if (strike !== null && expiration) {
      const exact = state.candidates.find(
        (c) => c.ticker === ticker && c.strike === strike && c.expiration === expiration,
      );
      if (exact) return exact;
    }
    return state.candidates.find((c) => c.ticker === ticker && c.qualified);
  }, [state.candidates, ticker, strike, expiration]);

  const btcTable = useMemo(() => {
    if (!candidate || !state.activeProfile) return null;
    // Use the candidate's scanned BTC values — do NOT recalculate independently.
    // The server already optimized BTC using the same iterative algorithm.
    if (candidate.suggested_btc > 0 && candidate.has_quotes) {
      return {
        best: {
          btc_price: candidate.suggested_btc,
          net_profit: candidate.net_profit,
          net_croi: candidate.net_croi,
          premium_capture: candidate.premium_capture,
          status: 'qualifies' as const,
          is_best: true,
        },
        table: [],
      };
    }
    return null;
  }, [candidate, state.activeProfile]);

  if (!candidate) {
    return (
      <div>
        <BackButton onClick={() => onNavigate('candidates')} />
        <div className="py-16 text-center">
          <p className="text-slate-400 mb-2">No candidate data found for {ticker}.</p>
          <p className="text-sm text-slate-500">
            Run a scan from Today's Candidates, then click a row to see details here.
          </p>
        </div>
      </div>
    );
  }

  const TrendIcon = trendIcons[candidate.trend_classification] || Minus;
  const trendColor = trendColors[candidate.trend_classification] || 'neutral';
  const recycleDate = calcRecycleDate(new Date().toISOString().split('T')[0], state.activeProfile?.max_recycle_days || 120);
  const stockPrice = candidate.stock_price;
  const primarySupport = candidate.primary_support;
  const secondarySupport = candidate.secondary_support ?? null;
  const resistance = candidate.resistance ?? null;

  const handleAddPosition = async () => {
    if (!candidate || !state.activeProfile) return;
    await state.addOpenPosition({
      ticker: candidate.ticker,
      company_name: candidate.company_name,
      strike: candidate.strike,
      expiration: candidate.expiration,
      contracts: 1,
      open_date: new Date().toISOString().split('T')[0],
      actual_sto: candidate.suggested_sto,
      current_bid: candidate.bid,
      current_ask: candidate.ask,
      current_mid: candidate.mid,
      btc_target: candidate.suggested_btc,
      net_target_profit: candidate.net_profit,
      net_croi: candidate.net_croi,
      premium_capture: candidate.premium_capture,
      collateral: candidate.strike * 100,
      breakeven: candidate.breakeven,
      stock_price: stockPrice ?? 0,
      trend_classification: candidate.trend_classification,
      primary_support: primarySupport ?? 0,
      support_status: 'Stable',
      position_status: 'Waiting',
      days_open: 0,
      days_to_review: state.activeProfile.max_recycle_days,
      strategy_profile_id: state.activeProfile.id,
    });
    onNavigate('open');
  };

  return (
    <div className="space-y-5">
      <BackButton onClick={() => onNavigate('candidates')} />

      {/* Header — uses the candidate row's own data, never a static lookup */}
      <div className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/50 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-100">{ticker}</h1>
              <Badge variant={trendColor} dot>
                <TrendIcon className="h-3 w-3 inline mr-0.5" />
                {displayTrend(candidate.trend_classification)}
              </Badge>
            </div>
            <p className="text-sm text-slate-400 mt-1">{candidate.company_name}</p>
            <div className="flex items-center gap-6 mt-4">
              <div>
                <div className="text-xs text-slate-500">Stock Price</div>
                <div className={`text-xl font-semibold tabular-nums ${stockPrice ? 'text-slate-100' : 'text-slate-600'}`}>
                  {displayPrice(stockPrice)}
                </div>
                {candidate.stock_source && candidate.stock_source !== 'daily_aggregates' && candidate.stock_source !== 'none' && (
                  <div className="text-[10px] text-slate-500 mt-0.5">Latest daily close</div>
                )}
              </div>
              <div>
                <div className="text-xs text-slate-500">Primary Support</div>
                <div className={`text-xl font-semibold tabular-nums ${primarySupport ? 'text-emerald-400' : 'text-slate-600'}`}>
                  {displayPrice(primarySupport)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Secondary Support</div>
                <div className={`text-xl font-semibold tabular-nums ${secondarySupport ? 'text-emerald-400/70' : 'text-slate-600'}`}>
                  {displayPrice(secondarySupport)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Resistance</div>
                <div className={`text-xl font-semibold tabular-nums ${resistance ? 'text-amber-400' : 'text-slate-600'}`}>
                  {displayPrice(resistance)}
                </div>
              </div>
            </div>
          </div>
          {candidate && (
            <button
              onClick={handleAddPosition}
              className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Open Position
            </button>
          )}
        </div>
      </div>

      {candidate.technical_pending && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Technical data is pending for {ticker}. Trend and support/resistance levels could not be calculated. This candidate is not fully validated until technical rules are evaluated.</span>
        </div>
      )}

      {candidate.pass_fail && candidate.pass_fail.length > 0 && (() => {
        let pCount = 0, wCount = 0, fCount = 0;
        for (const pf of candidate.pass_fail) {
          if (pf.status === 'pass') pCount++;
          else if (pf.status === 'fail') fCount++;
          else wCount++;
        }
        return (
          <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2.5 text-sm">
            <span className="text-slate-400">Rule Summary:</span>
            <span className="text-emerald-400 font-medium">Passes: {pCount}</span>
            <span className="text-amber-400 font-medium">Warnings: {wCount}</span>
            <span className="text-red-400 font-medium">Fails: {fCount}</span>
          </div>
        );
      })()}

      {!stockPrice && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          <BarChart3 className="h-4 w-4 shrink-0" />
          <span>Historical price data was unavailable for {ticker}. Technical indicators and support/resistance levels could not be calculated. Contract discovery and strike/expiration rules were still applied.</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Technical card — shows data from the scan, or Unavailable */}
        <Card title="Technical Analysis" action={<BarChart3 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            {stockPrice ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <MetricIndicator status={candidate.trend_classification === 'Downtrend' ? 'fail' : 'pass'} />
                  <span className="text-xs text-slate-500">Trend Classification</span>
                </div>
                <div className="text-sm text-slate-200">{displayTrend(candidate.trend_classification)}</div>
                <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                  <StatRow label="Primary Support" value={displayPrice(primarySupport)} />
                  <StatRow label="Secondary Support" value={displayPrice(secondarySupport)} />
                  <StatRow label="Resistance" value={displayPrice(resistance)} />
                </div>
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-500">Historical data unavailable — technical indicators could not be calculated.</p>
              </div>
            )}
          </div>
        </Card>

        {/* Fundamental card — uses candidate metadata, not static lookup */}
        <Card title="Fundamental Snapshot" action={<Building2 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            <div className="grid grid-cols-2 gap-x-6">
              <StatRow label="Company" value={candidate.company_name} />
              <StatRow label="Stock Price" value={displayPrice(stockPrice)} />
              <StatRow label="Trend" value={displayTrend(candidate.trend_classification)} />
              <StatRow label="Primary Support" value={displayPrice(primarySupport)} />
            </div>
            <div className="mt-4 border-t border-slate-800 pt-4">
              <p className="text-xs text-slate-500">
                Fundamental data is derived from live scan results. Detailed revenue, debt, and cash flow figures require a separate data feed.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {candidate && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Option card */}
          <Card title="Option Contract" action={<CandlestickChart className="h-4 w-4 text-slate-500" />}>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="info">PUT</Badge>
                <span className="text-sm text-slate-300 font-medium">${formatNum(candidate.strike)} Strike</span>
                <span className="text-xs text-slate-500">· {candidate.dte} DTE · {candidate.expiration}</span>
              </div>
              <StatRow label="Bid" value={`$${formatNum(candidate.bid)}`} />
              <StatRow label="Ask" value={`$${formatNum(candidate.ask)}`} />
              <StatRow label="Mid" value={`$${formatNum(candidate.mid)}`} />
              <StatRow
                label="Spread %"
                value={formatPct(candidate.spread_pct)}
                highlight={candidate.spread_pct <= 5}
              />
              <StatRow label="IV" value={`${formatNum(candidate.iv, 0)}%`} />
              <StatRow label="Delta" value={formatNum(candidate.delta)} />
              <StatRow label="Volume" value={candidate.volume.toLocaleString()} />
              <StatRow label="Open Interest" value={candidate.open_interest.toLocaleString()} />
              <div className="mt-3 border-t border-slate-800 pt-3">
                <StatRow label="Collateral" value={`$${formatNum(candidate.strike * 100)}`} />
                <StatRow label="Premium" value={`$${formatNum(candidate.mid * 100)}`} />
                <StatRow label="Breakeven" value={`$${formatNum(candidate.breakeven)}`} />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <MetricIndicator status={candidate.open_interest >= 1000 ? 'pass' : 'fail'} />
                <span className="text-xs text-slate-400">OI {candidate.open_interest >= 1000 ? 'meets' : 'below'} minimum</span>
                <span className="mx-1 text-slate-700">|</span>
                <Badge variant={volClassColor(candidate.volume_classification)}>{candidate.volume_classification}</Badge>
              </div>
            </div>
          </Card>

          {/* CSP Analysis card */}
          <Card title="CSP Analysis" action={<Calculator className="h-4 w-4 text-slate-500" />}>
            <div className="p-5">
              <StatRow label="Suggested STO Limit" value={`$${formatNum(candidate.suggested_sto)}`} highlight />
              <StatRow label="Suggested BTC Limit" value={`$${formatNum(candidate.suggested_btc)}`} highlight />
              <StatRow label="Net Profit" value={`$${formatNum(candidate.net_profit)}`} />
              <StatRow label="Net CROI" value={formatPct(candidate.net_croi)} highlight={candidate.net_croi >= 3.5} />
              <StatRow label="Premium Capture" value={formatPct(candidate.premium_capture)} />
              <div className="mt-3 border-t border-slate-800 pt-3">
                <StatRow
                  label="Strike Dist from Stock"
                  value={candidate.strike_distance_from_stock != null ? `${candidate.strike_distance_from_stock}%` : 'Unavailable'}
                />
                <StatRow
                  label="Strike Dist from Support"
                  value={candidate.strike_distance_from_support != null ? `${candidate.strike_distance_from_support}%` : 'Unavailable'}
                />
                <StatRow label="Recycle Date (120d)" value={recycleDate} />
              </div>
            </div>
          </Card>

          {/* BTC Optimization — single best qualifying BTC */}
          <Card title="BTC Optimization" action={<Target className="h-4 w-4 text-slate-500" />}>
            <div className="p-3">
              <div className="text-xs text-slate-500 px-2 py-1">
                Highest BTC meeting CROI &gt;= {state.activeProfile?.min_net_croi}% and PC &lt;= {state.activeProfile?.max_premium_capture}%
              </div>
              <div className="mt-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-800">
                      <th className="px-2 py-1.5 text-left">BTC</th>
                      <th className="px-2 py-1.5 text-right">Net $</th>
                      <th className="px-2 py-1.5 text-right">CROI</th>
                      <th className="px-2 py-1.5 text-right">PC</th>
                      <th className="px-2 py-1.5 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {btcTable?.best ? (
                      <tr className="bg-emerald-500/10">
                        <td className="px-2 py-2 tabular-nums text-emerald-300 font-medium">${formatNum(btcTable.best.btc_price)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-slate-300">${formatNum(btcTable.best.net_profit)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-emerald-400">{formatPct(btcTable.best.net_croi)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-slate-300">{formatPct(btcTable.best.premium_capture)}</td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                            <Check className="h-3.5 w-3.5" />
                            Pass
                          </span>
                        </td>
                      </tr>
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-2 py-2 text-center text-slate-500">No qualifying BTC target</td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-flex items-center gap-1 text-red-400 font-medium">
                            <XCircle className="h-3.5 w-3.5" />
                            Fail
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
