export interface StrategyProfile {
  id: string;
  name: string;
  is_default: boolean;
  order_type: string;
  max_strike: number;
  min_net_croi: number;
  preferred_croi_max: number;
  max_premium_capture: number;
  max_recycle_days: number;
  min_target_oi: number;
  preferred_daily_volume: number;
  preferred_spread_pct: number;
  max_spread_pct: number;
  rsi_min: number;
  rsi_max: number;
  require_ma20_above_ma50: boolean;
  require_ma50_above_ma200: boolean;
  require_price_above_ma200: boolean;
  short_interest_warning: number;
  short_interest_exclusion: number;
  round_trip_commission: number;
  btc_increment: number;
  allow_penny_increments: boolean;
  exclude_existing_positions: boolean;
  exclude_downtrend_no_support: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface OptionContract {
  id?: string;
  ticker: string;
  company_name: string;
  stock_price: number;
  strike: number;
  expiration: string;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  spread_pct: number;
  iv: number;
  delta: number;
  volume: number;
  open_interest: number;
  volume_classification: string;
  option_type: string;
  supports_penny: boolean;
}

export interface TechnicalSnapshot {
  id?: string;
  ticker: string;
  stock_price: number;
  ma20: number;
  ma50: number;
  ma200: number;
  rsi: number;
  macd_line: number;
  macd_signal: number;
  macd_histogram: number;
  bb_upper: number;
  bb_middle: number;
  bb_lower: number;
  volume_trend: string;
  trend_classification: TrendClassification;
  primary_support: number;
  secondary_support: number;
  resistance: number;
  swing_lows: number[];
  price_touches: number[];
  pivot_levels: number[];
}

export interface FundamentalSnapshot {
  id?: string;
  ticker: string;
  company_name: string;
  revenue: number;
  revenue_growth_pct: number;
  profitability: string;
  cash_balance: number;
  debt: number;
  cash_flow: string;
  liquidity: string;
  outlook: string;
  recent_developments: string;
  risk_factors: string;
  short_interest_pct: number;
}

export type TrendClassification =
  | 'Bullish'
  | 'Rebound'
  | 'Improving'
  | 'Sideways'
  | 'Stabilizing'
  | 'Downtrend';

export type RejectionReason =
  | 'CROI too low'
  | 'PC too high'
  | 'Spread too wide'
  | 'OI too low'
  | 'Strike too high'
  | 'Downtrend without support'
  | 'Existing position'
  | 'Short interest warning'
  | 'Insufficient liquidity';

export interface CandidateScan {
  id?: string;
  scan_date: string;
  ticker: string;
  company_name: string;
  stock_price: number;
  strike: number;
  expiration: string;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  spread_pct: number;
  iv: number;
  delta: number;
  volume: number;
  open_interest: number;
  volume_classification: string;
  trend_classification: string;
  primary_support: number;
  suggested_sto: number;
  suggested_btc: number;
  net_profit: number;
  net_croi: number;
  premium_capture: number;
  breakeven: number;
  qualified: boolean;
  rejection_reasons: string[];
  strategy_profile_id?: string;
  strike_distance_from_stock: number;
  strike_distance_from_support: number;
}

export interface OpenPosition {
  id?: string;
  ticker: string;
  company_name: string;
  strike: number;
  expiration: string;
  contracts: number;
  open_date: string;
  actual_sto: number;
  current_bid: number;
  current_ask: number;
  current_mid: number;
  btc_target: number;
  net_target_profit: number;
  net_croi: number;
  premium_capture: number;
  collateral: number;
  breakeven: number;
  stock_price: number;
  trend_classification: string;
  primary_support: number;
  support_status: string;
  position_status: PositionStatus;
  days_open: number;
  days_to_review: number;
  strategy_profile_id?: string;
}

export type PositionStatus =
  | 'Waiting'
  | 'Near BTC Target'
  | 'BTC Ready'
  | 'Support Warning'
  | 'Trend Warning'
  | '120-Day Review';

export interface ClosedPosition {
  id?: string;
  ticker: string;
  company_name: string;
  strike: number;
  contracts: number;
  sto_price: number;
  btc_price: number;
  net_profit: number;
  net_croi: number;
  premium_capture: number;
  days_in_trade: number;
  annualized_return: number;
  open_date: string;
  close_date: string;
  notes?: string;
}

export interface DailyScanResult {
  id?: string;
  scan_date: string;
  qualified_count: number;
  new_count: number;
  removed_tickers: string[];
  near_btc_count: number;
  near_120_day_count: number;
  support_breaks: string[];
  trend_changes: string[];
}

export interface Alert {
  id?: string;
  alert_type: string;
  ticker?: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  read: boolean;
  created_at?: string;
}

export interface BtcTarget {
  btc_price: number;
  net_profit: number;
  net_croi: number;
  premium_capture: number;
  status: 'qualifies' | 'below_croi' | 'above_pc' | 'no_exit';
  is_best: boolean;
}

export interface MarketDataStock {
  ticker: string;
  company_name: string;
  stock_price: number;
  sector: string;
  ohlcv: OhlcBar[];
}

export interface OhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
