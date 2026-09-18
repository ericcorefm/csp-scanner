import { useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Minus, ArrowUpRight, BarChart3, Building2,
  CandlestickChart, Calculator, Target, Plus, X,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import { getTechnicalSnapshot, getFundamentalSnapshot, getStockDef } from '@/lib/marketData';
import { calcBtcOptimization, calcRecycleDate } from '@/lib/calculations';
import { Badge, Card, StatRow, MetricIndicator, formatCurrency, formatPct, formatNum } from '@/components/ui';
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

export function DetailPage({
  ticker,
  state,
  onNavigate,
}: {
  ticker: string;
  state: AppState;
  onNavigate: (page: Page, ticker?: string) => void;
}) {
  const tech = useMemo(() => getTechnicalSnapshot(ticker), [ticker]);
  const fund = useMemo(() => getFundamentalSnapshot(ticker), [ticker]);
  const stockDef = useMemo(() => getStockDef(ticker), [ticker]);

  const candidate = useMemo(
    () => state.candidates.find((c) => c.ticker === ticker && c.qualified),
    [state.candidates, ticker],
  );

  const btcTable = useMemo(() => {
    if (!candidate || !state.activeProfile) return null;
    return calcBtcOptimization(
      candidate.mid,
      candidate.strike,
      1,
      state.activeProfile,
      candidate.open_interest > 0 && stockDef?.supportsPenny === true,
    );
  }, [candidate, state.activeProfile, stockDef]);

  if (!tech || !fund) {
    return (
      <div>
        <BackButton onClick={() => onNavigate('candidates')} />
        <p className="text-slate-400">Data not found for {ticker}.</p>
      </div>
    );
  }

  const TrendIcon = trendIcons[tech.trend_classification] || Minus;
  const recycleDate = candidate ? calcRecycleDate(new Date().toISOString().split('T')[0], state.activeProfile?.max_recycle_days || 120) : '';

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
      stock_price: candidate.stock_price,
      trend_classification: candidate.trend_classification,
      primary_support: candidate.primary_support,
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

      {/* Header */}
      <div className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/50 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-100">{ticker}</h1>
              <Badge variant={trendColors[tech.trend_classification]} dot>
                <TrendIcon className="h-3 w-3 inline mr-0.5" />
                {tech.trend_classification}
              </Badge>
            </div>
            <p className="text-sm text-slate-400 mt-1">{fund.company_name}</p>
            <div className="flex items-center gap-6 mt-4">
              <div>
                <div className="text-xs text-slate-500">Stock Price</div>
                <div className="text-xl font-semibold text-slate-100 tabular-nums">${formatNum(tech.stock_price)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Primary Support</div>
                <div className="text-xl font-semibold text-emerald-400 tabular-nums">${formatNum(tech.primary_support)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Secondary Support</div>
                <div className="text-xl font-semibold text-emerald-400/70 tabular-nums">${formatNum(tech.secondary_support)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Resistance</div>
                <div className="text-xl font-semibold text-amber-400 tabular-nums">${formatNum(tech.resistance)}</div>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Technical card */}
        <Card title="Technical Analysis" action={<BarChart3 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            <div className="grid grid-cols-2 gap-x-6">
              <div>
                <StatRow label="20-day MA" value={`$${formatNum(tech.ma20)}`} highlight={tech.stock_price > tech.ma20} />
                <StatRow label="50-day MA" value={`$${formatNum(tech.ma50)}`} highlight={tech.stock_price > tech.ma50} />
                <StatRow label="200-day MA" value={`$${formatNum(tech.ma200)}`} highlight={tech.stock_price > tech.ma200} />
                <StatRow
                  label="RSI (14)"
                  value={formatNum(tech.rsi, 1)}
                  highlight={tech.rsi >= 40 && tech.rsi <= 60}
                />
              </div>
              <div>
                <StatRow label="MACD Line" value={formatNum(tech.macd_line, 3)} />
                <StatRow label="MACD Signal" value={formatNum(tech.macd_signal, 3)} />
                <StatRow
                  label="MACD Hist"
                  value={formatNum(tech.macd_histogram, 3)}
                  highlight={tech.macd_histogram > 0}
                />
                <StatRow label="Volume Trend" value={tech.volume_trend} />
              </div>
            </div>
            <div className="mt-4 border-t border-slate-800 pt-4">
              <div className="text-xs text-slate-500 mb-2">Bollinger Bands (20, 2)</div>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-slate-800/50 p-3">
                  <div className="text-xs text-slate-500">Upper</div>
                  <div className="text-sm font-medium text-slate-200 tabular-nums">${formatNum(tech.bb_upper)}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 p-3">
                  <div className="text-xs text-slate-500">Middle</div>
                  <div className="text-sm font-medium text-slate-200 tabular-nums">${formatNum(tech.bb_middle)}</div>
                </div>
                <div className="rounded-lg bg-slate-800/50 p-3">
                  <div className="text-xs text-slate-500">Lower</div>
                  <div className="text-sm font-medium text-slate-200 tabular-nums">${formatNum(tech.bb_lower)}</div>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 mb-2">
                <MetricIndicator status={tech.trend_classification === 'Downtrend' ? 'fail' : 'pass'} />
                <span className="text-xs text-slate-500">Trend Classification</span>
              </div>
              <div className="text-sm text-slate-200">{tech.trend_classification}</div>
            </div>
          </div>
        </Card>

        {/* Fundamental card */}
        <Card title="Fundamental Analysis" action={<Building2 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            <div className="grid grid-cols-2 gap-x-6">
              <div>
                <StatRow label="Revenue" value={formatCurrency(fund.revenue)} />
                <StatRow
                  label="Revenue Growth"
                  value={formatPct(fund.revenue_growth_pct)}
                  highlight={fund.revenue_growth_pct > 0}
                />
                <StatRow label="Profitability" value={fund.profitability} />
                <StatRow label="Cash Balance" value={formatCurrency(fund.cash_balance)} />
                <StatRow label="Debt" value={formatCurrency(fund.debt)} />
              </div>
              <div>
                <StatRow label="Cash Flow" value={fund.cash_flow} />
                <StatRow label="Liquidity" value={fund.liquidity} />
                <StatRow label="Outlook" value={fund.outlook} />
                <StatRow
                  label="Short Interest"
                  value={formatPct(fund.short_interest_pct)}
                  highlight={fund.short_interest_pct < 10}
                />
              </div>
            </div>
            <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
              <div>
                <div className="text-xs text-slate-500 mb-1">Recent Developments</div>
                <p className="text-sm text-slate-300">{fund.recent_developments}</p>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Risk Factors</div>
                <p className="text-sm text-slate-300">{fund.risk_factors}</p>
              </div>
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
                <StatRow label="Strike Dist from Stock" value={`${candidate.strike_distance_from_stock}%`} />
                <StatRow label="Strike Dist from Support" value={`${candidate.strike_distance_from_support}%`} />
                <StatRow label="Recycle Date (120d)" value={recycleDate} />
              </div>
            </div>
          </Card>

          {/* BTC Optimization */}
          <Card title="BTC Optimization" action={<Target className="h-4 w-4 text-slate-500" />}>
            <div className="p-3">
              <div className="text-xs text-slate-500 px-2 py-1">
                Highest BTC meeting CROI &gt;= {state.activeProfile?.min_net_croi}% and PC &lt;= {state.activeProfile?.max_premium_capture}%
              </div>
              <div className="overflow-x-auto mt-2">
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
                  <tbody className="divide-y divide-slate-800/40">
                    {btcTable?.table.slice(0, 25).map((row) => (
                      <tr
                        key={row.btc_price}
                        className={row.is_best ? 'bg-emerald-500/10' : ''}
                      >
                        <td className="px-2 py-1.5 tabular-nums text-slate-300">${formatNum(row.btc_price)}</td>
                        <td className="px-2 py-1.5 tabular-nums text-right text-slate-400">${formatNum(row.net_profit)}</td>
                        <td className="px-2 py-1.5 tabular-nums text-right">
                          <span className={row.net_croi >= 3.5 ? 'text-emerald-400' : 'text-slate-500'}>{formatPct(row.net_croi)}</span>
                        </td>
                        <td className="px-2 py-1.5 tabular-nums text-right text-slate-400">{formatPct(row.premium_capture)}</td>
                        <td className="px-2 py-1.5 text-center">
                          {row.is_best ? (
                            <Badge variant="success">Best</Badge>
                          ) : row.status === 'qualifies' ? (
                            <MetricIndicator status="pass" />
                          ) : row.status === 'above_pc' ? (
                            <MetricIndicator status="fail" />
                          ) : (
                            <MetricIndicator status="warn" />
                          )}
                        </td>
                      </tr>
                    ))}
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
