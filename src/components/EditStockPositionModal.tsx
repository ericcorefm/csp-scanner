import { useState } from 'react';
import { X, Save } from 'lucide-react';
import type { StockPosition } from '@/lib/stockTypes';

type Field = { key: keyof StockPosition; label: string; type: 'text' | 'date' | 'number'; step?: string; optional?: boolean };

const OPEN_FIELDS: Field[] = [
  { key: 'ticker', label: 'Ticker', type: 'text' },
  { key: 'entry_date', label: 'Entry date', type: 'date' },
  { key: 'entry_price', label: 'Entry price ($)', type: 'number', step: '0.01' },
  { key: 'shares', label: 'Shares', type: 'number', step: '0.0001' },
  { key: 'target_price', label: 'Target ($)', type: 'number', step: '0.01', optional: true },
  { key: 'stop_price', label: 'Stop ($)', type: 'number', step: '0.01', optional: true },
  { key: 'max_cycle_days', label: 'Max cycle days', type: 'number', step: '1' },
  { key: 'notes', label: 'Notes', type: 'text', optional: true },
];
const CLOSED_FIELDS: Field[] = [
  ...OPEN_FIELDS.slice(0, 4),
  { key: 'exit_date', label: 'Exit date', type: 'date' },
  { key: 'exit_price', label: 'Exit price ($)', type: 'number', step: '0.01' },
  ...OPEN_FIELDS.slice(4),
];

/** Edit every saved field of an open or closed stock position. */
export function EditStockPositionModal({
  position, onSave, onClose,
}: {
  position: StockPosition;
  onSave: (patch: Partial<StockPosition>) => Promise<{ ok: boolean; error: string | null }>;
  onClose: () => void;
}) {
  const fields = position.status === 'closed' ? CLOSED_FIELDS : OPEN_FIELDS;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, position[f.key] == null ? '' : String(position[f.key])])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.key].trim();
      if (raw === '') {
        if (!f.optional) { setError(`${f.label} is required`); return; }
        patch[f.key] = null;
      } else if (f.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n) || (n <= 0 && f.key !== 'stop_price')) { setError(`${f.label} must be a positive number`); return; }
        patch[f.key] = f.key === 'max_cycle_days' ? Math.round(n) : n;
      } else {
        patch[f.key] = f.key === 'ticker' ? raw.toUpperCase() : raw;
      }
    }
    setSaving(true);
    const res = await onSave(patch as Partial<StockPosition>);
    setSaving(false);
    if (res.ok) onClose(); else setError(res.error || 'Could not save');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <span className="font-semibold text-slate-100">Edit {position.ticker} {position.status === 'closed' ? 'trade' : 'position'}</span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          {fields.map((f) => (
            <label key={f.key} className="flex items-center justify-between gap-3">
              <span className="text-slate-400">{f.label}{f.optional ? '' : ' *'}</span>
              <input
                type={f.type}
                step={f.step}
                value={values[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                className={`${f.key === 'notes' ? 'w-56' : 'w-40'} rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-slate-100 ${f.type === 'number' ? 'text-right tabular-nums' : ''}`}
              />
            </label>
          ))}
          {error && <div className="text-red-400">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300">Cancel</button>
          <button onClick={save} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
