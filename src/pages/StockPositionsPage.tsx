import { useMemo, useState } from 'react';
import { RefreshCw, Trash2, CheckSquare, RotateCcw, X } from 'lucide-react';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import type { StockPosition, PositionHealth } from '@/lib/stockTypes';
import { daysBetween, positionHealth, todayISO } from '@/lib/stockTypes';
import { Badge, formatNum, formatPct } from '@/components/ui';

const HEALTH_VARIANT: Record<PositionHealth, 'success' | 'warning' | 'error' | 'neutral' | 'info'> = {
  'Target hit': 'success', 'Near target': 'success', Active: 'info',
  'Near stop': 'warning', 'Cycle ended': 'warning', 'Stop hit': 'error', 'No price': 'neutral',
};

const money = (v: number | null | undefined) => (v == null ? '--' : `${v < 0 ? '−' : ''}$${formatNum(Math.abs(v))}`);
const plColor = (v: number | null | undefined) => (v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400');

function Summary({ items }: { items: { label: string; value: string; tone?: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-3 md:grid-cols-4 lg:grid-cols-6">
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

export function StockPositionsPage({ portfolio, view }: { portfolio: StockPortfolioState; view: 'open' | 'closed' }) {
  const [closing, setClosing] = useState<StockPosition | null>(null);
  const today = todayISO();

  const openRows = useMemo(() => portfolio.openPositions.map((p) => {
    const q = portfolio.quotes[p.ticker];
    const price = q?.price ?? null;
    const cost = p.entry_price * p.shares;
    const value = price != null ? price * p.shares : null;
    const pl = value != null ? value - cost : null;
    return { p, q, price, cost, value, pl, plPct: pl != null ? (pl / cost) * 100 : null, held: daysBetween(p.entry_date, today), health: positionHealth(p, price) };
  }), [portfolio.openPositions, portfolio.quotes, today]);

  const closedRows = useMemo(() => portfolio.closedPositions.map((p) => {
    const cost = p.entry_price * p.shares;
    const pl = p.exit_price != null ? (p.exit_price - p.entry_price) * p.shares : null;
    const plPct = pl != null ? (pl / cost) * 100 : null;
    const held = p.exit_date ? Math.max(1, daysBetween(p.entry_date, p.exit_date)) : null;
    const ann = plPct != null && held ? Math.min(1000, (Math.pow(1 + plPct / 100, 365 / Math.max(5, held)) - 1) * 100) : null;
    return { p, cost, pl, plPct, held, ann };
  }), [portfolio.closedPositions]);

  if (view === 'open') {
    const invested = openRows.reduce((a, r) => a + r.cost, 0);
    const value = openRows.reduce((a, r) => a + (r.value ?? r.cost), 0);
    const pl = value - invested;
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Open Stock Positions</h1>
            <p className="text-sm text-slate-500">Prices are the latest saved daily closes (updated by every stock scan). Add positions from Stock Candidates or Analyze.</p>
          </div>
          <button onClick={() => void portfolio.refreshQuotes()} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
            <RefreshCw className={`h-4 w-4 ${portfolio.quotesLoading ? 'animate-spin' : ''}`} /> Refresh prices
          </button>
        </div>
        <Summary items={[
          { label: 'Open positions', value: String(openRows.length) },
          { label: 'Invested', value: money(invested) },
          { label: 'Market value', value: money(value) },
          { label: 'Unrealized P/L', value: money(pl), tone: plColor(pl) },
          { label: 'Unrealized %', value: invested > 0 ? formatPct((pl / invested) * 100, 2) : '--', tone: plColor(pl) },
          { label: 'Need attention', value: String(openRows.filter((r) => ['Target hit', 'Stop hit', 'Cycle ended'].includes(r.health)).length), tone: 'text-amber-400' },
        ]} />
        {openRows.length === 0 ? (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-300">No open stock positions. Open a row on Stock Candidates and click "Add Position".</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                  {['Ticker', 'Status', 'Entry date', 'Held', 'Entry', 'Shares', 'Cost', 'Current', 'Day %', 'P/L', 'P/L %', 'Target', 'Stop', ''].map((h, i) => (
                    <th key={h + i} className={`whitespace-nowrap px-3 py-2.5 ${i <= 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openRows.map(({ p, q, price, cost, pl, plPct, held, health }) => (
                  <tr key={p.id} className="border-b border-slate-800/60">
                    <td className="px-3 py-2 font-semibold text-slate-100">{p.ticker}</td>
                    <td className="px-3 py-2"><Badge variant={HEALTH_VARIANT[health]}>{health}</Badge></td>
                    <td className="px-3 py-2 text-slate-400">{p.entry_date}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${held > p.max_cycle_days ? 'text-amber-400' : 'text-slate-300'}`}>{held}/{p.max_cycle_days}d</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.entry_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.shares, 4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{money(cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-100">{price != null ? formatNum(price) : '--'}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${plColor(q?.day_change_pct)}`}>{q?.day_change_pct != null ? formatPct(q.day_change_pct, 2) : '--'}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${plColor(pl)}`}>{money(pl)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${plColor(plPct)}`}>{plPct != null ? formatPct(plPct, 2) : '--'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-300">{p.target_price != null ? formatNum(p.target_price) : '--'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-300">{p.stop_price != null ? formatNum(p.stop_price) : '--'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
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
      </div>
    );
  }

  const realized = closedRows.reduce((a, r) => a + (r.pl ?? 0), 0);
  const wins = closedRows.filter((r) => (r.pl ?? 0) > 0).length;
  const avgPct = closedRows.length ? closedRows.reduce((a, r) => a + (r.plPct ?? 0), 0) / closedRows.length : null;
  const avgDays = closedRows.length ? closedRows.reduce((a, r) => a + (r.held ?? 0), 0) / closedRows.length : null;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Closed Stock Positions</h1>
        <p className="text-sm text-slate-500">Realized results. Annualized = the trade's return compounded over a year of similar cycles (capped at 1,000%).</p>
      </div>
      <Summary items={[
        { label: 'Closed trades', value: String(closedRows.length) },
        { label: 'Realized P/L', value: money(realized), tone: plColor(realized) },
        { label: 'Win rate', value: closedRows.length ? formatPct((wins / closedRows.length) * 100, 0) : '--' },
        { label: 'Avg return / trade', value: avgPct != null ? formatPct(avgPct, 2) : '--', tone: plColor(avgPct) },
        { label: 'Avg days held', value: avgDays != null ? formatNum(avgDays, 1) : '--' },
        { label: 'Wins / Losses', value: `${wins} / ${closedRows.length - wins}` },
      ]} />
      {closedRows.length === 0 ? (
        <div className="rounded-lg border border-slate-800 px-4 py-3 text-sm text-slate-500">No closed stock positions yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                {['Ticker', 'Result', 'Entry date', 'Exit date', 'Days', 'Entry', 'Exit', 'Shares', 'P/L', 'P/L %', 'Annualized', ''].map((h, i) => (
                  <th key={h + i} className={`whitespace-nowrap px-3 py-2.5 ${i <= 3 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {closedRows.map(({ p, pl, plPct, held, ann }) => (
                <tr key={p.id} className="border-b border-slate-800/60">
                  <td className="px-3 py-2 font-semibold text-slate-100">{p.ticker}</td>
                  <td className="px-3 py-2"><Badge variant={(pl ?? 0) > 0 ? 'success' : 'error'}>{(pl ?? 0) > 0 ? 'Win' : 'Loss'}</Badge></td>
                  <td className="px-3 py-2 text-slate-400">{p.entry_date}</td>
                  <td className="px-3 py-2 text-slate-400">{p.exit_date ?? '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{held ?? '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.entry_price)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{p.exit_price != null ? formatNum(p.exit_price) : '--'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatNum(p.shares, 4)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${plColor(pl)}`}>{money(pl)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${plColor(plPct)}`}>{plPct != null ? formatPct(plPct, 2) : '--'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${plColor(ann)}`}>{ann == null ? '--' : ann >= 1000 ? '>1,000%' : formatPct(ann, 0)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button onClick={() => void portfolio.reopenPosition(p.id)} className="mr-2 text-slate-500 hover:text-sky-400" title="Reopen"><RotateCcw className="inline h-4 w-4" /></button>
                    <button onClick={() => { if (confirm(`Delete ${p.ticker} trade?`)) void portfolio.deletePosition(p.id); }} className="text-slate-500 hover:text-red-400" title="Delete"><Trash2 className="inline h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
