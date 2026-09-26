import { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type CandlestickData,
  type HistogramData,
  type LineData,
} from 'lightweight-charts';
import { Loader2, AlertTriangle } from 'lucide-react';
import { getCachedBars, fetchCachedBars, type OhlcBar } from '@/lib/technicalCache';

interface Props {
  ticker: string;
  primarySupport?: number | null;
  secondarySupport?: number | null;
  resistance?: number | null;
}

const RESOLUTIONS = ['1D', '1W', '1M'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

// Aggregate daily OhlcBar[] into weekly or monthly bars for the chart
function aggregateBars(bars: OhlcBar[], resolution: Resolution): OhlcBar[] {
  if (resolution === '1D' || bars.length === 0) return bars;

  const groups = new Map<string, OhlcBar[]>();
  for (const bar of bars) {
    let key: string;
    if (resolution === '1W') {
      const d = new Date(bar.date + 'T00:00:00Z');
      const dow = d.getUTCDay();
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    } else {
      key = bar.date.slice(0, 7) + '-01';
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bar);
  }

  return Array.from(groups.entries()).map(([date, group]) => ({
    date,
    open: group[0].open,
    high: Math.max(...group.map((b) => b.high)),
    low: Math.min(...group.map((b) => b.low)),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, b) => sum + b.volume, 0),
  })).sort((a, b) => a.date.localeCompare(b.date));
}

export function TradingViewChart({ ticker, primarySupport, secondarySupport, resistance }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const supportLinesRef = useRef<ISeriesApi<'Line'>[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>('1D');

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 500,
      layout: {
        background: { color: '#0f172a' },
        textColor: '#cbd5e1',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#475569', width: 1, style: LineStyle.Dashed },
        horzLine: { color: '#475569', width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: '#334155',
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
      timeScale: {
        borderColor: '#334155',
        timeVisible: false,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: '#3b82f6',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          chart.applyOptions({ width: entry.contentRect.width });
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      supportLinesRef.current = [];
    };
  }, []);

  const renderBars = useCallback((bars: OhlcBar[], res: Resolution) => {
    if (!candleRef.current || !volumeRef.current || bars.length === 0) return false;

    const chartStart = Date.now();
    const aggregated = aggregateBars(bars, res);

    const candleData: CandlestickData<Time>[] = aggregated.map((b) => ({
      time: Math.floor(new Date(b.date + 'T00:00:00Z').getTime() / 1000) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));

    const volumeData: HistogramData<Time>[] = aggregated.map((b) => ({
      time: Math.floor(new Date(b.date + 'T00:00:00Z').getTime() / 1000) as Time,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
    }));

    candleRef.current.setData(candleData);
    volumeRef.current.setData(volumeData);

    // Clear old support/resistance lines
    for (const line of supportLinesRef.current) {
      chartRef.current?.removeSeries(line);
    }
    supportLinesRef.current = [];

    const addPriceLine = (price: number, color: string, title: string) => {
      if (!chartRef.current || !Number.isFinite(price) || price <= 0) return;
      const line = chartRef.current.addLineSeries({
        color,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      });
      const firstTime = candleData[0].time;
      const lastTime = candleData[candleData.length - 1].time;
      const lineData: LineData<Time>[] = [
        { time: firstTime, value: price },
        { time: lastTime, value: price },
      ];
      line.setData(lineData);
      line.applyOptions({ title });
      supportLinesRef.current.push(line);
    };

    if (primarySupport != null && primarySupport > 0) {
      addPriceLine(primarySupport, '#10b981', 'Primary Support');
    }
    if (secondarySupport != null && secondarySupport > 0) {
      addPriceLine(secondarySupport, '#34d399', 'Secondary Support');
    }
    if (resistance != null && resistance > 0) {
      addPriceLine(resistance, '#f59e0b', 'Resistance');
    }

    chartRef.current?.timeScale().fitContent();
    console.log(`[PERF] ${ticker} chart rendered ${Date.now() - chartStart}ms (${aggregated.length} ${res} bars)`);
    return true;
  }, [ticker, primarySupport, secondarySupport, resistance]);

  // Fetch bars when ticker or resolution changes — cache first, then fetch
  useEffect(() => {
    let cancelled = false;

    async function loadBars() {
      if (!ticker) return;
      const t0 = Date.now();
      setLoading(true);
      setError(null);

      // 1. Try in-memory cache first (instant render)
      const cached = getCachedBars(ticker);
      if (cached && cached.length > 0) {
        console.log(`[PERF] ${ticker} chart bars cache hit (${Date.now() - t0}ms)`);
        const ok = renderBars(cached, resolution);
        if (ok) {
          setLoading(false);
          return;
        }
      }

      // 2. Fetch via shared dedup (Supabase first, edge fn fallback)
      const bars = await fetchCachedBars(ticker);
      if (cancelled) return;

      if (bars && bars.length > 0) {
        renderBars(bars, resolution);
        setLoading(false);
      } else {
        setError('Chart data unavailable');
        setLoading(false);
      }
    }

    loadBars();

    return () => { cancelled = true; };
  }, [ticker, resolution, renderBars]);

  // Re-render support/resistance lines when they change (without refetching bars)
  useEffect(() => {
    if (loading) return;
    const cached = getCachedBars(ticker);
    if (cached && cached.length > 0) {
      renderBars(cached, resolution);
    }
  }, [primarySupport, secondarySupport, resistance, loading, ticker, resolution, renderBars]);

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    void fetchCachedBars(ticker).then((bars) => {
      if (bars && bars.length > 0) {
        renderBars(bars, resolution);
      } else {
        setError('Chart data unavailable');
      }
      setLoading(false);
    });
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-200">Price Chart</span>
          <span className="text-xs text-slate-500">{ticker}</span>
        </div>
        <div className="flex items-center gap-1">
          {RESOLUTIONS.map((r) => (
            <button
              key={r}
              onClick={() => setResolution(r)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                resolution === r
                  ? 'bg-sky-500 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <div ref={containerRef} className="w-full" style={{ height: 500 }} />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
              <span className="text-sm text-slate-400">Loading chart...</span>
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900/70">
            <div className="flex items-center gap-2 text-sm text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Chart data unavailable
            </div>
            <button
              onClick={handleRetry}
              className="flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <Loader2 className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
