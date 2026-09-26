import type {
  StrategyProfile,
  BtcTarget,
  PositionStatus,
} from '@/types';

export function calcCollateral(strike: number, contracts: number): number {
  return strike * 100 * contracts;
}

export function calcGrossPremium(stoPremium: number, contracts: number): number {
  return stoPremium * 100 * contracts;
}

export function calcGrossCapturedProfit(
  stoPrice: number,
  btcPrice: number,
  contracts: number,
): number {
  return (stoPrice - btcPrice) * 100 * contracts;
}

export function calcNetProfit(
  stoPrice: number,
  btcPrice: number,
  contracts: number,
  roundTripCommission: number,
): number {
  const gross = calcGrossCapturedProfit(stoPrice, btcPrice, contracts);
  return gross - roundTripCommission;
}

export function calcNetCroi(
  stoPrice: number,
  btcPrice: number,
  strike: number,
  contracts: number,
  roundTripCommission: number,
): number {
  const netProfit = calcNetProfit(stoPrice, btcPrice, contracts, roundTripCommission);
  const collateral = calcCollateral(strike, contracts);
  return collateral > 0 ? (netProfit / collateral) * 100 : 0;
}

export function calcCroiFromCollateral(
  netProfit: number,
  strike: number,
  contracts: number,
): number {
  const collateral = calcCollateral(strike, contracts);
  return collateral > 0 ? (netProfit / collateral) * 100 : 0;
}

export function calcPremiumCapture(stoPrice: number, btcPrice: number): number {
  if (stoPrice <= 0) return 0;
  return ((stoPrice - btcPrice) / stoPrice) * 100;
}

export function calcBreakeven(strike: number, stoPremium: number): number {
  return strike - stoPremium;
}

export function calcSpreadMidpoint(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

export function calcSpreadPct(bid: number, ask: number): number {
  const mid = calcSpreadMidpoint(bid, ask);
  if (mid <= 0) return 0;
  return ((ask - bid) / mid) * 100;
}

export function classifyVolume(volume: number): string {
  if (volume >= 250) return 'Excellent';
  if (volume >= 100) return 'Very Good';
  if (volume >= 50) return 'Good';
  if (volume >= 25) return 'Meaningful';
  if (volume >= 10) return 'Thin';
  return 'Very Thin';
}

export function annualizedReturn(netCroi: number, daysInTrade: number): number {
  if (daysInTrade <= 0) return 0;
  return netCroi * (365 / daysInTrade);
}

export function calcBtcOptimization(
  stoPrice: number,
  strike: number,
  contracts: number,
  profile: StrategyProfile,
  supportsPenny: boolean,
): { best: BtcTarget | null; table: BtcTarget[] } {
  const increment = supportsPenny && profile.allow_penny_increments ? 0.01 : profile.btc_increment;
  const table: BtcTarget[] = [];

  const minCroi = profile.min_net_croi;
  const maxPc = profile.max_premium_capture;

  let best: BtcTarget | null = null;

  const steps: number[] = [];
  let price = 0.01;
  while (price < stoPrice) {
    steps.push(parseFloat(price.toFixed(2)));
    price += increment;
  }

  for (const btcPrice of steps) {
    const netProfit = calcNetProfit(stoPrice, btcPrice, contracts, profile.round_trip_commission);
    const netCroi = calcCroiFromCollateral(netProfit, strike, contracts);
    const pc = calcPremiumCapture(stoPrice, btcPrice);

    let status: BtcTarget['status'] = 'qualifies';
    if (netCroi < minCroi) status = 'below_croi';
    if (pc > maxPc) status = 'above_pc';
    if (btcPrice >= stoPrice) status = 'no_exit';

    const entry: BtcTarget = {
      btc_price: btcPrice,
      net_profit: parseFloat(netProfit.toFixed(2)),
      net_croi: parseFloat(netCroi.toFixed(2)),
      premium_capture: parseFloat(pc.toFixed(1)),
      status,
      is_best: false,
    };

    if (status === 'qualifies') {
      if (!best || btcPrice > best.btc_price) {
        best = entry;
      }
    }

    table.push(entry);
  }

  if (best) best.is_best = true;

  const filtered = table.filter((t) => t.status === 'qualifies' || table.indexOf(t) % 3 === 0 || t.is_best);
  if (filtered.length < 12) {
    return { best, table: table.length > 30 ? table.slice(0, 50) : table };
  }

  return { best, table };
}

export function calcPositionStatus(
  currentMid: number,
  btcTarget: number,
  daysOpen: number,
  maxRecycleDays: number,
  trendClassification: string,
  stockPrice: number,
  primarySupport: number,
): PositionStatus {
  const threshold = btcTarget * 1.15;
  const nearThreshold = btcTarget * 1.30;

  if (daysOpen >= maxRecycleDays) return 'Cycle Review';
  if (trendClassification === 'Downtrend') return 'Trend Warning';
  if (stockPrice < primarySupport * 0.98) return 'Support Warning';
  if (currentMid <= btcTarget) return 'BTC Ready';
  if (currentMid <= threshold) return 'Near BTC Target';
  if (currentMid <= nearThreshold) return 'Near BTC Target';
  return 'Waiting';
}


export function formatLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function calcDaysToReview(openDate: string, maxRecycleDays: number): number {
  const open = new Date(openDate);
  const now = new Date();
  const elapsed = Math.floor((now.getTime() - open.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, maxRecycleDays - elapsed);
}

export function calcDaysOpen(openDate: string): number {
  const open = new Date(openDate);
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - open.getTime()) / (1000 * 60 * 60 * 24)));
}

export function calcRecycleDate(openDate: string, maxRecycleDays: number): string {
  const open = new Date(openDate);
  open.setDate(open.getDate() + maxRecycleDays);
  return open.toISOString().split('T')[0];
}

export function calcStrikeDistanceFromStock(strike: number, stockPrice: number): number {
  if (stockPrice <= 0) return 0;
  // Previously returned a string ("12.3") disguised as a number.
  return Number((((stockPrice - strike) / stockPrice) * 100).toFixed(1));
}

export function calcStrikeDistanceFromSupport(strike: number, support: number): number {
  if (support <= 0) return 0;
  return Number((((support - strike) / support) * 100).toFixed(1));
}
