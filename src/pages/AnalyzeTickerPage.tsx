import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Search,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Filter,
  AlertTriangle,
  Activity,
  TrendingUp,
  Crosshair,
  BarChart3,
  MinusCircle,
  X,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AnalyzeTickerResponse, ContractAnalysis } from '@/lib/liveMarketData';
import { Card, Badge, formatNum, formatPct } from '@/components/ui';
import { getCachedStockPrice } from '@/lib/technicalCache';

function getFailedRules(c: ContractAnalysis): string[] {
  if (!c.pass_fail || c.pass_fail.length === 0) return [];
  return c.pass_fail.filter((pf) => pf.status === 'fail').map((pf) => pf.rule);
}

function getNotEvaluatedRules(c: ContractAnalysis): string[] {
  if (!c.pass_fail || c.pass_fail.length === 0) return [];
  return c.pass_fail.filter((pf) => pf.status === 'not_evaluated').map((pf) => pf.rule);
}

function contractStatus(c: ContractAnalysis): 'qualifies' | 'warning' | 'fail' {
  if (c.qualified) return 'qualifies';
  if (c.technical_pending || getNotEvaluatedRules(c).length > 0) return 'warning';
  return 'fail';
}

function primaryReason(c: ContractAnalysis): string {
  const failed = getFailedRules(c);
  if (c.technical_pending) return 'Technical data unavailable';
  if (failed.length > 0) return failed[0];
  const notEval = getNotEvaluatedRules(c);
  if (notEval.length > 0) return 'Trend/support could not be evaluated';
  if (!c.has_quotes) return 'No option quotes available';
  return '--';
}

function reasonSummary(c: ContractAnalysis): { primary: string; count: number; all: string[] } {
  const failed = getFailedRules(c);
  const notEval = getNotEvaluatedRules(c);
  const all = [...failed, ...notEval];
  if (c.technical_pending) {
    return { primary: 'Technical data unavailable', count: all.length, all };
  }
  if (failed.length > 0) {
    return { primary: failed[0], count: failed.length, all };
  }
  if (notEval.length > 0) {
    return { primary: 'Trend/support could not be evaluated', count: notEval.length, all };
  }
  if (!c.has_quotes) return { primary: 'No option quotes available', count: 0, all: [] };
  return { primary: '--', count: 0, all: [] };
}

function findClosestMatch(contracts: ContractAnalysis[]): ContractAnalysis | null {
  const nonQualifying = contracts.filter((c) => !c.qualified);
  if (nonQualifying.length === 0) return null;
  nonQualifying.sort((a, b) => {
    const aFailed = getFailedRules(a).length;
    const bFailed = getFailedRules(b).length;
    if (aFailed !== bFailed) return aFailed - bFailed;
    if (b.net_croi !== a.net_croi) return b.net_croi - a.net_croi;
    if (a.premium_capture !== b.premium_capture) return a.premium_capture - b.premium_capture;
    return b.volume - a.volume;
  });
  return nonQualifying[0] || null;
}

export function AnalyzeTickerPage({ state, autoAnalyzeTicker, onConsumeAutoAnalyze }: { state: AppState; autoAnalyzeTicker?: string | null; onConsumeAutoAnalyze?: () => void }) {
  const [ticker, setTicker] = useState('');
  const [filterExpiration, setFilterExpiration] = useState<string>('all');
  const [filterStrike, setFilterStrike] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const tickerInputRef = useRef<HTMLInputElement>(null);
  const autoAnalyzeConsumed = useRef(false);
  const result = state.analyzeResult;
  const error = state.analyzeError;
  const analyzing = state.analyzing;

  useEffect(() => {
    if (autoAnalyzeTicker && !autoAnalyzeConsumed.current) {
      autoAnalyzeConsumed.current = true;
      setTicker(autoAnalyzeTicker);
      setFilterExpiration('all');
      setFilterStrike('all');
      setFilterStatus('all');
      state.runAnalyzeTicker(autoAnalyzeTicker);
      onConsumeAutoAnalyze?.();
    }
  }, [autoAnalyzeTicker, state, onConsumeAutoAnalyze]);

  useEffect(() => {
    if (!autoAnalyzeTicker) {
      autoAnalyzeConsumed.current = false;
    }
  }, [autoAnalyzeTicker]);

  const handleAnalyze = () => {
    const sym = ticker.toUpperCase().trim();
    if (!sym) return;
    setFilterExpiration('all');
    setFilterStrike('all');
    setFilterStatus('all');
    state.runAnalyzeTicker(sym);
  };

  const handleClear = () => {
    setTicker('');
    setFilterExpiration('all');
    setFilterStrike('all');
    setFilterStatus('all');
    state.clearAnalyzeResult();
    tickerInputRef.current?.focus();
  };

  const isInUniverse = (sym: string) =>
    state.scanUniverseEntries.some((e) => e.symbol === sym.toUpperCase());

  const allContracts = useMemo(() => {
    if (!result) return [];
    return result.all_analyzed_contracts && result.all_analyzed_contracts.length > 0
      ? result.all_analyzed_contracts
      : result.all_qualifying_contracts;
  }, [result]);

  const expirations = useMemo(() => {
    return [...new Set(allContracts.map((c) => c.expiration))].sort();
  }, [allContracts]);

  const strikes = useMemo(() => {
    return [...new Set(allContracts.map((c) => c.strike))].sort((a, b) => a - b);
  }, [allContracts]);

  const filteredContracts = useMemo(() => {
    let contracts = allContracts;
    if (filterExpiration !== 'all') {
      contracts = contracts.filter((c) => c.expiration === filterExpiration);
    }
    if (filterStrike !== 'all') {
      contracts = contracts.filter((c) => c.strike === Number(filterStrike));
    }
    if (filterStatus !== 'all') {
      contracts = contracts.filter((c) => contractStatus(c) === filterStatus);
    }
    return contracts;
  }, [allContracts, filterExpiration, filterStrike, filterStatus]);

  const groupedByExpiration = useMemo(() => {
    const groups: Record<string, ContractAnalysis[]> = {};
    for (const c of filteredContracts) {
      if (!groups[c.expiration]) groups[c.expiration] = [];
      groups[c.expiration].push(c);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredContracts]);

  const closestMatch = useMemo(() => {
    if (!result || result.qualifies) return null;
    return findClosestMatch(allContracts);
  }, [result, allContracts]);

  const cachedDisplayPrice = result ? getCachedStockPrice(result.ticker)?.price ?? null : null;
  const displayStockPrice = result?.stock_price ?? cachedDisplayPrice;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Analyze Ticker</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Analyze any U.S. stock against your active CSP strategy profile.
        </p>
      </div>

      {/* Active profile + ticker input */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">Active Profile:</span>
            <Badge variant="info">
              {state.activeProfile?.name || '—'}
            </Badge>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <div className="relative">
              <input
                ref={tickerInputRef}
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAnalyze();
                  if (e.key === 'Escape') handleClear();
                }}
                placeholder="e.g. SOFI"
                aria-label="Ticker to analyze"
                className="w-32 bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-100 uppercase placeholder:text-slate-600 placeholder:normal-case text-center font-medium focus:outline-none focus:border-sky-500"
              />
              {ticker && (
                <button
                  onClick={handleClear}
                  aria-label="Clear ticker"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors p-0.5"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button
              onClick={handleAnalyze}
              disabled={!ticker.trim() || analyzing}
              className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {analyzing ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <AnalyzeResult
          result={result}
          state={state}
          isInUniverse={isInUniverse(result.ticker)}
          expirations={expirations}
          strikes={strikes}
          filterExpiration={filterExpiration}
          filterStrike={filterStrike}
          filterStatus={filterStatus}
          setFilterExpiration={setFilterExpiration}
          setFilterStrike={setFilterStrike}
          setFilterStatus={setFilterStatus}
          groupedByExpiration={groupedByExpiration}
          totalContracts={allContracts.length}
          shownContracts={filteredContracts.length}
          closestMatch={closestMatch}
          displayStockPrice={displayStockPrice}
        />
      )}

      {!result && !error && !analyzing && (
        <div className="py-16 text-center">
          <Search className="h-10 w-10 mx-auto mb-3 text-slate-700" />
          <p className="text-sm text-slate-500">
            Enter a ticker above and click Analyze to see how it performs against your CSP strategy rules.
          </p>
        </div>
      )}
    </div>
  );
}

function AnalyzeResult({
  result,
  state,
  isInUniverse,
  expirations,
  strikes,
  filterExpiration,
  filterStrike,
  filterStatus,
  setFilterExpiration,
  setFilterStrike,
  setFilterStatus,
  groupedByExpiration,
  totalContracts,
  shownContracts,
  closestMatch,
  displayStockPrice,
}: {
  result: AnalyzeTickerResponse;
  state: AppState;
  isInUniverse: boolean;
  expirations: string[];
  strikes: number[];
  filterExpiration: string;
  filterStrike: string;
  filterStatus: string;
  setFilterExpiration: (v: string) => void;
  setFilterStrike: (v: string) => void;
  setFilterStatus: (v: string) => void;
  groupedByExpiration: [string, ContractAnalysis[]][];
  totalContracts: number;
  shownContracts: number;
  closestMatch: ContractAnalysis | null;
  displayStockPrice: number | null;
}) {
  const dataWarnings: string[] = [];
  if (displayStockPrice == null) dataWarnings.push('Stock price unavailable.');
  if (!result.technical) dataWarnings.push('Technical history unavailable.');
  if (result.primary_support == null) dataWarnings.push('Primary support could not be evaluated.');

  return (
    <div className="space-y-5">
      {/* Qualifies / Does Not Qualify */}
      <div className={`rounded-xl border px-5 py-4 ${result.qualifies ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-center gap-3">
          {result.qualifies ? (
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
          ) : (
            <XCircle className="h-6 w-6 text-red-400" />
          )}
          <span className={`text-lg font-semibold ${result.qualifies ? 'text-emerald-400' : 'text-red-400'}`}>
            {result.qualifies ? 'QUALIFIES' : 'DOES NOT QUALIFY'}
          </span>
          <span className="text-sm text-slate-400 ml-2">
            {result.qualifying_count} of {result.all_contracts_count} contracts qualified
          </span>
        </div>
      </div>

      {/* Closest Match when zero qualify */}
      {!result.qualifies && closestMatch && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            <span className="text-sm font-semibold text-amber-300">Closest Match</span>
            <span className="text-sm text-slate-300">
              ${formatNum(closestMatch.strike)} strike · {closestMatch.expiration} · CROI {formatPct(closestMatch.net_croi)}
            </span>
          </div>
          <p className="text-xs text-amber-300/70 mt-1.5 ml-8">
            This contract misses the fewest active rules. It is not qualified.
          </p>
        </div>
      )}

      {/* Stock Summary */}
      <Card title="Stock Summary">
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatBox label="Ticker" value={result.ticker} />
            <StatBox label="Stock Price" value={displayStockPrice != null ? `${formatNum(displayStockPrice)}` : 'Unavailable'} sub={result.stock_source && result.stock_source !== 'daily_aggregates' && result.stock_source !== 'none' ? 'Latest daily close' : undefined} />
            <StatBox label="Trend" value={result.trend === 'Unavailable' ? 'Unavailable' : result.trend} />
            <StatBox label="Primary Support" value={result.primary_support != null ? `${formatNum(result.primary_support)}` : 'Unavailable'} />
            <StatBox label="Secondary Support" value={result.secondary_support != null ? `${formatNum(result.secondary_support)}` : 'Unavailable'} />
            <StatBox label="Resistance" value={result.resistance != null ? `${formatNum(result.resistance)}` : 'Unavailable'} />
          </div>
        </div>
      </Card>

      {/* Data warnings — partial data is NOT fatal */}
      {dataWarnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Partial market data:</span>{' '}
            {dataWarnings.join(' ')} The analysis below shows all available information.
          </div>
        </div>
      )}

      {result.technical_warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{result.technical_warning}</span>
        </div>
      )}

      {/* Technical Analysis */}
      {result.technical && (
        <Card title="Technical Analysis">
          <div className="p-5">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <StatBox label="Trend Classification" value={result.trend} icon={<TrendingUp className="h-3.5 w-3.5 text-slate-500" />} />
              <StatBox label="RSI" value={formatNum(result.technical.rsi, 1)} icon={<Activity className="h-3.5 w-3.5 text-slate-500" />} />
              <StatBox label="20 DMA" value={`$${formatNum(result.technical.ma20)}`} />
              <StatBox label="50 DMA" value={`$${formatNum(result.technical.ma50)}`} />
              <StatBox label="200 DMA" value={`$${formatNum(result.technical.ma200)}`} />
              <StatBox
                label="MACD"
                value={`${formatNum(result.technical.macd, 4)} / ${formatNum(result.technical.macd_signal, 4)}`}
                sub={`Hist: ${formatNum(result.technical.macd_histogram, 4)}`}
                icon={<BarChart3 className="h-3.5 w-3.5 text-slate-500" />}
              />
              <StatBox
                label="Bollinger Position"
                value={result.technical.bb_position}
                sub={`U: $${formatNum(result.technical.bb_upper)} · L: $${formatNum(result.technical.bb_lower)}`}
                icon={<Crosshair className="h-3.5 w-3.5 text-slate-500" />}
              />
              <StatBox label="Volume Trend" value={result.technical.volume_trend} />
            </div>
          </div>
        </Card>
      )}

      {/* Rule Check for best contract */}
      {result.best_contract && result.best_contract.pass_fail && result.best_contract.pass_fail.length > 0 && (
        <Card title="Rule Check (Best Contract)">
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {result.best_contract.pass_fail.map((pf, i) => {
                const isNotEvaluated = pf.status === 'not_evaluated';
                return (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    {isNotEvaluated ? (
                      <MinusCircle className="h-4 w-4 text-slate-500 shrink-0" />
                    ) : pf.pass ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    )}
                    <span className={isNotEvaluated ? 'text-slate-500' : pf.pass ? 'text-slate-300' : 'text-red-400'}>{pf.rule}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* Scan Universe add/remove */}
      <div className="flex items-center gap-3">
        {isInUniverse ? (
          <button
            onClick={() => state.removeFromScanUniverse(result.ticker)}
            className="flex items-center gap-2 rounded-lg border border-red-900/50 px-4 py-2 text-sm text-red-400 hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Remove from Scan Universe
          </button>
        ) : (
          <button
            onClick={() => state.addToScanUniverse(result.ticker)}
            className="flex items-center gap-2 rounded-lg border border-emerald-700/50 px-4 py-2 text-sm text-emerald-400 hover:bg-emerald-900/20 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add to Scan Universe
          </button>
        )}
        <Badge variant={isInUniverse ? 'success' : 'neutral'}>
          {isInUniverse ? 'In scan universe' : 'Not in scan universe'}
        </Badge>
      </div>

      {/* Contract filters */}
      {totalContracts > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Filter className="h-4 w-4" />
            <span>Filter:</span>
          </div>
          <select
            value={filterExpiration}
            onChange={(e) => setFilterExpiration(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
          >
            <option value="all">All Expirations</option>
            {expirations.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
          <select
            value={filterStrike}
            onChange={(e) => setFilterStrike(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
          >
            <option value="all">All Strikes</option>
            {strikes.map((s) => (
              <option key={s} value={String(s)}>${formatNum(s)}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100"
          >
            <option value="all">All Statuses</option>
            <option value="qualifies">Qualifies</option>
            <option value="warning">Warning</option>
            <option value="fail">Does Not Qualify</option>
          </select>
          <span className="text-xs text-slate-500 ml-auto">
            {shownContracts} of {totalContracts} contracts
          </span>
        </div>
      )}

      {/* Contract Results — all analyzed contracts */}
      {groupedByExpiration.length > 0 && (
        <div className="space-y-3">
          {groupedByExpiration.map(([expiration, contracts]) => (
            <div key={expiration} className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900/80">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-200">
                    {expiration}
                    <span className="text-slate-500 font-normal ml-2">DTE {contracts[0].dte}</span>
                  </h4>
                  <span className="text-xs text-slate-500">{contracts.length} contract{contracts.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-800 bg-slate-900/40">
                    <tr>
                      {['Strike', 'DTE', 'Premium', 'BTC', 'CROI', 'PC', 'OI', 'IV', 'Vol', 'Support Dist', 'Status', 'Reason'].map((h) => (
                        <th key={h} className="px-3 py-2 text-xs font-medium text-slate-400 text-right whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {contracts.map((c, i) => {
                      const noQuote = !c.has_quotes;
                      const DASH = <span className="text-slate-600">--</span>;
                      const status = contractStatus(c);
                      const reason = reasonSummary(c);
                      const isClosest = closestMatch?.strike === c.strike && closestMatch?.expiration === c.expiration;
                      return (
                        <tr key={i} className={`hover:bg-slate-800/40 transition-colors ${isClosest ? 'ring-1 ring-inset ring-amber-500/20' : ''}`}>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-200 font-medium">
                            ${formatNum(c.strike)}
                            {isClosest && <span className="ml-1 text-amber-400 text-xs">★</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{c.dte}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-sky-400 font-medium">
                            {noQuote ? DASH : `${formatNum(c.suggested_sto)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-sky-300">
                            {noQuote ? DASH : `$${formatNum(c.suggested_btc)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {noQuote ? DASH : (
                              <span className={typeof c.net_croi === 'number' && c.net_croi >= 3.5 ? 'text-emerald-400 font-medium' : 'text-red-400'}>
                                {formatPct(c.net_croi)}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {noQuote ? DASH : formatPct(c.premium_capture)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {c.open_interest > 0 ? c.open_interest.toLocaleString() : DASH}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {typeof c.iv === 'number' && c.iv > 0 ? `${formatNum(c.iv, 0)}%` : DASH}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {c.volume > 0 ? c.volume.toLocaleString() : DASH}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {c.strike_distance_from_support != null ? `${c.strike_distance_from_support}%` : DASH}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {status === 'qualifies' ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400 text-xs font-medium">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Qualifies
                              </span>
                            ) : status === 'warning' ? (
                              <span className="inline-flex items-center gap-1 text-amber-400 text-xs font-medium">
                                <AlertTriangle className="h-3.5 w-3.5" /> Warning
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-red-400 text-xs font-medium">
                                <XCircle className="h-3.5 w-3.5" /> Fail
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-slate-400 whitespace-nowrap" title={reason.all.length > 1 ? reason.all.join('\n') : undefined}>
                            {reason.primary}
                            {reason.count > 1 && <span className="text-slate-500 ml-1">({reason.count} rules)</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalContracts === 0 && !result.qualifies && (
        <div className="py-12 text-center rounded-xl border border-slate-800 bg-slate-900/50">
          <XCircle className="h-8 w-8 mx-auto mb-2 text-red-400/60" />
          <p className="text-sm text-slate-500">No option contracts were returned for {result.ticker}.</p>
        </div>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-slate-800/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className="text-sm font-medium text-slate-200 tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}
