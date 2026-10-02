import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import type { StockResult, NewStockPosition } from '@/lib/stockTypes';
import { todayISO } from '@/lib/stockTypes';
import { formatNum } from '@/components/ui';

/**
 * Add a stock position, pre-filled from the scan's trade plan.
 * Fractional shares, no commission: shares = dollars ÷ entry price.
 */
export function StockPositionModal({
  result,
  defaultSize,
  defaultCycleDays,
  onSave,
  onClose,
}: {
  result: StockResult;
  defaultSize: number;
  defaultCycleDays: number;
  onSave: (p: NewStockPosition) => Promise<{ ok: boolean; error: string | null }>;
  onClose: () => void;
}) {
  const [entryDate, setEntryDate] = useState(todayISO());
  const [entryPrice, setEntryPrice] = useState(String(result.price ?? ''));
  const [dollars, setDollars] = useState(String(defaultSize));
  const [target, setTarget] = useState(result.target_price != null ? String(result.target_price) : '');
  const [stop, setStop] = useState(result.stop_price != null ? String(result.stop_price) : '');
  const [cycle, setCycle] = useState(String(defaultCycleDays));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const price = Number(entryPrice);
  const amount = Number(dollars);
  const shares = price > 0 && amount > 0 ? amount / price : 0;
  const tgt = Number(target);
  const stp = Number(stop);
  const profit = shares > 0 && tgt > 0 ? (tgt - price) * shares : null;
  const loss = shares > 0 && stp > 0 ? (price - stp) * shares : null;

  const save = async () => {
    if (!(price > 0) || !(shares > 0)) { setError('Enter an entry price and a dollar amount.'); return; }
    setSaving(true);
    const res = await onSave({
      ticker: result.ticker,
      company_name: result.company_name || null,
      entry_date: entryDate,
      entry_price: price,
      shares: Number(shares.toFixed(6)),
      target_price: tgt > 0 ? tgt : null,
      stop_price: stp > 0 ? stp : null,
      max_cycle_days: Math.max(1, Math.round(Number(cycle) || defaultCycleDays)),
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (res.ok) onClose();
    else setError(res.error || 'Could not save position');
  };

  const field = (label: string, value: string, set: (v: string) => void, type = 'number', step = '0.01') => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-slate-400">{label}</span>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-right text-slate-100 tabular-nums"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="font-semibold text-slate-100">Add Stock Position · {result.ticker}</div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          {field('Entry date', entryDate, setEntryDate, 'date', '1')}
          {field('Entry price ($)', entryPrice, setEntryPrice)}
          {field('Amount invested ($)', dollars, setDollars, 'number', '50')}
          <div className="flex justify-between text-xs text-slate-500">
            <span>Shares (fractional)</span><span className="tabular-nums">{shares > 0 ? formatNum(shares, 4) : '--'}</span>
          </div>
          {field('Target price ($)', target, setTarget)}
          {field('Stop price ($)', stop, setStop)}
          {field('Max cycle days', cycle, setCycle, 'number', '1')}
          <label className="block text-sm">
            <span className="text-slate-400">Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-slate-100" />
          </label>
          <div className="flex justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-xs">
            <span className="text-emerald-400">At target: {profit != null ? `+$${formatNum(profit)}` : '--'}</span>
            <span className="text-red-400">At stop: {loss != null ? `−$${formatNum(loss)}` : '--'}</span>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
            <Plus className="h-4 w-4" /> {saving ? 'Saving…' : 'Add Position'}
          </button>
        </div>
      </div>
    </div>
  );
}
