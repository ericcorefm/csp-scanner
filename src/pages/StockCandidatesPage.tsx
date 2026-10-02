import { Fragment, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Telescope, Globe, ArrowUp, ArrowDown, Info } from 'lucide-react';
import type { StockScannerState } from '@/lib/stockStore';
import type { StockResult, StockStatus } from '@/lib/stockTypes';
import { Badge, formatNum, formatPct } from '@/components/ui';

type SortKey = keyof StockResult;

const DASH = <span className="text-slate-600">--</span>;
const STATUS_RANK: Record<StockStatus, number> = { qualified: 0, pending: 1, rejected: 2 };

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
      <button
        onClick={onClick}
        className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-sky-500' : 'bg-slate-700'}`}
        aria-pressed={on}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? 'left-4' : 'left-0.5'}`} />
      </button>
      {label}
    </label>
  );
}

function CountItem({ label, value, color = 'text-slate-200' }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function StatusIcon({ status }: { status: StockStatus }) {
  if (status === 'qualified') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-label="Qualified" />;
  if (status === 'pending') return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" aria-label="Pending" />;
  return <XCircle className="h-3.5 w-3.5 text-red-400" aria-label="Rejected" />;
}

const pctColor = (v: number | null, good: number) =>
  v == null ? 'text-slate-500' : v >= good ? 'text-emerald-400' : 'text-slate-300';

const COLUMNS: { key: SortKey; label: string; title: string; align?: 'left' | 'right' }[] = [
  { key: 'ticker', label: 'Ticker', title: 'Ticker', align: 'left' },
  { key: 'price', label: 'Entry', title: 'Latest close (entry price)' },
  { key: 'day_change_pct', label: 'Day %', title: 'Change vs previous close' },
  { key: 'rsi', label: 'RSI', title: 'RSI(14), Wilder — same as TradingView' },
  { key: 'above_ma200_pct', label: 'vs MA200', title: '% above the 200-day moving average (arrow = MA200 rising/falling)' },
  { key: 'dist_to_support_pct', label: 'Above Sup.', title: '% the price sits above primary support' },
  { key: 'hv_pct', label: 'HV', title: '60-day historical volatility (annualized)' },
  { key: 'target_price', label: 'Target', title: 'Entry × (1 + target return). No commission.' },
  { key: 'stop_price', label: 'Stop', title: 'Primary support minus the stop buffer' },
  { key: 'reward_risk', label: 'R:R', title: 'Target % ÷ % distance to stop' },
  { key: 'prob_target_pct', label: 'Prob. Target', title: 'Model: chance the price touches the target within the cycle (2,000 simulated paths, no upward drift)' },
  { key: 'pop_pct', label: 'POP', title: 'Model: probability of profit — target hit first, or above entry at the end of the cycle' },
  { key: 'hist_hit_rate_pct', label: 'Hist. Hit', title: 'This stock, last ~2 years: how often this exact trade plan hit the target before the stop' },
  { key: 'est_days', label: 'Est. Days', title: 'Model: median calendar days to reach the target' },
  { key: 'annualized_if_hit_pct', label: 'Ann. if Hit', title: 'Annualized return if every cycle hits the target in Est. Days (optimistic)' },
  { key: 'expected_annualized_pct', label: 'Exp. Ann.', title: 'Realistic: wins, stops and time-exits as they actually played out on this stock, compounded over a year' },
];

export function StockCandidatesPage({ stock }: { stock: StockScannerState }) {
  const [showPending, setShowPending] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);

  const isDiscovery = stock.scanMode === 'discovery';
  const counts = stock.counts;
  const rules = stock.profile?.rules;

  const rows = useMemo(() => {
    const list = stock.results.filter((r) =>
      r.status === 'qualified' || (r.status === 'pending' && showPending) || (r.status === 'rejected' && showRejected),
    );
    if (!sortKey) return list; // server order: status, then Expected Annualized, POP, Hist. Hit
    return [...list].sort((a, b) => {
      const sa = STATUS_RANK[a.status], sb = STATUS_RANK[b.status];
      if (sa !== sb) return sa - sb;
      const av = a[sortKey], bv = b[sortKey];
      const aMissing = av == null, bMissing = bv == null;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return 0;
      const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : Number(av) - Number(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [stock.results, showPending, showRejected, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'ticker' ? 'asc' : 'desc'); }
  };

  const colCount = COLUMNS.length;

  return (
    <div className="space-y-5">
      {(stock.autoLoad || (counts?.still_pending_history ?? 0) > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-3">
            <Toggle on={stock.autoLoad} onClick={() => stock.setAutoLoad(!stock.autoLoad)} label="Keep loading history" />
            <span className="text-sky-300">
              {stock.autoLoad
                ? stock.scanning
                  ? 'Scanning… loading the next batch of price history.'
                  : stock.secondsToNextScan != null
                    ? `Next automatic Rescan in ${stock.secondsToNextScan}s · ${counts?.still_pending_history ?? 0} stock(s) still loading.`
                    : 'Starting…'
                : `${counts?.still_pending_history ?? 0} stock(s) still need price history. Turn this on to Rescan automatically every ~70 seconds until done.`}
            </span>
          </div>
          {stock.autoLoad && (
            <span className="text-xs text-slate-500">Keep this tab open. It stops by itself when all history is loaded.</span>
          )}
        </div>
      )}

      {stock.notice && !stock.scanning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-300">{stock.notice}</div>
      )}
      {stock.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-300">{stock.error}</div>
      )}

      {counts && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-3">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <CountItem label="Stocks Screened" value={counts.stocks_screened} />
            <CountItem label="Qualified" value={counts.qualified} color="text-emerald-400" />
            <CountItem label="Pending" value={counts.pending} color="text-amber-400" />
            <CountItem label="Rejected" value={counts.rejected} color="text-red-400" />
            <CountItem label="History Loaded This Scan" value={counts.history_fetched_this_scan} color="text-sky-400" />
            <CountItem
              label="Last Scan"
              value={stock.lastScanAt ? new Date(stock.lastScanAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '--'}
            />
          </div>
        </div>
      )}

      {counts && counts.qualified === 0 && (counts.pending > 0 || counts.rejected > 0) && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-3 text-xs">
          <div className="mb-2 text-sm font-medium text-slate-300">Why nothing qualified</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(counts.pending_breakdown || {}).sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
              <Badge key={'p' + reason} variant="warning">Pending: {reason} · {n}</Badge>
            ))}
            {Object.entries(counts.rejection_breakdown || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, n]) => (
              <Badge key={'r' + reason} variant="error">{reason} · {n}</Badge>
            ))}
          </div>
          <div className="mt-2 text-slate-500">Counts are stocks per reason. Rules use your last SAVED Stock Settings.</div>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Stock Candidates</h1>
          <p className="text-sm text-slate-500">
            Pullbacks in an uptrend that can return {rules ? `${rules.target_return_pct}%` : 'your target'} within{' '}
            {rules ? `${rules.max_cycle_days} days` : 'the cycle'}. No commission · fractional shares.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 p-1">
          <button
            onClick={() => stock.setScanMode('discovery')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <Telescope className="h-4 w-4" /> Market Discovery
          </button>
          <button
            onClick={() => stock.setScanMode('universe')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${!isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <Globe className="h-4 w-4" /> My Scan Universe
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {rows.filter((r) => r.status === 'qualified').length} qualified
          {showPending && ` · ${rows.filter((r) => r.status === 'pending').length} pending`}
          {showRejected && ` · ${rows.filter((r) => r.status === 'rejected').length} rejected`}
        </p>
        <div className="flex items-center gap-4">
          <Toggle on={showPending} onClick={() => setShowPending(!showPending)} label="Show Pending" />
          <Toggle on={showRejected} onClick={() => setShowRejected(!showRejected)} label="Show Rejected" />
        </div>
      </div>

      {stock.results.length === 0 && !stock.scanning && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-sky-300">
          No stock scan yet — click Rescan to scan {isDiscovery ? 'the market universe' : 'your Scan Universe'}.
        </div>
      )}

      {stock.results.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs text-slate-400">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    title={c.title}
                    onClick={() => onSort(c.key)}
                    className={`cursor-pointer whitespace-nowrap px-3 py-2.5 font-medium hover:text-slate-200 ${c.align === 'left' ? 'text-left' : 'text-right'}`}
                  >
                    {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = expanded === r.ticker;
                return (
                  <Fragment key={r.ticker}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : r.ticker)}
                      className={`cursor-pointer border-b border-slate-800/60 hover:bg-slate-800/40 ${r.status === 'qualified' ? '' : 'opacity-75'}`}
                    >
                      <td className="px-3 py-2.5 text-left">
                        <span className="flex items-center gap-1.5 font-semibold text-slate-100">
                          <StatusIcon status={r.status} /> {r.ticker}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{r.price != null ? formatNum(r.price) : DASH}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${r.day_change_pct == null ? '' : r.day_change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {r.day_change_pct != null ? formatPct(r.day_change_pct, 2) : DASH}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.rsi != null ? formatNum(r.rsi, 1) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                        {r.above_ma200_pct != null ? (
                          <span className="inline-flex items-center gap-1">
                            {r.ma200_rising === true && <ArrowUp className="h-3 w-3 text-emerald-400" />}
                            {r.ma200_rising === false && <ArrowDown className="h-3 w-3 text-red-400" />}
                            {formatPct(r.above_ma200_pct)}
                          </span>
                        ) : DASH}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.dist_to_support_pct != null ? formatPct(r.dist_to_support_pct) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.hv_pct != null ? formatPct(r.hv_pct, 0) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">{r.target_price != null ? formatNum(r.target_price) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.stop_price != null ? formatNum(r.stop_price) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.reward_risk != null ? formatNum(r.reward_risk, 2) : DASH}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${pctColor(r.prob_target_pct, rules?.min_prob_target ?? 50)}`}>{r.prob_target_pct != null ? formatPct(r.prob_target_pct, 0) : DASH}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${pctColor(r.pop_pct, rules?.min_pop ?? 60)}`}>{r.pop_pct != null ? formatPct(r.pop_pct, 0) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.hist_hit_rate_pct != null ? formatPct(r.hist_hit_rate_pct, 0) : DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{r.est_days ?? DASH}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{r.annualized_if_hit_pct != null ? formatPct(r.annualized_if_hit_pct, 0) : DASH}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${r.expected_annualized_pct == null ? '' : r.expected_annualized_pct > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {r.expected_annualized_pct != null ? formatPct(r.expected_annualized_pct, 0) : DASH}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-slate-800/60 bg-slate-900/80">
                        <td colSpan={colCount} className="px-4 py-4">
                          <StockDetail r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-800 px-4 py-3 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Qualified</span>
        <span className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Pending (data missing)</span>
        <span className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-red-400" /> Rejected</span>
        <span className="flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> Click a row for the trade plan and rule checklist. Hover a column header for its definition.</span>
        <span>Probabilities are estimates from past behavior, not guarantees. Gaps (e.g. earnings) can jump past a stop.</span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-200">{value}</span>
    </div>
  );
}

function StockDetail({ r }: { r: StockResult }) {
  return (
    <div className="grid gap-6 text-xs md:grid-cols-3">
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-200">Trade plan {r.company_name ? `· ${r.company_name}` : ''}</div>
        <Stat label="Entry" value={formatNum(r.price)} />
        <Stat label={`Target (+${r.target_pct}%)`} value={formatNum(r.target_price)} />
        <Stat label="Stop (below support)" value={r.stop_price != null ? `${formatNum(r.stop_price)} (−${formatNum(r.risk_pct, 1)}%)` : '--'} />
        <Stat label="Position size" value={`$${formatNum(r.position_size, 0)}`} />
        <Stat label="Shares (fractional)" value={r.shares != null ? formatNum(r.shares, 4) : '--'} />
        <Stat label="Profit at target" value={r.profit_at_target != null ? `$${formatNum(r.profit_at_target)}` : '--'} />
        <Stat label="Hist. avg return / cycle" value={r.expected_return_pct != null ? `${formatPct(r.expected_return_pct, 2)} over ~${r.expected_cycle_days}d` : '--'} />
        <Stat label="Prob. of stop (model)" value={formatPct(r.prob_stop_pct, 0)} />
        <Stat label="Replay samples" value={r.replay_samples ?? '--'} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-200">Technicals</div>
        <Stat label="MA20 / MA50 / MA200" value={`${formatNum(r.ma20)} / ${formatNum(r.ma50)} / ${formatNum(r.ma200)}`} />
        <Stat label="vs MA50" value={formatPct(r.above_ma50_pct)} />
        <Stat label="MA200 trend" value={r.ma200_rising == null ? '--' : r.ma200_rising ? 'Rising ↑' : 'Falling ↓'} />
        <Stat label="Primary support" value={formatNum(r.support)} />
        <Stat label="From 52-week high" value={r.from_52w_high_pct != null ? `−${formatPct(r.from_52w_high_pct)}` : '--'} />
        <Stat label="3-month return" value={formatPct(r.return_3m_pct)} />
        <Stat label="vs SPY (3 months)" value={r.rs_vs_spy_pct != null ? `${r.rs_vs_spy_pct >= 0 ? '+' : ''}${formatPct(r.rs_vs_spy_pct)}` : '--'} />
        <Stat label="Avg volume (20d)" value={r.avg_volume != null ? r.avg_volume.toLocaleString() : '--'} />
        <Stat label="Dollar volume" value={r.dollar_volume_m != null ? `$${formatNum(r.dollar_volume_m, 1)}M` : '--'} />
        <Stat label="History bars" value={r.history_bars} />
      </div>
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-200">Rule checklist</div>
        {r.pass_fail.length === 0 && <div className="text-slate-500">No rules enabled.</div>}
        <ul className="space-y-1">
          {r.pass_fail.map((pf) => (
            <li key={pf.rule} className="flex items-center gap-2">
              {pf.status === 'pass' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
              {pf.status === 'fail' && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
              {pf.status === 'not_evaluated' && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
              <span className={pf.status === 'fail' ? 'text-red-300' : pf.status === 'not_evaluated' ? 'text-amber-300' : 'text-slate-300'}>{pf.rule}</span>
            </li>
          ))}
        </ul>
        {(r.rejection_reasons.length > 0 || r.pending_reasons.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {r.rejection_reasons.map((x) => <Badge key={x} variant="error">{x}</Badge>)}
            {r.pending_reasons.map((x) => <Badge key={'p' + x} variant="warning">Pending: {x}</Badge>)}
          </div>
        )}
        {r.history_note && <div className="mt-2 text-amber-300">History: {r.history_note}</div>}
      </div>
    </div>
  );
}
