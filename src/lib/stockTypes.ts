/**
 * Stock Scanner types ("Pullback in an Uptrend" + 30-day recycling metrics).
 * DEFAULT_STOCK_RULES must stay in sync with the edge function
 * (supabase/functions/market-scan/index.ts → DEFAULT_STOCK_RULES).
 * No commission; fractional shares, so returns are % of capital.
 */
export interface StockRules {
  liquidity_enabled: boolean;
  min_price: number | null;
  max_price: number | null;
  min_avg_volume: number | null;
  min_dollar_volume_m: number | null;

  trend_enabled: boolean;
  require_price_above_ma200: boolean;
  require_ma200_rising: boolean;
  ma200_slope_lookback: number;
  require_ma50_above_ma200: boolean;

  momentum_enabled: boolean;
  rsi_min: number | null;
  rsi_max: number | null;

  support_enabled: boolean;
  support_dist_min: number | null;
  support_dist_max: number | null;

  extension_enabled: boolean;
  max_above_ma50: number | null;
  max_above_ma200: number | null;

  strength_enabled: boolean;
  max_from_52w_high: number | null;
  require_outperform_spy: boolean;

  volatility_enabled: boolean;
  hv_min: number | null;
  hv_max: number | null;

  trade_enabled: boolean;
  target_return_pct: number;
  max_cycle_days: number;
  stop_buffer_pct: number;
  min_reward_risk: number | null;
  min_prob_target: number | null;
  min_pop: number | null;
  position_size: number;
}

export const DEFAULT_STOCK_RULES: StockRules = {
  liquidity_enabled: true, min_price: 5, max_price: null, min_avg_volume: 1_000_000, min_dollar_volume_m: 20,
  trend_enabled: true, require_price_above_ma200: true, require_ma200_rising: true, ma200_slope_lookback: 20, require_ma50_above_ma200: true,
  momentum_enabled: true, rsi_min: 40, rsi_max: 65,
  support_enabled: true, support_dist_min: 0, support_dist_max: 5,
  extension_enabled: true, max_above_ma50: 10, max_above_ma200: 30,
  strength_enabled: true, max_from_52w_high: 25, require_outperform_spy: true,
  volatility_enabled: true, hv_min: 25, hv_max: 60,
  trade_enabled: true, target_return_pct: 4, max_cycle_days: 30, stop_buffer_pct: 2,
  min_reward_risk: 1, min_prob_target: 50, min_pop: 60,
  position_size: 1000,
};

export interface StockProfile {
  id: string;
  name: string;
  is_default: boolean;
  rules: StockRules;
  created_at?: string;
  updated_at?: string;
}

export type StockStatus = 'qualified' | 'pending' | 'rejected';
export type StockScanMode = 'discovery' | 'universe';

export interface StockResult {
  ticker: string;
  company_name: string;
  status: StockStatus;
  qualified: boolean;
  technical_pending: boolean;
  rejection_reasons: string[];
  pending_reasons: string[];
  pass_fail: { rule: string; pass: boolean; status: 'pass' | 'fail' | 'not_evaluated' }[];
  history_bars: number;
  history_note: string | null;
  price: number | null;
  day_change_pct: number | null;
  rsi: number | null;
  ma20: number | null;
  ma50: number | null;
  ma200: number | null;
  ma200_rising: boolean | null;
  above_ma50_pct: number | null;
  above_ma200_pct: number | null;
  support: number | null;
  dist_to_support_pct: number | null;
  from_52w_high_pct: number | null;
  return_3m_pct: number | null;
  rs_vs_spy_pct: number | null;
  avg_volume: number | null;
  dollar_volume_m: number | null;
  hv_pct: number | null;
  target_price: number | null;
  stop_price: number | null;
  target_pct: number;
  risk_pct: number | null;
  reward_risk: number | null;
  prob_target_pct: number | null;
  prob_stop_pct: number | null;
  pop_pct: number | null;
  hist_hit_rate_pct: number | null;
  est_days: number | null;
  expected_return_pct: number | null;
  expected_cycle_days: number | null;
  replay_samples: number | null;
  annualized_if_hit_pct: number | null;
  expected_annualized_pct: number | null;
  position_size: number;
  profit_at_target: number | null;
  shares: number | null;
}

export interface StockScanCounts {
  stocks_screened: number;
  qualified: number;
  pending: number;
  rejected: number;
  required_bars: number;
  history_fetched_this_scan: number;
  still_pending_history: number;
  history_rate_limited: boolean;
  warming_time_budget_hit: boolean;
  latest_trading_date: string;
  spy_bars: number;
  rejection_breakdown: Record<string, number>;
  pending_breakdown: Record<string, number>;
  elapsed_ms: number;
}
