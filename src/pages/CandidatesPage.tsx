import { useState, useMemo, Fragment } from 'react';
import { ChevronDown, Info, CheckCircle2, XCircle, AlertTriangle, Telescope, Globe, Pencil } from 'lucide-react';
import type { CandidateScan, AppState } from '@/lib/types';
import type { ScanMode } from '@/lib/liveMarketData';
import type { Page } from '@/components/Layout';
import { Badge, MetricIndicator, formatPct, formatNum } from '@/components/ui';
import { EnterQuoteModal } from '@/components/EnterQuoteModal';
import { deriveCandidateQualification, type QualificationStatus } from '@/lib/qualification';

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

const DASH = <span className="text-slate-600">--</span>;

export function CandidatesPage({
  state,
  onNavigate,
}: {
  state: AppState;
  onNavigate: (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => void;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<keyof CandidateScan>('net_croi');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [quoteModalRow, setQuoteModalRow] = useState<string | null>(null);

  const scanMode: ScanMode = state.scanMode;
  const isDiscovery = scanMode === 'discovery';

  const qualificationFor = (c: CandidateScan): QualificationStatus => deriveCandidateQualification(c);

  const firstFailReason = (c: CandidateScan): string | null => {
    const failed = c.pass_fail?.find((pf) => pf.status === 'fail');
    if (failed) return failed.rule;
    if (c.rejection_reasons.length > 0) return c.rejection_reasons[0];
    return null;
  };

  const filtered = useMemo(() => {
    let list = state.candidates.filter((c) => (showRejected ? true : qualificationFor(c) !== 'rejected'));
    list = [...list].sort((a, b) => {
      let aVal = a[sortKey as keyof CandidateScan];
      let bVal = b[sortKey as keyof CandidateScan];
      if (aVal === null || aVal === undefined) aVal = 0;
      if (bVal === null || bVal === undefined) bVal = 0;
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [state.candidates, showRejected, sortKey, sortDir]);

  const quoteModalCandidate = useMemo(() => {
    if (!quoteModalRow) return null;
    return state.candidates.find((c) => `${c.ticker}-${c.strike}-${c.expiration}` === quoteModalRow) || null;
  }, [quoteModalRow, state.candidates]);

  const handleSort = (key: keyof CandidateScan) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortHeader = ({ k, label, align = 'left' }: { k: keyof CandidateScan; label: string; align?: 'left' | 'right' }) => (
    <th
      onClick={() => handleSort(k)}
      className={`px-3 py-2.5 text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-200 select-none whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === k && <ChevronDown className={`h-3 w-3 transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
      </span>
    </th>
  );

  const handleQuoteSubmit = (rowKey: string, updates: Partial<CandidateScan>) => {
    state.updateCandidateWithQuote(rowKey, updates);
  };

  const colCount = 16;

  return (
    <div className="space-y-4">
      {state.scanError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-400">
          {state.scanError}
        </div>
      )}

      {scanMode === 'universe' && state.scanUniverseLoaded && state.scanUniverse.length === 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          No active tickers in Scan Universe. Go to Scan Universe to add or enable tickers, or switch to Market Discovery.
        </div>
      )}

      {state.noFilterMode && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-300">
          NO FILTER MODE — All strategy sections and Exclude Existing Positions are OFF. Every discovered put contract is qualified.
        </div>
      )}

      {(() => {
        const allCandidates = state.candidates;
        const qualCounts = allCandidates.reduce(
          (acc, c) => {
            const q = qualificationFor(c);
            if (q === 'qualified') acc.qualified++;
            else if (q === 'pending') acc.pending++;
            else acc.rejected++;
            return acc;
          },
          { qualified: 0, pending: 0, rejected: 0 },
        );
        const lastScanLabel = state.lastScanAt
          ? new Date(state.lastScanAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '--';
        const totalContracts = allCandidates.length;
        const symbolsCount = new Set(allCandidates.map((c) => c.ticker)).size;
        return (
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <ScanCountItem label={isDiscovery ? 'Stocks Screened' : 'In Universe'} value={state.scanCounts?.symbols_in_universe ?? symbolsCount} />
              <ScanCountItem label="Contracts Found" value={state.scanCounts?.puts_returned ?? totalContracts} color="text-sky-400" />
              <ScanCountItem label="Qualified" value={qualCounts.qualified} color="text-emerald-400" />
              <ScanCountItem label="Pending" value={qualCounts.pending} color="text-amber-400" />
              <ScanCountItem label="Rejected" value={qualCounts.rejected} color="text-slate-400" />
              <ScanCountItem label="Last Scan" value={lastScanLabel} isText />
            </div>
          </div>
        );
      })()}

      {/* Scan Mode Selector */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Today's CSP Candidates</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {isDiscovery
              ? 'Searching the broader optionable market using your active CSP rules.'
              : 'Scanning only your saved tickers.'}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-slate-500 mr-1">Scan Mode</span>
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-800/50 p-0.5">
            <button
              onClick={() => state.setScanMode('discovery')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Telescope className="h-4 w-4" />
              Market Discovery
            </button>
            <button
              onClick={() => state.setScanMode('universe')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                !isDiscovery ? 'bg-sky-500 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="h-4 w-4" />
              My Scan Universe
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">
            {filtered.filter((c) => qualificationFor(c) === 'qualified').length} qualified
            {showRejected && ` · ${filtered.filter((c) => qualificationFor(c) === 'pending').length} pending · ${filtered.filter((c) => qualificationFor(c) === 'rejected').length} rejected`}
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
                <SortHeader k="ticker" label="Ticker" />
                <SortHeader k="stock_price" label="Price" align="right" />
                <SortHeader k="strike" label="Strike" align="right" />
                <SortHeader k="expiration" label="Expiration" />
                <SortHeader k="dte" label="DTE" align="right" />
                <SortHeader k="suggested_sto" label="Premium" align="right" />
                <SortHeader k="suggested_btc" label="BTC" align="right" />
                <SortHeader k="net_croi" label="Net CROI" align="right" />
                <SortHeader k="premium_capture" label="PC" align="right" />
                <SortHeader k="open_interest" label="OI" align="right" />
                <SortHeader k="iv" label="IV" align="right" />
                <SortHeader k="volume" label="Volume" align="right" />
                <SortHeader k="strike_distance_from_support" label="Support Dist %" align="right" />
                <th className="px-3 py-2.5 text-xs font-medium text-slate-400 text-center whitespace-nowrap">Qualified</th>
                <th className="px-3 py-2.5 text-xs font-medium text-slate-400 text-center whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map((c) => {
                const rowKey = `${c.ticker}-${c.strike}-${c.expiration}`;
                const isExpanded = expandedRow === rowKey;
                const hasNoPremium = c.suggested_sto === 0 || c.suggested_btc === 0;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      onClick={() => onNavigate('detail', c.ticker, { strike: c.strike, expiration: c.expiration })}
                      className={`cursor-pointer transition-colors ${
                        qualificationFor(c) === 'qualified' ? 'hover:bg-slate-800/40' : 'opacity-75 hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {(() => {
                            const q = qualificationFor(c);
                            if (q === 'qualified') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
                            if (q === 'pending') return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
                            return <XCircle className="h-3.5 w-3.5 text-red-400" />;
                          })()}
                          <span className="font-semibold text-slate-100">{c.ticker}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">{c.stock_price != null ? `${formatNum(c.stock_price)}` : <span className="text-slate-600">Unavailable</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-200 font-medium">${formatNum(c.strike)}</td>
                      <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap">{c.expiration}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.dte}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-400 font-medium">
                        {hasNoPremium ? DASH : `${formatNum(c.suggested_sto)}`}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">
                        {hasNoPremium ? DASH : `${formatNum(c.suggested_btc)}`}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {hasNoPremium ? DASH : (
                          <span className={typeof c.net_croi === 'number' && c.net_croi >= 3.5 ? 'text-emerald-400 font-medium' : 'text-red-400'}>
                            {formatPct(c.net_croi)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                        {hasNoPremium ? DASH : formatPct(c.premium_capture)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">
                        {c.open_interest > 0 ? c.open_interest.toLocaleString() : DASH}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">
                        {typeof c.iv === 'number' && c.iv > 0 ? `${formatNum(c.iv, 0)}%` : DASH}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">
                        {c.volume > 0 ? c.volume : DASH}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{c.strike_distance_from_support != null ? `${c.strike_distance_from_support}%` : <span className="text-slate-600">--</span>}</td>
                      <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                        {(() => {
                          const q = qualificationFor(c);
                          if (q === 'qualified') return (
                            <span className="inline-flex items-center gap-1 text-emerald-400 text-xs font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Yes
                            </span>
                          );
                          if (q === 'pending') return (
                            <span className="inline-flex items-center gap-1 text-amber-400 text-xs font-medium">
                              <AlertTriangle className="h-3.5 w-3.5" /> Pending
                            </span>
                          );
                          const reason = firstFailReason(c);
                          return (
                            <span
                              className="inline-flex items-center gap-1 text-red-400 text-xs font-medium"
                              title={reason ?? undefined}
                            >
                              <XCircle className="h-3.5 w-3.5" /> No
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setQuoteModalRow(rowKey)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors"
                        >
                          <Pencil className="h-3 w-3" />
                          Enter Quote
                        </button>
                      </td>
                    </tr>
                    {showRejected && qualificationFor(c) === 'rejected' && isExpanded && (
                      <tr key={rowKey + '-detail'}>
                        <td colSpan={colCount} className="px-4 py-3 bg-slate-900/80">
                          <div className="flex flex-wrap gap-2">
                            {c.rejection_reasons.map((r) => (
                              <Badge key={r} variant={rejectionColors[r] || 'warning'}>{r}</Badge>
                            ))}
                            {c.pass_fail?.filter((pf) => pf.status === 'fail').map((pf) => (
                              <Badge key={pf.rule} variant="error">{pf.rule}</Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    {showRejected && qualificationFor(c) === 'rejected' && !isExpanded && (
                      <tr
                        key={rowKey + '-expand'}
                        className="cursor-pointer hover:bg-slate-800/30"
                        onClick={(e) => { e.stopPropagation(); setExpandedRow(isExpanded ? null : rowKey); }}
                      >
                        <td colSpan={colCount} className="px-4 py-1.5 bg-slate-900/40">
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <Info className="h-3 w-3" />
                            {firstFailReason(c) ?? `${c.rejection_reasons.length} rejection reason(s)`} — click to expand
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
            <p className="text-sm">
              {state.scanCounts && state.scanCounts.symbols_with_chains === 0
                ? 'No option contracts were returned for the saved tickers.'
                : 'No contracts qualified under the current strategy rules.'}
            </p>
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

      {quoteModalCandidate && state.activeProfile && (
        <EnterQuoteModal
          candidate={quoteModalCandidate}
          profile={state.activeProfile}
          onClose={() => setQuoteModalRow(null)}
          onSubmit={(updates) => handleQuoteSubmit(quoteModalRow!, updates)}
        />
      )}
    </div>
  );
}

function ScanCountItem({ label, value, color = 'text-slate-200', isText = false }: { label: string; value: number | string; color?: string; isText?: boolean }) {
  return (
    <div className="text-center">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${isText ? '' : 'tabular-nums'} ${color}`}>{value}</div>
    </div>
  );
}
