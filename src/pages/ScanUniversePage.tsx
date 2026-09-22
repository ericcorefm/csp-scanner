import { useState, useMemo } from 'react';
import { Plus, Trash2, RotateCcw, Power, AlertCircle } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Card, Badge } from '@/components/ui';

export function ScanUniversePage({ state }: { state: AppState }) {
  const [newTicker, setNewTicker] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const entries = state.scanUniverseEntries;
  const activeCount = entries.filter((e) => e.enabled).length;
  const disabledCount = entries.filter((e) => !e.enabled).length;

  const allSelected = entries.length > 0 && selected.size === entries.length;
  const someSelected = selected.size > 0 && selected.size < entries.length;

  const toggleRow = (symbol: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map((e) => e.symbol)));
    }
  };

  const handleAdd = async () => {
    const sym = newTicker.toUpperCase().trim();
    if (!sym) return;
    if (entries.some((e) => e.symbol === sym)) {
      setError(`${sym} is already in the scan universe`);
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      await state.addToScanUniverse(sym);
      setNewTicker('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add ticker');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggle = async (symbol: string, enabled: boolean) => {
    setActionLoading(true);
    setError(null);
    try {
      await state.toggleScanUniverseEnabled(symbol, enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle ticker');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!confirm(`Delete ${count} selected ticker${count > 1 ? 's' : ''} from Scan Universe?`)) return;
    setActionLoading(true);
    setError(null);
    try {
      await state.removeFromScanUniverseBulk([...selected]);
      setSelected(new Set());
    } catch (err) {
      setError('Could not delete selected tickers.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestoreDefaults = async () => {
    if (!confirm('Restore the default scan universe? This will re-add the 9 default tickers if missing.')) return;
    setActionLoading(true);
    setError(null);
    try {
      await state.restoreDefaultUniverse();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore defaults');
    } finally {
      setActionLoading(false);
    }
  };

  const headerCheckboxRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = someSelected;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Scan Universe</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Manage the stock tickers included in the Rescan process. Only enabled tickers are scanned.
        </p>
      </div>

      {/* Summary stats */}
      <div className="flex flex-wrap items-center gap-4">
        <Card className="px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums text-slate-100">{entries.length}</span>
            <span className="text-sm text-slate-400">total tickers</span>
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums text-emerald-400">{activeCount}</span>
            <span className="text-sm text-slate-400">active</span>
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-semibold tabular-nums ${disabledCount > 0 ? 'text-amber-400' : 'text-slate-300'}`}>{disabledCount}</span>
            <span className="text-sm text-slate-400">disabled</span>
          </div>
        </Card>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Add ticker + action buttons */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="e.g. SOFI"
              className="w-36 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 uppercase placeholder:text-slate-600 placeholder:normal-case"
            />
            <button
              onClick={handleAdd}
              disabled={!newTicker.trim() || actionLoading}
              className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              Add Ticker
            </button>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={toggleSelectAll}
              disabled={entries.length === 0 || actionLoading}
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selected.size === 0 || actionLoading}
              className="flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-4 w-4" />
              Delete Selected ({selected.size})
            </button>
            <button
              onClick={handleRestoreDefaults}
              disabled={actionLoading}
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              Restore Defaults
            </button>
          </div>
        </div>
      </Card>

      {/* Ticker table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-800 bg-slate-900/80">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400 w-10">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={entries.length === 0 || actionLoading}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500/40 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400">Ticker</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400">Company Name</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400">Added Date</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400">Source</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-400">Status</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-400">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {entries.map((entry) => {
                const isChecked = selected.has(entry.symbol);
                return (
                  <tr key={entry.id} className={`hover:bg-slate-800/40 transition-colors ${!entry.enabled ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRow(entry.symbol)}
                        disabled={actionLoading}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500/40 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-slate-100">{entry.symbol}</td>
                    <td className="px-4 py-2.5 text-slate-400">{entry.company_name || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={entry.source === 'default' ? 'info' : 'neutral'}>
                        {entry.source}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${entry.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${entry.enabled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        {entry.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleToggle(entry.symbol, !entry.enabled)}
                        disabled={actionLoading}
                        title={entry.enabled ? 'Disable' : 'Enable'}
                        className={`rounded-md p-1.5 transition-colors disabled:opacity-50 ${
                          entry.enabled
                            ? 'text-slate-400 hover:bg-amber-900/20 hover:text-amber-400'
                            : 'text-slate-400 hover:bg-emerald-900/20 hover:text-emerald-400'
                        }`}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No tickers in the scan universe. Add tickers above or restore the defaults.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
