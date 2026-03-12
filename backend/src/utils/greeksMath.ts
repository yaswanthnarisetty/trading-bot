/**
 * Pure Black-Scholes mathematics for options Greeks.
 * These helpers are deterministic, side-effect free, and never involve any LLM logic.
 *
 * Black-Scholes inputs:
 *   S = current spot price
 *   K = strike price
 *   T = time to expiry in years (DTE / 365)
 *   r = risk-free rate as decimal (e.g. 0.065 for 6.5%)
 *   sigma = implied volatility as decimal (e.g. 0.15 for 15%)
 *
 * All formulas are standard Black-Scholes-Merton (1973).
 */

const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

/**
 * Computes the standard normal probability density function (PDF) at x.
 * This is used as the building block for gamma, vega, and theta calculations.
 *
 * @param x - The point on the real line for which to evaluate the PDF.
 * @returns The value of the standard normal PDF at x.
 */
export function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_TWO_PI;
}

/**
 * Approximates the standard normal cumulative distribution function (CDF) at x.
 * Uses the Abramowitz & Stegun (1964) approximation, which is accurate enough for trading Greeks.
 *
 * @param x - The point on the real line for which to evaluate the CDF.
 * @returns The probability that a standard normal variable is less than or equal to x.
 */
export function normalCDF(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);

  // Abramowitz and Stegun formula 7.1.26
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absX);
  const erfApprox =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t *
      Math.exp(-absX * absX));

  const result = 0.5 * (1 + sign * erfApprox);
  return result;
}

/**
 * Computes the Black-Scholes d1 term.
 * This term combines moneyness, volatility, and time to expiry into a single statistic.
 *
 * @param S - Current spot price of the underlying.
 * @param K - Option strike price.
 * @param T - Time to expiry in years.
 * @param r - Risk-free interest rate as a decimal.
 * @param sigma - Implied volatility as a decimal.
 * @returns The d1 value used in Black-Scholes Greeks.
 */
export function computeD1(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): number {
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
    return 0;
  }

  const numerator = Math.log(S / K) + (r + 0.5 * sigma * sigma) * T;
  const denominator = sigma * Math.sqrt(T);
  return numerator / denominator;
}

/**
 * Computes the Black-Scholes d2 term from d1.
 * This is a simple shift of d1 by one volatility standard deviation.
 *
 * @param d1 - The pre-computed d1 term.
 * @param sigma - Implied volatility as a decimal.
 * @param T - Time to expiry in years.
 * @returns The d2 value used in Black-Scholes Greeks.
 */
export function computeD2(d1: number, sigma: number, T: number): number {
  if (T <= 0 || sigma <= 0) {
    return d1;
  }
  return d1 - sigma * Math.sqrt(T);
}

/**
 * Computes the Black-Scholes delta for a call or put option.
 * Delta measures the sensitivity of option price to a small change in the underlying.
 *
 * @param d1 - The d1 term from Black-Scholes.
 * @param optionType - "CALL" for call options, "PUT" for put options.
 * @returns Delta in the range [0,1] for calls and [-1,0] for puts.
 */
export function computeDelta(
  d1: number,
  optionType: "CALL" | "PUT"
): number {
  if (optionType === "CALL") {
    return normalCDF(d1);
  }
  return normalCDF(d1) - 1;
}

/**
 * Computes the Black-Scholes gamma.
 * Gamma measures the curvature of the option price with respect to the underlying price.
 *
 * @param d1 - The d1 term from Black-Scholes.
 * @param S - Current spot price of the underlying.
 * @param sigma - Implied volatility as a decimal.
 * @param T - Time to expiry in years.
 * @returns Gamma, which is always non-negative for vanilla options.
 */
export function computeGamma(
  d1: number,
  S: number,
  sigma: number,
  T: number
): number {
  if (S <= 0 || sigma <= 0 || T <= 0) {
    return 0;
  }
  return normalPDF(d1) / (S * sigma * Math.sqrt(T));
}

/**
 * Computes the Black-Scholes theta expressed on a per-day basis.
 * Theta measures time decay of option value as expiry approaches.
 *
 * @param S - Current spot price of the underlying.
 * @param K - Option strike price.
 * @param T - Time to expiry in years.
 * @param r - Risk-free interest rate as a decimal.
 * @param sigma - Implied volatility as a decimal.
 * @param d1 - The d1 term from Black-Scholes.
 * @param d2 - The d2 term from Black-Scholes.
 * @param optionType - "CALL" for call options, "PUT" for put options.
 * @returns Theta per day (annual theta divided by 365).
 */
export function computeTheta(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  d1: number,
  d2: number,
  optionType: "CALL" | "PUT"
): number {
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
    return 0;
  }

  const firstTerm = (-S * normalPDF(d1) * sigma) / (2 * Math.sqrt(T));

  const discountedStrike = K * Math.exp(-r * T);
  let secondTerm: number;

  if (optionType === "CALL") {
    secondTerm = -r * discountedStrike * normalCDF(d2);
  } else {
    secondTerm = r * discountedStrike * normalCDF(-d2);
  }

  const thetaAnnual = firstTerm + secondTerm;
  return thetaAnnual / 365;
}

/**
 * Computes the Black-Scholes vega, scaled per 1% change in implied volatility.
 * Vega measures sensitivity of option price to volatility changes.
 *
 * @param S - Current spot price of the underlying.
 * @param d1 - The d1 term from Black-Scholes.
 * @param T - Time to expiry in years.
 * @returns Vega per 1% IV move.
 */
export function computeVega(S: number, d1: number, T: number): number {
  if (S <= 0 || T <= 0) {
    return 0;
  }

  const vegaAnnual = S * normalPDF(d1) * Math.sqrt(T);
  return vegaAnnual / 100;
}

/**
 * Computes IV rank as a percentile within a 52-week high/low range.
 * IV rank answers: where does the current IV sit within its yearly band?
 *
 * @param currentIV - Current implied volatility as a decimal.
 * @param yearlyHighIV - 52-week highest implied volatility as a decimal.
 * @param yearlyLowIV - 52-week lowest implied volatility as a decimal.
 * @returns IV rank in the range [0, 100].
 */
export function computeIVRank(
  currentIV: number,
  yearlyHighIV: number,
  yearlyLowIV: number
): number {
  if (yearlyHighIV <= yearlyLowIV) {
    return 0;
  }
  const clampedIV = Math.max(
    yearlyLowIV,
    Math.min(yearlyHighIV, currentIV)
  );
  const rank =
    ((clampedIV - yearlyLowIV) / (yearlyHighIV - yearlyLowIV)) * 100;
  return Math.max(0, Math.min(100, rank));
}

/**
 * Computes the one standard deviation expected move in price over a given DTE.
 * This uses the classic options heuristic: S * IV * sqrt(DTE / 365).
 *
 * @param spot - Current spot price of the underlying.
 * @param iv - Implied volatility as a decimal.
 * @param dte - Days to expiry.
 * @returns An object with expected move up and down from spot.
 */
export function computeExpectedMove(
  spot: number,
  iv: number,
  dte: number
): { up: number; down: number } {
  if (spot <= 0 || iv <= 0 || dte <= 0) {
    return { up: spot, down: spot };
  }
  const move = spot * iv * Math.sqrt(dte / 365);
  return {
    up: spot + move,
    down: spot - move,
  };
}

