import { useState, useMemo } from 'react';
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
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AnalyzeTickerResponse, ContractAnalysis, TechnicalData } from '@/lib/liveMarketData';
import { Card, Badge, formatNum, formatPct } from '@/components/ui';

export function AnalyzeTickerPage({ state }: { state: AppState }) {
  const [ticker, setTicker] = useState('');
  const [filterExpiration, setFilterExpiration] = useState<string>('all');
  const [filterStrike, setFilterStrike] = useState<string>('all');
  const result = state.analyzeResult;
  const error = state.analyzeError;
  const analyzing = state.analyzing;

  const handleAnalyze = () => {
    const sym = ticker.toUpperCase().trim();
    if (!sym) return;
    setFilterExpiration('all');
    setFilterStrike('all');
    state.runAnalyzeTicker(sym);
  };

  const isInUniverse = (sym: string) =>
    state.scanUniverseEntries.some((e) => e.symbol === sym.toUpperCase());

  const expirations = useMemo(() => {
    if (!result?.all_qualifying_contracts) return [];
    return [...new Set(result.all_qualifying_contracts.map((c) => c.expiration))].sort();
  }, [result]);

  const strikes = useMemo(() => {
    if (!result?.all_qualifying_contracts) return [];
    return [...new Set(result.all_qualifying_contracts.map((c) => c.strike))].sort((a, b) => a - b);
  }, [result]);

  const groupedByExpiration = useMemo(() => {
    if (!result?.all_qualifying_contracts) return [];
    let contracts = result.all_qualifying_contracts;
    if (filterExpiration !== 'all') {
      contracts = contracts.filter((c) => c.expiration === filterExpiration);
    }
    if (filterStrike !== 'all') {
      contracts = contracts.filter((c) => c.strike === Number(filterStrike));
    }
    const groups: Record<string, ContractAnalysis[]> = {};
    for (const c of contracts) {
      if (!groups[c.expiration]) groups[c.expiration] = [];
      groups[c.expiration].push(c);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [result, filterExpiration, filterStrike]);

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
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAnalyze(); }}
              placeholder="e.g. SOFI"
              className="w-32 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 uppercase placeholder:text-slate-600 placeholder:normal-case text-center font-medium"
            />
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
          setFilterExpiration={setFilterExpiration}
          setFilterStrike={setFilterStrike}
          groupedByExpiration={groupedByExpiration}
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
  setFilterExpiration,
  setFilterStrike,
  groupedByExpiration,
}: {
  result: AnalyzeTickerResponse;
  state: AppState;
  isInUniverse: boolean;
  expirations: string[];
  strikes: number[];
  filterExpiration: string;
  filterStrike: string;
  setFilterExpiration: (v: string) => void;
  setFilterStrike: (v: string) => void;
  groupedByExpiration: [string, ContractAnalysis[]][];
}) {
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

      {/* Stock Summary */}
      <Card title="Stock Summary">
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatBox label="Ticker" value={result.ticker} />
            <StatBox label="Stock Price" value={`$${formatNum(result.stock_price)}`} />
            <StatBox label="Trend" value={result.trend} />
            <StatBox label="Primary Support" value={`$${formatNum(result.primary_support)}`} />
            <StatBox label="Secondary Support" value={`$${formatNum(result.secondary_support)}`} />
            <StatBox label="Resistance" value={`$${formatNum(result.resistance)}`} />
          </div>
        </div>
      </Card>

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
      {result.best_contract && (
        <Card title="Rule Check (Best Contract)">
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {result.best_contract.pass_fail.map((pf, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {pf.pass ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                  )}
                  <span className={pf.pass ? 'text-slate-300' : 'text-red-400'}>{pf.rule}</span>
                </div>
              ))}
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
      {result.all_qualifying_contracts.length > 0 && (
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
          <span className="text-xs text-slate-500 ml-auto">
            {groupedByExpiration.reduce((sum, [, contracts]) => sum + contracts.length, 0)} contracts
          </span>
        </div>
      )}

      {/* Contract Results */}
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
                      {['Strike', 'Expiration', 'DTE', 'Strike Below Stock %', 'Strike Below Support %', 'Quote Status', 'STO', 'BTC', 'Net Profit', 'CROI', 'PC', 'Breakeven'].map((h) => (
                        <th key={h} className="px-3 py-2 text-xs font-medium text-slate-400 text-right whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {contracts.map((c, i) => {
                      const noQuote = !c.has_quotes;
                      const DASH = <span className="text-slate-600">--</span>;
                      return (
                        <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-3 py-2 text-right tabular-nums text-slate-200 font-medium">${formatNum(c.strike)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{c.expiration}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">{c.dte}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {c.strike_distance_from_stock != null ? `${c.strike_distance_from_stock}%` : DASH}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {c.strike_distance_from_support != null ? `${c.strike_distance_from_support}%` : DASH}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {noQuote ? (
                              <span className="text-amber-300">Enter Quote</span>
                            ) : (
                              <Badge variant="success" dot>Quoted</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-sky-400 font-medium">
                            {noQuote ? DASH : `$${formatNum(c.suggested_sto)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-sky-300">
                            {noQuote ? DASH : `$${formatNum(c.suggested_btc)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {noQuote ? DASH : `$${formatNum(c.net_profit)}`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {noQuote ? DASH : (
                              <span className={c.net_croi >= 3.5 ? 'text-emerald-400 font-medium' : 'text-red-400'}>
                                {formatPct(c.net_croi)}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                            {noQuote ? DASH : formatPct(c.premium_capture)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                            {noQuote ? DASH : `$${formatNum(c.breakeven)}`}
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

      {result.all_qualifying_contracts.length === 0 && !result.qualifies && (
        <div className="py-12 text-center rounded-xl border border-slate-800 bg-slate-900/50">
          <XCircle className="h-8 w-8 mx-auto mb-2 text-red-400/60" />
          <p className="text-sm text-slate-500">No contracts qualified for {result.ticker} under the current strategy rules.</p>
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
