import type { OHLCV } from "../types/trading";
import { logger } from "./logger";
import {
  BREAKOUT_ATR_MULTIPLIER,
  BREAKOUT_VOLUME_RATIO,
  BREAKOUT_EXPIRY_CANDLES,
} from "../config/constants";

/**
 * Candle alias — identical to OHLCV but named Candle to match S/R function signatures.
 */
export type Candle = OHLCV;

// ─── Swing Level Detection ────────────────────────────────────────────────────

/**
 * Detects swing highs and swing lows in an OHLCV series using a 2-bar lookback
 * on each side (total: 5-bar pivot window).
 *
 * A Swing High has its high strictly greater than both 2 preceding and 2 following bars.
 * A Swing Low has its low strictly less than both 2 preceding and 2 following bars.
 *
 * @param candles - OHLCV candles in chronological order.
 * @returns Detected swing levels and the nearest resistance/support relative to the last close.
 */
export function calculateSwingLevels(candles: OHLCV[]): {
  swingHighs: number[];
  swingLows: number[];
  nearestResistance: number | null;
  nearestSupport: number | null;
} {
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  const lookback = 2; // bars each side

  for (let i = lookback; i < candles.length - lookback; i++) {
    const curr = candles[i]!;

    // Swing High: strictly higher than 2 candles each side
    const isSwingHigh =
      candles[i - 2]!.high < curr.high &&
      candles[i - 1]!.high < curr.high &&
      candles[i + 1]!.high < curr.high &&
      candles[i + 2]!.high < curr.high;

    if (isSwingHigh) swingHighs.push(curr.high);

    // Swing Low: strictly lower than 2 candles each side
    const isSwingLow =
      candles[i - 2]!.low > curr.low &&
      candles[i - 1]!.low > curr.low &&
      candles[i + 1]!.low > curr.low &&
      candles[i + 2]!.low > curr.low;

    if (isSwingLow) swingLows.push(curr.low);
  }

  const spot = candles[candles.length - 1]!.close;

  // Nearest resistance = lowest swing high above spot
  const resistancesAbove = swingHighs.filter((h) => h > spot);
  const nearestResistance =
    resistancesAbove.length > 0 ? Math.min(...resistancesAbove) : null;

  // Nearest support = highest swing low below spot
  const supportsBelow = swingLows.filter((l) => l < spot);
  const nearestSupport =
    supportsBelow.length > 0 ? Math.max(...supportsBelow) : null;

  return { swingHighs, swingLows, nearestResistance, nearestSupport };
}

// ─── S/R Context ─────────────────────────────────────────────────────────────

/**
 * Full Support & Resistance context for a single tick.
 * Aggregates PDH/PDL, swing levels, and option-chain OI walls.
 */
export interface SRContext {
  // Previous day levels
  pdHigh: number | null;
  pdLow: number | null;
  pdClose: number | null;

  // Swing levels (from recent price history)
  nearestResistance: number | null;
  nearestSupport: number | null;

  // Option chain levels (OI walls)
  maxCallOIStrike: number | null; // acts as resistance
  maxPutOIStrike: number | null;  // acts as support

  // Derived: closest S/R from all sources
  strongestResistance: number | null;
  strongestSupport: number | null;

  // Range metrics
  rangeWidth: number | null;        // strongestResistance − strongestSupport
  spotToResistance: number | null;  // pts from spot to nearest resistance
  spotToSupport: number | null;     // pts from spot to nearest support

  // True when spot is within 1 ATR of any key level
  isNearKeyLevel: boolean;
}

/**
 * Builds a complete SRContext by merging three S/R sources:
 *   1. Previous day OHLC (PDH / PDL)
 *   2. Swing high/low levels from recent 5-min history
 *   3. Option-chain OI walls (maxCallOIStrike / maxPutOIStrike)
 *
 * The "strongest" level is the one closest to the current spot —
 * that is, the tightest nearby resistance (lowest above) and tightest support (highest below).
 *
 * @param spot        - Current underlying index price.
 * @param pdOHLC      - Previous day OHLC or null (mock / unavailable).
 * @param swingLevels - Output of calculateSwingLevels().
 * @param optionChain - Object with maxCallOIStrike and maxPutOIStrike, or null.
 * @param atr         - Current ATR(14). Used for isNearKeyLevel check.
 * @returns Fully populated SRContext.
 */
export function buildSRContext(
  spot: number,
  pdOHLC: { pdHigh: number; pdLow: number; pdClose: number; pdOpen: number } | null,
  swingLevels: { nearestResistance: number | null; nearestSupport: number | null },
  optionChain: { maxCallOIStrike?: number | null; maxPutOIStrike?: number | null } | null,
  atr: number
): SRContext {
  // Collect all resistance candidates (above spot)
  const allResistances: number[] = [
    pdOHLC?.pdHigh,
    swingLevels.nearestResistance,
    optionChain?.maxCallOIStrike,
  ].filter((v): v is number => typeof v === "number" && v > spot);

  // Collect all support candidates (below spot)
  const allSupports: number[] = [
    pdOHLC?.pdLow,
    swingLevels.nearestSupport,
    optionChain?.maxPutOIStrike,
  ].filter((v): v is number => typeof v === "number" && v < spot);

  // Strongest = closest to spot
  const strongestResistance =
    allResistances.length > 0 ? Math.min(...allResistances) : null;
  const strongestSupport =
    allSupports.length > 0 ? Math.max(...allSupports) : null;

  const spotToResistance =
    strongestResistance !== null ? strongestResistance - spot : null;
  const spotToSupport =
    strongestSupport !== null ? spot - strongestSupport : null;

  const rangeWidth =
    strongestResistance !== null && strongestSupport !== null
      ? strongestResistance - strongestSupport
      : null;

  // Near key level = within 1 ATR of any resistance or support
  const isNearKeyLevel =
    atr > 0 &&
    ((spotToResistance !== null && spotToResistance < atr) ||
      (spotToSupport !== null && spotToSupport < atr));

  const ctx: SRContext = {
    pdHigh: pdOHLC?.pdHigh ?? null,
    pdLow: pdOHLC?.pdLow ?? null,
    pdClose: pdOHLC?.pdClose ?? null,
    nearestResistance: swingLevels.nearestResistance,
    nearestSupport: swingLevels.nearestSupport,
    maxCallOIStrike: optionChain?.maxCallOIStrike ?? null,
    maxPutOIStrike: optionChain?.maxPutOIStrike ?? null,
    strongestResistance,
    strongestSupport,
    rangeWidth,
    spotToResistance,
    spotToSupport,
    isNearKeyLevel,
  };

  logger.debug("buildSRContext", {
    spot,
    strongestResistance,
    strongestSupport,
    rangeWidth,
    spotToResistance,
    spotToSupport,
    isNearKeyLevel,
  });

  return ctx;
}

// ─── Breakout Detection ───────────────────────────────────────────────────────

export type BreakoutState =
  | "BULLISH_BREAKOUT"
  | "BEARISH_BREAKDOWN"
  | "NONE";

export interface BreakoutResult {
  state: BreakoutState;
  /** The S/R level that was violated. null when state is NONE. */
  breakLevel: number | null;
  /** Points the close extended beyond the level. null when state is NONE. */
  breachSize: number | null;
  /** Candles ago the break occurred (0 = current candle). null when state is NONE. */
  candlesSinceBreak: number | null;
}

/**
 * Scans the last BREAKOUT_EXPIRY_CANDLES bars for a volume-confirmed S/R breakout.
 *
 * A breakout qualifies only when:
 *   1. The candle's close is beyond a key S/R level from srContext.
 *   2. The breach size >= atr × BREAKOUT_ATR_MULTIPLIER pts.
 *   3. The candle's volume >= the 20-bar average volume × BREAKOUT_VOLUME_RATIO.
 *
 * Returns the most recent qualifying breakout or NONE.
 *
 * @param candles   - OHLCV history in chronological order (at least 21 bars).
 * @param srContext - Current tick S/R context with strongestResistance / strongestSupport.
 * @param atr       - Current ATR(14). Pass 0 to skip ATR size check.
 * @returns BreakoutResult describing the active breakout or NONE.
 */
export function detectBreakout(
  candles: Candle[],
  srContext: SRContext,
  atr: number
): BreakoutResult {
  const NONE: BreakoutResult = {
    state: "NONE",
    breakLevel: null,
    breachSize: null,
    candlesSinceBreak: null,
  };

  // Need at least 21 bars: 20 for volume average + 1 to scan
  if (candles.length < 21) return NONE;
  // If no key levels exist yet, there is nothing to break
  if (srContext.strongestResistance === null && srContext.strongestSupport === null) {
    return NONE;
  }

  const minMove = atr > 0 ? atr * BREAKOUT_ATR_MULTIPLIER : 0;

  // 20-bar average volume from candles immediately before the scan window.
  // Using a fixed window anchored to the most recent 20 bars (excluding the
  // current candle) is an acceptable approximation given the 6-bar scan range.
  const avgVolWindow = candles.slice(-21, -1); // candles[n-21] to candles[n-2]
  const avgVolume =
    avgVolWindow.reduce((sum, c) => sum + c.volume, 0) / avgVolWindow.length;

  const scanLen = candles.length;
  const scanStart = Math.max(0, scanLen - BREAKOUT_EXPIRY_CANDLES);

  // Scan newest → oldest; return on first qualifying breakout
  for (let i = scanLen - 1; i >= scanStart; i--) {
    const c = candles[i]!;
    const candlesSinceBreak = scanLen - 1 - i;

    // Volume filter — must exceed threshold to confirm participation
    const volRatio = avgVolume > 0 ? c.volume / avgVolume : 0;
    if (volRatio < BREAKOUT_VOLUME_RATIO) continue;

    // Bullish breakout: close above strongest resistance
    if (srContext.strongestResistance !== null) {
      const breach = c.close - srContext.strongestResistance;
      if (breach >= minMove) {
        return {
          state: "BULLISH_BREAKOUT",
          breakLevel: srContext.strongestResistance,
          breachSize: breach,
          candlesSinceBreak,
        };
      }
    }

    // Bearish breakdown: close below strongest support
    if (srContext.strongestSupport !== null) {
      const breach = srContext.strongestSupport - c.close;
      if (breach >= minMove) {
        return {
          state: "BEARISH_BREAKDOWN",
          breakLevel: srContext.strongestSupport,
          breachSize: breach,
          candlesSinceBreak,
        };
      }
    }
  }

  return NONE;
}
