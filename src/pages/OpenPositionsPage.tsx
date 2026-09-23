import { useState, useMemo } from 'react';
import { Edit2, Check, X, Trash2, Archive } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { OpenPosition, PositionStatus } from '@/types';
import {
  calcNetProfit,
  calcCroiFromCollateral,
  calcPremiumCapture,
  calcBtcOptimization,
  calcPositionStatus,
  calcDaysOpen,
  calcDaysToReview,
} from '@/lib/calculations';
import { Badge, Card, formatPct, formatNum } from '@/components/ui';

const statusVariants: Record<PositionStatus, 'success' | 'warning' | 'error' | 'neutral' | 'info'> = {
  'Waiting': 'neutral',
  'Near BTC Target': 'info',
  'BTC Ready': 'success',
  'Support Warning': 'warning',
  'Trend Warning': 'warning',
  'Cycle Review': 'error',
};

export function OpenPositionsPage({ state }: { state: AppState }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSto, setEditSto] = useState('');
  const [editContracts, setEditContracts] = useState('');
  const [closeModalId, setCloseModalId] = useState<string | null>(null);
  const [closeBtc, setCloseBtc] = useState('');

  const positions = useMemo(() => {
    return state.openPositions.map((p) => {
      const daysOpen = calcDaysOpen(p.open_date);
      const daysToReview = calcDaysToReview(p.open_date, state.activeProfile?.max_recycle_days || 120);
      const status = calcPositionStatus(
        p.current_mid,
        p.btc_target,
        daysOpen,
        state.activeProfile?.max_recycle_days || 120,
        p.trend_classification,
        p.stock_price,
        p.primary_support,
      );
      return { ...p, days_open: daysOpen, days_to_review: daysToReview, position_status: status };
    });
  }, [state.openPositions, state.activeProfile]);

  const handleSaveSto = async (pos: OpenPosition) => {
    const newSto = parseFloat(editSto);
    const newContracts = parseInt(editContracts) || pos.contracts;
    if (isNaN(newSto) || newSto <= 0) return;

    const profile = state.activeProfile!;
    const { best } = calcBtcOptimization(newSto, pos.strike, newContracts, profile, true);
    const btcTarget = best ? best.btc_price : 0.01;
    const netProfit = calcNetProfit(newSto, btcTarget, newContracts, profile.round_trip_commission);
    const netCroi = calcCroiFromCollateral(netProfit, pos.strike, newContracts);
    const pc = calcPremiumCapture(newSto, btcTarget);

    await state.updateOpenPosition(pos.id!, {
      actual_sto: newSto,
      contracts: newContracts,
      btc_target: parseFloat(btcTarget.toFixed(2)),
      net_target_profit: parseFloat(netProfit.toFixed(2)),
      net_croi: parseFloat(netCroi.toFixed(2)),
      premium_capture: parseFloat(pc.toFixed(1)),
      collateral: pos.strike * 100 * newContracts,
      breakeven: parseFloat((pos.strike - newSto).toFixed(2)),
    });
    setEditingId(null);
  };

  const startEdit = (pos: OpenPosition) => {
    setEditingId(pos.id!);
    setEditSto(String(pos.actual_sto));
    setEditContracts(String(pos.contracts));
  };

  const handleClose = async () => {
    const pos = positions.find((p) => p.id === closeModalId);
    if (!pos) return;
    const btc = parseFloat(closeBtc);
    if (isNaN(btc) || btc < 0) return;
    await state.closePosition(pos, btc);
    setCloseModalId(null);
    setCloseBtc('');
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Open Positions</h1>
        <p className="text-sm text-slate-500 mt-0.5">{positions.length} open position{positions.length !== 1 ? 's' : ''}</p>
      </div>

      {positions.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-slate-500 text-sm">No open positions. Open one from a candidate's detail page.</p>
        </Card>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80">
                <tr className="text-xs text-slate-400">
                  <th className="px-3 py-2.5 text-left">Ticker</th>
                  <th className="px-3 py-2.5 text-right">Strike</th>
                  <th className="px-3 py-2.5 text-left">Expiration</th>
                  <th className="px-3 py-2.5 text-right">Contracts</th>
                  <th className="px-3 py-2.5 text-left">Open Date</th>
                  <th className="px-3 py-2.5 text-right">Actual STO</th>
                  <th className="px-3 py-2.5 text-right">Bid</th>
                  <th className="px-3 py-2.5 text-right">Ask</th>
                  <th className="px-3 py-2.5 text-right">Mid</th>
                  <th className="px-3 py-2.5 text-right">BTC Target</th>
                  <th className="px-3 py-2.5 text-right">Net Profit</th>
                  <th className="px-3 py-2.5 text-right">CROI</th>
                  <th className="px-3 py-2.5 text-right">PC</th>
                  <th className="px-3 py-2.5 text-right">Days Open</th>
                  <th className="px-3 py-2.5 text-right">Days to Review</th>
                  <th className="px-3 py-2.5 text-left">Trend</th>
                  <th className="px-3 py-2.5 text-left">Support</th>
                  <th className="px-3 py-2.5 text-left">Status</th>
                  <th className="px-3 py-2.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {positions.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="px-3 py-2.5 font-semibold text-slate-100">{p.ticker}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(p.strike)}</td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap">{p.expiration}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                      {editingId === p.id ? (
                        <input
                          type="number"
                          value={editContracts}
                          onChange={(e) => setEditContracts(e.target.value)}
                          className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-right text-sm text-slate-100"
                        />
                      ) : p.contracts}
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{p.open_date}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {editingId === p.id ? (
                        <input
                          type="number"
                          step="0.01"
                          value={editSto}
                          onChange={(e) => setEditSto(e.target.value)}
                          className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-right text-sm text-slate-100"
                        />
                      ) : (
                        <span className="text-sky-400 font-medium">${formatNum(p.actual_sto)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">${formatNum(p.current_bid)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">${formatNum(p.current_ask)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(p.current_mid)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">${formatNum(p.btc_target)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(p.net_target_profit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span className={p.net_croi >= 3.5 ? 'text-emerald-400' : 'text-slate-400'}>{formatPct(p.net_croi)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{formatPct(p.premium_capture)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{p.days_open}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      <span className={p.days_to_review <= 10 ? 'text-amber-400' : 'text-slate-400'}>{p.days_to_review}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={p.trend_classification === 'Downtrend' ? 'error' : p.trend_classification === 'Sideways' ? 'neutral' : 'success'} dot>
                        {p.trend_classification}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400">${formatNum(p.primary_support)}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={statusVariants[p.position_status]} dot>{p.position_status}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-center gap-1.5">
                        {editingId === p.id ? (
                          <>
                            <button onClick={() => handleSaveSto(p)} className="p-1 rounded hover:bg-slate-700 text-emerald-400">
                              <Check className="h-4 w-4" />
                            </button>
                            <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-slate-700 text-slate-400">
                              <X className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(p)} className="p-1 rounded hover:bg-slate-700 text-slate-400" title="Edit STO fill">
                              <Edit2 className="h-4 w-4" />
                            </button>
                            <button onClick={() => setCloseModalId(p.id!)} className="p-1 rounded hover:bg-slate-700 text-sky-400" title="Close position">
                              <Archive className="h-4 w-4" />
                            </button>
                            <button onClick={() => state.deleteOpenPosition(p.id!)} className="p-1 rounded hover:bg-slate-700 text-red-400" title="Delete">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Close position modal */}
      {closeModalId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCloseModalId(null)}>
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-slate-100 mb-2">Close Position</h2>
            <p className="text-sm text-slate-400 mb-4">
              Enter the BTC fill price to close this position and move it to closed history.
            </p>
            <label className="block text-sm text-slate-400 mb-1">BTC Price</label>
            <input
              type="number"
              step="0.01"
              value={closeBtc}
              onChange={(e) => setCloseBtc(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 mb-4"
              placeholder="0.05"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setCloseModalId(null)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:bg-slate-800">
                Cancel
              </button>
              <button onClick={handleClose} className="px-4 py-2 rounded-lg bg-sky-500 text-white text-sm hover:bg-sky-600">
                Close Position
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
