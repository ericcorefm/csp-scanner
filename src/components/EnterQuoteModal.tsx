import { useState, useMemo } from 'react';
import { X, Calculator } from 'lucide-react';
import type { CandidateScan, StrategyProfile } from '@/types';
import { calcSpreadMidpoint, calcSpreadPct, calcNetProfit, calcCroiFromCollateral, calcPremiumCapture, calcBreakeven } from '@/lib/calculations';
import { formatNum, formatPct, Badge } from '@/components/ui';

interface EnterQuoteModalProps {
  candidate: CandidateScan;
  profile: StrategyProfile;
  onClose: () => void;
  onSubmit: (updates: Partial<CandidateScan>) => void;
}

export function EnterQuoteModal({ candidate, profile, onClose, onSubmit }: EnterQuoteModalProps) {
  const [bid, setBid] = useState(candidate.bid > 0 ? String(candidate.bid) : '');
  const [ask, setAsk] = useState(candidate.ask > 0 ? String(candidate.ask) : '');
  const [sto, setSto] = useState('');
  const [contracts, setContracts] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const bidNum = parseFloat(bid) || 0;
  const askNum = parseFloat(ask) || 0;
  const stoNum = parseFloat(sto) || 0;
  const contractsNum = parseInt(contracts) || 1;

  const hasBidAsk = bidNum > 0 && askNum > 0 && askNum >= bidNum;
  const hasSto = stoNum > 0;

  const mid = useMemo(() => hasBidAsk ? calcSpreadMidpoint(bidNum, askNum) : 0, [hasBidAsk, bidNum, askNum]);
  const spreadPct = useMemo(() => hasBidAsk ? calcSpreadPct(bidNum, askNum) : 0, [hasBidAsk, bidNum, askNum]);

  // Optimal BTC: find highest BTC satisfying CROI >= min and PC <= max
  const btcResult = useMemo(() => {
    if (!hasSto) return null;
    const increment = profile.allow_penny_increments ? 0.01 : Math.max(0.01, profile.btc_increment);
    let best: { btc: number; netProfit: number; netCroi: number; pc: number } | null = null;

    for (let btc = increment; btc < stoNum; btc += increment) {
      const px = parseFloat(btc.toFixed(2));
      const netProfit = calcNetProfit(stoNum, px, contractsNum, profile.round_trip_commission);
      const netCroi = calcCroiFromCollateral(netProfit, candidate.strike, contractsNum);
      const pc = calcPremiumCapture(stoNum, px);

      if (netCroi >= profile.min_net_croi && pc <= profile.max_premium_capture) {
        if (!best || px > best.btc) {
          best = { btc: px, netProfit, netCroi, pc };
        }
      }
    }
    return best;
  }, [hasSto, stoNum, contractsNum, candidate.strike, profile]);

  const handleSubmit = () => {
    setError(null);

    if (!hasBidAsk && !hasSto) {
      setError('Enter at least a bid/ask or an actual STO price.');
      return;
    }

    const updates: Partial<CandidateScan> = {
      has_quotes: hasBidAsk || hasSto,
    };

    if (hasBidAsk) {
      updates.bid = parseFloat(bidNum.toFixed(2));
      updates.ask = parseFloat(askNum.toFixed(2));
      updates.mid = parseFloat(mid.toFixed(2));
      updates.spread_pct = parseFloat(spreadPct.toFixed(1));
      updates.breakeven = parseFloat(calcBreakeven(candidate.strike, mid).toFixed(2));
    }

    if (hasSto) {
      updates.suggested_sto = parseFloat(stoNum.toFixed(2));

      if (btcResult) {
        updates.suggested_btc = parseFloat(btcResult.btc.toFixed(2));
        updates.net_profit = parseFloat(btcResult.netProfit.toFixed(2));
        updates.net_croi = parseFloat(btcResult.netCroi.toFixed(2));
        updates.premium_capture = parseFloat(btcResult.pc.toFixed(1));
        updates.breakeven = parseFloat(calcBreakeven(candidate.strike, stoNum).toFixed(2));
      } else {
        updates.suggested_btc = 0;
        updates.net_profit = 0;
        updates.net_croi = 0;
        updates.premium_capture = 0;
      }
    } else if (hasBidAsk) {
      // Use midpoint as STO if no actual STO entered
      updates.suggested_sto = parseFloat(mid.toFixed(2));
    }

    onSubmit(updates);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-100">Enter Quote</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg bg-slate-800/50 px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">{candidate.ticker}</span>
              <span className="text-slate-300 font-medium">${formatNum(candidate.strike)} PUT</span>
            </div>
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="text-slate-500">Exp: {candidate.expiration}</span>
              <span className="text-slate-500">DTE: {candidate.dte}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Bid</label>
              <input
                type="number"
                step="0.01"
                value={bid}
                onChange={(e) => setBid(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Ask</label>
              <input
                type="number"
                step="0.01"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Actual STO Price</label>
              <input
                type="number"
                step="0.01"
                value={sto}
                onChange={(e) => setSto(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Contracts</label>
              <input
                type="number"
                step="1"
                value={contracts}
                onChange={(e) => setContracts(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          {hasBidAsk && (
            <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Calculator className="h-3.5 w-3.5" />
                <span>Calculated from Bid/Ask</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Midpoint</span>
                  <span className="text-slate-200 tabular-nums">${formatNum(mid)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Spread %</span>
                  <span className={`tabular-nums ${spreadPct <= 5 ? 'text-emerald-400' : spreadPct <= 10 ? 'text-amber-400' : 'text-red-400'}`}>
                    {formatPct(spreadPct)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {hasSto && btcResult && (
            <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                <Calculator className="h-3.5 w-3.5" />
                <span>Optimal BTC Target</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">BTC</span>
                  <span className="text-sky-300 tabular-nums">${formatNum(btcResult.btc)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Net Profit</span>
                  <span className="text-slate-200 tabular-nums">${formatNum(btcResult.netProfit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Net CROI</span>
                  <span className="text-emerald-400 tabular-nums">{formatPct(btcResult.netCroi)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Premium Capture</span>
                  <span className="text-slate-200 tabular-nums">{formatPct(btcResult.pc)}</span>
                </div>
                <div className="flex justify-between col-span-2">
                  <span className="text-slate-500">Breakeven</span>
                  <span className="text-slate-200 tabular-nums">${formatNum(calcBreakeven(candidate.strike, stoNum))}</span>
                </div>
              </div>
              <div className="text-xs text-slate-500 pt-1">
                Highest BTC satisfying CROI {'>='} {profile.min_net_croi}% and PC {'<='} {profile.max_premium_capture}%
              </div>
            </div>
          )}

          {hasSto && !btcResult && (
            <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-3 py-2.5">
              <div className="text-xs text-amber-400">
                No BTC price satisfies CROI {'>='} {profile.min_net_croi}% and PC {'<='} {profile.max_premium_capture}% for this STO.
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-1.5">
              {hasBidAsk && <Badge variant="success">Bid/Ask OK</Badge>}
              {hasSto && <Badge variant="info">STO entered</Badge>}
              {!hasBidAsk && !hasSto && <Badge variant="warning">Awaiting input</Badge>}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 transition-colors"
              >
                Save Quote
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
