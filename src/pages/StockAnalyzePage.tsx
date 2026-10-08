import { useEffect, useState } from 'react';
import { Search, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import type { StockScannerState } from '@/lib/stockStore';
import type { StockPortfolioState } from '@/lib/stockPortfolio';
import type { StockResult } from '@/lib/stockTypes';
import { formatNum, formatPct } from '@/components/ui';
import { StockDetail, StockActions, TrendBadge } from '@/pages/StockCandidatesPage';

function Metric({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/** Analyze any ticker against your saved Stock Settings (same engine as the scan). */
export function StockAnalyzePage({
  stock, portfolio, autoTicker, onConsumeAutoTicker,
}: {
  stock: StockScannerState;
  portfolio: StockPortfolioState;
  /** Ticker clicked elsewhere in the app; analyzed automatically on arrival. */
  autoTicker?: string | null;
  onConsumeAutoTicker?: () => void;
}) {
  const [ticker, setTicker] = useState('');
  const [result, setResult] = useState<StockResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (override?: string) => {
    const t = (override ?? ticker).trim().toUpperCase();
    if (!t) return;
    setTicker(t);
    setError(null); setNote(null);
    const res = await stock.analyze(t);
    if (res.error) { setError(res.error); setResult(null); return; }
    setResult(res.result);
    if (res.counts?.history_rate_limited && (res.result?.history_bars ?? 0) < (res.counts?.required_bars ?? 0)) {
      setNote('Massive rate limit reached while loading this stock’s history — wait 1–2 minutes and Analyze again.');
    }
  };

  // Run once for a ticker clicked on another page (waits for stock settings to load).
  useEffect(() => {
    if (!autoTicker || !stock.profile) return;
    const t = autoTicker;
    onConsumeAutoTicker?.();
    void run(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTicker, stock.profile]);

  const ann = (v: number | null) => (v == null ? '--' : v >= 1000 ? '>1,000%' : formatPct(v, 0));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Analyze Stock</h1>
        <p className="text-sm text-slate-500">Check any ticker against your saved Stock Settings — same rules and math as Stock Candidates.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder="Ticker, e.g. AAPL"
          className="w-48 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
        />
        <button onClick={() => void run()} disabled={stock.analyzing || !ticker.trim()} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
          {stock.analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Analyze
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-300">{error}</div>}
      {note && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-300">{note}</div>}

      {result && (
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xl font-semibold text-slate-100">{result.ticker}</span>
            {result.company_name && <span className="text-sm text-slate-500">{result.company_name}</span>}
            {result.status === 'qualified' && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Qualifies</span>}
            {result.status === 'pending' && <span className="flex items-center gap-1 text-amber-400"><AlertTriangle className="h-4 w-4" /> Pending (data missing)</span>}
            {result.status === 'rejected' && <span className="flex items-center gap-1 text-red-400"><XCircle className="h-4 w-4" /> Does not qualify</span>}
            <TrendBadge trend={result.trend_classification} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Price" value={result.price != null ? `$${formatNum(result.price)}` : '--'} />
            <Metric label="RSI" value={result.rsi != null ? formatNum(result.rsi, 1) : '--'} />
            <Metric label="vs MA200" value={formatPct(result.above_ma200_pct)} />
            <Metric label="Above support" value={formatPct(result.dist_to_support_pct)} />
            <Metric label="Prob. target (model)" value={formatPct(result.prob_target_pct, 0)} />
            <Metric label="Hist. hit rate" value={formatPct(result.hist_hit_rate_pct, 0)} />
            <Metric label="Est. days" value={result.est_days != null ? String(result.est_days) : '--'} />
            <Metric label="Exp. annualized" value={ann(result.expected_annualized_pct)} tone={(result.expected_annualized_pct ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'} />
          </div>
          <StockDetail r={result} actions={<StockActions r={result} stock={stock} portfolio={portfolio} />} />
        </div>
      )}
    </div>
  );
}
