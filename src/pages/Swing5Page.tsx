import { Fragment, useMemo, useState } from 'react';
import { Telescope, Globe, RefreshCw, Settings2, Search, CheckCircle2, XCircle, HelpCircle, Plus, Check, Info } from 'lucide-react';
import { TradingViewChart, type ChartMarker } from '@/components/TradingViewChart';
import { StockPositionModal } from '@/components/StockPositionModal';
import { SortTh } from '@/components/SortTh';
import { useSort } from '@/lib/useSort';
import type { StockScannerState } from '@/lib/stockStore';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import type { Swing5State } from '@/lib/swing5Store';
import {
  DEFAULT_SWING5_RULES,
  type StockResult, type Swing5Result, type Swing5Rules, type Swing5Signal, type Swing5Stats, type Swing5Trade, type Swing5Check,
} from '@/lib/stockTypes';
import { formatNum } from '@/components/ui';

const DASH = <span className="text-slate-600">--</span>;

const SIGNAL_STYLE: Record<Swing5Signal, string> = {
  BUY: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  WATCH: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  WAIT: 'bg-slate-700/40 text-slate-400 border-slate-600',
  PENDING: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
};
const EXIT_STYLE: Record<Swing5Trade['exit_reason'], string> = {
  TP: 'text-emerald-300', SL: 'text-red-300', TIME: 'text-amber-300', OPEN: 'text-sky-300',
};
const EXIT_LABEL: Record<Swing5Trade['exit_reason'], string> = {
  TP: 'TP HIT', SL: 'SL HIT', TIME: 'TIME EXIT', OPEN: 'IN TRADE',
};

function SignalBadge({ s }: { s: Swing5Signal }) {
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${SIGNAL_STYLE[s]}`}>{s}</span>;
}

const money = (v: number | null | undefined) => (v == null ? '--' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);

/** Trade labels for the chart: BUY at entry, then TP / SL / TIME at exit. */
function tradeMarkers(trades: Swing5Trade[]): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const t of trades) {
    out.push({ date: t.entry_date, position: 'belowBar', color: '#38bdf8', shape: 'arrowUp', text: 'BUY' });
    if (t.exit_date && t.exit_reason !== 'OPEN') {
      out.push({
        date: t.exit_date, position: 'aboveBar', shape: 'arrowDown',
        color: t.exit_reason === 'TP' ? '#10b981' : t.exit_reason === 'SL' ? '#ef4444' : '#f59e0b',
        text: t.exit_reason === 'TIME' ? `TIME ${pct(t.return_pct)}` : t.exit_reason,
      });
    }
  }
  return out;
}

function CheckRow({ c }: { c: Swing5Check }) {
  const Icon = c.pass === true ? CheckCircle2 : c.pass === false ? XCircle : HelpCircle;
  const color = c.pass === true ? 'text-emerald-400' : c.pass === false ? 'text-red-400' : 'text-slate-500';
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
      <div>
        <div className="text-sm text-slate-200">{c.label}</div>
        <div className="text-xs text-slate-500">{c.detail}</div>
      </div>
    </div>
  );
}

function StatsBlock({ title, s, years }: { title: string; s: Swing5Stats | null; years?: number | null }) {
  if (!s || s.trades === 0) {
    return (
      <div className="rounded-lg border border-slate-800 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
        <div className="text-sm text-slate-500">No simulated trades in the history available.</div>
      </div>
    );
  }
  const rows: [string, string, string?][] = [
    ['Trades', `${s.trades}${s.trades_per_year != null ? ` (${s.trades_per_year}/yr)` : ''}`],
    ['Win rate', pct(s.win_rate_pct).replace('+', ''), s.win_rate_pct != null && s.win_rate_pct > 50 ? 'text-emerald-400' : 'text-red-300'],
    ['Avg return / trade', pct(s.avg_return_pct, 2), s.avg_return_pct != null && s.avg_return_pct > 0 ? 'text-emerald-400' : 'text-red-300'],
    ['Profit factor', s.profit_factor == null ? '--' : s.profit_factor >= 99 ? 'no losses' : s.profit_factor.toFixed(2), s.profit_factor != null && s.profit_factor > 1 ? 'text-emerald-400' : 'text-red-300'],
    ['Avg DIM (sessions)', s.avg_sessions == null ? '--' : s.avg_sessions.toFixed(1)],
    ['Exits TP / SL / Time', `${s.tp_count} / ${s.sl_count} / ${s.time_count}`],
    ['Net P/L ($ per trade size)', money(s.total_pnl), s.total_pnl != null && s.total_pnl > 0 ? 'text-emerald-400' : 'text-red-300'],
    ['Net CROI (sum)', pct(s.net_croi_pct, 1)],
    ['Max drawdown', money(s.max_drawdown == null ? null : -s.max_drawdown)],
  ];
  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{title}{years ? ` · last ${years} yrs` : ''}</div>
      {rows.map(([k, v, c]) => (
        <div key={k} className="flex justify-between py-0.5 text-sm">
          <span className="text-slate-400">{k}</span>
          <span className={`tabular-nums ${c ?? 'text-slate-200'}`}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Actions({ r, rules, portfolio }: { r: Swing5Result; rules: Swing5Rules; portfolio: StockPortfolioState }) {
  const [adding, setAdding] = useState(false);
  const inUniverse = portfolio.universe.some((u) => u.symbol === r.ticker);
  const isOpen = portfolio.openPositions.some((p) => p.ticker === r.ticker);
  // StockPositionModal reads ticker, company, price, target and stop only.
  const asResult = {
    ticker: r.ticker, company_name: r.company_name, price: r.plan?.entry_est ?? r.price,
    target_price: r.plan?.tp_price ?? null, stop_price: r.plan?.sl_price ?? null,
  } as unknown as StockResult;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={(e) => { e.stopPropagation(); setAdding(true); }}
        className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600"
      >
        <Plus className="h-3.5 w-3.5" /> Add Paper Position{isOpen ? ' (already open)' : ''}
      </button>
      {inUniverse ? (
        <span className="flex items-center gap-1 text-xs text-emerald-400"><Check className="h-3.5 w-3.5" /> In Stock Universe</span>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); void portfolio.addToUniverse(r.ticker, r.company_name); }}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" /> Add to Stock Universe
        </button>
      )}
      {adding && (
        <StockPositionModal
          result={asResult}
          defaultSize={rules.allocation}
          // Positions count calendar days; 5 sessions ≈ 7 calendar days.
          defaultCycleDays={Math.ceil((rules.max_hold_sessions * 7) / 5)}
          onSave={(p) => portfolio.addPosition({ ...p, notes: p.notes ?? `5-Day Swing (${r.signal} ${r.score ?? 0}/4)` })}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function Detail({ r, rules, portfolio }: { r: Swing5Result; rules: Swing5Rules; portfolio: StockPortfolioState }) {
  const markers = useMemo(() => tradeMarkers(r.trades || []), [r.trades]);
  const p = r.plan;
  return (
    <div className="space-y-4 bg-slate-950/60 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-300">
          <span className="font-semibold text-slate-100">{r.ticker}</span> {r.company_name && <span className="text-slate-500">· {r.company_name}</span>}
          {r.signal_date && <span className="text-slate-500"> · signal on the {r.signal_date} close</span>}
        </div>
        <Actions r={r} rules={rules} portfolio={portfolio} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-800 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Indicators ({r.score ?? 0}/4)</div>
          {r.checks.length ? r.checks.map((c) => <CheckRow key={c.key} c={c} />) : <div className="text-sm text-slate-500">Not enough history yet.</div>}
          {r.filters.length > 0 && (
            <>
              <div className="mb-1 mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">Mandatory filters</div>
              {r.filters.map((c) => <CheckRow key={c.key} c={c} />)}
            </>
          )}
          {r.wait_reasons.length > 0 && (
            <div className="mt-2 text-xs text-amber-300/90">{r.wait_reasons.join(' · ')}</div>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Paper trade plan</div>
          {p ? (
            <div className="space-y-0.5 text-sm">
              {[
                ['Allocation', `$${rules.allocation.toLocaleString()}`],
                ['Entry (est. — fills at next open)', `$${formatNum(p.entry_est)}`],
                ['Shares (fractional)', formatNum(p.shares, 4)],
                [`Take profit (+${rules.tp_pct}%)`, `$${formatNum(p.tp_price)} → +${money(p.gain_at_tp)}`],
                [`Stop loss (−${rules.sl_pct}%)`, `$${formatNum(p.sl_price)} → −${money(p.loss_at_sl)}`],
                ['Time exit', `close of session ${p.max_hold_sessions}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2"><span className="text-slate-400">{k}</span><span className="tabular-nums text-slate-200">{v}</span></div>
              ))}
              <p className="pt-2 text-xs text-slate-500">
                Before fees, slippage and taxes. A stop can fill worse than −{rules.sl_pct}% on a gap. With equal TP and SL you need a win rate above 50% just to break even.
              </p>
            </div>
          ) : <div className="text-sm text-slate-500">--</div>}
          {r.recent_trade && (
            <div className="mt-3 rounded border border-slate-800 p-2 text-xs">
              <span className={`font-semibold ${EXIT_STYLE[r.recent_trade.exit_reason]}`}>{EXIT_LABEL[r.recent_trade.exit_reason]}</span>
              <span className="text-slate-400"> · latest simulated trade: bought {r.recent_trade.entry_date} at ${formatNum(r.recent_trade.entry_price)}
                {r.recent_trade.exit_date ? `, exited ${r.recent_trade.exit_date} (${pct(r.recent_trade.return_pct, 2)})` : `, ${r.recent_trade.sessions} session(s) so far`}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <StatsBlock title="Backtest · BUY (4 of 4)" s={r.backtest} years={r.backtest_years} />
          <StatsBlock title="Compare · 3+ of 4" s={r.backtest_3of4} />
        </div>
      </div>

      <TradingViewChart ticker={r.ticker} defaultStyle="candle" defaultRange="6M" markers={markers} />

      {r.trades.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 text-slate-500">
              <tr>
                {['Signal', 'Entry', 'Entry $', 'Exit', 'Exit $', 'Result', 'Sessions', 'Return', 'P/L'].map((h) => (
                  <th key={h} className={`px-3 py-2 font-medium ${h === 'Signal' || h === 'Entry' || h === 'Exit' || h === 'Result' ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...r.trades].reverse().map((t) => (
                <tr key={t.entry_date} className="border-t border-slate-800/60">
                  <td className="px-3 py-1.5 text-slate-400">{t.signal_date}</td>
                  <td className="px-3 py-1.5 text-slate-300">{t.entry_date}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(t.entry_price)}</td>
                  <td className="px-3 py-1.5 text-slate-300">{t.exit_date ?? '--'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{t.exit_price != null ? formatNum(t.exit_price) : '--'}</td>
                  <td className={`px-3 py-1.5 font-medium ${EXIT_STYLE[t.exit_reason]}`}>{EXIT_LABEL[t.exit_reason]}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{t.sessions}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${(t.return_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-300'}`}>{pct(t.return_pct, 2)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-slate-500">Last {r.trades.length} simulated trades. Signal at the close, filled at the next open, {rules.slippage_pct}% slippage each side, stop counted first if TP and SL are both touched on the same bar.</p>
        </div>
      )}
    </div>
  );
}

type NumKey = Exclude<keyof Swing5Rules, 'spy_filter'>;
const FIELDS: { key: NumKey; label: string; step: string; optional?: boolean; hint?: string }[] = [
  { key: 'allocation', label: 'Allocation per trade ($)', step: '50' },
  { key: 'tp_pct', label: 'Take profit (%)', step: '0.1' },
  { key: 'sl_pct', label: 'Stop loss (%)', step: '0.1' },
  { key: 'max_hold_sessions', label: 'Max hold (sessions)', step: '1' },
  { key: 'min_price', label: 'Min price ($)', step: '1', optional: true, hint: 'blank = off' },
  { key: 'max_price', label: 'Max price ($)', step: '1', optional: true, hint: 'blank = off' },
  { key: 'min_avg_volume', label: 'Min avg daily volume (shares)', step: '100000', optional: true, hint: 'blank = off' },
  { key: 'rsi_min', label: 'RSI min', step: '1' },
  { key: 'rsi_max', label: 'RSI max', step: '1' },
  { key: 'bb_lookback', label: 'BB pullback lookback (bars)', step: '1' },
  { key: 'slippage_pct', label: 'Backtest slippage per side (%)', step: '0.01' },
];

function SettingsPanel({ swing5, onClose }: { swing5: Swing5State; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, swing5.rules[f.key] == null ? '' : String(swing5.rules[f.key])])),
  );
  const [spy, setSpy] = useState(swing5.rules.spy_filter);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    const next: Record<string, unknown> = { spy_filter: spy };
    for (const f of FIELDS) {
      const raw = draft[f.key].trim();
      if (raw === '') {
        if (!f.optional) { setMsg(`${f.label} is required`); return; }
        next[f.key] = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) { setMsg(`${f.label} must be a number`); return; }
        next[f.key] = n;
      }
    }
    setSaving(true);
    const res = await swing5.saveRules(next as unknown as Swing5Rules);
    setSaving(false);
    setMsg(res.ok ? 'Saved. Click Scan to apply.' : res.error || 'Could not save');
  };
  const reset = () => {
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, DEFAULT_SWING5_RULES[f.key] == null ? '' : String(DEFAULT_SWING5_RULES[f.key])])));
    setSpy(DEFAULT_SWING5_RULES.spy_filter);
    setMsg('Defaults loaded — click Save to keep them.');
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-medium text-slate-100">5-Day Swing settings</span>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-300">Close</button>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-400">{f.label}{f.hint && <span className="text-slate-600"> ({f.hint})</span>}</span>
            <input
              type="number" step={f.step} value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              className="w-28 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-right tabular-nums text-slate-100"
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-400">Market regime: SPY above 50-day SMA</span>
          <input type="checkbox" checked={spy} onChange={(e) => setSpy(e.target.checked)} className="h-4 w-4 accent-sky-500" />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={saving} className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={reset} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Reset to defaults</button>
        {msg && <span className="text-sm text-slate-400">{msg}</span>}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Market cap (&gt;$300M) and the earnings-date exclusion aren't applied yet: the app has no market-cap or earnings data source on your current Massive plan. Check earnings dates yourself before entering.
      </p>
    </div>
  );
}

type SortKey = 'ticker' | 'signal' | 'score' | 'price' | 'tp' | 'sl' | 'trades' | 'win' | 'avg' | 'pf' | 'dim' | 'croi';
const SIGNAL_RANK: Record<Swing5Signal, number> = { BUY: 0, WATCH: 1, WAIT: 2, PENDING: 3 };

export function Swing5Page({ stock, swing5, portfolio }: { stock: StockScannerState; swing5: Swing5State; portfolio: StockPortfolioState }) {
  const [showWait, setShowWait] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checkTicker, setCheckTicker] = useState('');
  const [checked, setChecked] = useState<Swing5Result | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const isDiscovery = stock.scanMode === 'discovery';
  const c = swing5.counts;

  const rows = useMemo(
    () => swing5.results.filter((r) => showWait || r.signal === 'BUY' || r.signal === 'WATCH'),
    [swing5.results, showWait],
  );
  const getValue = useMemo(() => (r: Swing5Result, k: SortKey): string | number | null | undefined => {
    switch (k) {
      case 'ticker': return r.ticker;
      case 'signal': return SIGNAL_RANK[r.signal];
      case 'score': return r.score;
      case 'price': return r.price;
      case 'tp': return r.plan?.tp_price;
      case 'sl': return r.plan?.sl_price;
      case 'trades': return r.backtest?.trades;
      case 'win': return r.backtest?.win_rate_pct;
      case 'avg': return r.backtest?.avg_return_pct;
      case 'pf': return r.backtest?.profit_factor;
      case 'dim': return r.backtest?.avg_sessions;
      case 'croi': return r.backtest?.net_croi_pct;
    }
  }, []);
  const { sorted, sortKey, sortDir, toggle } = useSort<Swing5Result, SortKey>(rows, getValue);

  const runCheck = async () => {
    if (!checkTicker.trim()) return;
    setCheckError(null);
    const res = await swing5.analyze(checkTicker);
    setChecked(res.result);
    setCheckError(res.error ?? (res.result ? null : 'No result'));
  };

  const th = (label: string, k: SortKey, title: string, align: 'left' | 'right' = 'right') => (
    <SortTh label={label} k={k} sortKey={sortKey} sortDir={sortDir} onSort={toggle} align={align} title={title} />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">1% / 5-Day Swing</h2>
          <p className="text-sm text-slate-500">
            EMA 9/21 · RSI 14 · MACD 12/26/9 · Bollinger 20/2 on daily bars. TP +{swing5.rules.tp_pct}% / SL −{swing5.rules.sl_pct}%, max {swing5.rules.max_hold_sessions} sessions, ${swing5.rules.allocation.toLocaleString()} per trade. Paper trading only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            <button onClick={() => stock.setScanMode('discovery')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              <Telescope className="h-4 w-4" /> Market Discovery
            </button>
            <button onClick={() => stock.setScanMode('universe')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${!isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              <Globe className="h-4 w-4" /> My Stock Universe
            </button>
          </div>
          <button onClick={() => setShowSettings(!showSettings)} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
            <Settings2 className="h-4 w-4" /> Settings
          </button>
          <button onClick={() => void swing5.runScan()} disabled={swing5.scanning} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${swing5.scanning ? 'animate-spin' : ''}`} /> {swing5.scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {showSettings && <SettingsPanel swing5={swing5} onClose={() => setShowSettings(false)} />}

      {swing5.error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{swing5.error}</div>}
      {swing5.notice && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{swing5.notice}</div>}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm">
        <span className="text-slate-400">Screened <b className="text-slate-200">{c?.stocks_screened ?? 0}</b></span>
        <span className="text-emerald-300">BUY <b>{c?.buy ?? 0}</b></span>
        <span className="text-amber-300">WATCH <b>{c?.watch ?? 0}</b></span>
        <span className="text-slate-400">WAIT <b>{c?.wait ?? 0}</b></span>
        {(c?.pending ?? 0) > 0 && <span className="text-sky-300">Pending <b>{c?.pending}</b></span>}
        {c?.spy_above_50 != null && (
          <span className={c.spy_above_50 ? 'text-emerald-300' : 'text-red-300'}>SPY {c.spy_above_50 ? 'above' : 'below'} 50-day SMA</span>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {swing5.lastScanAt ? `Last scan ${new Date(swing5.lastScanAt).toLocaleString()}` : 'Not scanned yet — click Scan'}
          {c?.latest_trading_date && ` · bars through ${c.latest_trading_date}`}
        </span>
      </div>

      {c?.spy_above_50 === false && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0" /> SPY is below its 50-day SMA, so the market-regime filter puts every stock on WAIT. Turn it off in Settings if you want signals anyway.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            value={checkTicker}
            onChange={(e) => setCheckTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') void runCheck(); }}
            placeholder="Check a ticker…"
            className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100"
          />
          <button onClick={() => void runCheck()} disabled={swing5.analyzing} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60">
            <Search className="h-4 w-4" /> {swing5.analyzing ? 'Checking…' : 'Check'}
          </button>
          {checkError && <span className="text-sm text-red-300">{checkError}</span>}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
          <input type="checkbox" checked={showWait} onChange={(e) => setShowWait(e.target.checked)} className="h-4 w-4 accent-sky-500" />
          Show WAIT / Pending
        </label>
      </div>

      {checked && (
        <div className="overflow-hidden rounded-xl border border-sky-500/30">
          <div className="flex items-center justify-between bg-slate-900 px-4 py-2 text-sm">
            <span className="flex items-center gap-2"><SignalBadge s={checked.signal} /> <b className="text-slate-100">{checked.ticker}</b> <span className="text-slate-500">{checked.score ?? 0}/4 indicators</span></span>
            <button onClick={() => setChecked(null)} className="text-xs text-slate-500 hover:text-slate-300">Close</button>
          </div>
          <Detail r={checked} rules={swing5.rules} portfolio={portfolio} />
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-800 text-xs text-slate-500">
            <tr>
              {th('Ticker', 'ticker', 'Ticker', 'left')}
              {th('Signal', 'signal', 'BUY = 4 of 4 indicators + filters; WATCH = 3 of 4 + filters; WAIT = fewer, or a filter fails', 'left')}
              {th('Score', 'score', 'Indicators passing (of 4)')}
              {th('Price', 'price', 'Latest close — the trade fills at the next open')}
              {th('TP', 'tp', `Take profit: price × (1 + ${swing5.rules.tp_pct}%)`)}
              {th('SL', 'sl', `Stop loss: price × (1 − ${swing5.rules.sl_pct}%)`)}
              {th('Trades', 'trades', 'Simulated BUY trades in the last ~2 years')}
              {th('Win %', 'win', 'Share of simulated trades that closed with a gain')}
              {th('Avg Ret.', 'avg', 'Average return per simulated trade, after slippage')}
              {th('PF', 'pf', 'Profit factor: gross gains ÷ gross losses (above 1 = net profitable)')}
              {th('Avg DIM', 'dim', 'Average sessions held')}
              {th('Net CROI', 'croi', 'Sum of trade returns on one allocation over the backtest')}
              <th className="px-3 py-2.5 text-left font-medium">Last trade</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={13} className="px-4 py-8 text-center text-slate-500">
                {swing5.results.length === 0 ? 'No scan yet. Click Scan.' : 'No BUY or WATCH signals right now. Turn on "Show WAIT / Pending" to see every stock and why.'}
              </td></tr>
            )}
            {sorted.map((r) => {
              const bt = r.backtest;
              const open = expanded === r.ticker;
              return (
                <Fragment key={r.ticker}>
                  <tr onClick={() => setExpanded(open ? null : r.ticker)} className={`cursor-pointer border-b border-slate-800/60 hover:bg-slate-800/40 ${open ? 'bg-slate-800/40' : ''}`}>
                    <td className="px-3 py-2 font-semibold text-slate-100">{r.ticker}</td>
                    <td className="px-3 py-2"><SignalBadge s={r.signal} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.score == null ? DASH : `${r.score}/4`}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.price == null ? DASH : formatNum(r.price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-300/90">{r.plan ? formatNum(r.plan.tp_price) : DASH}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-300/90">{r.plan ? formatNum(r.plan.sl_price) : DASH}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{bt ? bt.trades : DASH}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${bt?.win_rate_pct != null && bt.win_rate_pct > 50 ? 'text-emerald-400' : 'text-slate-300'}`}>{bt?.win_rate_pct != null ? `${bt.win_rate_pct.toFixed(0)}%` : DASH}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(bt?.avg_return_pct ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'}`}>{bt?.avg_return_pct != null ? pct(bt.avg_return_pct, 2) : DASH}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(bt?.profit_factor ?? 0) > 1 ? 'text-emerald-400' : 'text-slate-300'}`}>{bt?.profit_factor != null ? (bt.profit_factor >= 99 ? '∞' : bt.profit_factor.toFixed(2)) : DASH}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{bt?.avg_sessions != null ? bt.avg_sessions.toFixed(1) : DASH}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(bt?.net_croi_pct ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-300'}`}>{bt?.net_croi_pct != null ? pct(bt.net_croi_pct, 1) : DASH}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.recent_trade ? <span className={`font-semibold ${EXIT_STYLE[r.recent_trade.exit_reason]}`}>{EXIT_LABEL[r.recent_trade.exit_reason]}</span> : DASH}
                    </td>
                  </tr>
                  {open && (
                    <tr><td colSpan={13} className="p-0"><Detail r={r} rules={swing5.rules} portfolio={portfolio} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Backtest figures are simulations on past daily bars (signal at the close, fill at the next open, slippage included). They are not guarantees and don't include fees or taxes. Validate with paper trades before using real money.
      </p>
    </div>
  );
}
