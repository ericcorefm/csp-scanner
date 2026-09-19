import { useState, useMemo, Fragment } from 'react';
import { ChevronDown, Info, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { CandidateScan, AppState } from '@/lib/types';
import type { Page } from '@/components/Layout';
import { Badge, MetricIndicator, formatPct, formatNum } from '@/components/ui';
import { AnalyzeTickerSection } from '@/components/AnalyzeTickerSection';

const rejectionColors: Record<string, 'error' | 'warning'> = {
  'CROI too low': 'error',
  'PC too high': 'error',
  'Spread too wide': 'warning',
  'OI too low': 'error',
  'Strike too high': 'error',
  'Downtrend without support': 'error',
  'Existing position': 'warning',
  'Short interest warning': 'warning',
  'Insufficient liquidity': 'error',
};

const trendColors: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  Bullish: 'success',
  Rebound: 'success',
  Improving: 'success',
  Sideways: 'neutral',
  Stabilizing: 'info' as 'neutral',
  Downtrend: 'error',
};

export function CandidatesPage({
  state,
  onNavigate,
}: {
  state: AppState;
  onNavigate: (page: Page, ticker?: string) => void;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<keyof CandidateScan>('net_croi');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const filtered = useMemo(() => {
    let list = state.candidates.filter((c) => (showRejected ? true : c.qualified));
    list = [...list].sort((a, b) => {
      let aVal = a[sortKey];
      let bVal = b[sortKey];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [state.candidates, showRejected, sortKey, sortDir]);

  const handleSort = (key: keyof CandidateScan) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortHeader = ({ key, label, align = 'left' }: { key: keyof CandidateScan; label: string; align?: 'left' | 'right' }) => (
    <th
      onClick={() => handleSort(key)}
      className={`px-3 py-2.5 text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-200 select-none whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === key && <ChevronDown className={`h-3 w-3 transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
      </span>
    </th>
  );

  return (
    <div className="space-y-4">
      {state.scanSource === 'live' && (
        <div className="rounded-lg border px-3 py-2 text-xs border-emerald-500/30 bg-emerald-500/5 text-emerald-300">
          {`LIVE market scan (Massive)${state.lastScanAt ? ` · ${new Date(state.lastScanAt).toLocaleString()}` : ''}`}
          {state.scanError && <span className="ml-2 text-red-400">{state.scanError}</span>}
        </div>
      )}
      {state.scanSource === null && state.scanError && (
        <div className="rounded-lg border px-3 py-2 text-xs border-red-500/30 bg-red-500/5 text-red-400">
          {state.scanError}
        </div>
      )}

      {state.noFilterMode && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-300">
          NO FILTER MODE — All strategy sections and Exclude Existing Positions are OFF. Every put contract with valid bid/ask is qualified.
        </div>
      )}

      {state.scanCounts && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-13 gap-3">
            <ScanCountItem label="In Universe" value={state.scanCounts.symbols_in_universe} />
            <ScanCountItem label="Requested" value={state.scanCounts.symbols_requested} />
            <ScanCountItem label="Returned" value={state.scanCounts.symbols_returned} color={state.scanCounts.symbols_failed > 0 ? 'text-amber-400' : 'text-slate-200'} />
            <ScanCountItem label="Failed" value={state.scanCounts.symbols_failed} color={state.scanCounts.symbols_failed > 0 ? 'text-red-400' : 'text-slate-200'} />
            <ScanCountItem label="Puts Returned" value={state.scanCounts.puts_returned} />
            <ScanCountItem label="Missing Bid" value={state.scanCounts.missing_bid} color={state.scanCounts.missing_bid > 0 ? 'text-red-400' : 'text-slate-200'} />
            <ScanCountItem label="Missing Ask" value={state.scanCounts.missing_ask} color={state.scanCounts.missing_ask > 0 ? 'text-red-400' : 'text-slate-200'} />
            <ScanCountItem label="Missing Strike" value={state.scanCounts.missing_strike} color={state.scanCounts.missing_strike > 0 ? 'text-amber-400' : 'text-slate-200'} />
            <ScanCountItem label="Missing Exp" value={state.scanCounts.missing_expiration} color={state.scanCounts.missing_expiration > 0 ? 'text-amber-400' : 'text-slate-200'} />
            <ScanCountItem label="Valid Quotes" value={state.scanCounts.valid_quotes} color="text-emerald-400" />
            <ScanCountItem label="Qualified" value={state.scanCounts.qualified} color="text-emerald-400" />
            <ScanCountItem label="Rejected" value={state.scanCounts.rejected} color={state.scanCounts.rejected > 0 ? 'text-red-400' : 'text-slate-200'} />
            <ScanCountItem label="Pages Fetched" value={state.scanCounts.pages_fetched} />
          </div>
          {state.rawSample && (
            <details className="mt-3 border-t border-slate-800 pt-3">
              <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
                Raw Massive sample contract (for debugging)
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-400 max-h-64 overflow-y-auto">
                {JSON.stringify(state.rawSample, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      <AnalyzeTickerSection state={state} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Today's CSP Candidates</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {filtered.filter((c) => c.qualified).length} qualified
            {showRejected && ` · ${filtered.filter((c) => !c.qualified).length} rejected`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <button
              onClick={() => setShowRejected(!showRejected)}
              className={`relative h-5 w-9 rounded-full transition-colors ${showRejected ? 'bg-sky-500' : 'bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${showRejected ? 'left-4' : 'left-0.5'}`} />
            </button>
            Show Rejected
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-800 bg-slate-900/80">
              <tr>
                <SortHeader key="ticker" label="Ticker" />
                <SortHeader key="stock_price" label="Price" align="right" />
                <SortHeader key="trend_classification" label="Trend" />
                <SortHeader key="primary_support" label="Support" align="right" />
                <SortHeader key="strike" label="Strike" align="right" />
                <SortHeader key="strike_distance_from_stock" label="Dist %" align="right" />
                <SortHeader key="strike_distance_from_support" label="Supp Dist %" align="right" />
                <SortHeader key="expiration" label="Expiration" />
                <SortHeader key="dte" label="DTE" align="right" />
                <SortHeader key="bid" label="Bid" align="right" />
                <SortHeader key="ask" label="Ask" align="right" />
                <SortHeader key="mid" label="Mid" align="right" />
                <SortHeader key="spread_pct" label="Spread %" align="right" />
                <SortHeader key="suggested_sto" label="STO" align="right" />
                <SortHeader key="suggested_btc" label="BTC" align="right" />
                <SortHeader key="net_profit" label="Net $" align="right" />
                <SortHeader key="net_croi" label="CROI %" align="right" />
                <SortHeader key="premium_capture" label="PC %" align="right" />
                <SortHeader key="breakeven" label="BE" align="right" />
                <SortHeader key="iv" label="IV %" align="right" />
                <SortHeader key="delta" label="Delta" align="right" />
                <SortHeader key="volume" label="Vol" align="right" />
                <SortHeader key="open_interest" label="OI" align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map((c) => {
                const rowKey = `${c.ticker}-${c.strike}-${c.expiration}`;
                const isExpanded = expandedRow === rowKey;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      onClick={() => onNavigate('detail', c.ticker)}
                      className={`cursor-pointer transition-colors ${
                        c.qualified ? 'hover:bg-slate-800/40' : 'opacity-60 hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {!c.qualified && <XCircle className="h-3.5 w-3.5 text-red-400" />}
                          {c.qualified && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                          <span className="font-semibold text-slate-100">{c.ticker}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(c.stock_price)}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant={trendColors[c.trend_classification] || 'neutral'} dot>
                          {c.trend_classification}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(c.primary_support)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-200 font-medium">${formatNum(c.strike)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.strike_distance_from_stock}%</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.strike_distance_from_support}%</td>
                      <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap">{c.expiration}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.dte}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">${formatNum(c.bid)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">${formatNum(c.ask)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(c.mid)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={c.spread_pct <= 5 ? 'text-emerald-400' : c.spread_pct <= 10 ? 'text-amber-400' : 'text-red-400'}>
                          {formatPct(c.spread_pct)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-400 font-medium">${formatNum(c.suggested_sto)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">${formatNum(c.suggested_btc)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">${formatNum(c.net_profit)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={c.net_croi >= 3.5 ? 'text-emerald-400 font-medium' : 'text-red-400'}>
                          {formatPct(c.net_croi)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{formatPct(c.premium_capture)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">${formatNum(c.breakeven)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{formatNum(c.iv, 0)}%</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{formatNum(c.delta)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.volume}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.open_interest.toLocaleString()}</td>
                    </tr>
                    {showRejected && !c.qualified && isExpanded && (
                      <tr key={rowKey + '-detail'}>
                        <td colSpan={22} className="px-4 py-3 bg-slate-900/80">
                          <div className="flex flex-wrap gap-2">
                            {c.rejection_reasons.map((r) => (
                              <Badge key={r} variant={rejectionColors[r] || 'warning'}>{r}</Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    {showRejected && !c.qualified && !isExpanded && (
                      <tr
                        key={rowKey + '-expand'}
                        className="cursor-pointer hover:bg-slate-800/30"
                        onClick={(e) => { e.stopPropagation(); setExpandedRow(isExpanded ? null : rowKey); }}
                      >
                        <td colSpan={22} className="px-4 py-1.5 bg-slate-900/40">
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <Info className="h-3 w-3" />
                            {c.rejection_reasons.length} rejection reason(s) — click to expand
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center text-slate-500">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-slate-600" />
            <p className="text-sm">No candidates found. Try adjusting your strategy rules in Settings.</p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap gap-6 text-xs">
          <div className="flex items-center gap-2"><MetricIndicator status="pass" /> <span className="text-slate-400">Passes rule</span></div>
          <div className="flex items-center gap-2"><MetricIndicator status="warn" /> <span className="text-slate-400">Warning</span></div>
          <div className="flex items-center gap-2"><MetricIndicator status="fail" /> <span className="text-slate-400">Fails rule</span></div>
          <div className="flex items-center gap-2 text-slate-500">
            <Info className="h-3.5 w-3.5" />
            Click any row to view full candidate detail
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanCountItem({ label, value, color = 'text-slate-200' }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
