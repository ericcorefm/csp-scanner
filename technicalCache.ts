import type { AnalyzeTickerResponse, TechnicalData } from '@/lib/liveMarketData';
import { analyzeTicker } from '@/lib/liveMarketData';
import type { CandidateScan } from '@/types';

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
// Populated by both scan (discovery/universe) and analyze modes.
// Any page can read from this cache to avoid re-fetching prices.
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

const STALE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, TechnicalSnapshot>();
const pending = new Map<string, Promise<TechnicalSnapshot | null>>();

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

export function populateFromAnalyzeResponse(resp: AnalyzeTickerResponse): void {
  setCachedStockPrice(resp.ticker, resp.stock_price, resp.stock_source || 'analyze');

  // Do not cache a "Pending / all-null" technical response for 6 hours.
  // That previously made Candidate Detail keep showing Unavailable even after
  // the provider could return history on a later request.
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

export async function fetchTechnicalSnapshot(
  ticker: string,
  profile: import('@/types').StrategyProfile,
): Promise<TechnicalSnapshot | null> {
  const key = ticker.toUpperCase().trim();
  const cached = getCachedTechnical(key);
  if (cached) return cached;

  const existing = pending.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const knownPrice = getCachedStockPrice(key)?.price ?? null;
      const resp = await analyzeTicker(key, profile, knownPrice);
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
      return snap;
    } catch (err) {
      console.error(`[fetchTechnicalSnapshot] ${key} failed:`, err);
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
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
  if (supportDist == null && mergedPrimarySupport != null && mergedPrimarySupport > 0) {
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
