import type { AnalyzeTickerResponse, TechnicalData } from '@/lib/liveMarketData';
import { analyzeTicker } from '@/lib/liveMarketData';

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
      const resp = await analyzeTicker(key, profile);
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
      setCachedTechnical(snap);
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
