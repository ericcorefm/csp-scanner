// Probability calculations for option contract analysis.
// Informational only — never used to auto-reject contracts.

// Standard normal CDF (Abramowitz-Stegun approximation)
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-0.5 * x * x);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Box-Muller transform for standard normal random variable
function randomNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Black-Scholes put price
function bsPut(S: number, K: number, T: number, sigma: number, r: number): number {
  if (T <= 0) return Math.max(0, K - S);
  if (sigma <= 0) return Math.max(0, K * Math.exp(-r * T) - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
}

export interface ProbabilityInputs {
  stockPrice: number;
  strike: number;
  dte: number;
  iv: number; // percentage, e.g. 85 means 85%
  suggestedSto: number;
  suggestedBtc: number;
  maxCycleDays: number;
}

export interface ProbabilityResult {
  expirationPop: number | null; // 0..1
  btcTargetProb: number | null; // 0..1
  evaluationDays: number | null;
}

function hasValidInputs(p: ProbabilityInputs): boolean {
  return (
    p.stockPrice > 0 &&
    p.strike > 0 &&
    p.dte > 0 &&
    p.iv > 0 &&
    p.suggestedSto > 0 &&
    p.suggestedBtc > 0 &&
    p.suggestedBtc < p.suggestedSto &&
    p.maxCycleDays > 0
  );
}

/**
 * Expiration POP: probability the short put expires worthless (stock > strike at expiration).
 * Uses Black-Scholes d2 with risk-free rate assumed 0.
 */
function calcExpirationPop(p: ProbabilityInputs): number {
  const T = p.dte / 365;
  const sigma = p.iv / 100;
  const d2 =
    (Math.log(p.stockPrice / p.strike) + (0 - 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));
  return normalCdf(d2);
}

/**
 * BTC Target Probability: probability the put premium reaches the BTC target
 * at least once within evaluationDays = min(maxCycleDays, dte).
 *
 * Monte Carlo simulation: simulate stock paths via GBM, price the put at each
 * daily step via Black-Scholes, and check if the put price drops to or below
 * the BTC target.
 */
function calcBtcTargetProb(p: ProbabilityInputs, evaluationDays: number): number {
  const sigma = p.iv / 100;
  const r = 0;
  const dt = 1 / 365;
  const steps = evaluationDays;
  const paths = 3000;
  const S0 = p.stockPrice;
  const K = p.strike;
  const btc = p.suggestedBtc;
  const totalDte = p.dte;

  let hits = 0;

  for (let path = 0; path < paths; path++) {
    let S = S0;
    let hit = false;
    for (let step = 1; step <= steps && !hit; step++) {
      const z = randomNormal();
      S = S * Math.exp((r - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
      const remainingT = Math.max(0, (totalDte - step) / 365);
      const putPrice = bsPut(S, K, remainingT, sigma, r);
      if (putPrice <= btc) {
        hit = true;
        break;
      }
    }
    if (hit) hits++;
  }

  return hits / paths;
}

export function calcProbabilities(inputs: ProbabilityInputs): ProbabilityResult {
  if (!hasValidInputs(inputs)) {
    return { expirationPop: null, btcTargetProb: null, evaluationDays: null };
  }

  const evaluationDays = Math.min(inputs.maxCycleDays, inputs.dte);

  const expirationPop = calcExpirationPop(inputs);
  const btcTargetProb = calcBtcTargetProb(inputs, evaluationDays);

  return { expirationPop, btcTargetProb, evaluationDays };
}
