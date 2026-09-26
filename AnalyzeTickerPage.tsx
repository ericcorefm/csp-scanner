import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Search,
  Plus,
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
  Trophy,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AnalyzeTickerResponse, ContractAnalysis } from '@/lib/liveMarketData';
import type { ScanUniverseEntry, OpenPosition } from '@/types';
import { Card, Badge, formatNum, formatPct } from '@/components/ui';
import { getCachedStockPrice } from '@/lib/technicalCache';
import { TradingViewChart } from '@/components/TradingViewChart';
import { calcProbabilities } from '@/lib/probability';
import { calcBtcOptimization, calcNetProfit, calcCroiFromCollateral, calcPremiumCapture, calcBreakeven } from '@/lib/calculations';
import { getContractStatus } from '@/lib/status';

function getFailedRules(c: ContractAnalysis): string[] {
  if (!c.pass_fail || c.pass_fail.length === 0) return [];
  return c.pass_fail.filter((pf) => pf.status === 'fail').map((pf) => pf.rule);
}

// Status comes straight from the shared evaluator (same as Today's Candidates):
// informational "not evaluated" rows never turn a Rejected contract into a warning.
function contractStatus(c: ContractAnalysis): 'qualifies' | 'warning' | 'fail' {
  const status = getContractStatus(c);
  if (status === 'qualified') return 'qualifies';
  if (status === 'pending') return 'warning';
  return 'fail';
}

function reasonSummary(c: ContractAnalysis): { primary: string; count: number; all: string[] } {
  const rejections = c.rejection_reasons ?? getFailedRules(c);
  const pending = c.pending_reasons ?? [];
  const status = getContractStatus(c);
  if (status === 'rejected' && rejections.length > 0) {
    return { primary: rejections[0], count: rejections.length, all: [...rejections, ...pending.map((p) => `Pending: ${p}`)] };
  }
  if (status === 'pending') {
    return { primary: pending[0] ?? 'Required data unavailable', count: pending.length, all: pending };
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
  const [viewMode, setViewMode] = useState<'qualified' | 'all'>('qualified');
  const [selectedContract, setSelectedContract] = useState<ContractAnalysis | null>(null);
  const [showAddPosition, setShowAddPosition] = useState(false);
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
    setViewMode('qualified');
    setSelectedContract(null);
    state.runAnalyzeTicker(sym);
  };

  const handleClear = () => {
    setTicker('');
    setFilterExpiration('all');
    setFilterStrike('all');
    setFilterStatus('all');
    setViewMode('qualified');
    setSelectedContract(null);
    state.clearAnalyzeResult();
    tickerInputRef.current?.focus();
  };

  const universeEntryFor = (sym: string) =>
    state.scanUniverseEntries.find((e) => e.symbol === sym.toUpperCase()) ?? null;

  const companyNameFor = (sym: string): string | null => {
    const c = state.candidates.find((c) => c.ticker.toUpperCase() === sym.toUpperCase());
    return c?.company_name || null;
  };

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

  const qualifiedContracts = useMemo(() => allContracts.filter((c) => c.qualified), [allContracts]);

  const bestQualified = useMemo(() => {
    const qs = qualifiedContracts.slice();
    qs.sort((a, b) => {
      if (b.volume !== a.volume) return b.volume - a.volume;
      if (a.premium_capture !== b.premium_capture) return a.premium_capture - b.premium_capture;
      if (b.net_croi !== a.net_croi) return b.net_croi - a.net_croi;
      return b.open_interest - a.open_interest;
    });
    return qs[0] ?? null;
  }, [qualifiedContracts]);

  useEffect(() => {
    if (qualifiedContracts.length === 1) {
      setSelectedContract(qualifiedContracts[0]);
    } else if (qualifiedContracts.length > 1 && bestQualified) {
      setSelectedContract(bestQualified);
    } else {
      setSelectedContract(null);
    }
  }, [qualifiedContracts, bestQualified]);

  const filteredContracts = useMemo(() => {
    let contracts = allContracts;
    if (viewMode === 'qualified') {
      contracts = contracts.filter((c) => c.qualified);
    }
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
  }, [allContracts, viewMode, filterExpiration, filterStrike, filterStatus]);

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
          universeEntry={universeEntryFor(result.ticker)}
          companyName={companyNameFor(result.ticker)}
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
          selectedContract={selectedContract}
          onSelectContract={setSelectedContract}
          onAddPosition={() => setShowAddPosition(true)}
          viewMode={viewMode}
          setViewMode={setViewMode}
          bestQualified={bestQualified}
          qualifiedCount={qualifiedContracts.length}
        />
      )}

      {showAddPosition && selectedContract && result && (
        <AddPositionModal
          state={state}
          contract={selectedContract}
          ticker={result.ticker}
          companyName={companyNameFor(result.ticker)}
          displayStockPrice={displayStockPrice}
          trend={result.trend}
          primarySupport={result.primary_support}
          onClose={() => setShowAddPosition(false)}
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
  universeEntry,
  companyName,
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
  selectedContract,
  onSelectContract,
  onAddPosition,
  viewMode,
  setViewMode,
  bestQualified,
  qualifiedCount,
}: {
  result: AnalyzeTickerResponse;
  state: AppState;
  universeEntry: ScanUniverseEntry | null;
  companyName: string | null;
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
  selectedContract: ContractAnalysis | null;
  onSelectContract: (c: ContractAnalysis | null) => void;
  onAddPosition: () => void;
  viewMode: 'qualified' | 'all';
  setViewMode: (m: 'qualified' | 'all') => void;
  bestQualified: ContractAnalysis | null;
  qualifiedCount: number;
}) {
  const maxCycleDays = state.activeProfile?.max_recycle_days ?? 120;

  const dataWarnings: string[] = [];
  if (displayStockPrice == null) dataWarnings.push('Stock price unavailable.');
  if (!result.technical) dataWarnings.push('Technical history unavailable.');
  if (result.primary_support == null) dataWarnings.push('Primary support could not be evaluated.');

  const [universeBusy, setUniverseBusy] = useState(false);
  const [universeToast, setUniverseToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (!universeToast) return;
    const t = setTimeout(() => setUniverseToast(null), 3000);
    return () => clearTimeout(t);
  }, [universeToast]);

  const handleAddToUniverse = async () => {
    setUniverseBusy(true);
    try {
      await state.addToScanUniverse(result.ticker, {
        source: 'analyze',
        company_name: companyName,
      });
      setUniverseToast({ msg: `${result.ticker} added to Scan Universe`, kind: 'success' });
    } catch (err) {
      console.error('[AddToScanUniverse] Failed:', err);
      setUniverseToast({ msg: 'Could not add ticker to Scan Universe.', kind: 'error' });
    } finally {
      setUniverseBusy(false);
    }
  };

  const handleEnableInUniverse = async () => {
    setUniverseBusy(true);
    try {
      await state.toggleScanUniverseEnabled(result.ticker, true);
      setUniverseToast({ msg: `${result.ticker} enabled in Scan Universe`, kind: 'success' });
    } catch {
      setUniverseToast({ msg: 'Could not enable ticker in Scan Universe.', kind: 'error' });
    } finally {
      setUniverseBusy(false);
    }
  };

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

      {/* Scan Universe + Add Position actions — above Stock Summary */}
      <div className="flex flex-wrap items-center gap-3">
        {universeEntry?.enabled ? (
          <button
            disabled
            className="flex items-center gap-2 rounded-lg border border-emerald-700/50 px-4 py-2 text-sm text-emerald-400 cursor-default"
          >
            <CheckCircle2 className="h-4 w-4" />
            In Scan Universe
          </button>
        ) : universeEntry ? (
          <button
            onClick={handleEnableInUniverse}
            disabled={universeBusy}
            className="flex items-center gap-2 rounded-lg border border-emerald-700/50 px-4 py-2 text-sm text-emerald-400 hover:bg-emerald-900/20 transition-colors disabled:opacity-50"
          >
            {universeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Enable in Scan Universe
          </button>
        ) : (
          <button
            onClick={handleAddToUniverse}
            disabled={universeBusy}
            className="flex items-center gap-2 rounded-lg border border-emerald-700/50 px-4 py-2 text-sm text-emerald-400 hover:bg-emerald-900/20 transition-colors disabled:opacity-50"
          >
            {universeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add to Scan Universe
          </button>
        )}
        <button
          onClick={onAddPosition}
          disabled={!selectedContract}
          title={!selectedContract ? 'Select a contract first' : undefined}
          className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="h-4 w-4" />
          + Position
        </button>
      </div>

      {/* Toast feedback */}
      {universeToast && (
        <div
          className={`fixed bottom-6 right-6 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${
            universeToast.kind === 'success'
              ? 'border-emerald-500/30 bg-emerald-900/80 text-emerald-300'
              : 'border-red-500/30 bg-red-900/80 text-red-300'
          }`}
        >
          {universeToast.msg}
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
              <StatBox label="200 DMA" value={result.technical.ma200 != null ? `${formatNum(result.technical.ma200)}` : 'N/A'} />
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

      {/* Price Chart */}
      <TradingViewChart
        ticker={result.ticker}
        primarySupport={result.primary_support}
        secondarySupport={result.secondary_support}
        resistance={result.resistance}
      />

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

      {/* View toggle + Contract filters */}
      {totalContracts > 0 && (
        <>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/50 p-0.5">
            <button
              onClick={() => setViewMode('qualified')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${viewMode === 'qualified' ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Qualified Only
            </button>
            <button
              onClick={() => setViewMode('all')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${viewMode === 'all' ? 'bg-sky-500/20 text-sky-400' : 'text-slate-400 hover:text-slate-200'}`}
            >
              All Contracts
            </button>
          </div>
          {viewMode === 'qualified' && qualifiedCount > 0 && (
            <span className="text-xs text-slate-500">{qualifiedCount} qualified of {totalContracts} total</span>
          )}
        </div>

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
        </>
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
                      {[
                        { label: 'Strike' },
                        { label: 'DTE' },
                        { label: 'Premium' },
                        { label: 'BTC' },
                        { label: 'CROI' },
                        { label: 'PC' },
                        { label: 'Exp POP', title: 'Probability of expiring worthless (stock > strike at expiration)' },
                        { label: `BTC Prob (${maxCycleDays}d)`, title: `Probability the put premium reaches the BTC target within min(${maxCycleDays}, DTE) days` },
                        { label: 'OI' },
                        { label: 'IV' },
                        { label: 'Vol' },
                        { label: 'Support Dist' },
                        { label: 'Status' },
                        { label: 'Reason' },
                      ].map((h) => (
                        <th key={h.label} className="px-3 py-2 text-xs font-medium text-slate-400 text-right whitespace-nowrap" title={h.title}>{h.label}</th>
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
                      const isBestQualified = bestQualified?.strike === c.strike && bestQualified?.expiration === c.expiration && c.qualified;
                      const isSelected = selectedContract?.strike === c.strike && selectedContract?.expiration === c.expiration;
                      const probs = calcProbabilities({
                        stockPrice: displayStockPrice ?? 0,
                        strike: c.strike,
                        dte: c.dte,
                        iv: c.iv,
                        suggestedSto: c.suggested_sto,
                        suggestedBtc: c.suggested_btc,
                        maxCycleDays,
                      });
                      return (
                        <tr
                          key={i}
                          onClick={() => onSelectContract(isSelected ? null : c)}
                          className={`cursor-pointer transition-colors ${isSelected ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-500/30' : 'hover:bg-slate-800/40'} ${isBestQualified && !isSelected ? 'ring-1 ring-inset ring-emerald-500/20' : ''} ${isClosest && !isSelected && !isBestQualified ? 'ring-1 ring-inset ring-amber-500/20' : ''}`}
                        >
                          <td className="px-3 py-2 text-right tabular-nums text-slate-200 font-medium">
                            ${formatNum(c.strike)}
                            {isBestQualified && <span className="ml-1 text-emerald-400 text-xs" title="Best Match"><Trophy className="inline h-3 w-3" /></span>}
                            {isClosest && !isBestQualified && <span className="ml-1 text-amber-400 text-xs">★</span>}
                            {isSelected && <span className="ml-1 text-sky-400 text-xs">●</span>}
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
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {noQuote || probs.expirationPop == null ? DASH : `${formatPct(probs.expirationPop * 100)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {noQuote || probs.btcTargetProb == null ? DASH : `${formatPct(probs.btcTargetProb * 100)}`}
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

      {/* No qualified contracts empty state */}
      {viewMode === 'qualified' && qualifiedCount === 0 && totalContracts > 0 && (
        <div className="py-12 text-center rounded-xl border border-slate-800 bg-slate-900/50">
          <XCircle className="h-8 w-8 mx-auto mb-2 text-slate-600" />
          <p className="text-sm text-slate-400">No contracts currently qualify under the active strategy.</p>
          <button
            onClick={() => setViewMode('all')}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
          >
            <Filter className="h-3.5 w-3.5" />
            View All Contracts
          </button>
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

function AddPositionModal({
  state,
  contract,
  ticker,
  companyName,
  displayStockPrice,
  trend,
  primarySupport,
  onClose,
}: {
  state: AppState;
  contract: ContractAnalysis;
  ticker: string;
  companyName: string | null;
  displayStockPrice: number | null;
  trend: string;
  primarySupport: number | null;
  onClose: () => void;
}) {
  const profile = state.activeProfile;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const [contracts, setContracts] = useState('1');
  const [openDate, setOpenDate] = useState(today);
  const [actualSto, setActualSto] = useState(String(contract.suggested_sto ?? ''));
  const [broker, setBroker] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  const stoNum = parseFloat(actualSto);
  const contractsNum = parseInt(contracts) || 1;

  const recalc = useMemo(() => {
    if (!profile || isNaN(stoNum) || stoNum <= 0) return null;
    const { best } = calcBtcOptimization(stoNum, contract.strike, contractsNum, profile, true);
    const btcTarget = best ? best.btc_price : 0.01;
    const netProfit = calcNetProfit(stoNum, btcTarget, contractsNum, profile.round_trip_commission);
    const netCroi = calcCroiFromCollateral(netProfit, contract.strike, contractsNum);
    const pc = calcPremiumCapture(stoNum, btcTarget);
    const breakeven = calcBreakeven(contract.strike, stoNum);
    return { btcTarget, netProfit, netCroi, pc, breakeven };
  }, [profile, stoNum, contractsNum, contract.strike]);

  const isQualified = contract.qualified;
  const duplicateExists = state.openPositions.some(
    (p) =>
      p.ticker.toUpperCase() === ticker.toUpperCase() &&
      p.strike === contract.strike &&
      p.expiration === contract.expiration,
  );

  useEffect(() => {
    setDuplicateWarning(duplicateExists);
  }, [duplicateExists]);

  const handleSave = async () => {
    setSaveError(null);

    if (!ticker) {
      setSaveError('Ticker is required.');
      return;
    }
    if (!contract.strike || contract.strike <= 0) {
      setSaveError('Strike must be greater than 0.');
      return;
    }
    if (!contract.expiration) {
      setSaveError('Expiration is required.');
      return;
    }
    if (contractsNum < 1) {
      setSaveError('Contracts must be at least 1.');
      return;
    }
    if (isNaN(stoNum) || stoNum <= 0) {
      setSaveError('Actual STO Fill must be a positive number.');
      return;
    }
    if (!openDate) {
      setSaveError('Open date is required.');
      return;
    }

    setSaving(true);
    try {
      const btcTarget = recalc?.btcTarget ?? 0.01;
      const netProfit = recalc?.netProfit ?? 0;
      const netCroi = recalc?.netCroi ?? 0;
      const pc = recalc?.pc ?? 0;
      const breakeven = recalc?.breakeven ?? contract.strike - stoNum;

      const newPos: Partial<OpenPosition> = {
        ticker,
        company_name: companyName ?? '',
        strike: contract.strike,
        expiration: contract.expiration,
        contracts: contractsNum,
        open_date: openDate,
        actual_sto: stoNum,
        current_bid: contract.bid,
        current_ask: contract.ask,
        current_mid: contract.mid,
        btc_target: parseFloat(btcTarget.toFixed(2)),
        net_target_profit: parseFloat(netProfit.toFixed(2)),
        net_croi: parseFloat(netCroi.toFixed(2)),
        premium_capture: parseFloat(pc.toFixed(1)),
        collateral: contract.strike * 100 * contractsNum,
        breakeven: parseFloat(breakeven.toFixed(2)),
        stock_price: displayStockPrice ?? 0,
        trend_classification: trend,
        primary_support: primarySupport ?? 0,
        support_status: 'Stable',
        position_status: 'Waiting',
        days_open: 0,
        days_to_review: profile?.max_recycle_days,
        strategy_profile_id: profile?.id,
      };

      await state.addOpenPosition(newPos);
      setSaveSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      console.error('[AddPosition] Failed:', err);
      const supabaseErr = err as { code?: string; message?: string; details?: string; hint?: string };
      const msg = supabaseErr?.message || (err instanceof Error ? err.message : 'Failed to add position');
      setSaveError(`Failed to add position: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-100">Add Position</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {saveSuccess ? (
          <div className="p-8 text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-400" />
            <p className="text-sm font-medium text-emerald-400">Position added</p>
            <p className="text-xs text-slate-500 mt-1">{ticker} ${formatNum(contract.strike)} Put · {contract.expiration}</p>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {/* Contract summary */}
            <div className="rounded-lg border border-slate-800 bg-slate-800/40 p-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-slate-500">Ticker:</span> <span className="font-semibold text-slate-200">{ticker}</span></div>
                <div><span className="text-slate-500">Type:</span> <span className="text-slate-200">Put</span></div>
                <div><span className="text-slate-500">Strike:</span> <span className="text-slate-200 tabular-nums">${formatNum(contract.strike)}</span></div>
                <div><span className="text-slate-500">Expiration:</span> <span className="text-slate-200">{contract.expiration}</span></div>
                <div><span className="text-slate-500">DTE:</span> <span className="text-slate-300 tabular-nums">{contract.dte}</span></div>
                <div><span className="text-slate-500">Stock Price:</span> <span className="text-slate-300 tabular-nums">{displayStockPrice != null ? `${formatNum(displayStockPrice)}` : 'Unavailable'}</span></div>
              </div>
            </div>

            {/* Qualification warning */}
            {!isQualified && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>This contract does not currently qualify under the active strategy.</span>
              </div>
            )}

            {/* Duplicate warning */}
            {duplicateWarning && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>An open position already exists for this contract. You can still add another lot.</span>
              </div>
            )}

            {/* Form fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Contracts</label>
                <input
                  type="number"
                  min="1"
                  value={contracts}
                  onChange={(e) => setContracts(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Open Date</label>
                <input
                  type="date"
                  value={openDate}
                  onChange={(e) => setOpenDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-400 mb-1">Actual STO Fill</label>
                <input
                  type="number"
                  step="0.01"
                  value={actualSto}
                  onChange={(e) => setActualSto(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  placeholder="0.00"
                  autoFocus
                />
                <p className="text-xs text-slate-500 mt-1">Prefilled from scanner quote. Edit to match your actual fill.</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Broker <span className="text-slate-600">(optional)</span></label>
                <input
                  type="text"
                  value={broker}
                  onChange={(e) => setBroker(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  placeholder="e.g. Tastytrade"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Notes <span className="text-slate-600">(optional)</span></label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  placeholder=""
                />
              </div>
            </div>

            {/* Live recalculation preview */}
            {recalc && (
              <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-4">
                <div className="text-xs text-slate-500 mb-2">Recalculated from actual fill</div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-slate-500">BTC Target:</span> <span className="text-sky-300 tabular-nums">${formatNum(recalc.btcTarget)}</span></div>
                  <div><span className="text-slate-500">Net Profit:</span> <span className="text-slate-300 tabular-nums">${formatNum(recalc.netProfit)}</span></div>
                  <div><span className="text-slate-500">Net CROI:</span> <span className="text-emerald-400 tabular-nums">{formatPct(recalc.netCroi)}</span></div>
                  <div><span className="text-slate-500">Premium Capture:</span> <span className="text-slate-300 tabular-nums">{formatPct(recalc.pc)}</span></div>
                  <div><span className="text-slate-500">Breakeven:</span> <span className="text-slate-300 tabular-nums">${formatNum(recalc.breakeven)}</span></div>
                  <div><span className="text-slate-500">Collateral:</span> <span className="text-slate-300 tabular-nums">${formatNum(contract.strike * 100 * contractsNum)}</span></div>
                </div>
              </div>
            )}

            {saveError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
                {saveError}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || isNaN(stoNum) || stoNum <= 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {saving ? 'Saving...' : 'Save Position'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
