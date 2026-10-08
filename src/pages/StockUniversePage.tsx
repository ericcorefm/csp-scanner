import { useMemo, useState } from 'react';
import { Plus, Trash2, CheckCircle2, XCircle, AlertTriangle, Download } from 'lucide-react';
import type { StockScannerState } from '@/lib/stockStore';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import type { StockStatus } from '@/lib/stockTypes';
import { Badge, formatNum } from '@/components/ui';
import { TrendBadge } from '@/pages/StockCandidatesPage';
import { TickerLink } from '@/components/TickerLink';

/**
 * Stocks watchlist used by "My Scan Universe" on Stock Candidates.
 * Separate from the Options (CSP) Scan Universe.
 */
export function StockUniversePage({
  stock, portfolio, optionsUniverse, onAnalyze,
}: { stock: StockScannerState; portfolio: StockPortfolioState; optionsUniverse: string[]; onAnalyze?: (ticker: string) => void }) {
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Status of each symbol from the latest "My Scan Universe" stock scan.
  const statusBySymbol = useMemo(() => {
    const m = new Map<string, { status: StockStatus; trend?: string; price: number | null; reason: string | null }>();
    for (const r of stock.resultsByMode.universe) {
      m.set(r.ticker, { status: r.status, trend: r.trend_classification, price: r.price, reason: r.rejection_reasons[0] ?? r.pending_reasons[0] ?? null });
    }
    return m;
  }, [stock.resultsByMode]);

  const add = async (raw: string) => {
    if (!raw.trim()) return;
    const res = await portfolio.addToUniverse(raw);
    if (res.error) setMessage({ ok: false, text: res.error });
    else setMessage({
      ok: true,
      text: `Added ${res.added}${res.skipped ? ` · ${res.skipped} already listed` : ''}${res.invalid.length ? ` · invalid: ${res.invalid.join(', ')}` : ''}. Rescan in "My Scan Universe" to evaluate.`,
    });
    setInput('');
    setTimeout(() => setMessage(null), 6000);
  };

  const ids = [...selected];
  const allSelected = portfolio.universe.length > 0 && selected.size === portfolio.universe.length;
  const enabledCount = portfolio.universe.filter((u) => u.enabled).length;
  const lastScan = stock.lastScanAtByMode.universe;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Stock Scan Universe</h1>
        <p className="text-sm text-slate-500">
          Your stock watchlist for "My Scan Universe" on Stock Candidates. Separate from the Options universe.
          {' '}{enabledCount} enabled of {portfolio.universe.length}.
          {lastScan && ` Last universe scan ${new Date(lastScan).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(input); }}
          placeholder="Add tickers, e.g. AAPL, MSFT NVDA"
          className="min-w-[260px] flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
        />
        <button onClick={() => void add(input)} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600">
          <Plus className="h-4 w-4" /> Add
        </button>
        {optionsUniverse.length > 0 && (
          <button
            onClick={() => void add(optionsUniverse.join(' '))}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
            title="Copy the enabled tickers from your Options Scan Universe"
          >
            <Download className="h-4 w-4" /> Import from Options universe ({optionsUniverse.length})
          </button>
        )}
        {message && <span className={`w-full text-sm ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>{message.text}</span>}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400">{selected.size} selected</span>
          <button onClick={() => void portfolio.setUniverseEnabled(ids, true)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800">Enable</button>
          <button onClick={() => void portfolio.setUniverseEnabled(ids, false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800">Disable</button>
          <button onClick={() => { void portfolio.removeFromUniverse(ids); setSelected(new Set()); }} className="flex items-center gap-1 rounded-lg border border-red-500/40 px-3 py-1.5 text-red-300 hover:bg-red-500/10">
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        </div>
      )}

      {portfolio.universe.length === 0 ? (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-300">
          Your stock universe is empty. Add tickers above{optionsUniverse.length ? ', or import them from your Options universe' : ''}.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                <th className="px-3 py-2.5 text-left">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(portfolio.universe.map((u) => u.id)))} />
                </th>
                <th className="px-3 py-2.5 text-left">Ticker</th>
                <th className="px-3 py-2.5 text-left">Enabled</th>
                <th className="px-3 py-2.5 text-left">Last Scan Status</th>
                <th className="px-3 py-2.5 text-left">Trend</th>
                <th className="px-3 py-2.5 text-right">Price</th>
                <th className="px-3 py-2.5 text-left">Main Reason</th>
                <th className="px-3 py-2.5 text-left">Added</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {portfolio.universe.map((u) => {
                const st = statusBySymbol.get(u.symbol);
                return (
                  <tr key={u.id} className={`border-b border-slate-800/60 ${u.enabled ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(u.id)} onChange={() => {
                        const next = new Set(selected);
                        if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
                        setSelected(next);
                      }} />
                    </td>
                    <td className="px-3 py-2 font-semibold text-slate-100"><TickerLink ticker={u.symbol} onAnalyze={onAnalyze} /><span className="ml-2 text-xs font-normal text-slate-500">{u.company_name ?? ''}</span></td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => void portfolio.setUniverseEnabled([u.id], !u.enabled)}
                        className={`relative h-5 w-9 rounded-full transition-colors ${u.enabled ? 'bg-sky-500' : 'bg-slate-700'}`}
                        aria-pressed={u.enabled}
                      >
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${u.enabled ? 'left-4' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      {!st ? <span className="text-xs text-slate-500">Not scanned yet</span>
                        : st.status === 'qualified' ? <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Qualified</span>
                        : st.status === 'pending' ? <span className="flex items-center gap-1 text-amber-400"><AlertTriangle className="h-3.5 w-3.5" /> Pending</span>
                        : <span className="flex items-center gap-1 text-red-400"><XCircle className="h-3.5 w-3.5" /> Rejected</span>}
                    </td>
                    <td className="px-3 py-2">{st ? <TrendBadge trend={st.trend} /> : null}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{st?.price != null ? formatNum(st.price) : '--'}</td>
                    <td className="px-3 py-2 text-xs">{st?.reason ? <Badge variant={st.status === 'pending' ? 'warning' : 'error'}>{st.reason}</Badge> : null}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => void portfolio.removeFromUniverse([u.id])} className="text-slate-500 hover:text-red-400" title="Remove">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
