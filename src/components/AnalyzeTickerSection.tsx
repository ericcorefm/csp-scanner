import { useState } from 'react';
import { Search, Plus, Trash2, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AnalyzeTickerResponse, ContractAnalysis } from '@/lib/liveMarketData';
import { Card, Badge, formatNum, formatPct } from '@/components/ui';

export function AnalyzeTickerSection({ state }: { state: AppState }) {
  const [ticker, setTicker] = useState('');
  const result = state.analyzeResult;
  const error = state.analyzeError;
  const analyzing = state.analyzing;

  const handleAnalyze = () => {
    const sym = ticker.toUpperCase().trim();
    if (!sym) return;
    state.runAnalyzeTicker(sym);
  };

  const isInUniverse = (sym: string) => state.scanUniverse.includes(sym.toUpperCase());

  return (
    <Card title="Analyze Ticker">
      <div className="p-5 space-y-4">
        <p className="text-sm text-slate-400">
          Enter any U.S. stock ticker to run it through your active CSP strategy rules. Works even if the ticker is not in your scan universe.
        </p>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAnalyze(); }}
            placeholder="e.g. SOFI"
            className="w-40 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 uppercase placeholder:text-slate-600 placeholder:normal-case"
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

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {result && <AnalyzeResult result={result} state={state} isInUniverse={isInUniverse(result.ticker)} />}
      </div>
    </Card>
  );
}

function AnalyzeResult({ result, state, isInUniverse }: { result: AnalyzeTickerResponse; state: AppState; isInUniverse: boolean }) {
  return (
    <div className="space-y-4 pt-2">
      {/* Qualifies / Does Not Qualify */}
      <div className={`rounded-lg border px-4 py-3 ${result.qualifies ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-center gap-2">
          {result.qualifies ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
          ) : (
            <XCircle className="h-5 w-5 text-red-400" />
          )}
          <span className={`text-base font-semibold ${result.qualifies ? 'text-emerald-400' : 'text-red-400'}`}>
            {result.qualifies ? 'QUALIFIES' : 'DOES NOT QUALIFY'}
          </span>
          <span className="text-sm text-slate-400 ml-2">
            {result.qualifying_count} of {result.all_contracts_count} contracts qualified
          </span>
        </div>
      </div>

      {/* Ticker overview */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatBox label="Ticker" value={result.ticker} />
        <StatBox label="Stock Price" value={`$${formatNum(result.stock_price)}`} />
        <StatBox label="Trend" value={result.trend} />
        <StatBox label="Primary Support" value={`$${formatNum(result.primary_support)}`} />
        <StatBox label="Secondary Support" value={`$${formatNum(result.secondary_support)}`} />
        <StatBox label="Resistance" value={`$${formatNum(result.resistance)}`} />
      </div>

      {/* Pass/Fail reasons for best contract or all contracts */}
      {result.best_contract && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <h4 className="text-sm font-semibold text-slate-200 mb-3">Rule Check (Best Contract)</h4>
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
      )}

      {/* Best matching contract */}
      {result.best_contract && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
          <h4 className="text-sm font-semibold text-sky-300 mb-3">Best Matching Contract</h4>
          <BestContractDetails contract={result.best_contract} />
        </div>
      )}

      {/* Other qualifying contracts */}
      {result.other_qualifying_contracts.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-800">
            <h4 className="text-sm font-semibold text-slate-200">Other Qualifying Contracts</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-800 bg-slate-900/80">
                <tr>
                  {['Strike', 'Exp', 'Bid', 'Ask', 'Spread %', 'STO', 'BTC', 'CROI %', 'PC %', 'Delta', 'IV %', 'Vol', 'OI'].map((h) => (
                    <th key={h} className="px-3 py-2 text-xs font-medium text-slate-400 text-right whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {result.other_qualifying_contracts.map((c, i) => (
                  <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">${formatNum(c.strike)}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">{c.expiration}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">${formatNum(c.bid)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">${formatNum(c.ask)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={c.spread_pct <= 5 ? 'text-emerald-400' : c.spread_pct <= 10 ? 'text-amber-400' : 'text-red-400'}>
                        {formatPct(c.spread_pct)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-400">${formatNum(c.suggested_sto)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-300">${formatNum(c.suggested_btc)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{formatPct(c.net_croi)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{formatPct(c.premium_capture)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatNum(c.delta)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatNum(c.iv, 0)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{c.volume}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{c.open_interest.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Remove from scan universe */}
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
    </div>
  );
}

function BestContractDetails({ contract }: { contract: ContractAnalysis }) {
  const rows: { label: string; value: string; highlight?: boolean }[] = [
    { label: 'Strike', value: `$${formatNum(contract.strike)}` },
    { label: 'Expiration', value: contract.expiration },
    { label: 'DTE', value: String(contract.dte) },
    { label: 'Bid', value: `$${formatNum(contract.bid)}` },
    { label: 'Ask', value: `$${formatNum(contract.ask)}` },
    { label: 'Mid', value: `$${formatNum(contract.mid)}` },
    { label: 'Spread %', value: formatPct(contract.spread_pct) },
    { label: 'Suggested STO Limit', value: `$${formatNum(contract.suggested_sto)}`, highlight: true },
    { label: 'Suggested BTC Limit', value: `$${formatNum(contract.suggested_btc)}`, highlight: true },
    { label: 'Net Profit', value: `$${formatNum(contract.net_profit)}` },
    { label: 'Net CROI', value: formatPct(contract.net_croi), highlight: true },
    { label: 'Premium Capture', value: formatPct(contract.premium_capture) },
    { label: 'Breakeven', value: `$${formatNum(contract.breakeven)}` },
    { label: 'IV', value: `${formatNum(contract.iv, 0)}%` },
    { label: 'Delta', value: formatNum(contract.delta) },
    { label: 'Volume', value: String(contract.volume) },
    { label: 'Open Interest', value: contract.open_interest.toLocaleString() },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {rows.map((r) => (
        <div key={r.label} className="rounded-lg bg-slate-800/50 px-3 py-2">
          <div className="text-xs text-slate-500">{r.label}</div>
          <div className={`text-sm font-medium tabular-nums ${r.highlight ? 'text-sky-300' : 'text-slate-200'}`}>{r.value}</div>
        </div>
      ))}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800/50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-medium text-slate-200 tabular-nums">{value}</div>
    </div>
  );
}
