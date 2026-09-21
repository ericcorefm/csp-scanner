import type {
  MarketDataStock,
  OhlcBar,
  OptionContract,
  FundamentalSnapshot,
  StrategyProfile,
  CandidateScan,
  RejectionReason,
  TechnicalSnapshot,
} from '@/types';
import {
  calcSpreadMidpoint,
  calcSpreadPct,
  classifyVolume,
  calcBreakeven,
  calcNetProfit,
  calcCroiFromCollateral,
  calcPremiumCapture,
  calcStrikeDistanceFromStock,
  calcStrikeDistanceFromSupport,
  calcBtcOptimization,
} from '@/lib/calculations';
import {
  sma,
  ema,
  calcRSI,
  calcMACD,
  calcBollingerBands,
  findSwingLows,
  findResistance,
  calcPivotLevels,
  analyzeVolumeTrend,
  classifyTrend,
  calcPrimarySupport,
  calcSecondarySupport,
} from '@/lib/indicators';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function generateOhlcv(basePrice: number, trend: 'up' | 'down' | 'sideways', days = 250): OhlcBar[] {
  const bars: OhlcBar[] = [];
  const rand = seededRandom(basePrice * 1000);
  let price = basePrice * 0.85;
  const now = new Date();

  for (let i = days; i > 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    let drift = 0;
    if (trend === 'up') drift = 0.0015;
    else if (trend === 'down') drift = -0.0012;
    else drift = 0.0001;

    const noise = (rand() - 0.5) * 0.04;
    price = price * (1 + drift + noise);
    const open = price * (1 + (rand() - 0.5) * 0.01);
    const close = price;
    const high = Math.max(open, close) * (1 + rand() * 0.015);
    const low = Math.min(open, close) * (1 - rand() * 0.015);
    const volume = Math.floor(rand() * 5000000) + 500000;
    bars.push({ date: date.toISOString().split('T')[0], open, high, low, close, volume });
  }

  const lastBar = bars[bars.length - 1];
  if (lastBar) lastBar.close = basePrice;

  return bars;
}

interface StockDef {
  ticker: string;
  company_name: string;
  price: number;
  trend: 'up' | 'down' | 'sideways';
  sector: string;
  strikes: number[];
  iv: number;
  delta: number;
  supportsPenny: boolean;
  revenue: number;
  revenueGrowth: number;
  profitability: string;
  cash: number;
  debt: number;
  cashFlow: string;
  liquidity: string;
  outlook: string;
  developments: string;
  risks: string;
  shortInterest: number;
}

const STOCKS: StockDef[] = [
  {
    ticker: 'F', company_name: 'Ford Motor Co', price: 11.85, trend: 'sideways', sector: 'Auto',
    strikes: [11, 11.5, 12], iv: 38, delta: -0.35, supportsPenny: false,
    revenue: 164e9, revenueGrowth: 3.5, profitability: 'Moderate', cash: 25e9, debt: 95e9,
    cashFlow: 'Positive operating', liquidity: 'Adequate', outlook: 'Stable',
    developments: 'EV transition progressing; hybrid sales strong',
    risks: 'Cyclical demand, legacy debt, EV competition', shortInterest: 4.2,
  },
  {
    ticker: 'BAC', company_name: 'Bank of America', price: 38.50, trend: 'up', sector: 'Banking',
    strikes: [37, 37.5, 38], iv: 28, delta: -0.32, supportsPenny: false,
    revenue: 98e9, revenueGrowth: 6.2, profitability: 'Strong', cash: 380e9, debt: 120e9,
    cashFlow: 'Strong operating', liquidity: 'Excellent', outlook: 'Positive',
    developments: 'Net interest income expanding; cost controls effective',
    risks: 'Credit losses, rate sensitivity, regulatory', shortInterest: 1.8,
  },
  {
    ticker: 'CSCO', company_name: 'Cisco Systems', price: 49.20, trend: 'up', sector: 'Tech',
    strikes: [47, 48, 48.5], iv: 24, delta: -0.30, supportsPenny: false,
    revenue: 53e9, revenueGrowth: 1.5, profitability: 'Strong', cash: 16e9, debt: 8e9,
    cashFlow: 'Strong free cash flow', liquidity: 'Excellent', outlook: 'Stable',
    developments: 'AI networking demand; Splunk integration on track',
    risks: 'Competition, integration risk, slowdown', shortInterest: 2.1,
  },
  {
    ticker: 'WFC', company_name: 'Wells Fargo', price: 58.40, trend: 'up', sector: 'Banking',
    strikes: [55, 57, 57.5], iv: 31, delta: -0.33, supportsPenny: false,
    revenue: 86e9, revenueGrowth: 5.8, profitability: 'Strong', cash: 350e9, debt: 90e9,
    cashFlow: 'Strong operating', liquidity: 'Excellent', outlook: 'Positive',
    developments: 'Asset cap removal progress; efficiency gains',
    risks: 'Regulatory, credit cycle, commercial real estate', shortInterest: 1.5,
  },
  {
    ticker: 'GOLD', company_name: 'Barrick Gold', price: 21.30, trend: 'sideways', sector: 'Mining',
    strikes: [20, 20.5, 21], iv: 42, delta: -0.38, supportsPenny: false,
    revenue: 11.7e9, revenueGrowth: 8.5, profitability: 'Improving', cash: 4.5e9, debt: 4.2e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Positive',
    developments: 'Gold prices elevated; new mine ramp-up',
    risks: 'Commodity price risk, geopolitical, operational', shortInterest: 3.8,
  },
  {
    ticker: 'KGC', company_name: 'Kinross Gold', price: 15.80, trend: 'up', sector: 'Mining',
    strikes: [14, 15, 15.5], iv: 45, delta: -0.36, supportsPenny: true,
    revenue: 4.8e9, revenueGrowth: 12.3, profitability: 'Strong', cash: 1.8e9, debt: 2.1e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Positive',
    developments: 'Production growth; cost discipline improving',
    risks: 'Gold price, operational, jurisdictional', shortInterest: 2.5,
  },
  {
    ticker: 'NOK', company_name: 'Nokia Oyj', price: 4.95, trend: 'sideways', sector: 'Telecom',
    strikes: [4, 4.5, 5], iv: 35, delta: -0.34, supportsPenny: true,
    revenue: 22.2e9, revenueGrowth: 2.1, profitability: 'Moderate', cash: 6.5e9, debt: 4.2e9,
    cashFlow: 'Positive', liquidity: 'Good', outlook: 'Stable',
    developments: '5G deployment; licensing revenue stable',
    risks: 'Competition, capex pressure, macro', shortInterest: 5.5,
  },
  {
    ticker: 'T', company_name: 'AT&T Inc', price: 22.15, trend: 'up', sector: 'Telecom',
    strikes: [21, 21.5, 22], iv: 26, delta: -0.31, supportsPenny: false,
    revenue: 122e9, revenueGrowth: 1.2, profitability: 'Strong', cash: 8e9, debt: 135e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Stable',
    developments: 'Debt reduction on track; subscriber growth continues',
    risks: 'High leverage, competitive, regulatory', shortInterest: 4.1,
  },
  {
    ticker: 'VZ', company_name: 'Verizon Comm', price: 43.70, trend: 'sideways', sector: 'Telecom',
    strikes: [42, 42.5, 43], iv: 25, delta: -0.30, supportsPenny: false,
    revenue: 134e9, revenueGrowth: 0.8, profitability: 'Strong', cash: 7.5e9, debt: 170e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Stable',
    developments: '5G buildout; fixed wireless gaining traction',
    risks: 'High leverage, competitive, capex', shortInterest: 2.8,
  },
  {
    ticker: 'PBR', company_name: 'Petrobras', price: 18.40, trend: 'sideways', sector: 'Energy',
    strikes: [17, 17.5, 18], iv: 40, delta: -0.37, supportsPenny: false,
    revenue: 102e9, revenueGrowth: -2.5, profitability: 'Strong', cash: 15e9, debt: 28e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Stable',
    developments: 'Dividend policy maintained; production stable',
    risks: 'Oil price, political, FX', shortInterest: 3.2,
  },
  {
    ticker: 'RIG', company_name: 'Transocean', price: 7.85, trend: 'down', sector: 'Energy',
    strikes: [7, 7.5, 8], iv: 55, delta: -0.40, supportsPenny: true,
    revenue: 3.2e9, revenueGrowth: -8.5, profitability: 'Weak', cash: 1.5e9, debt: 6.8e9,
    cashFlow: 'Negative FCF', liquidity: 'Tight', outlook: 'Challenged',
    developments: 'Offshore market slow; contract backlog declining',
    risks: 'High debt, offshore cycle, operational', shortInterest: 12.5,
  },
  {
    ticker: 'AAL', company_name: 'American Airlines', price: 13.20, trend: 'down', sector: 'Travel',
    strikes: [12, 12.5, 13], iv: 48, delta: -0.38, supportsPenny: false,
    revenue: 52e9, revenueGrowth: 4.2, profitability: 'Marginal', cash: 12e9, debt: 35e9,
    cashFlow: 'Positive', liquidity: 'Adequate', outlook: 'Cautious',
    developments: 'Travel demand softening; cost pressures',
    risks: 'Fuel costs, leverage, labor, demand', shortInterest: 8.5,
  },
  {
    ticker: 'NEM', company_name: 'Newmont Corp', price: 41.50, trend: 'up', sector: 'Mining',
    strikes: [39, 40, 40.5], iv: 38, delta: -0.33, supportsPenny: false,
    revenue: 17.8e9, revenueGrowth: 15.2, profitability: 'Improving', cash: 6e9, debt: 7.5e9,
    cashFlow: 'Strong FCF', liquidity: 'Excellent', outlook: 'Positive',
    developments: 'Gold production guidance raised; synergies from acquisitions',
    risks: 'Gold price, operational, geopolitical', shortInterest: 2.3,
  },
  {
    ticker: 'SBLK', company_name: 'Star Bulk Carriers', price: 24.80, trend: 'sideways', sector: 'Shipping',
    strikes: [22, 23, 24], iv: 52, delta: -0.39, supportsPenny: true,
    revenue: 1.15e9, revenueGrowth: -5.2, profitability: 'Strong', cash: 350e6, debt: 1.4e9,
    cashFlow: 'Strong FCF', liquidity: 'Good', outlook: 'Variable',
    developments: 'Dividend maintained; fleet modernization',
    risks: 'Dry bulk cycle, BDI volatility, rates', shortInterest: 6.8,
  },
  {
    ticker: 'UGP', company_name: 'Ultrapar Participacoes', price: 6.45, trend: 'sideways', sector: 'Energy',
    strikes: [5, 5.5, 6], iv: 44, delta: -0.36, supportsPenny: true,
    revenue: 24e9, revenueGrowth: 3.1, profitability: 'Moderate', cash: 800e6, debt: 2.1e9,
    cashFlow: 'Positive', liquidity: 'Adequate', outlook: 'Stable',
    developments: 'Divestiture progress; specialty chemicals growth',
    risks: 'FX, Brazilian macro, fuel margins', shortInterest: 4.5,
  },
];

function generateOptionContracts(stock: StockDef): OptionContract[] {
  const contracts: OptionContract[] = [];
  const today = new Date();

  const expirations = [
    { days: 30, dte: 30 },
    { days: 45, dte: 45 },
    { days: 60, dte: 60 },
  ];

  for (const exp of expirations) {
    const expDate = new Date(today);
    expDate.setDate(expDate.getDate() + exp.days);
    const expStr = expDate.toISOString().split('T')[0];

    for (const strike of stock.strikes) {
      const otmPct = (stock.price - strike) / stock.price;
      const basePremium = stock.price * (stock.iv / 100) * Math.sqrt(exp.dte / 365) * 0.4;
      const premium = Math.max(0.05, basePremium * (1 + otmPct * 1.5));
      const spreadWidth = Math.max(0.01, premium * 0.08);
      const bid = Math.max(0.01, premium - spreadWidth / 2);
      const ask = premium + spreadWidth / 2;
      const mid = calcSpreadMidpoint(bid, ask);
      const spreadPct = calcSpreadPct(bid, ask);
      const volume = Math.floor(Math.abs(Math.sin(strike * 100 + exp.dte)) * 300) + 5;
      const oi = Math.floor(Math.abs(Math.cos(strike * 100 + exp.dte)) * 3000) + 200;

      contracts.push({
        ticker: stock.ticker,
        company_name: stock.company_name,
        stock_price: stock.price,
        strike,
        expiration: expStr,
        dte: exp.dte,
        bid: parseFloat(bid.toFixed(2)),
        ask: parseFloat(ask.toFixed(2)),
        mid: parseFloat(mid.toFixed(2)),
        spread_pct: parseFloat(spreadPct.toFixed(1)),
        iv: stock.iv,
        delta: parseFloat(stock.delta.toFixed(2)),
        volume,
        open_interest: oi,
        volume_classification: classifyVolume(volume),
        option_type: 'PUT',
        supports_penny: stock.supportsPenny,
      });
    }
  }

  return contracts;
}

export function getMarketDataStocks(): MarketDataStock[] {
  return STOCKS.map((s) => ({
    ticker: s.ticker,
    company_name: s.company_name,
    stock_price: s.price,
    sector: s.sector,
    ohlcv: generateOhlcv(s.price, s.trend),
  }));
}

export function getAllOptionContracts(): OptionContract[] {
  return STOCKS.flatMap(generateOptionContracts);
}

export function getTechnicalSnapshot(ticker: string): TechnicalSnapshot | null {
  const stock = STOCKS.find((s) => s.ticker === ticker);
  if (!stock) return null;

  const bars = generateOhlcv(stock.price, stock.trend);
  const closes = bars.map((b) => b.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, Math.min(200, closes.length));
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const swingLows = findSwingLows(bars);
  const resistance = findResistance(bars);
  const pivots = calcPivotLevels(bars);
  const volTrend = analyzeVolumeTrend(bars);
  const trend = classifyTrend(closes, ma20, ma50, ma200, rsi, macd.histogram);

  const primarySupport = calcPrimarySupport(swingLows, ma200, pivots, stock.price);
  const secondarySupport = calcSecondarySupport(swingLows, ma200, pivots, primarySupport);

  return {
    ticker,
    stock_price: stock.price,
    ma20: parseFloat(ma20.toFixed(2)),
    ma50: parseFloat(ma50.toFixed(2)),
    ma200: parseFloat(ma200.toFixed(2)),
    rsi: parseFloat(rsi.toFixed(1)),
    macd_line: parseFloat(macd.macdLine.toFixed(3)),
    macd_signal: parseFloat(macd.signalLine.toFixed(3)),
    macd_histogram: parseFloat(macd.histogram.toFixed(3)),
    bb_upper: parseFloat(bb.upper.toFixed(2)),
    bb_middle: parseFloat(bb.middle.toFixed(2)),
    bb_lower: parseFloat(bb.lower.toFixed(2)),
    volume_trend: volTrend,
    trend_classification: trend,
    primary_support: parseFloat(primarySupport.toFixed(2)),
    secondary_support: parseFloat(secondarySupport.toFixed(2)),
    resistance: parseFloat(resistance.toFixed(2)),
    swing_lows: swingLows,
    price_touches: swingLows,
    pivot_levels: pivots,
  };
}

export function getFundamentalSnapshot(ticker: string): FundamentalSnapshot | null {
  const stock = STOCKS.find((s) => s.ticker === ticker);
  if (!stock) return null;
  return {
    ticker,
    company_name: stock.company_name,
    revenue: stock.revenue,
    revenue_growth_pct: stock.revenueGrowth,
    profitability: stock.profitability,
    cash_balance: stock.cash,
    debt: stock.debt,
    cash_flow: stock.cashFlow,
    liquidity: stock.liquidity,
    outlook: stock.outlook,
    recent_developments: stock.developments,
    risk_factors: stock.risks,
    short_interest_pct: stock.shortInterest,
  };
}

export function getStockDef(ticker: string): StockDef | undefined {
  return STOCKS.find((s) => s.ticker === ticker);
}

export function scanCandidates(
  profile: StrategyProfile,
  openTickers: string[],
): CandidateScan[] {
  const contracts = getAllOptionContracts();
  const results: CandidateScan[] = [];

  for (const contract of contracts) {
    const tech = getTechnicalSnapshot(contract.ticker);
    if (!tech) continue;

    const reasons: RejectionReason[] = [];

    if (profile.exclude_existing_positions && openTickers.includes(contract.ticker)) {
      reasons.push('Existing position');
    }

    if (contract.strike > profile.max_strike) {
      reasons.push('Strike too high');
    }

    const sto = contract.mid;
    const contracts_ = 1;
    const { best } = calcBtcOptimization(sto, contract.strike, contracts_, profile, contract.supports_penny);
    const btc = best ? best.btc_price : 0.01;

    const netProfit = calcNetProfit(sto, btc, contracts_, profile.round_trip_commission);
    const netCroi = calcCroiFromCollateral(netProfit, contract.strike, contracts_);
    const pc = calcPremiumCapture(sto, btc);
    const breakeven = calcBreakeven(contract.strike, sto);

    if (netCroi < profile.min_net_croi) {
      reasons.push('CROI too low');
    }

    if (pc > profile.max_premium_capture) {
      reasons.push('PC too high');
    }

    if (contract.spread_pct > profile.max_spread_pct) {
      reasons.push('Spread too wide');
    }

    if (contract.open_interest < profile.min_target_oi) {
      reasons.push('OI too low');
    }

    if (contract.volume < 10) {
      reasons.push('Insufficient liquidity');
    }

    const fund = getFundamentalSnapshot(contract.ticker);
    if (fund && fund.short_interest_pct >= profile.short_interest_exclusion) {
      reasons.push('Short interest warning');
    }

    if (profile.exclude_downtrend_no_support && tech.trend_classification === 'Downtrend') {
      if (contract.strike < tech.primary_support) {
        // strike is below support, might still be acceptable
      } else {
        reasons.push('Downtrend without support');
      }
    }

    const qualified = reasons.length === 0;

    results.push({
      scan_date: new Date().toISOString().split('T')[0],
      ticker: contract.ticker,
      company_name: contract.company_name,
      stock_price: contract.stock_price,
      strike: contract.strike,
      expiration: contract.expiration,
      dte: contract.dte,
      bid: contract.bid,
      ask: contract.ask,
      mid: contract.mid,
      spread_pct: contract.spread_pct,
      iv: contract.iv,
      delta: contract.delta,
      volume: contract.volume,
      open_interest: contract.open_interest,
      volume_classification: contract.volume_classification,
      trend_classification: tech.trend_classification,
      primary_support: tech.primary_support,
      suggested_sto: parseFloat(sto.toFixed(2)),
      suggested_btc: parseFloat(btc.toFixed(2)),
      net_profit: parseFloat(netProfit.toFixed(2)),
      net_croi: parseFloat(netCroi.toFixed(2)),
      premium_capture: parseFloat(pc.toFixed(1)),
      breakeven: parseFloat(breakeven.toFixed(2)),
      qualified,
      rejection_reasons: reasons as string[],
      strategy_profile_id: profile.id,
      strike_distance_from_stock: parseFloat(calcStrikeDistanceFromStock(contract.strike, contract.stock_price).toFixed(1)),
      strike_distance_from_support: parseFloat(calcStrikeDistanceFromSupport(contract.strike, tech.primary_support).toFixed(1)),
    });
  }

  return results.sort((a, b) => b.net_croi - a.net_croi);
}
