import { indicatorSnapshotSchema, type IndicatorSnapshot } from "@trading-bot/shared";
import type { OHLCV, OHLCVData, Regime } from "../types/trading";

// Minimum candle counts for each indicator to produce meaningful values
const ATR_MIN_CANDLES = 15; // 14 TR values needed — 14+1 candles
const EMA20_MIN_CANDLES = 20;
const EMA50_MIN_CANDLES = 50;

/**
 * Computes Wilder's Relative Strength Index (RSI) from a series of closing prices.
 * Returns 50 (neutral) when there is insufficient history.
 *
 * @param closes - Array of closing prices in chronological order.
 * @param period - Lookback period for RSI calculation, defaults to 14.
 * @returns The latest RSI value for the given series.
 */
export function computeRSI(closes: number[], period = 14): number {
  if (closes.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Math.max(0, Math.min(100, rsi));
}

/**
 * Computes the Exponential Moving Average (EMA) for a series of closing prices.
 * Returns null when there are fewer candles than the period — signals warmup state.
 * The caller should display "warming up" rather than using 0 or last-close as a fake value.
 *
 * @param closes - Array of closing prices in chronological order.
 * @param period - Lookback period for EMA calculation.
 * @returns The latest EMA value, or null if insufficient data.
 */
export function computeEMA(closes: number[], period: number): number | null {
  if (closes.length === 0) {
    return null;
  }
  if (closes.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let ema = closes[0]!;

  for (let i = 1; i < closes.length; i += 1) {
    ema = closes[i]! * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Computes the Average True Range (ATR) using Wilder's smoothing method.
 * Returns null when there are fewer candles than the period + 1 — signals warmup state.
 * ATR(14) requires at least 15 candles to produce a meaningful first value.
 *
 * @param ohlcv - Array of OHLCV candles in chronological order.
 * @param period - Lookback period for ATR calculation, defaults to 14.
 * @returns The latest ATR value, or null if insufficient data.
 */
export function computeATR(ohlcv: OHLCVData, period = 14): number | null {
  if (ohlcv.length < ATR_MIN_CANDLES) {
    return null;
  }

  const trs: number[] = [];
  for (let i = 1; i < ohlcv.length; i += 1) {
    const curr = ohlcv[i]!;
    const prevClose = ohlcv[i - 1]!.close;
    const highLow = curr.high - curr.low;
    const highClose = Math.abs(curr.high - prevClose);
    const lowClose = Math.abs(curr.low - prevClose);
    trs.push(Math.max(highLow, highClose, lowClose));
  }

  if (trs.length < period) {
    return null;
  }

  let atr = 0;
  for (let i = 0; i < period; i += 1) {
    atr += trs[i]!;
  }
  atr /= period;

  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }

  return atr;
}

/**
 * Computes the volume ratio between current volume and recent history.
 * A value greater than 1 indicates volume above its recent average.
 *
 * @param currentVolume - The latest traded volume.
 * @param volumeHistory - Array of historical volumes (ideally last 20 periods).
 * @returns The ratio currentVolume / averageHistory, or 1 if history is empty.
 */
export function computeVolumeRatio(
  currentVolume: number,
  volumeHistory: number[]
): number {
  if (volumeHistory.length === 0) {
    return 1;
  }
  const avg =
    volumeHistory.reduce((sum, v) => sum + v, 0) / volumeHistory.length;
  if (avg === 0) {
    return 1;
  }
  return currentVolume / avg;
}

/**
 * Detects the current market regime (trending, ranging, volatile, or INSUFFICIENT_DATA).
 * Returns INSUFFICIENT_DATA when EMA values are not yet available (warmup period).
 * When ATR is null, falls back to EMA-distance-only regime detection.
 *
 * @param closes - Array of closing prices in chronological order.
 * @param ema20 - Latest 20-period EMA, or null during warmup.
 * @param ema50 - Latest 50-period EMA, or null during warmup.
 * @param atr - Latest Average True Range, or null during warmup.
 * @returns The inferred Regime.
 */
export function detectRegime(
  closes: number[],
  ema20: number | null,
  ema50: number | null,
  atr: number | null
): Regime {
  if (ema20 === null || ema50 === null) {
    return "INSUFFICIENT_DATA";
  }

  if (closes.length === 0) {
    return "ranging";
  }

  const last = closes[closes.length - 1]!;
  if (last <= 0) {
    return "ranging";
  }

  const emaDiff = Math.abs(ema20 - ema50);

  // If ATR is not ready yet, use EMA distance only (no volatility fraction)
  if (atr === null || atr === 0) {
    return emaDiff > last * 0.003 ? "trending" : "ranging";
  }

  const volFraction = atr / last;

  if (volFraction > 0.015) {
    return "volatile";
  }

  if (emaDiff > atr * 0.5 && (last > ema20 || last < ema20)) {
    return "trending";
  }

  return "ranging";
}

/**
 * Runs the full deterministic indicator stack from raw OHLCV candles.
 * Fields that require more candles than available are set to null (warmup state).
 * The returned snapshot includes candleCount for warmup UI display.
 *
 * @param ohlcv - Array of OHLCV candles in chronological order.
 * @returns A fully validated IndicatorSnapshot ready for downstream use and LLM input.
 */
export function computeAll(ohlcv: OHLCVData): IndicatorSnapshot {
  const candleCount = ohlcv.length;

  if (ohlcv.length === 0) {
    return indicatorSnapshotSchema.parse({
      rsi: 50,
      ema20: null,
      ema50: null,
      atr: null,
      volumeRatio: 1,
      regime: "INSUFFICIENT_DATA",
      priceVsEma20: "unknown",
      priceVsEma50: "unknown",
      emaAlignment: "mixed",
      candleCount: 0,
      rsiSlope: null,
      candleMomentum: "NEUTRAL",
    });
  }

  const closes = ohlcv.map((c) => c.close);
  const volumes = ohlcv.map((c) => c.volume);
  const lastClose = closes[closes.length - 1]!;
  const currentVolume = volumes[volumes.length - 1]!;

  const ema20 = candleCount >= EMA20_MIN_CANDLES ? computeEMA(closes, 20) : null;
  const ema50 = candleCount >= EMA50_MIN_CANDLES ? computeEMA(closes, 50) : null;
  const atr = candleCount >= ATR_MIN_CANDLES ? computeATR(ohlcv, 14) : null;

  const volumeRatio = computeVolumeRatio(
    currentVolume,
    volumes.slice(-20)
  );
  const regime = detectRegime(closes, ema20, ema50, atr);

  const priceVsEma20 =
    ema20 === null ? "unknown" : lastClose >= ema20 ? "above" : "below";
  const priceVsEma50 =
    ema50 === null ? "unknown" : lastClose >= ema50 ? "above" : "below";

  const emaAlignment =
    ema20 !== null && ema50 !== null
      ? ema20 > ema50 ? "bullish" : ema20 < ema50 ? "bearish" : "mixed"
      : "mixed";

  const rsi = computeRSI(closes, 14);

  // RSI slope: change over last 3 bars. Null if insufficient history.
  const RSI_SLOPE_BARS = 3;
  let rsiSlope: number | null = null;
  if (closes.length > 14 + RSI_SLOPE_BARS) {
    const rsiPrev = computeRSI(closes.slice(0, -RSI_SLOPE_BARS), 14);
    rsiSlope = parseFloat((rsi - rsiPrev).toFixed(2));
  }

  // Candle momentum: 3-bar directional pattern
  let candleMomentum: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  const last3 = ohlcv.slice(-3);
  if (last3.length === 3) {
    const allRed   = last3.every((c) => c.close < c.open);
    const allGreen = last3.every((c) => c.close > c.open);
    const allLowerClose = last3.every((c) => {
      const range = c.high - c.low;
      return range > 0 && (c.close - c.low) / range < 0.30;
    });
    const allUpperClose = last3.every((c) => {
      const range = c.high - c.low;
      return range > 0 && (c.close - c.low) / range > 0.70;
    });
    if (allRed   && allLowerClose) candleMomentum = "BEARISH";
    else if (allGreen && allUpperClose) candleMomentum = "BULLISH";
  }

  return indicatorSnapshotSchema.parse({
    rsi,
    ema20,
    ema50,
    atr,
    volumeRatio,
    regime,
    priceVsEma20,
    priceVsEma50,
    emaAlignment,
    candleCount,
    rsiSlope,
    candleMomentum,
  });
}
