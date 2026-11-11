import { useState } from 'react';
import { X, RefreshCw, RotateCcw } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export type CalcDefaults = { ticker: string; avgCost: string; shares: string; price: string; priceDate?: string | null; additional?: string };

const EXAMPLE: CalcDefaults = { ticker: 'META', avgCost: '674.88', shares: '3.554', price: '610.15', priceDate: null, additional: '1300' };
const SLIDER_MAX = 10000;

const num = (s: string) => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const f4 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const usd = (v: number, d = 2) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/**
 * Stock Average Cost Calculator (dollar-cost averaging).
 * New shares are bought at the entered price with no fees:
 *   new avg = (C·S + A) / (S + A/P), value = (S + A/P)·P, gain = value − (C·S + A)
 */
export function AverageCostCalculator({ defaults, onClose }: { defaults?: CalcDefaults; onClose: () => void }) {
  const start = defaults ?? EXAMPLE;
  const [ticker, setTicker] = useState(start.ticker);
  const [avgCost, setAvgCost] = useState(start.avgCost);
  const [shares, setShares] = useState(start.shares);
  const [price, setPrice] = useState(start.price);
  const [priceNote, setPriceNote] = useState<string | null>(start.priceDate ? `Saved daily close on ${start.priceDate}` : start === EXAMPLE ? 'Historical example price — not a live quote' : null);
  const [additional, setAdditional] = useState(start.additional ?? '0');
  const [looking, setLooking] = useState(false);

  const reset = () => {
    setTicker(start.ticker); setAvgCost(start.avgCost); setShares(start.shares); setPrice(start.price);
    setAdditional(start.additional ?? '0');
    setPriceNote(start.priceDate ? `Saved daily close on ${start.priceDate}` : start === EXAMPLE ? 'Historical example price — not a live quote' : null);
  };

  // Keeps avg cost, shares and additional investment; only replaces the price.
  const lookUp = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setLooking(true);
    try {
      const { data, error } = await supabase.functions.invoke('market-scan', { body: { mode: 'stock-quotes', tickers: [t] } });
      if (error) throw error;
      const q = data?.quotes?.[0];
      if (q?.price) {
        setPrice(String(q.price));
        setPriceNote(`Saved daily close on ${q.date} (from the app's price history, not a live quote)`);
      } else {
        setPriceNote(`No saved price for ${t} yet. Enter it manually, or run Analyze Stock on ${t} first.`);
      }
    } catch (err) {
      console.error('[price lookup]', err);
      setPriceNote('Price lookup failed. Enter it manually.');
    } finally {
      setLooking(false);
    }
  };

  const C = num(avgCost), S = num(shares), P = num(price), A = num(additional);
  const errors: string[] = [];
  if (C == null || C < 0) errors.push('Average cost must be 0 or more');
  if (S == null || S <= 0) errors.push('Shares owned must be above 0');
  if (P == null || P <= 0) errors.push('Stock price must be above 0');
  if (A == null || A < 0) errors.push('Additional investment must be 0 or more');

  const out = (() => {
    if (errors.length || C == null || S == null || P == null || A == null) return null;
    const bought = A / P;
    const totalShares = S + bought;
    const basis = C * S + A;
    const value = totalShares * P;
    const gain = value - basis;
    return { bought, totalShares, newAvg: basis / totalShares, value, gain, gainPct: basis > 0 ? (gain / basis) * 100 : 0 };
  })();

  const tone = !out || Math.abs(out.gain) < 0.005 ? 'text-slate-200' : out.gain > 0 ? 'text-emerald-400' : 'text-red-400';
  const sign = !out || Math.abs(out.gain) < 0.005 ? '' : out.gain > 0 ? '+' : '−';
  const input = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-right tabular-nums text-slate-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <span className="font-semibold text-slate-100">Stock Average Cost Calculator</span>
          <div className="flex items-center gap-3">
            <button onClick={reset} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          <div>
            <label className="mb-1 block text-slate-400">Stock ticker</label>
            <div className="flex gap-2">
              <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} className="w-32 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold text-slate-100" />
              <button onClick={() => void lookUp()} disabled={looking} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-slate-300 hover:bg-slate-800 disabled:opacity-60">
                <RefreshCw className={`h-4 w-4 ${looking ? 'animate-spin' : ''}`} /> Look Up Price
              </button>
            </div>
            {priceNote && <div className="mt-1 text-xs text-slate-500">{priceNote}</div>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {([
              ['Average cost ($)', avgCost, setAvgCost, '0.01'],
              ['Total shares owned', shares, setShares, '0.0001'],
              ['Current stock price ($)', price, (v: string) => { setPrice(v); setPriceNote('Manual price'); }, '0.01'],
              ['Additional investment ($)', additional, setAdditional, '100'],
            ] as [string, string, (v: string) => void, string][]).map(([label, value, set, step]) => (
              <label key={label} className="block">
                <span className="mb-1 block text-slate-400">{label}</span>
                <input type="number" inputMode="decimal" step={step} min="0" value={value} onChange={(e) => set(e.target.value)} className={input} />
              </label>
            ))}
          </div>

          <div>
            <input
              type="range" min={0} max={SLIDER_MAX} step={100}
              value={Math.min(SLIDER_MAX, Math.max(0, A ?? 0))}
              onChange={(e) => setAdditional(e.target.value)}
              className="w-full accent-sky-500"
              aria-label="Additional investment"
            />
            <div className="flex justify-between text-[11px] text-slate-600"><span>$0</span><span>${SLIDER_MAX.toLocaleString()}</span></div>
          </div>

          {errors.length > 0 && <div className="text-xs text-amber-300">{errors.join(' · ')}</div>}

          <div className="rounded-lg border border-slate-800 p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Updated position</div>
            <div className="grid grid-cols-2 gap-3">
              {([
                ['New average cost', out ? `$${f4(out.newAvg)}` : '--'],
                ['New total shares', out ? f4(out.totalShares) : '--'],
                ['Total value', out ? usd(out.value) : '--'],
                ['Shares purchased', out ? f4(out.bought) : '--'],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}>
                  <div className="text-xs text-slate-500">{k}</div>
                  <div className="text-base font-semibold tabular-nums text-slate-100">{v}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 p-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Total gain / loss</div>
            <div className={`text-lg font-semibold tabular-nums ${tone}`}>
              {out ? <>{sign}{usd(out.gain)} <span className="ml-2">{sign}{Math.abs(out.gainPct).toFixed(2)}%</span></> : '--'}
            </div>
          </div>

          <p className="text-[11px] text-slate-500">
            Assumes the new shares are bought at the entered price, fractional shares are available, and there are no fees. Actual brokerage execution may differ. Buying more at the same price lowers your average cost but does not remove the existing dollar loss.
          </p>
        </div>
      </div>
    </div>
  );
}
