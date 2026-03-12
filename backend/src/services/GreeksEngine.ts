import type { AssetKey } from "../config/assets";
import { ALLOWED_ASSETS } from "../config/assets";
import {
  greeksSnapshotSchema,
  type GreeksSnapshot,
} from "@trading-bot/shared";
import type { OptionChainData, Greeks } from "../types/trading";
import {
  computeD1,
  computeD2,
  computeDelta,
  computeGamma,
  computeTheta,
  computeVega,
  computeIVRank,
  computeExpectedMove,
} from "../utils/greeksMath";
import { getDTE } from "../utils/marketHours";
import { RISK_FREE_RATE } from "../config/constants";

/**
 * Finds the strike price closest to the current spot level.
 * This is used to identify the ATM option for Greeks snapshot computation.
 *
 * @param spot - Current spot price of the underlying.
 * @param strikes - Array of available strike prices.
 * @returns The strike price with minimal distance to spot.
 */
export function findATMStrike(
  spot: number,
  strikes: number[]
): number {
  if (strikes.length === 0) {
    return spot;
  }
  return strikes.reduce((closest, s) =>
    Math.abs(s - spot) < Math.abs(closest - spot) ? s : closest
  );
}

/**
 * Computes core Black-Scholes Greeks for a single option leg.
 * Greeks are returned independently for use in higher-level aggregations.
 *
 * @param spot - Current spot price.
 * @param strike - Option strike price.
 * @param dte - Days to expiry.
 * @param iv - Implied volatility as a decimal.
 * @param optionType - "CALL" or "PUT" to indicate option side.
 * @returns A Greeks object containing delta, gamma, theta, and vega.
 */
export function computeGreeksForStrike(
  spot: number,
  strike: number,
  dte: number,
  iv: number,
  optionType: "CALL" | "PUT"
): Greeks {
  // Clamp T to a 1-hour minimum so Black-Scholes stays well-defined on expiry day.
  // Without this, T=0 causes sqrt(T) → 0 in the denominator → NaN → all Greeks show 0.
  const T = Math.max(dte / 365, 1 / (365 * 24));
  const sigma = iv;
  const r = RISK_FREE_RATE;

  const d1 = computeD1(spot, strike, T, r, sigma);
  const d2 = computeD2(d1, sigma, T);

  const delta = computeDelta(d1, optionType);
  const gamma = computeGamma(d1, spot, sigma, T);
  const theta = computeTheta(spot, strike, T, r, sigma, d1, d2, optionType);
  const vega = computeVega(spot, d1, T);

  return { delta, gamma, theta, vega };
}

/**
 * Computes IV rank for an asset given current IV and hardcoded yearly ranges.
 * This approximation is sufficient for MVP-1 and can be refined with live history later.
 *
 * @param currentIV - Current implied volatility as a decimal.
 * @param asset - Asset key for which the IV band is defined.
 * @returns IV rank between 0 and 100.
 */
export function computeIVRankFromChain(
  currentIV: number,
  asset: AssetKey
): number {
  let low = 0.1;
  let high = 0.3;

  if (asset === "BANKNIFTY") {
    low = 0.12;
    high = 0.35;
  } else if (asset === "FINNIFTY") {
    low = 0.11;
    high = 0.3;
  }

  return computeIVRank(currentIV, high, low);
}

/**
 * Computes a full GreeksSnapshot for the ATM strike using option chain data.
 * This snapshot gives the LLM a concise but rich view of current options pricing.
 *
 * @param optionChain - Normalized option chain for the asset.
 * @param spot - Current spot price of the underlying.
 * @returns A validated GreeksSnapshot instance.
 */
export function computeGreeksSnapshot(
  optionChain: OptionChainData,
  spot: number
): GreeksSnapshot {
  const strikes = optionChain.strikes.map((s) => s.strike);
  const atmStrike = findATMStrike(spot, strikes);
  const atm = optionChain.strikes.find((s) => s.strike === atmStrike);

  if (!atm) {
    // Fallback to a neutral snapshot if no strikes are available.
    return greeksSnapshotSchema.parse({
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      currentIV: 0,
      ivRank: 0,
      ivPercentile: 0,
      ivTrend: "stable",
      pcr: optionChain.pcr,
      maxPain: spot,
      oiSkew: "neutral",
      nearWeekIV: 0,
      nextWeekIV: 0,
      expectedMoveUp: spot,
      expectedMoveDown: spot,
    });
  }

  const dte = getDTE(optionChain.underlying);

  const atmIv = (atm.ce.iv + atm.pe.iv) / 2;

  const callGreeks = computeGreeksForStrike(
    spot,
    atmStrike,
    dte,
    atmIv,
    "CALL"
  );

  const ivRank = computeIVRankFromChain(atmIv, optionChain.underlying);

  // Approximate IV percentile and trend from current IV rank
  const ivPercentile = ivRank;
  const ivTrend =
    ivRank > 60 ? "expanding" : ivRank < 40 ? "contracting" : "stable";

  const totalPutOi = optionChain.strikes.reduce(
    (sum, s) => sum + s.pe.oi,
    0
  );
  const totalCallOi = optionChain.strikes.reduce(
    (sum, s) => sum + s.ce.oi,
    0
  );

  const oiSkew =
    totalCallOi === 0 || totalPutOi === 0
      ? "neutral"
      : totalPutOi / totalCallOi > 1.1
      ? "puts_heavy"
      : totalCallOi / totalPutOi > 1.1
      ? "calls_heavy"
      : "neutral";

  // Max pain approximation: strike with highest combined OI
  const maxPainStrike = optionChain.strikes.reduce((best, s) => {
    const bestOi = best.ce.oi + best.pe.oi;
    const currOi = s.ce.oi + s.pe.oi;
    return currOi > bestOi ? s : best;
  }, optionChain.strikes[0]!).strike;

  const { up: expectedMoveUp, down: expectedMoveDown } = computeExpectedMove(
    spot,
    atmIv,
    Math.max(1, dte)
  );

  const snapshot: GreeksSnapshot = greeksSnapshotSchema.parse({
    delta: callGreeks.delta,
    gamma: callGreeks.gamma,
    theta: callGreeks.theta,
    vega: callGreeks.vega,
    currentIV: atmIv,
    ivRank,
    ivPercentile,
    ivTrend,
    pcr: optionChain.pcr,
    maxPain: maxPainStrike,
    oiSkew,
    nearWeekIV: atmIv,
    nextWeekIV: atmIv, // MVP-1 approximation, refined with real term structure later
    expectedMoveUp,
    expectedMoveDown,
  });

  return snapshot;
}

