import type { AssetKey } from "../config/assets";
import { ALLOWED_ASSETS } from "../config/assets";
import type { Greeks, SpreadDetails, Regime } from "../types/trading";
import type { SRContext } from "../utils/indicators";
import { SR_ATR_BUFFER } from "../config/constants";
import { logger } from "../utils/logger";

type Direction = "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";

/**
 * Deterministically maps direction, IV environment, DTE, and regime to a base strategy.
 * This pre-selection runs before the LLM call and serves as a guardrail suggestion.
 *
 * @param direction - Current directional bias from indicators or prior logic.
 * @param ivRank - Current IV rank in the 0–100 band.
 * @param dte - Days to expiry for the nearest options.
 * @param regime - Inferred market regime (trending, ranging, volatile).
 * @returns An object containing the chosen strategy and a human-readable reason.
 */
export function selectStrategy(
  direction: Direction,
  ivRank: number,
  dte: number,
  regime: Regime
): { strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "HOLD"; reason: string } {
  if (dte < 3) {
    return {
      strategy: "HOLD",
      reason: "DTE below 3, theta risk too high for new spreads",
    };
  }

  if (direction === "HOLD" || direction === "NEUTRAL") {
    return {
      strategy: "HOLD",
      reason: "Direction unclear, staying flat per MVP-1 rules",
    };
  }

  if (regime === "ranging") {
    return {
      strategy: "HOLD",
      reason: "Ranging regime reduces directional edge, skipping spreads",
    };
  }

  if (direction === "BULLISH") {
    return {
      strategy: "BULL_PUT_SPREAD",
      reason: `Bullish bias with IV rank ${ivRank.toFixed(
        1
      )}, preferring credit put spreads`,
    };
  }

  return {
    strategy: "BEAR_CALL_SPREAD",
    reason: `Bearish bias with IV rank ${ivRank.toFixed(
      1
    )}, preferring credit call spreads`,
  };
}

/**
 * Computes detailed spread configuration for a credit spread in index options.
 * Strike selection is based on approximate 0.30 delta OTM levels and fixed width by asset.
 *
 * When `sr` (SRContext) is provided, the sell strike is adjusted to respect key S/R levels:
 *   - BEAR_CALL_SPREAD: sell strike is pushed above strongestResistance + ATR×SR_ATR_BUFFER
 *   - BULL_PUT_SPREAD:  sell strike is pulled below strongestSupport − ATR×SR_ATR_BUFFER
 * The SR-based strike is used only when it results in a safer (further from spot) placement.
 *
 * @param spot     - Current spot price of the underlying index.
 * @param greeks   - Representative Greeks for the ATM option.
 * @param asset    - Asset key (NIFTY, BANKNIFTY, FINNIFTY).
 * @param strategy - Credit spread strategy to construct.
 * @param sr       - Optional S/R context for SR-aware strike placement.
 * @param atr      - Optional ATR used for SR-based strike buffer calculation.
 * @returns SpreadDetails describing strikes, credit, max loss, breakeven, and risk/reward.
 */
export function computeSpreadDetails(
  spot: number,
  greeks: Greeks,
  asset: AssetKey,
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD",
  sr?: SRContext,
  atr?: number
): SpreadDetails {
  const assetConfig = ALLOWED_ASSETS[asset];

  const width =
    asset === "NIFTY"
      ? 100
      : asset === "BANKNIFTY"
      ? 200
      : 50; // FINNIFTY

  const step =
    asset === "BANKNIFTY" ? 100 : asset === "FINNIFTY" ? 50 : 50;

  /** Rounds a value to the nearest strike step */
  const roundToStep = (v: number, s: number) => Math.round(v / s) * s;

  let sellStrike: number;
  let buyStrike: number;

  if (strategy === "BULL_PUT_SPREAD") {
    // Default: sell 1 width below spot
    const defaultStrike = roundToStep(spot - width, step);
    sellStrike = defaultStrike;

    // SR override: if we have a support level, move sell strike below it
    if (sr?.strongestSupport && atr && atr > 0) {
      const srBasedStrike = roundToStep(
        sr.strongestSupport - atr * SR_ATR_BUFFER,
        step
      );
      // Use whichever is further below spot (safer placement)
      sellStrike = Math.min(defaultStrike, srBasedStrike);
    }

    buyStrike = sellStrike - width;

    logger.info("Strike selection [BULL_PUT_SPREAD]", {
      defaultStrike,
      srBasedStrike: sr?.strongestSupport
        ? roundToStep(sr.strongestSupport - (atr ?? 0) * SR_ATR_BUFFER, step)
        : "n/a",
      finalSellStrike: sellStrike,
      support: sr?.strongestSupport ?? null,
    });
  } else {
    // BEAR_CALL_SPREAD default: sell 1 width above spot
    const defaultStrike = roundToStep(spot + width, step);
    sellStrike = defaultStrike;

    // SR override: if we have a resistance level, move sell strike above it
    if (sr?.strongestResistance && atr && atr > 0) {
      const srBasedStrike = roundToStep(
        sr.strongestResistance + atr * SR_ATR_BUFFER,
        step
      );
      // Use whichever is further above spot (safer placement)
      sellStrike = Math.max(defaultStrike, srBasedStrike);
    }

    buyStrike = sellStrike + width;

    logger.info("Strike selection [BEAR_CALL_SPREAD]", {
      defaultStrike,
      srBasedStrike: sr?.strongestResistance
        ? roundToStep(sr.strongestResistance + (atr ?? 0) * SR_ATR_BUFFER, step)
        : "n/a",
      finalSellStrike: sellStrike,
      resistance: sr?.strongestResistance ?? null,
    });
  }

  // Credit approximation: ~30% of width, scaled by theta (time value).
  const thetaScale = Math.min(2, Math.max(0.5, Math.abs(greeks.theta) / 0.02));
  const credit = Math.round(width * 0.3 * thetaScale);
  const maxLoss = width - credit;

  const breakeven =
    strategy === "BULL_PUT_SPREAD"
      ? sellStrike - credit
      : sellStrike + credit;

  const riskReward = maxLoss === 0 ? 0 : credit / maxLoss;

  const details: SpreadDetails = {
    strategy,
    sellStrike,
    buyStrike,
    credit,
    maxLoss,
    breakeven,
    riskReward,
  };

  return details;
}

