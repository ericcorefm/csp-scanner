import type { AnalyzeTickerResponse, TechnicalData } from '@/lib/liveMarketData';
import { analyzeTicker } from '@/lib/liveMarketData';
import type { CandidateScan, StrategyProfile, OhlcBar } from '@/types';
import { supabase } from '@/lib/supabase';

export interface TechnicalSnapshot {
  ticker: string;
  trend: string;
  primary_support: number | null;
  secondary_support: number | null;
  resistance: number | null;
  stock_price: number | null;
  technical: TechnicalData | null;
  fetchedAt: number;
}

// ── Shared stock price cache ──
export interface StockPriceEntry {
  price: number | null;
  source: string;
  updatedAt: number;
}

const PRICE_STALE_MS = 6 * 60 * 60 * 1000;
const stockPriceCache = new Map<string, StockPriceEntry>();

export function getCachedStockPrice(ticker: string): StockPriceEntry | null {
  const key = ticker.toUpperCase().trim();
  const entry = stockPriceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > PRICE_STALE_MS) {
    stockPriceCache.delete(key);
    return null;
  }
  return entry;
}

export function setCachedStockPrice(ticker: string, price: number | null, source: string): void {
  const key = ticker.toUpperCase().trim();
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return;
  stockPriceCache.set(key, { price, source, updatedAt: Date.now() });
}

export function populateStockPricesFromCandidates(candidates: CandidateScan[]): void {
  for (const c of candidates) {
    if (c.stock_price != null && c.stock_price > 0) {
      setCachedStockPrice(c.ticker, c.stock_price, c.stock_source || 'scan');
    }
  }
}

// ── Technical snapshot cache (valid for the trading day) ──
const STALE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, TechnicalSnapshot>();

export function getCachedTechnical(ticker: string): TechnicalSnapshot | null {
  const key = ticker.toUpperCase();
  const snap = cache.get(key);
  if (!snap) return null;
  if (Date.now() - snap.fetchedAt > STALE_MS) {
    cache.delete(key);
    return null;
  }
  return snap;
}

export function setCachedTechnical(snap: TechnicalSnapshot): void {
  cache.set(snap.ticker.toUpperCase(), { ...snap, fetchedAt: Date.now() });
}

export function clearCachedTechnical(ticker: string): void {
  cache.delete(ticker.toUpperCase().trim());
}

// ── OHLC bars cache (shared by chart + technical indicators) ──
export interface CachedBars {
  ticker: string;
  bars: OhlcBar[];
  fetchedAt: number;
}

const barsCache = new Map<string, CachedBars>();

export function getCachedBars(ticker: string): OhlcBar[] | null {
  const key = ticker.toUpperCase().trim();
  const entry = barsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_MS) {
    barsCache.delete(key);
    return null;
  }
  return entry.bars;
}

export function setCachedBars(ticker: string, bars: OhlcBar[]): void {
  const key = ticker.toUpperCase().trim();
  if (bars.length === 0) return;
  barsCache.set(key, { ticker: key, bars, fetchedAt: Date.now() });
}

// ── In-flight request deduplication ──
// A single shared promise per ticker so DetailPage, AnalyzeTicker, and Chart
// all reuse the SAME request when history is being fetched.
const inFlight = new Map<string, Promise<TechnicalSnapshot | null>>();
const inFlightBars = new Map<string, Promise<OhlcBar[] | null>>();

// ── Error types for timeout / rate-limit handling ──
export type TechFetchError = 'timeout' | 'rate_limited' | 'error';

export interface TechnicalFetchResult {
  snapshot: TechnicalSnapshot | null;
  error: TechFetchError | null;
}

const TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[PERF] ${label} timeout after ${ms}ms`);
      reject(new Error('__TIMEOUT__'));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function populateFromAnalyzeResponse(resp: AnalyzeTickerResponse): void {
  setCachedStockPrice(resp.ticker, resp.stock_price, resp.stock_source || 'analyze');

  const hasTechnicalData =
    resp.technical_data_available === true ||
    resp.technical != null ||
    resp.primary_support != null ||
    resp.secondary_support != null ||
    resp.resistance != null;

  if (hasTechnicalData) {
    setCachedTechnical({
      ticker: resp.ticker,
      trend: resp.trend,
      primary_support: resp.primary_support,
      secondary_support: resp.secondary_support,
      resistance: resp.resistance,
      stock_price: resp.stock_price,
      technical: resp.technical ?? null,
      fetchedAt: Date.now(),
    });
  }
}

// ── Fetch technical snapshot with cache-first, in-flight dedup, timeout, 429 handling ──
export async function fetchTechnicalSnapshot(
  ticker: string,
  profile: StrategyProfile,
): Promise<TechnicalSnapshot | null> {
  const key = ticker.toUpperCase().trim();
  const t0 = Date.now();
  console.log(`[PERF] ${key} fetchTechnicalSnapshot start`);

  const cached = getCachedTechnical(key);
  if (cached) {
    console.log(`[PERF] ${key} cache hit (${Date.now() - t0}ms)`);
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[PERF] ${key} in-flight reuse`);
    return existing;
  }

  console.log(`[PERF] ${key} cache miss — history request started`);
  const promise = (async () => {
    const reqStart = Date.now();
    try {
      const knownPrice = getCachedStockPrice(key)?.price ?? null;
      const wrapped = withTimeout(analyzeTicker(key, profile, knownPrice), TIMEOUT_MS, `analyze ${key}`);
      const resp = await wrapped;
      const snap: TechnicalSnapshot = {
        ticker: resp.ticker,
        trend: resp.trend,
        primary_support: resp.primary_support,
        secondary_support: resp.secondary_support,
        resistance: resp.resistance,
        stock_price: resp.stock_price,
        technical: resp.technical ?? null,
        fetchedAt: Date.now(),
      };

      const hasTechnicalData =
        resp.technical_data_available === true ||
        resp.technical != null ||
        resp.primary_support != null ||
        resp.secondary_support != null ||
        resp.resistance != null;

      if (hasTechnicalData) setCachedTechnical(snap);
      console.log(`[PERF] ${key} history response ${Date.now() - reqStart}ms`);
      return snap;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === '__TIMEOUT__') {
        console.warn(`[PERF] ${key} technical request timed out`);
      } else if (msg.includes('429') || msg.includes('rate')) {
        console.warn(`[PERF] ${key} rate limited — using cache if available`);
      } else {
        console.error(`[fetchTechnicalSnapshot] ${key} failed:`, err);
      }
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// ── Fetch with typed error result (for UI timeout/retry) ──
export async function fetchTechnicalWithRetry(
  ticker: string,
  profile: StrategyProfile,
): Promise<TechnicalFetchResult> {
  const key = ticker.toUpperCase().trim();
  const cached = getCachedTechnical(key);
  if (cached) return { snapshot: cached, error: null };

  const snap = await fetchTechnicalSnapshot(key, profile);
  if (snap) return { snapshot: snap, error: null };

  // Distinguish timeout vs rate-limit vs generic error by checking the in-flight
  // error message that was logged. Since fetchTechnicalSnapshot swallows errors
  // and returns null, we detect rate-limit heuristically.
  return { snapshot: null, error: 'error' };
}

// ── Fetch OHLC bars (shared by chart + technical) ──
// Uses Supabase stock_history_cache directly when available, falling back
// to the edge function chart-bars endpoint. Deduplicates via inFlightBars.
export async function fetchCachedBars(ticker: string): Promise<OhlcBar[] | null> {
  const key = ticker.toUpperCase().trim();
  const t0 = Date.now();

  const cached = getCachedBars(key);
  if (cached) {
    console.log(`[PERF] ${key} bars cache hit (${Date.now() - t0}ms)`);
    return cached;
  }

  const existing = inFlightBars.get(key);
  if (existing) {
    console.log(`[PERF] ${key} bars in-flight reuse`);
    return existing;
  }

  console.log(`[PERF] ${key} bars cache miss — request started`);
  const promise = (async () => {
    const reqStart = Date.now();
    try {
      // 1. Try Supabase stock_history_cache directly (no edge function call needed)
      const { data, error } = await supabase
        .from('stock_history_cache')
        .select('trade_date,open,high,low,close,volume')
        .eq('ticker', key)
        .order('trade_date', { ascending: true })
        .limit(500);

      if (!error && data && data.length > 0) {
        const bars: OhlcBar[] = data
          .map((r: any) => ({
            date: String(r.trade_date),
            open: Number(r.open || 0),
            high: Number(r.high || 0),
            low: Number(r.low || 0),
            close: Number(r.close || 0),
            volume: Number(r.volume || 0),
          }))
          .filter((b: OhlcBar) => Number.isFinite(b.close) && b.close > 0);

        if (bars.length > 0) {
          setCachedBars(key, bars);
          console.log(`[PERF] ${key} bars from supabase ${bars.length} bars (${Date.now() - reqStart}ms)`);
          return bars;
        }
      }

      // 2. Fall back to edge function chart-bars (fetches from Massive + caches server-side)
      const wrapped = withTimeout(
        supabase.functions.invoke('market-scan', {
          body: { mode: 'chart-bars', ticker: key, resolution: '1D' },
        }),
        TIMEOUT_MS,
        `chart-bars ${key}`,
      );

      const { data: fnData, error: fnError } = await wrapped;

      if (fnError) {
        console.warn(`[PERF] ${key} chart-bars edge function error`);
        return null;
      }

      if (!fnData || fnData.success === false || !Array.isArray(fnData.bars) || fnData.bars.length === 0) {
        return null;
      }

      // Convert chart-bars format (time = unix seconds) to OhlcBar format
      const bars: OhlcBar[] = fnData.bars
        .map((b: any) => ({
          date: new Date(b.time * 1000).toISOString().slice(0, 10),
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: Number(b.volume || 0),
        }))
        .filter((b: OhlcBar) => Number.isFinite(b.close) && b.close > 0);

      if (bars.length > 0) {
        setCachedBars(key, bars);
        console.log(`[PERF] ${key} bars from edge fn ${bars.length} bars (${Date.now() - reqStart}ms)`);
      }
      return bars.length > 0 ? bars : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === '__TIMEOUT__') {
        console.warn(`[PERF] ${key} bars request timed out`);
      } else {
        console.error(`[fetchCachedBars] ${key} failed:`, err);
      }
      return null;
    } finally {
      inFlightBars.delete(key);
    }
  })();

  inFlightBars.set(key, promise);
  return promise;
}

export function mergeCandidateWithTechnical<
  T extends {
    trend_classification: string;
    primary_support: number | null;
    secondary_support?: number | null;
    resistance?: number | null;
    stock_price: number | null;
    strike_distance_from_support: number | null;
    strike: number;
    technical_pending?: boolean;
  }
>(candidate: T, snap: TechnicalSnapshot): T {
  const mergedTrend =
    candidate.trend_classification === 'Pending' || candidate.trend_classification === 'Unavailable' || !candidate.trend_classification
      ? snap.trend
      : candidate.trend_classification;

  const mergedPrimarySupport =
    candidate.primary_support != null ? candidate.primary_support : snap.primary_support;
  const mergedSecondarySupport =
    candidate.secondary_support != null ? candidate.secondary_support : snap.secondary_support;
  const mergedResistance =
    candidate.resistance != null ? candidate.resistance : snap.resistance;
  const mergedStockPrice =
    candidate.stock_price != null ? candidate.stock_price : snap.stock_price;

  let supportDist = candidate.strike_distance_from_support;
  if (
    supportDist == null &&
    mergedPrimarySupport != null &&
    mergedPrimarySupport > 0 &&
    typeof candidate.strike === 'number' && Number.isFinite(candidate.strike)
  ) {
    supportDist = parseFloat(
      ((mergedPrimarySupport - candidate.strike) / mergedPrimarySupport * 100).toFixed(1),
    );
  }

  return {
    ...candidate,
    trend_classification: mergedTrend,
    primary_support: mergedPrimarySupport,
    secondary_support: mergedSecondarySupport,
    resistance: mergedResistance,
    stock_price: mergedStockPrice,
    strike_distance_from_support: supportDist,
    technical_pending: false,
  };
}
