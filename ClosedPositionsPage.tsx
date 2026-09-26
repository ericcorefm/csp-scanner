import { useMemo } from 'react';
import { TrendingUp, DollarSign, RotateCw, Calendar } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Card, formatPct, formatNum, formatCurrency } from '@/components/ui';

export function ClosedPositionsPage({ state }: { state: AppState }) {
  const positions = state.closedPositions;

  const stats = useMemo(() => {
    const totalProfit = positions.reduce((sum, p) => sum + p.net_profit, 0);
    const avgCroi = positions.length > 0 ? positions.reduce((s, p) => s + p.net_croi, 0) / positions.length : 0;
    const avgDays = positions.length > 0 ? positions.reduce((s, p) => s + p.days_in_trade, 0) / positions.length : 0;
    const avgAnnRet = positions.length > 0 ? positions.reduce((s, p) => s + p.annualized_return, 0) / positions.length : 0;
    const totalCapital = positions.reduce((s, p) => s + p.strike * 100 * p.contracts, 0);
    return { totalProfit, avgCroi, avgDays, avgAnnRet, totalCapital };
  }, [positions]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Closed Positions</h1>
        <p className="text-sm text-slate-500 mt-0.5">{positions.length} closed trade{positions.length !== 1 ? 's' : ''}</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-emerald-400" />
            <span className="text-xs text-slate-500">Cumulative Profit</span>
          </div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">${formatNum(stats.totalProfit)}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-sky-400" />
            <span className="text-xs text-slate-500">Average CROI</span>
          </div>
          <div className="text-2xl font-bold text-sky-400 tabular-nums">{formatPct(stats.avgCroi)}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-4 w-4 text-amber-400" />
            <span className="text-xs text-slate-500">Avg Days in Trade</span>
          </div>
          <div className="text-2xl font-bold text-amber-400 tabular-nums">{formatNum(stats.avgDays, 0)}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-2">
            <RotateCw className="h-4 w-4 text-violet-400" />
            <span className="text-xs text-slate-500">Avg Annualized Return</span>
          </div>
          <div className="text-2xl font-bold text-violet-400 tabular-nums">{formatPct(stats.avgAnnRet)}</div>
        </Card>
      </div>

      {positions.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-slate-500 text-sm">No closed positions yet. Close an open position to see it here.</p>
        </Card>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80">
                <tr className="text-xs text-slate-400">
                  <th className="px-3 py-2.5 text-left">Ticker</th>
                  <th className="px-3 py-2.5 text-right">Strike</th>
                  <th className="px-3 py-2.5 text-right">Contracts</th>
                  <th className="px-3 py-2.5 text-right">STO</th>
                  <th className="px-3 py-2.5 text-right">BTC</th>
                  <th className="px-3 py-2.5 text-right">Net Profit</th>
                  <th className="px-3 py-2.5 text-right">CROI</th>
                  <th className="px-3 py-2.5 text-right">PC</th>
                  <th className="px-3 py-2.5 text-right">Days</th>
                  <th className="px-3 py-2.5 text-right">Annualized</th>
                  <th className="px-3 py-2.5 text-left">Open Date</th>
                  <th className="px-3 py-2.5 text-left">Close Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {positions.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="px-3 py-2.5 font-semibold text-slate-100">{p.ticker}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(p.strike)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{p.contracts}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sky-400">${formatNum(p.sto_price)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">${formatNum(p.btc_price)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400 font-medium">${formatNum(p.net_profit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">{formatPct(p.net_croi)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{formatPct(p.premium_capture)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{p.days_in_trade}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{formatPct(p.annualized_return)}</td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{p.open_date}</td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{p.close_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Capital recycling history */}
      {positions.length > 0 && (
        <Card title="Capital Recycling History">
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <div className="text-xs text-slate-500">Total Capital Deployed</div>
                <div className="text-lg font-semibold text-slate-200">{formatCurrency(stats.totalCapital)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Return on Deployed Capital</div>
                <div className="text-lg font-semibold text-emerald-400">
                  {stats.totalCapital > 0 ? formatPct((stats.totalProfit / stats.totalCapital) * 100) : '0%'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Capital Recycled (Trades)</div>
                <div className="text-lg font-semibold text-sky-400">{positions.length}x</div>
              </div>
            </div>
            <div className="space-y-2">
              {positions.map((p, i) => (
                <div key={p.id} className="flex items-center gap-3 text-sm">
                  <span className="text-slate-500 text-xs w-6">#{i + 1}</span>
                  <span className="font-medium text-slate-300 w-12">{p.ticker}</span>
                  <div className="flex-1 h-6 bg-slate-800/50 rounded relative overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500/30 to-emerald-500/50"
                      style={{ width: `${Math.min(100, (p.net_profit / Math.max(...positions.map((x) => x.net_profit))) * 100)}%` }}
                    />
                    <span className="absolute inset-0 flex items-center px-3 text-xs text-slate-300">
                      ${formatNum(p.net_profit)} profit · {p.days_in_trade} days
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
