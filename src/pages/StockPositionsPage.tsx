import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw, Trash2, CheckSquare, RotateCcw, X, Pencil, Download, Upload, Combine } from 'lucide-react';
import { useSort } from '@/lib/useSort';
import { SortTh } from '@/components/SortTh';
import { EditStockPositionModal } from '@/components/EditStockPositionModal';
import { exportPositionsToExcel, readPositionsFromExcel } from '@/lib/positionsExcel';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import type { StockPosition, PositionHealth } from '@/lib/stockTypes';
import { daysBetween, positionHealth, todayISO } from '@/lib/stockTypes';
import { Badge, formatNum, formatPct } from '@/components/ui';
import { TickerLink } from '@/components/TickerLink';

const HEALTH_VARIANT: Record<PositionHealth, 'success' | 'warning' | 'error' | 'neutral' | 'info'> = {
  'Target hit': 'success', 'Near target': 'success', Active: 'info',
  'Near stop': 'warning', 'Cycle ended': 'warning', 'Stop hit': 'error', 'No price': 'neutral',
};

const money = (v: number | null | undefined) => (v == null ? '--' : `${v < 0 ? '−' : ''}$${formatNum(Math.abs(v))}`);
const plColor = (v: number | null | undefined) => (v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400');

function Summary({ items }: { items: { label: string; value: string; tone?: string }[] }) {
  return (
    <div className={`grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-3 md:grid-cols-4 ${items.length > 6 ? 'lg:grid-cols-7' : 'lg:grid-cols-6'}`}>
      {items.map((i) => (
        <div key={i.label} className="text-center">
          <div className="text-xs text-slate-500">{i.label}</div>
          <div className={`text-sm font-semibold tabular-nums ${i.tone ?? 'text-slate-200'}`}>{i.value}</div>
        </div>
      ))}
    </div>
  );
}

function CloseModal({ p, price, onClose, onConfirm }: {
  p: StockPosition; price: number | null; onClose: () => void;
  onConfirm: (exit: number, date: string) => Promise<{ ok: boolean; error: string | null }>;
}) {
  const [exit, setExit] = useState(price != null ? String(price) : '');
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState<string | null>(null);
  const exitNum = Number(exit);
  const pl = exitNum > 0 ? (exitNum - p.entry_price) * p.shares : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <span className="font-semibold text-slate-100">Close {p.ticker}</span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <label className="flex items-center justify-between"><span className="text-slate-400">Exit price ($)</span>
            <input type="number" step="0.01" value={exit} onChange={(e) => setExit(e.target.value)} className="w-36 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-right text-slate-100" /></label>
          <label className="flex items-center justify-between"><span className="text-slate-400">Exit date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-36 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-slate-100" /></label>
          <div className={`text-right font-semibold ${plColor(pl)}`}>P/L: {money(pl)}</div>
          {err && <div className="text-red-400">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300">Cancel</button>
          <button
            onClick={async () => {
              if (!(exitNum > 0)) { setErr('Enter an exit price'); return; }
              const r = await onConfirm(exitNum, date);
              if (r.ok) onClose(); else setErr(r.error);
            }}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
          >Close Position</button>
        </div>
      </div>
    </div>
  );
}

type OpenKey = 'ticker' | 'status' | 'entry_date' | 'held' | 'entry' | 'shares' | 'cost' | 'current' | 'pl' | 'plPct' | 'target';
type ClosedKey = 'ticker' | 'result' | 'entry_date' | 'exit_date' | 'held' | 'entry' | 'exit' | 'shares' | 'invested' | 'pl' | 'plPct' | 'ann';
type TickerKey = 'ticker' | 'trades' | 'avgInv' | 'avgDays' | 'totalGain' | 'avgCroi' | 'recycled';

type TickerRow = { ticker: string; trades: number; avgInv: number; avgDays: number; totalGain: number; avgCroi: number; recycled: number; wins: number };

/**
 * Per-ticker results from closed trades.
 * - A trade = all rows with the same ticker and exit date (fills bought over several days, sold together, count once)
 * - Avg Investment: average capital per trade (entry price × shares, fills summed)
 * - Avg DIM: average days in market (exit date − entry date; same-day = 0)
 * - Avg CROI / Trade: average return of the individual trades
 * - Recycled CROI: total gain ÷ average investment — what recycling roughly the
 *   same capital through repeated trades returned on that capital
 */
function TickerSummary({ positions, onAnalyze }: { positions: StockPosition[]; onAnalyze?: (ticker: string) => void }) {
  const rows = useMemo<TickerRow[]>(() => {
    const by = new Map<string, StockPosition[]>();
    for (const p of positions) {
      if (p.exit_price == null) continue;
      const arr = by.get(p.ticker);
      if (arr) arr.push(p); else by.set(p.ticker, [p]);
    }
    return [...by.entries()].map(([ticker, list]) => {
      // Fills sold on the same exit date count as ONE trade (same as All Trades);
      // DIM runs from the earliest entry of that trade.
      const trades = new Map<string, { inv: number; gain: number; days: number }>();
      for (const p of list) {
        const key = p.exit_date ?? '';
        const d = p.exit_date ? Math.max(0, daysBetween(p.entry_date, p.exit_date)) : 0;
        const t = trades.get(key) ?? { inv: 0, gain: 0, days: d };
        t.inv += p.entry_price * p.shares;
        t.gain += (p.exit_price! - p.entry_price) * p.shares;
        t.days = Math.max(t.days, d);
        trades.set(key, t);
      }
      const tl = [...trades.values()];
      const n = tl.length;
      const avgInv = tl.reduce((a, t) => a + t.inv, 0) / n;
      const totalGain = tl.reduce((a, t) => a + t.gain, 0);
      return {
        ticker,
        trades: n,
        avgInv,
        avgDays: tl.reduce((a, t) => a + t.days, 0) / n,
        totalGain,
        avgCroi: (tl.reduce((a, t) => a + (t.inv > 0 ? t.gain / t.inv : 0), 0) / n) * 100,
        recycled: avgInv > 0 ? (totalGain / avgInv) * 100 : 0,
        wins: tl.filter((t) => t.gain > 0).length,
      };
    });
  }, [positions]);

  const value = useCallback((r: TickerRow, k: TickerKey) => r[k], []);
  const { sorted, sortKey, sortDir, toggle } = useSort<TickerRow, TickerKey>(rows, value, { key: 'recycled', dir: 'desc' });
  const th = (label: string, k: TickerKey, align: 'left' | 'right' = 'right', title?: string) => (
    <SortTh label={label} k={k} sortKey={sortKey} sortDir={sortDir} onSort={toggle} align={align} title={title} />
  );
  const days = (d: number) => `${formatNum(d, d % 1 === 0 ? 0 : 1)} ${d === 1 ? 'day' : 'days'}`;

  if (!rows.length) return <div className="rounded-lg border border-slate-800 px-4 py-3 text-sm text-slate-500">No closed trades with an exit price yet.</div>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
              <th className="px-3 py-2.5 text-right font-medium">Rank</th>
              {th('Ticker', 'ticker', 'left')}
              {th('Closed Trades', 'trades')}
              {th('Avg Investment', 'avgInv', 'right', 'Average capital per trade (entry price × shares)')}
              {th('Avg DIM', 'avgDays', 'right', 'Average days in market (same-day trades = 0)')}
              {th('Total Gain', 'totalGain')}
              {th('Avg CROI / Trade', 'avgCroi', 'right', 'Average return of the individual trades')}
              {th('Recycled CROI', 'recycled', 'right', 'Total gain ÷ average investment: the return from recycling roughly the same capital')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.ticker} className="border-b border-slate-800/60">
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{i + 1}</td>
                <td className="px-3 py-2 font-semibold text-slate-100"><TickerLink ticker={r.ticker} onAnalyze={onAnalyze} /></td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300" title={`${r.wins} win(s), ${r.trades - r.wins} loss(es)`}>{r.trades}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{money(r.avgInv)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{days(r.avgDays)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${plColor(r.totalGain)}`}>{r.totalGain >= 0 ? '+' : ''}{money(r.totalGain)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${plColor(r.avgCroi)}`}>{formatPct(r.avgCroi, 2)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${plColor(r.recycled)}`}>{formatPct(r.recycled, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Recycled CROI = total gain ÷ average investment. It shows what repeatedly recycling roughly the same capital in that ticker returned,
        so it grows with each winning trade. Avg CROI / Trade is the typical single-trade return.
      </p>
    </div>
  );
}

/** Export / Import buttons shared by the Open and Closed pages. */
function ExcelButtons({ portfolio, view }: { portfolio: StockPortfolioState; view: 'open' | 'closed' }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const positions = view === 'open' ? portfolio.openPositions : portfolio.closedPositions;

  const onFile = async (file: File) => {
    setBusy(true); setMsg(null);
    try {
      const { rows, skipped } = await readPositionsFromExcel(file, view);
      if (!rows.length) { setMsg({ ok: false, text: skipped[0] ?? 'No rows to import.' }); return; }
      const res = await portfolio.importPositions(rows, view);
      const parts = [`Added ${res.added} new`, `overwrote ${res.updated} existing`];
      if (skipped.length) parts.push(`skipped ${skipped.length}`);
      setMsg({
        ok: res.errors.length === 0,
        text: `${parts.join(', ')}.` + (res.errors.length ? ` Errors: ${res.errors.slice(0, 2).join('; ')}` : '') + (skipped.length ? ` (${skipped.slice(0, 2).join('; ')}${skipped.length > 2 ? '…' : ''})` : ''),
      });
    } catch (e) {
      setMsg({ ok: false, text: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => void exportPositionsToExcel(positions, view, portfolio.quotes)}
        disabled={!positions.length}
        className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        title="Download these positions as an Excel file"
      >
        <Download className="h-4 w-4" /> Export Excel
      </button>
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        title="Rows matching an existing position (same ID, or same ticker + entry date) overwrite it; other rows are added as new"
      >
        <Upload className="h-4 w-4" /> {busy ? 'Importing…' : 'Import Excel'}
      </button>
      <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
      {msg && <span className={`w-full text-right text-xs ${msg.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{msg.text}</span>}
    </div>
  );
}

/** Select all / Combine / Delete selected / Delete all for one positions list. */
function SelectionBar({ total, selectedIds, allIds, onSelectAll, onClear, portfolio, label }: {
  total: number; selectedIds: string[]; allIds: string[];
  onSelectAll: () => void; onClear: () => void; portfolio: StockPortfolioState; label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const n = selectedIds.length;
  const run = async (fn: () => Promise<{ ok: boolean; error: string | null }>, done: string) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    setMsg(res.ok ? done : res.error || 'Something went wrong');
    if (res.ok) onClear();
  };
  if (total === 0) return null;
  const btn = 'rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button onClick={n === total ? onClear : onSelectAll} className={`${btn} border-slate-700 text-slate-300 hover:bg-slate-800`}>
        {n === total ? 'Clear selection' : `Select all (${total})`}
      </button>
      {n > 0 && <span className="text-slate-400">{n} selected</span>}
      {n >= 2 && (
        <button
          disabled={busy}
          title="Merge partial fills of the same ticker into one position (share-weighted prices)"
          onClick={() => { if (confirm(`Combine ${n} selected ${label} into one position?`)) void run(() => portfolio.combinePositions(selectedIds), `Combined ${n} rows into one.`); }}
          className={`${btn} border-sky-500/50 text-sky-300 hover:bg-sky-500/10`}
        >
          <Combine className="mr-1 inline h-3.5 w-3.5" />Combine selected
        </button>
      )}
      {n > 0 && (
        <button
          disabled={busy}
          onClick={() => { if (confirm(`Delete ${n} selected ${label}? This can't be undone.`)) void run(() => portfolio.deletePositions(selectedIds), `Deleted ${n}.`); }}
          className={`${btn} border-red-500/50 text-red-300 hover:bg-red-500/10`}
        >
          <Trash2 className="mr-1 inline h-3.5 w-3.5" />Delete selected
        </button>
      )}
      <button
        disabled={busy}
        onClick={() => { if (confirm(`Delete ALL ${total} ${label}? This can't be undone. (Tip: Export Excel first as a backup.)`)) void run(() => portfolio.deletePositions(allIds), `Deleted all ${total}.`); }}
        className={`${btn} border-slate-700 text-red-300/80 hover:bg-red-500/10`}
      >
        Delete all
      </button>
      {msg && <span className="text-slate-400">{msg}</span>}
    </div>
  );
}

function RowCheck({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <td className="w-8 px-3 py-2">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 cursor-pointer accent-sky-500" />
    </td>
  );
}

export function StockPositionsPage({ portfolio, view, onAnalyze }: { portfolio: StockPortfolioState; view: 'open' | 'closed'; onAnalyze?: (ticker: string) => void }) {
  const [closing, setClosing] = useState<StockPosition | null>(null);
  const [editing, setEditing] = useState<StockPosition | null>(null);
  const [closedView, setClosedView] = useState<'trades' | 'tickers'>(() => {
    try { return localStorage.getItem('closed-stock-view') === 'tickers' ? 'tickers' : 'trades'; } catch { return 'trades'; }
  });
  const switchClosedView = (v: 'trades' | 'tickers') => {
    setClosedView(v);
    try { localStorage.setItem('closed-stock-view', v); } catch { /* storage unavailable */ }
  };
  const today = todayISO();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clearSel = () => setSelected(new Set());
  // Closed tab: month filter by exit date ('all' = every month).
  const [month, setMonth] = useState<string>('all');

  const openRows = useMemo(() => portfolio.openPositions.map((p) => {
    const q = portfolio.quotes[p.ticker];
    const price = q?.price ?? null;
    const cost = p.entry_price * p.shares;
    const value = price != null ? price * p.shares : null;
    const pl = value != null ? value - cost : null;
    return { p, price, cost, value, pl, plPct: pl != null ? (pl / cost) * 100 : null, held: daysBetween(p.entry_date, today), health: positionHealth(p, price) };
  }), [portfolio.openPositions, portfolio.quotes, today]);

  // All Trades: one row per ticker + exit date. Fills bought on one or several
  // days and sold together become ONE trade (share-weighted entry and exit
  // price, earliest entry date). "Show individual fills" turns this off.
  const [consolidate, setConsolidateState] = useState<boolean>(() => {
    try { return localStorage.getItem('closed-consolidate') !== 'off'; } catch { return true; }
  });
  const setConsolidate = (on: boolean) => {
    setConsolidateState(on);
    clearSel();
    try { localStorage.setItem('closed-consolidate', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  };
  const allClosedRows = useMemo(() => {
    const groups = new Map<string, StockPosition[]>();
    for (const p of portfolio.closedPositions) {
      const key = consolidate ? `${p.ticker}|${p.exit_date ?? ''}|${p.exit_price == null ? p.id : ''}` : p.id;
      const g = groups.get(key);
      if (g) g.push(p); else groups.set(key, [p]);
    }
    return [...groups.values()].map((fills) => {
      const sorted = [...fills].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
      const shares = fills.reduce((a, f) => a + f.shares, 0);
      const cost = fills.reduce((a, f) => a + f.entry_price * f.shares, 0);
      const exitValue = fills.every((f) => f.exit_price != null) ? fills.reduce((a, f) => a + (f.exit_price as number) * f.shares, 0) : null;
      const p: StockPosition = fills.length === 1 ? fills[0] : {
        ...sorted[0],
        shares,
        entry_price: shares > 0 ? cost / shares : sorted[0].entry_price,
        exit_price: exitValue != null && shares > 0 ? exitValue / shares : null,
      };
      const pl = exitValue != null ? exitValue - cost : null;
      const plPct = pl != null && cost > 0 ? (pl / cost) * 100 : null;
      const held = p.exit_date ? Math.max(1, daysBetween(p.entry_date, p.exit_date)) : null;
      const ann = plPct != null && held ? Math.min(1000, (Math.pow(1 + plPct / 100, 365 / Math.max(5, held)) - 1) * 100) : null;
      const lastEntry = sorted[sorted.length - 1].entry_date;
      return { p, ids: fills.map((f) => f.id), fills: fills.length, lastEntry, cost, pl, plPct, held, ann };
    });
  }, [portfolio.closedPositions, consolidate]);

  // Realized P/L per month (by exit date), newest first, for the dropdown.
  const months = useMemo(() => {
    const m = new Map<string, { pl: number; trades: number }>();
    for (const r of allClosedRows) {
      const key = r.p.exit_date ? r.p.exit_date.slice(0, 7) : 'none';
      const v = m.get(key) ?? { pl: 0, trades: 0 };
      v.pl += r.pl ?? 0; v.trades += 1;
      m.set(key, v);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [allClosedRows]);
  const closedRows = useMemo(
    () => (month === 'all' ? allClosedRows : allClosedRows.filter((r) => (r.p.exit_date ? r.p.exit_date.slice(0, 7) : 'none') === month)),
    [allClosedRows, month],
  );
  const monthLabel = (key: string) => {
    if (key === 'none') return 'No exit date';
    const [y, mo] = key.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const signedMoney = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const openValue = useCallback((r: typeof openRows[number], k: OpenKey) => ({
    ticker: r.p.ticker, status: r.health, entry_date: r.p.entry_date, held: r.held, entry: r.p.entry_price,
    shares: r.p.shares, cost: r.cost, current: r.price, pl: r.pl, plPct: r.plPct, target: r.p.target_price,
  })[k], []);
  const closedValue = useCallback((r: typeof closedRows[number], k: ClosedKey) => ({
    ticker: r.p.ticker, result: (r.pl ?? 0) > 0 ? 'Win' : 'Loss', entry_date: r.p.entry_date, exit_date: r.p.exit_date,
    held: r.held, entry: r.p.entry_price, exit: r.p.exit_price, shares: r.p.shares, invested: r.cost, pl: r.pl, plPct: r.plPct, ann: r.ann,
  })[k], []);
  const openSort = useSort<typeof openRows[number], OpenKey>(openRows, openValue);
  const closedSort = useSort<typeof closedRows[number], ClosedKey>(closedRows, closedValue);

  const editModal = editing && (
    <EditStockPositionModal position={editing} onClose={() => setEditing(null)} onSave={(patch) => portfolio.updatePosition(editing.id, patch)} />
  );
  const editBtn = (p: StockPosition) => (
    <button onClick={() => setEditing(p)} className="mr-2 text-slate-500 hover:text-sky-400" title="Edit"><Pencil className="inline h-4 w-4" /></button>
  );

  if (view === 'open') {
    const invested = openRows.reduce((a, r) => a + r.cost, 0);
    const value = openRows.reduce((a, r) => a + (r.value ?? r.cost), 0);
    const pl = value - invested;
    const th = (label: string, k: OpenKey, align: 'left' | 'right' = 'right') => (
      <SortTh label={label} k={k} sortKey={openSort.sortKey} sortDir={openSort.sortDir} onSort={openSort.toggle} align={align} />
    );
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Open Stock Positions</h1>
            <p className="text-sm text-slate-500">Prices are the latest saved daily closes (updated by every stock scan). Click a header to sort; ✎ to edit.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ExcelButtons portfolio={portfolio} view="open" />
            <button onClick={() => void portfolio.refreshQuotes()} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
              <RefreshCw className={`h-4 w-4 ${portfolio.quotesLoading ? 'animate-spin' : ''}`} /> Refresh prices
            </button>
          </div>
        </div>
        <Summary items={[
          { label: 'Open positions', value: String(openRows.length) },
          { label: 'Invested', value: money(invested) },
          { label: 'Market value', value: money(value) },
          { label: 'Unrealized P/L', value: money(pl), tone: plColor(pl) },
          { label: 'Unrealized %', value: invested > 0 ? formatPct((pl / invested) * 100, 2) : '--', tone: plColor(pl) },
          { label: 'Need attention', value: String(openRows.filter((r) => ['Target hit', 'Stop hit', 'Cycle ended'].includes(r.health)).length), tone: 'text-amber-400' },
        ]} />
        <SelectionBar
          total={openRows.length} label="open positions"
          allIds={openRows.map((r) => r.p.id)}
          selectedIds={openRows.filter((r) => selected.has(r.p.id)).map((r) => r.p.id)}
          onSelectAll={() => setSelected(new Set(openRows.map((r) => r.p.id)))} onClear={clearSel} portfolio={portfolio}
        />
        {openRows.length === 0 ? (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-300">No open stock positions. Add one from Stock Candidates or Analyze, or use Import Excel.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                  <th className="w-8 px-3 py-2.5"><input type="checkbox" aria-label="Select all" checked={openRows.length > 0 && openRows.every((r) => selected.has(r.p.id))} onChange={() => (openRows.every((r) => selected.has(r.p.id)) ? clearSel() : setSelected(new Set(openRows.map((r) => r.p.id))))} className="h-4 w-4 cursor-pointer accent-sky-500" /></th>
                  {th('Ticker', 'ticker', 'left')}{th('Status', 'status', 'left')}{th('Entry date', 'entry_date', 'left')}
                  {th('Held', 'held')}{th('Entry', 'entry')}{th('Shares', 'shares')}{th('Cost', 'cost')}
                  {th('Current', 'current')}{th('P/L', 'pl')}{th('P/L %', 'plPct')}{th('Target', 'target')}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {openSort.sorted.map(({ p, price, cost, pl, plPct, held, health }) => (
                  <tr key={p.id} className={`border-b border-slate-800/60 ${selected.has(p.id) ? 'bg-sky-500/5' : ''}`}>
                    <RowCheck checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} />
                    <td className="px-3 py-2 font-semibold text-slate-100"><TickerLink ticker={p.ticker} onAnalyze={onAnalyze} /></td>
                    <td className="px-3 py-2"><Badge variant={HEALTH_VARIANT[health]}>{health}</Badge></td>
                    <td className="px-3 py-2 text-slate-400">{p.entry_date}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${held > p.max_cycle_days ? 'text-amber-400' : 'text-slate-300'}`} title={`Max cycle: ${p.max_cycle_days} days`}>{held}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.entry_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.shares, 4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{money(cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-100">{price != null ? formatNum(price) : '--'}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${plColor(pl)}`}>{money(pl)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${plColor(plPct)}`}>{plPct != null ? formatPct(plPct, 2) : '--'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-300">{p.target_price != null ? formatNum(p.target_price) : '--'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {editBtn(p)}
                      <button onClick={() => setClosing(p)} className="mr-2 inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
                        <CheckSquare className="h-3.5 w-3.5" /> Close
                      </button>
                      <button onClick={() => { if (confirm(`Delete ${p.ticker} position?`)) void portfolio.deletePosition(p.id); }} className="text-slate-500 hover:text-red-400" title="Delete">
                        <Trash2 className="inline h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {closing && (
          <CloseModal
            p={closing}
            price={portfolio.quotes[closing.ticker]?.price ?? null}
            onClose={() => setClosing(null)}
            onConfirm={(exit, date) => portfolio.closePosition(closing.id, exit, date)}
          />
        )}
        {editModal}
      </div>
    );
  }

  const realized = closedRows.reduce((a, r) => a + (r.pl ?? 0), 0);
  const wins = closedRows.filter((r) => (r.pl ?? 0) > 0).length;
  const avgPct = closedRows.length ? closedRows.reduce((a, r) => a + (r.plPct ?? 0), 0) / closedRows.length : null;
  const avgDays = closedRows.length ? closedRows.reduce((a, r) => a + (r.held ?? 0), 0) / closedRows.length : null;
  const th = (label: string, k: ClosedKey, align: 'left' | 'right' = 'right') => (
    <SortTh label={label} k={k} sortKey={closedSort.sortKey} sortDir={closedSort.sortDir} onSort={closedSort.toggle} align={align} />
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Closed Stock Positions</h1>
          <p className="text-sm text-slate-500">Realized results. Click a header to sort; ✎ to edit. Annualized is capped at 1,000%.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            Realized P/L
            <select
              value={month}
              onChange={(e) => { setMonth(e.target.value); clearSel(); }}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            >
              <option value="all">All months ({signedMoney(allClosedRows.reduce((a, r) => a + (r.pl ?? 0), 0))})</option>
              {months.map(([key, v]) => (
                <option key={key} value={key}>{monthLabel(key)}: {signedMoney(v.pl)} · {v.trades} trade{v.trades === 1 ? '' : 's'}</option>
              ))}
            </select>
          </label>
          <ExcelButtons portfolio={portfolio} view="closed" />
        </div>
      </div>
      <Summary items={[
        { label: 'Closed trades', value: String(closedRows.length) },
        { label: 'Avg investment', value: closedRows.length ? money(closedRows.reduce((a, r) => a + r.cost, 0) / closedRows.length) : '--' },
        { label: month === 'all' ? 'Realized P/L' : `Realized P/L · ${monthLabel(month)}`, value: money(realized), tone: plColor(realized) },
        { label: 'Win rate', value: closedRows.length ? formatPct((wins / closedRows.length) * 100, 0) : '--' },
        { label: 'Avg return / trade', value: avgPct != null ? formatPct(avgPct, 2) : '--', tone: plColor(avgPct) },
        { label: 'Avg days held', value: avgDays != null ? formatNum(avgDays, 1) : '--' },
        { label: 'Wins / Losses', value: `${wins} / ${closedRows.length - wins}` },
      ]} />
      <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1 text-sm">
        {([['trades', 'All Trades'], ['tickers', 'By Ticker']] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => switchClosedView(v)}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${closedView === v ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {closedView === 'tickers' ? (
        <TickerSummary positions={portfolio.closedPositions.filter((p) => month === 'all' || (p.exit_date ? p.exit_date.slice(0, 7) : 'none') === month)} onAnalyze={onAnalyze} />
      ) : closedRows.length === 0 ? (
        <div className="rounded-lg border border-slate-800 px-4 py-3 text-sm text-slate-500">No closed stock positions yet. You can also use Import Excel.</div>
      ) : (
        <div className="space-y-3">
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-400">
          <input type="checkbox" checked={!consolidate} onChange={(e) => setConsolidate(!e.target.checked)} className="h-4 w-4 accent-sky-500" />
          Show individual fills (otherwise fills of the same ticker sold on the same day are shown as one averaged trade)
        </label>
        <SelectionBar
          total={closedRows.flatMap((r) => r.ids).length} label="closed rows"
          allIds={closedRows.flatMap((r) => r.ids)}
          selectedIds={closedRows.flatMap((r) => r.ids).filter((id) => selected.has(id))}
          onSelectAll={() => setSelected(new Set(closedRows.flatMap((r) => r.ids)))} onClear={clearSel} portfolio={portfolio}
        />
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                <th className="w-8 px-3 py-2.5"><input type="checkbox" aria-label="Select all" checked={closedRows.length > 0 && closedRows.every((r) => r.ids.every((id) => selected.has(id)))} onChange={() => (closedRows.every((r) => r.ids.every((id) => selected.has(id))) ? clearSel() : setSelected(new Set(closedRows.flatMap((r) => r.ids))))} className="h-4 w-4 cursor-pointer accent-sky-500" /></th>
                {th('Ticker', 'ticker', 'left')}{th('Result', 'result', 'left')}{th('Entry date', 'entry_date', 'left')}{th('Exit date', 'exit_date', 'left')}
                {th('Held', 'held')}{th('Entry', 'entry')}{th('Exit', 'exit')}{th('Shares', 'shares')}{th('Investment', 'invested')}
                {th('P/L', 'pl')}{th('P/L %', 'plPct')}{th('Annualized', 'ann')}
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {closedSort.sorted.map(({ p, ids, fills, lastEntry, cost, pl, plPct, held, ann }) => {
                const allSel = ids.every((id) => selected.has(id));
                const toggleGroup = () => setSelected((prev) => {
                  const n = new Set(prev);
                  if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
                  return n;
                });
                return (
                <tr key={ids.join(',')} className={`border-b border-slate-800/60 ${allSel ? 'bg-sky-500/5' : ''}`}>
                  <RowCheck checked={allSel} onChange={toggleGroup} />
                  <td className="px-3 py-2 font-semibold text-slate-100">
                    <TickerLink ticker={p.ticker} onAnalyze={onAnalyze} />
                    {fills > 1 && <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-400" title="Rows averaged into this trade">{fills} fills</span>}
                  </td>
                  <td className="px-3 py-2"><Badge variant={(pl ?? 0) > 0 ? 'success' : 'error'}>{(pl ?? 0) > 0 ? 'Win' : 'Loss'}</Badge></td>
                  <td className="px-3 py-2 text-slate-400" title={fills > 1 && lastEntry !== p.entry_date ? `Bought ${p.entry_date} to ${lastEntry}` : undefined}>
                    {p.entry_date}{fills > 1 && lastEntry !== p.entry_date && <span className="text-slate-600"> → {lastEntry.slice(5)}</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{p.exit_date ?? '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{held ?? '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.entry_price)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{p.exit_price != null ? formatNum(p.exit_price) : '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.shares, 4)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{money(cost)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${plColor(pl)}`}>{money(pl)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${plColor(plPct)}`}>{plPct != null ? formatPct(plPct, 2) : '--'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${plColor(ann)}`}>{ann == null ? '--' : ann >= 1000 ? '>1,000%' : formatPct(ann, 0)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {fills > 1 ? (
                      <>
                        <button
                          onClick={() => { if (confirm(`Permanently merge the ${fills} ${p.ticker} fills into one saved trade (average entry ${formatNum(p.entry_price)}, average exit ${p.exit_price != null ? formatNum(p.exit_price) : '--'})?`)) void portfolio.combinePositions(ids); }}
                          className="mr-2 inline-flex items-center gap-1 rounded-lg border border-sky-500/50 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/10"
                          title="Save these fills as one trade (can't be undone)"
                        >
                          <Combine className="h-3.5 w-3.5" /> Combine
                        </button>
                        <button onClick={() => { if (confirm(`Delete all ${fills} ${p.ticker} fills of this trade?`)) void portfolio.deletePositions(ids); }} className="text-slate-500 hover:text-red-400" title="Delete this trade (all fills)"><Trash2 className="inline h-4 w-4" /></button>
                      </>
                    ) : (
                      <>
                        {editBtn(p)}
                        <button onClick={() => void portfolio.reopenPosition(p.id)} className="mr-2 text-slate-500 hover:text-sky-400" title="Reopen"><RotateCcw className="inline h-4 w-4" /></button>
                        <button onClick={() => { if (confirm(`Delete ${p.ticker} trade?`)) void portfolio.deletePosition(p.id); }} className="text-slate-500 hover:text-red-400" title="Delete"><Trash2 className="inline h-4 w-4" /></button>
                      </>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </div>
      )}
      {editModal}
    </div>
  );
}
