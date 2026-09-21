import { useEffect, useRef, useState } from 'react';
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
import { supabase } from '@/lib/supabase';

interface ChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Props {
  ticker: string;
  primarySupport?: number | null;
  secondarySupport?: number | null;
  resistance?: number | null;
}

const RESOLUTIONS = ['1D', '1W', '1M'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

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

  // Fetch bars when ticker or resolution changes
  useEffect(() => {
    let cancelled = false;

    async function fetchBars() {
      if (!ticker || !candleRef.current || !volumeRef.current) return;

      setLoading(true);
      setError(null);

      try {
        const { data, error: fnError } = await supabase.functions.invoke('market-scan', {
          body: {
            mode: 'chart-bars',
            ticker,
            resolution,
          },
        });

        if (cancelled) return;

        if (fnError) {
          setError('Chart data unavailable');
          setLoading(false);
          return;
        }

        if (!data || data.success === false || !Array.isArray(data.bars) || data.bars.length === 0) {
          setError('Chart data unavailable');
          setLoading(false);
          return;
        }

        const bars: ChartBar[] = data.bars;

        const candleData: CandlestickData<Time>[] = bars.map((b) => ({
          time: b.time as Time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }));

        const volumeData: HistogramData<Time>[] = bars.map((b) => ({
          time: b.time as Time,
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
          const firstTime = bars[0].time as Time;
          const lastTime = bars[bars.length - 1].time as Time;
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
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Chart data unavailable');
          setLoading(false);
        }
      }
    }

    fetchBars();

    return () => {
      cancelled = true;
    };
  }, [ticker, resolution, primarySupport, secondarySupport, resistance]);

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
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading chart...
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70">
            <div className="flex items-center gap-2 text-sm text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Chart data unavailable
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
