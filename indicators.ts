import type { OhlcBar, TrendClassification } from '@/types';

export function sma(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let emaPrev = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
  }
  return emaPrev;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(closes: number[]): {
  macdLine: number;
  signalLine: number;
  histogram: number;
} {
  if (closes.length < 35) {
    return { macdLine: 0, signalLine: 0, histogram: 0 };
  }
  const k = 2 / (9 + 1);
  const ema12Arr: number[] = [];
  const ema26Arr: number[] = [];
  let e12 = sma(closes.slice(0, 12), 12);
  let e26 = sma(closes.slice(0, 26), 26);
  for (let i = 12; i < closes.length; i++) {
    e12 = closes[i] * (2 / 13) + e12 * (1 - 2 / 13);
    ema12Arr.push(e12);
  }
  for (let i = 26; i < closes.length; i++) {
    e26 = closes[i] * (2 / 27) + e26 * (1 - 2 / 27);
    ema26Arr.push(e26);
  }
  const macdArr = ema12Arr.slice(-ema26Arr.length).map((v, i) => v - ema26Arr[i]);
  let signal = macdArr.length >= 9 ? sma(macdArr.slice(0, 9), 9) : macdArr[0] || 0;
  for (let i = 9; i < macdArr.length; i++) {
    signal = macdArr[i] * k + signal * (1 - k);
  }
  const macdLine = macdArr[macdArr.length - 1] || 0;
  const histogram = macdLine - signal;
  return { macdLine, signalLine: signal, histogram };
}

export function calcBollingerBands(closes: number[], period = 20, stdDev = 2): {
  upper: number;
  middle: number;
  lower: number;
} {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mid + stdDev * sd,
    middle: mid,
    lower: mid - stdDev * sd,
  };
}

export function findSwingLows(bars: OhlcBar[], lookback = 20): number[] {
  const lows: number[] = [];
  for (let i = 2; i < Math.min(bars.length, lookback + 2); i++) {
    const bar = bars[bars.length - 1 - i + 2];
    const prev = bars[bars.length - 1 - i + 1];
    const next = bars[bars.length - 1 - i + 3];
    if (bar && prev && next && bar.low < prev.low && bar.low < next.low) {
      lows.push(bar.low);
    }
  }
  return lows.sort((a, b) => a - b);
}

export function findResistance(bars: OhlcBar[], lookback = 50): number {
  let max = 0;
  const slice = bars.slice(-lookback);
  for (const bar of slice) {
    if (bar.high > max) max = bar.high;
  }
  return max;
}

export function calcPivotLevels(bars: OhlcBar[]): number[] {
  if (bars.length < 3) return [];
  const recent = bars.slice(-5);
  const high = Math.max(...recent.map((b) => b.high));
  const low = Math.min(...recent.map((b) => b.low));
  const close = recent[recent.length - 1].close;
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);
  return [s2, s1, pivot, r1, r2].filter((v) => v > 0);
}

export function analyzeVolumeTrend(bars: OhlcBar[], lookback = 20): string {
  if (bars.length < lookback) return 'Insufficient data';
  const slice = bars.slice(-lookback);
  const firstHalf = slice.slice(0, lookback / 2);
  const secondHalf = slice.slice(lookback / 2);
  const avgFirst = firstHalf.reduce((a, b) => a + b.volume, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b.volume, 0) / secondHalf.length;
  const ratio = avgSecond / avgFirst;
  if (ratio > 1.3) return 'Increasing';
  if (ratio < 0.7) return 'Decreasing';
  return 'Stable';
}

export function classifyTrend(
  closes: number[],
  ma20: number,
  ma50: number,
  ma200: number,
  rsi: number,
  macdHistogram: number,
): TrendClassification {
  const currentPrice = closes[closes.length - 1] || 0;
  const prevPrice = closes[closes.length - 5] || currentPrice;
  const priceChange = (currentPrice - prevPrice) / prevPrice;

  if (ma20 > ma50 && ma50 > ma200 && currentPrice > ma20 && macdHistogram > 0) {
    return 'Bullish';
  }
  if (currentPrice > ma20 && rsi > 45 && macdHistogram > 0 && priceChange > 0.02) {
    return 'Rebound';
  }
  if (macdHistogram > 0 && rsi > 45 && currentPrice > ma50) {
    return 'Improving';
  }
  if (Math.abs(priceChange) < 0.03 && Math.abs(currentPrice - ma20) / ma20 < 0.05) {
    return 'Sideways';
  }
  if (currentPrice > ma200 && rsi > 40 && macdHistogram > -0.1) {
    return 'Stabilizing';
  }
  if (currentPrice < ma50 && currentPrice < ma200 && rsi < 40) {
    return 'Downtrend';
  }
  return 'Sideways';
}

export function calcPrimarySupport(swingLows: number[], ma200: number, pivotLevels: number[], currentPrice: number): number {
  const candidates = [...swingLows, ...pivotLevels, ma200].filter((v) => v > 0 && v < currentPrice);
  if (candidates.length === 0) return currentPrice * 0.9;
  return Math.max(...candidates);
}

export function calcSecondarySupport(swingLows: number[], ma200: number, pivotLevels: number[], primarySupport: number): number {
  const candidates = [...swingLows, ...pivotLevels, ma200].filter((v) => v > 0 && v < primarySupport);
  if (candidates.length === 0) return primarySupport * 0.95;
  return Math.max(...candidates);
}
