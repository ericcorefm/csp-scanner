import { useMemo, useState, useEffect } from 'react';
import {
  TrendingUp, TrendingDown, Minus, ArrowUpRight, BarChart3, Building2,
  CandlestickChart, Calculator, Target, Plus, Check, XCircle, AlertTriangle,
  Activity, Crosshair, Loader2, Search,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import { calcRecycleDate, formatLocalDate } from '@/lib/calculations';
import { Badge, Card, StatRow, MetricIndicator, formatPct, formatNum } from '@/components/ui';
import { BackButton } from '@/components/Layout';
import { TradingViewChart } from '@/components/TradingViewChart';
import type { Page } from '@/components/Layout';
import type { TechnicalData } from '@/lib/liveMarketData';
import { getCachedTechnical, type TechFetchError } from '@/lib/technicalCache';
import { selectBestContractPerTicker } from '@/lib/bestContract';

const trendIcons: Record<string, typeof TrendingUp> = {
  Bullish: TrendingUp,
  Rebound: ArrowUpRight,
  Improving: TrendingUp,
  Sideways: Minus,
  Stabilizing: Minus,
  Downtrend: TrendingDown,
};

const trendColors: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  Bullish: 'success',
  Rebound: 'success',
  Improving: 'success',
  Sideways: 'neutral',
  Stabilizing: 'neutral',
  Downtrend: 'error',
  Pending: 'warning',
  Unavailable: 'warning',
};

function volClassColor(cls: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (cls === 'Excellent' || cls === 'Very Good' || cls === 'Good') return 'success';
  if (cls === 'Meaningful') return 'neutral';
  if (cls === 'Thin') return 'warning';
  return 'error';
}

function displayPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'Unavailable';
  return `$${formatNum(v)}`;
}

function displayTrend(v: string | null | undefined): string {
  if (!v || v === 'Unavailable' || v === 'Pending') return v || 'Pending';
  return v;
}

export function DetailPage({
  ticker,
  strike,
  expiration,
  state,
  onNavigate,
}: {
  ticker: string;
  strike: number | null;
  expiration: string | null;
  state: AppState;
  onNavigate: (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => void;
}) {
  const [techLoading, setTechLoading] = useState(false);
  const [techError, setTechError] = useState<TechFetchError | null>(null);
  const [extraTech, setExtraTech] = useState<TechnicalData | null>(null);
  const [mergedTrend, setMergedTrend] = useState<string | null>(null);
  const [mergedPrimarySupport, setMergedPrimarySupport] = useState<number | null>(null);
  const [mergedSecondarySupport, setMergedSecondarySupport] = useState<number | null>(null);
  const [mergedResistance, setMergedResistance] = useState<number | null>(null);
  const [mergedSupportDist, setMergedSupportDist] = useState<number | null>(null);

  const candidate = useMemo(() => {
    if (strike !== null && expiration) {
      const exact = state.candidates.find(
        (c) => c.ticker === ticker && c.strike === strike && c.expiration === expiration,
      );
      if (exact) return exact;
    }
    // No exact contract: show this ticker's best contract (same ranking as
    // Today's Candidates) instead of an arbitrary one.
    return selectBestContractPerTicker(state.candidates.filter((c) => c.ticker === ticker))[0];
  }, [state.candidates, ticker, strike, expiration]);

  // ── Auto-fetch missing technical data (non-blocking) ──
  useEffect(() => {
    if (!candidate || !state.activeProfile) return;
    const t0 = Date.now();
    console.log(`[PERF] ${ticker} candidate detail opened`);

    const hasFullTech =
      candidate.trend_classification !== 'Pending' &&
      candidate.trend_classification !== 'Unavailable' &&
      candidate.primary_support != null &&
      candidate.secondary_support != null &&
      candidate.resistance != null;

    if (hasFullTech) {
      setTechLoading(false);
      setTechError(null);
      return;
    }

    // Use cache first — no loading spinner if we already have data
    const cached = getCachedTechnical(ticker);
    if (cached) {
      console.log(`[PERF] ${ticker} cache hit (${Date.now() - t0}ms)`);
      setExtraTech(cached.technical);
      setMergedTrend(
        candidate.trend_classification === 'Pending' || candidate.trend_classification === 'Unavailable'
          ? cached.trend : candidate.trend_classification,
      );
      setMergedPrimarySupport(candidate.primary_support ?? cached.primary_support);
      setMergedSecondarySupport(candidate.secondary_support ?? cached.secondary_support);
      setMergedResistance(candidate.resistance ?? cached.resistance);
      const sd = candidate.strike_distance_from_support;
      if (sd != null) {
        setMergedSupportDist(sd);
      } else if (cached.primary_support != null && cached.primary_support > 0 && typeof candidate.strike === 'number' && Number.isFinite(candidate.strike)) {
        setMergedSupportDist(parseFloat(((cached.primary_support - candidate.strike) / cached.primary_support * 100).toFixed(1)));
      } else {
        setMergedSupportDist(null);
      }
      // Still refresh in background to update candidates list
      void state.refreshCandidateTechnical(ticker);
      return;
    }

    // No cache — show loading skeleton, but DON'T block page render
    let cancelled = false;
    setTechLoading(true);
    setTechError(null);

    (async () => {
      console.log(`[PERF] ${ticker} cache miss — history request started`);
      const result = await state.refreshCandidateTechnical(ticker);
      if (cancelled) return;
      if (result.ok) {
        const fresh = getCachedTechnical(ticker);
        if (fresh) {
          setExtraTech(fresh.technical);
          setMergedTrend(
            candidate.trend_classification === 'Pending' || candidate.trend_classification === 'Unavailable'
              ? fresh.trend : candidate.trend_classification,
          );
          setMergedPrimarySupport(candidate.primary_support ?? fresh.primary_support);
          setMergedSecondarySupport(candidate.secondary_support ?? fresh.secondary_support);
          setMergedResistance(candidate.resistance ?? fresh.resistance);
          const sd = candidate.strike_distance_from_support;
          if (sd != null) {
            setMergedSupportDist(sd);
          } else if (fresh.primary_support != null && fresh.primary_support > 0 && typeof candidate.strike === 'number' && Number.isFinite(candidate.strike)) {
            setMergedSupportDist(parseFloat(((fresh.primary_support - candidate.strike) / fresh.primary_support * 100).toFixed(1)));
          } else {
            setMergedSupportDist(null);
          }
        }
        console.log(`[PERF] ${ticker} technical calculations done (${Date.now() - t0}ms)`);
      } else {
        setTechError(result.error || 'error');
      }
      setTechLoading(false);
    })();

    return () => { cancelled = true; };
  }, [candidate, ticker, state.activeProfile, state.refreshCandidateTechnical]);

  const handleRetryTechnical = () => {
    setTechError(null);
    setTechLoading(true);
    void state.refreshCandidateTechnical(ticker).then((result) => {
      if (result.ok) {
        const fresh = getCachedTechnical(ticker);
        if (fresh) {
          setExtraTech(fresh.technical);
          setMergedTrend(fresh.trend);
          setMergedPrimarySupport(fresh.primary_support);
          setMergedSecondarySupport(fresh.secondary_support);
          setMergedResistance(fresh.resistance);
        }
      } else {
        setTechError(result.error || 'error');
      }
      setTechLoading(false);
    });
  };

  const btcTable = useMemo(() => {
    if (!candidate || !state.activeProfile) return null;
    if (candidate.suggested_btc > 0 && candidate.has_quotes) {
      return {
        best: {
          btc_price: candidate.suggested_btc,
          net_profit: candidate.net_profit,
          net_croi: candidate.net_croi,
          premium_capture: candidate.premium_capture,
          status: 'qualifies' as const,
          is_best: true,
        },
        table: [],
      };
    }
    return null;
  }, [candidate, state.activeProfile]);

  if (!candidate) {
    return (
      <div>
        <BackButton onClick={() => onNavigate('candidates')} />
        <div className="py-16 text-center">
          <p className="text-slate-400 mb-2">No candidate data found for {ticker}.</p>
          <p className="text-sm text-slate-500">
            Run a scan from Today's Candidates, then click a row to see details here.
          </p>
        </div>
      </div>
    );
  }

  const effectiveTrend = mergedTrend ?? candidate.trend_classification;
  const effectivePrimarySupport = mergedPrimarySupport ?? candidate.primary_support;
  const effectiveSecondarySupport = mergedSecondarySupport ?? (candidate.secondary_support ?? null);
  const effectiveResistance = mergedResistance ?? (candidate.resistance ?? null);
  const effectiveSupportDist = mergedSupportDist ?? candidate.strike_distance_from_support;

  const TrendIcon = trendIcons[effectiveTrend] || Minus;
  const trendColor = trendColors[effectiveTrend] || 'neutral';
  const recycleDate = calcRecycleDate(formatLocalDate(new Date()), state.activeProfile?.max_recycle_days || 120);
  const stockPrice = candidate.stock_price;

  const handleAddPosition = async () => {
    if (!candidate || !state.activeProfile) return;
    await state.addOpenPosition({
      ticker: candidate.ticker,
      company_name: candidate.company_name,
      strike: candidate.strike,
      expiration: candidate.expiration,
      contracts: 1,
      open_date: formatLocalDate(new Date()),
      actual_sto: candidate.suggested_sto,
      current_bid: candidate.bid,
      current_ask: candidate.ask,
      current_mid: candidate.mid,
      btc_target: candidate.suggested_btc,
      net_target_profit: candidate.net_profit,
      net_croi: candidate.net_croi,
      premium_capture: candidate.premium_capture,
      collateral: candidate.strike * 100,
      breakeven: candidate.breakeven,
      stock_price: stockPrice ?? 0,
      trend_classification: effectiveTrend,
      primary_support: effectivePrimarySupport ?? 0,
      support_status: 'Stable',
      position_status: 'Waiting',
      days_open: 0,
      days_to_review: state.activeProfile.max_recycle_days,
      strategy_profile_id: state.activeProfile.id,
    });
    onNavigate('open');
  };

  return (
    <div className="space-y-5">
      <BackButton onClick={() => onNavigate('candidates')} />

      {/* Header */}
      <div className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/50 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-100">{ticker}</h1>
              {techLoading ? (
                <Badge variant="neutral" dot>
                  <Loader2 className="h-3 w-3 inline mr-0.5 animate-spin" />
                  Loading
                </Badge>
              ) : (
                <Badge variant={trendColor} dot>
                  <TrendIcon className="h-3 w-3 inline mr-0.5" />
                  {displayTrend(effectiveTrend)}
                </Badge>
              )}
            </div>
            <p className="text-sm text-slate-400 mt-1">{candidate.company_name}</p>
            <div className="flex items-center gap-6 mt-4">
              <div>
                <div className="text-xs text-slate-500">Stock Price</div>
                <div className={`text-xl font-semibold tabular-nums ${stockPrice ? 'text-slate-100' : 'text-slate-600'}`}>
                  {displayPrice(stockPrice)}
                </div>
                {candidate.stock_source && candidate.stock_source !== 'daily_aggregates' && candidate.stock_source !== 'none' && (
                  <div className="text-[10px] text-slate-500 mt-0.5">Latest daily close</div>
                )}
              </div>
              <div>
                <div className="text-xs text-slate-500">Primary Support</div>
                <div className={`text-xl font-semibold tabular-nums ${effectivePrimarySupport ? 'text-emerald-400' : 'text-slate-600'}`}>
                  {displayPrice(effectivePrimarySupport)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Secondary Support</div>
                <div className={`text-xl font-semibold tabular-nums ${effectiveSecondarySupport ? 'text-emerald-400/70' : 'text-slate-600'}`}>
                  {displayPrice(effectiveSecondarySupport)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Resistance</div>
                <div className={`text-xl font-semibold tabular-nums ${effectiveResistance ? 'text-amber-400' : 'text-slate-600'}`}>
                  {displayPrice(effectiveResistance)}
                </div>
              </div>
            </div>
          </div>
          {candidate && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => onNavigate('analyze', candidate.ticker)}
                className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
              >
                <Search className="h-4 w-4" />
                Analyze Ticker
              </button>
              <button
                onClick={handleAddPosition}
                className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Open Position
              </button>
            </div>
          )}
        </div>
      </div>

      {techError && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Technical data temporarily {techError === 'rate_limited' ? 'unavailable due to API rate limit' : 'unavailable'}.</span>
          </div>
          <button
            onClick={handleRetryTechnical}
            className="flex items-center gap-1.5 rounded-md border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/10 transition-colors"
          >
            <Loader2 className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      )}

      {candidate.pass_fail && candidate.pass_fail.length > 0 && (() => {
        let pCount = 0, wCount = 0, fCount = 0;
        for (const pf of candidate.pass_fail) {
          if (pf.status === 'pass') pCount++;
          else if (pf.status === 'fail') fCount++;
          else wCount++;
        }
        return (
          <div className="flex items-center gap-4 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2.5 text-sm">
            <span className="text-slate-400">Rule Summary:</span>
            <span className="text-emerald-400 font-medium">Passes: {pCount}</span>
            <span className="text-amber-400 font-medium">Warnings: {wCount}</span>
            <span className="text-red-400 font-medium">Fails: {fCount}</span>
          </div>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Technical Analysis card */}
        <Card title="Technical Analysis" action={<BarChart3 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            {techLoading ? (
              <div className="py-8 space-y-4 animate-pulse">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full bg-slate-700" />
                  <div className="h-3 w-32 rounded bg-slate-700" />
                </div>
                <div className="h-4 w-24 rounded bg-slate-700" />
                <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex justify-between">
                      <div className="h-3 w-20 rounded bg-slate-700/70" />
                      <div className="h-3 w-16 rounded bg-slate-700/70" />
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                  {[...Array(7)].map((_, i) => (
                    <div key={i} className="flex justify-between">
                      <div className="h-3 w-16 rounded bg-slate-700/50" />
                      <div className="h-3 w-14 rounded bg-slate-700/50" />
                    </div>
                  ))}
                </div>
              </div>
            ) : techError ? (
              <div className="py-8 text-center">
                <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-amber-400/60" />
                <p className="text-sm text-slate-500 mb-3">Technical data temporarily unavailable</p>
                <button
                  onClick={handleRetryTechnical}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors"
                >
                  <Loader2 className="h-3.5 w-3.5" />
                  Retry
                </button>
              </div>
            ) : stockPrice || extraTech ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <MetricIndicator status={
                    effectiveTrend === 'Downtrend' ? 'fail' :
                    effectiveTrend === 'Pending' || effectiveTrend === 'Unavailable' || !effectiveTrend ? 'warn' : 'pass'
                  } />
                  <span className="text-xs text-slate-500">Trend Classification</span>
                </div>
                <div className="text-sm text-slate-200">{displayTrend(effectiveTrend)}</div>
                <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                  <StatRow label="Primary Support" value={displayPrice(effectivePrimarySupport)} />
                  <StatRow label="Secondary Support" value={displayPrice(effectiveSecondarySupport)} />
                  <StatRow label="Resistance" value={displayPrice(effectiveResistance)} />
                </div>
                {!extraTech && candidate.technical_snapshot && (
                  <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                    <StatRow label="RSI (scan)" value={formatNum(candidate.technical_snapshot.rsi, 1)} icon={<Activity className="h-3.5 w-3.5 text-slate-500" />} />
                    <StatRow label="20 DMA" value={`$${formatNum(candidate.technical_snapshot.ma20)}`} />
                    <StatRow label="50 DMA" value={`$${formatNum(candidate.technical_snapshot.ma50)}`} />
                    <StatRow label="200 DMA" value={candidate.technical_snapshot.ma200 != null ? formatNum(candidate.technical_snapshot.ma200) : 'N/A'} />
                  </div>
                )}
                {extraTech && (
                  <div className="grid grid-cols-2 gap-x-6 border-t border-slate-800 pt-4">
                    <StatRow label="RSI" value={formatNum(extraTech.rsi, 1)} icon={<Activity className="h-3.5 w-3.5 text-slate-500" />} />
                    <StatRow label="20 DMA" value={`$${formatNum(extraTech.ma20)}`} />
                    <StatRow label="50 DMA" value={`$${formatNum(extraTech.ma50)}`} />
                    <StatRow label="200 DMA" value={extraTech.ma200 != null ? `${formatNum(extraTech.ma200)}` : 'N/A'} />
                    <StatRow
                      label="MACD"
                      value={`${formatNum(extraTech.macd, 4)} / ${formatNum(extraTech.macd_signal, 4)}`}
                      sub={`Hist: ${formatNum(extraTech.macd_histogram, 4)}`}
                      icon={<BarChart3 className="h-3.5 w-3.5 text-slate-500" />}
                    />
                    <StatRow
                      label="Bollinger Position"
                      value={extraTech.bb_position}
                      sub={`U: $${formatNum(extraTech.bb_upper)} · L: $${formatNum(extraTech.bb_lower)}`}
                      icon={<Crosshair className="h-3.5 w-3.5 text-slate-500" />}
                    />
                    <StatRow label="Volume Trend" value={extraTech.volume_trend} />
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-500">Historical data unavailable — technical indicators could not be calculated.</p>
              </div>
            )}
          </div>
        </Card>

        {/* Fundamental card */}
        <Card title="Fundamental Snapshot" action={<Building2 className="h-4 w-4 text-slate-500" />}>
          <div className="p-5">
            <div className="grid grid-cols-2 gap-x-6">
              <StatRow label="Company" value={candidate.company_name} />
              <StatRow label="Stock Price" value={displayPrice(stockPrice)} />
              <StatRow label="Trend" value={displayTrend(effectiveTrend)} />
              <StatRow label="Primary Support" value={displayPrice(effectivePrimarySupport)} />
            </div>
            <div className="mt-4 border-t border-slate-800 pt-4">
              <p className="text-xs text-slate-500">
                Fundamental data is derived from live scan results. Detailed revenue, debt, and cash flow figures require a separate data feed.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Price Chart */}
      <TradingViewChart
        ticker={candidate.ticker}
        primarySupport={effectivePrimarySupport}
        secondarySupport={effectiveSecondarySupport}
        resistance={effectiveResistance}
      />

      {candidate && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Option card */}
          <Card title="Option Contract" action={<CandlestickChart className="h-4 w-4 text-slate-500" />}>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="info">PUT</Badge>
                <span className="text-sm text-slate-300 font-medium">${formatNum(candidate.strike)} Strike</span>
                <span className="text-xs text-slate-500">· {candidate.dte} DTE · {candidate.expiration}</span>
              </div>
              <StatRow label="Bid" value={`$${formatNum(candidate.bid)}`} />
              <StatRow label="Ask" value={`$${formatNum(candidate.ask)}`} />
              <StatRow label="Mid" value={`$${formatNum(candidate.mid)}`} />
              <StatRow
                label="Spread %"
                value={formatPct(candidate.spread_pct)}
                highlight={candidate.spread_pct <= 5}
              />
              <StatRow label="IV" value={`${formatNum(candidate.iv, 0)}%`} />
              <StatRow label="Delta" value={formatNum(candidate.delta)} />
              <StatRow label="Volume" value={candidate.volume.toLocaleString()} />
              <StatRow label="Open Interest" value={candidate.open_interest.toLocaleString()} />
              <div className="mt-3 border-t border-slate-800 pt-3">
                <StatRow label="Collateral" value={`$${formatNum(candidate.strike * 100)}`} />
                <StatRow label="Premium" value={`$${formatNum(candidate.mid * 100)}`} />
                <StatRow label="Breakeven" value={`$${formatNum(candidate.breakeven)}`} />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <MetricIndicator status={candidate.open_interest >= 1000 ? 'pass' : 'fail'} />
                <span className="text-xs text-slate-400">OI {candidate.open_interest >= 1000 ? 'meets' : 'below'} minimum</span>
                <span className="mx-1 text-slate-700">|</span>
                <Badge variant={volClassColor(candidate.volume_classification)}>{candidate.volume_classification}</Badge>
              </div>
            </div>
          </Card>

          {/* CSP Analysis card */}
          <Card title="CSP Analysis" action={<Calculator className="h-4 w-4 text-slate-500" />}>
            <div className="p-5">
              <StatRow label="Suggested STO Limit" value={`$${formatNum(candidate.suggested_sto)}`} highlight />
              <StatRow label="Suggested BTC Limit" value={`$${formatNum(candidate.suggested_btc)}`} highlight />
              <StatRow label="Net Profit" value={`$${formatNum(candidate.net_profit)}`} />
              <StatRow label="Net CROI" value={formatPct(candidate.net_croi)} highlight={typeof candidate.net_croi === 'number' && candidate.net_croi >= 3.5} />
              <StatRow label="Premium Capture" value={formatPct(candidate.premium_capture)} />
              <div className="mt-3 border-t border-slate-800 pt-3">
                <StatRow
                  label="Strike Dist from Stock"
                  value={candidate.strike_distance_from_stock != null ? `${candidate.strike_distance_from_stock}%` : 'Unavailable'}
                />
                <StatRow
                  label="Strike Dist from Support"
                  value={effectiveSupportDist != null ? `${effectiveSupportDist}%` : 'Unavailable'}
                />
                <StatRow label={`Recycle Date (${state.activeProfile?.max_recycle_days ?? 120}d)`} value={recycleDate} />
              </div>
            </div>
          </Card>

          {/* BTC Optimization */}
          <Card title="BTC Optimization" action={<Target className="h-4 w-4 text-slate-500" />}>
            <div className="p-3">
              <div className="text-xs text-slate-500 px-2 py-1">
                Highest BTC meeting CROI &gt;= {state.activeProfile?.min_net_croi}% and PC &lt;= {state.activeProfile?.max_premium_capture}%
              </div>
              <div className="mt-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-800">
                      <th className="px-2 py-1.5 text-left">BTC</th>
                      <th className="px-2 py-1.5 text-right">Net $</th>
                      <th className="px-2 py-1.5 text-right">CROI</th>
                      <th className="px-2 py-1.5 text-right">PC</th>
                      <th className="px-2 py-1.5 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {btcTable?.best ? (
                      <tr className="bg-emerald-500/10">
                        <td className="px-2 py-2 tabular-nums text-emerald-300 font-medium">${formatNum(btcTable.best.btc_price)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-slate-300">${formatNum(btcTable.best.net_profit)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-emerald-400">{formatPct(btcTable.best.net_croi)}</td>
                        <td className="px-2 py-2 tabular-nums text-right text-slate-300">{formatPct(btcTable.best.premium_capture)}</td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                            <Check className="h-3.5 w-3.5" />
                            Pass
                          </span>
                        </td>
                      </tr>
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-2 py-2 text-center text-slate-500">No qualifying BTC target</td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-flex items-center gap-1 text-red-400 font-medium">
                            <XCircle className="h-3.5 w-3.5" />
                            Fail
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
