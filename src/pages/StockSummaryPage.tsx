import { useMemo } from 'react';
import { CheckCircle2, Wallet, Target, AlertTriangle } from 'lucide-react';
import type { StockScannerState } from '@/lib/stockStore';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import { daysBetween, positionHealth, todayISO } from '@/lib/stockTypes';
import { Badge, formatNum, formatPct } from '@/components/ui';
import { TrendBadge } from '@/pages/StockCandidatesPage';

const money = (v: number) => `${v < 0 ? '−' : ''}$${formatNum(Math.abs(v))}`;
const tone = (v: number | null) => (v == null ? 'text-slate-300' : v >= 0 ? 'text-emerald-400' : 'text-red-400');

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50">
      <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-3 font-semibold text-slate-100">{icon}{title}</div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function KV({ k, v, t }: { k: string; v: string; t?: string }) {
  return <div className="flex justify-between py-1 text-sm"><span className="text-slate-500">{k}</span><span className={`tabular-nums ${t ?? 'text-slate-200'}`}>{v}</span></div>;
}

export function StockSummaryPage({ stock, portfolio }: { stock: StockScannerState; portfolio: StockPortfolioState }) {
  const today = todayISO();
  const qualified = stock.results.filter((r) => r.status === 'qualified');

  const open = useMemo(() => portfolio.openPositions.map((p) => {
    const price = portfolio.quotes[p.ticker]?.price ?? null;
    const cost = p.entry_price * p.shares;
    const pl = price != null ? (price - p.entry_price) * p.shares : null;
    return { p, price, cost, pl, health: positionHealth(p, price), held: daysBetween(p.entry_date, today) };
  }), [portfolio.openPositions, portfolio.quotes, today]);

  const invested = open.reduce((a, r) => a + r.cost, 0);
  const unrealized = open.reduce((a, r) => a + (r.pl ?? 0), 0);
  const attention = open.filter((r) => r.health !== 'Active' && r.health !== 'No price');

  const closed = portfolio.closedPositions.map((p) => ({
    p, pl: p.exit_price != null ? (p.exit_price - p.entry_price) * p.shares : 0,
    pct: p.exit_price != null ? (p.exit_price / p.entry_price - 1) * 100 : 0,
  }));
  const monthKey = today.slice(0, 7);
  const thisMonth = closed.filter((c) => (c.p.exit_date ?? '').startsWith(monthKey));
  const realizedMonth = thisMonth.reduce((a, c) => a + c.pl, 0);
  const realizedAll = closed.reduce((a, c) => a + c.pl, 0);
  const winRate = closed.length ? (closed.filter((c) => c.pl > 0).length / closed.length) * 100 : null;
  const avgPct = closed.length ? closed.reduce((a, c) => a + c.pct, 0) / closed.length : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Stock Daily Summary</h1>
        <p className="text-sm text-slate-500">
          {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          {stock.lastScanAt && ` · Last stock scan ${new Date(stock.lastScanAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${stock.scanMode === 'universe' ? 'My Scan Universe' : 'Market Discovery'})`}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={`Today's qualified stocks (${qualified.length})`} icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />}>
          {qualified.length === 0 ? (
            <div className="text-sm text-slate-500">{stock.results.length ? 'Nothing qualifies with your current Stock Settings.' : 'No stock scan yet — Rescan on Stock Candidates.'}</div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-slate-500">
                <th className="py-1 text-left">Ticker</th><th className="text-left">Trend</th><th className="text-right">Entry</th>
                <th className="text-right">Hist. hit</th><th className="text-right">Est. days</th><th className="text-right">Exp. ann.</th>
              </tr></thead>
              <tbody>
                {qualified.slice(0, 10).map((r) => (
                  <tr key={r.ticker} className="border-t border-slate-800/60">
                    <td className="py-1.5 font-semibold text-slate-100">{r.ticker}</td>
                    <td><TrendBadge trend={r.trend_classification} /></td>
                    <td className="text-right tabular-nums text-slate-300">{formatNum(r.price)}</td>
                    <td className="text-right tabular-nums text-slate-300">{formatPct(r.hist_hit_rate_pct, 0)}</td>
                    <td className="text-right tabular-nums text-slate-300">{r.est_days ?? '--'}</td>
                    <td className={`text-right tabular-nums ${tone(r.expected_annualized_pct)}`}>{r.expected_annualized_pct == null ? '--' : r.expected_annualized_pct >= 1000 ? '>1,000%' : formatPct(r.expected_annualized_pct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Open positions" icon={<Wallet className="h-4 w-4 text-sky-400" />}>
          <KV k="Open positions" v={String(open.length)} />
          <KV k="Invested" v={money(invested)} />
          <KV k="Unrealized P/L" v={money(unrealized)} t={tone(unrealized)} />
          <KV k="Unrealized %" v={invested > 0 ? formatPct((unrealized / invested) * 100, 2) : '--'} t={tone(unrealized)} />
          <KV k="Average days held" v={open.length ? formatNum(open.reduce((a, r) => a + r.held, 0) / open.length, 1) : '--'} />
        </Panel>

        <Panel title={`Needs attention (${attention.length})`} icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}>
          {attention.length === 0 ? (
            <div className="text-sm text-slate-500">No open position is at its target, stop, or past its cycle.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {attention.map(({ p, price, health, held }) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-100">{p.ticker}</span>
                  <Badge variant={health === 'Target hit' || health === 'Near target' ? 'success' : health === 'Stop hit' ? 'error' : 'warning'}>{health}</Badge>
                  <span className="text-xs text-slate-500 tabular-nums">now {price != null ? formatNum(price) : '--'} · target {p.target_price != null ? formatNum(p.target_price) : '--'} · stop {p.stop_price != null ? formatNum(p.stop_price) : '--'} · day {held}/{p.max_cycle_days}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Performance (closed trades)" icon={<Target className="h-4 w-4 text-emerald-400" />}>
          <KV k="Realized this month" v={money(realizedMonth)} t={tone(realizedMonth)} />
          <KV k="Realized all time" v={money(realizedAll)} t={tone(realizedAll)} />
          <KV k="Trades closed" v={String(closed.length)} />
          <KV k="Win rate" v={winRate != null ? formatPct(winRate, 0) : '--'} />
          <KV k="Average return / trade" v={avgPct != null ? formatPct(avgPct, 2) : '--'} t={tone(avgPct)} />
        </Panel>
      </div>
    </div>
  );
}
