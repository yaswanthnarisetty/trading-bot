import type { IndicatorSnapshot } from "@trading-bot/shared";
import { computeAll } from "../services/IndicatorService";
import type { HistoricalInterval } from "../services/KiteMarketDataService";
import { freeze, marketTimestamp } from "./kiteMarketData";

/** Prices remain integer paise at the analytics boundary. No candle is inferred. */
export interface AnalyticsCandle {
  readonly timestamp: string;
  readonly openMinor: number;
  readonly highMinor: number;
  readonly lowMinor: number;
  readonly closeMinor: number;
  readonly volume: number;
}
export type IndicatorFailure = "INVALID_CANDLE" | "CANDLE_NOT_FINAL" | "INSUFFICIENT_HISTORY" | "INVALID_EVALUATION_TIME";
export type ValidatedIndicators = Readonly<{
  version: "INDICATORS_V1";
  interval: HistoricalInterval;
  range: Readonly<{ from: string; to: string }>;
  lastFinalizedAt: string;
  values: Readonly<IndicatorSnapshot>;
  directionalTrend: Readonly<{ adx14: number; plusDi14: number; minusDi14: number }>;
}>;
export type IndicatorOutcome = Readonly<{ available: true; snapshot: ValidatedIndicators } |
  { available: false; reason: IndicatorFailure }>;

const intervalMs: Record<HistoricalInterval, number> = {
  minute: 60_000, "3minute": 180_000, "5minute": 300_000, "10minute": 600_000,
  "15minute": 900_000, "30minute": 1_800_000, "60minute": 3_600_000, day: 86_400_000,
};
const price = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Wilder's 14-period directional movement, using only validated completed bars. */
function directionalTrend(bars: readonly { high: number; low: number; close: number }[]) {
  const period = 14;
  let trueRange = 0, plusMovement = 0, minusMovement = 0, dxTotal = 0, adx = 0;
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1]!, current = bars[i]!;
    const up = current.high - previous.high, down = previous.low - current.low;
    const tr = Math.max(current.high - current.low, Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close));
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    if (i <= period) {
      trueRange += tr; plusMovement += plus; minusMovement += minus;
    } else {
      trueRange = trueRange - trueRange / period + tr;
      plusMovement = plusMovement - plusMovement / period + plus;
      minusMovement = minusMovement - minusMovement / period + minus;
    }
    if (i < period) continue;
    const plusDi = trueRange > 0 ? 100 * plusMovement / trueRange : 0;
    const minusDi = trueRange > 0 ? 100 * minusMovement / trueRange : 0;
    const sum = plusDi + minusDi;
    const dx = sum > 0 ? 100 * Math.abs(plusDi - minusDi) / sum : 0;
    if (i < period * 2) dxTotal += dx;
    if (i === period * 2 - 1) adx = dxTotal / period;
    else if (i >= period * 2) adx = (adx * (period - 1) + dx) / period;
  }
  const plusDi14 = trueRange > 0 ? 100 * plusMovement / trueRange : 0;
  const minusDi14 = trueRange > 0 ? 100 * minusMovement / trueRange : 0;
  return { adx14: adx, plusDi14, minusDi14 };
}

/** Reuses legacy indicator math only after the entire ordered, finalized series passes validation. */
export function computeValidatedIndicators(input: {
  candles: readonly AnalyticsCandle[]; interval: HistoricalInterval; evaluatedAt: string;
}): IndicatorOutcome {
  let evaluated: number;
  try { evaluated = Date.parse(marketTimestamp(input.evaluatedAt)); }
  catch { return freeze({ available: false, reason: "INVALID_EVALUATION_TIME" }); }
  const duration = intervalMs[input.interval];
  if (!Number.isSafeInteger(duration)) return freeze({ available: false, reason: "INVALID_CANDLE" });
  if (!Array.isArray(input.candles)) return freeze({ available: false, reason: "INVALID_CANDLE" });
  let previous = -Infinity;
  const series: Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (const candle of input.candles) {
    if (!candle || typeof candle !== "object") return freeze({ available: false, reason: "INVALID_CANDLE" });
    let time: number;
    try { time = Date.parse(marketTimestamp(candle.timestamp)); }
    catch { return freeze({ available: false, reason: "INVALID_CANDLE" }); }
    if (time <= previous || !price(candle.openMinor) || !price(candle.highMinor) || !price(candle.lowMinor)
      || !price(candle.closeMinor) || !Number.isSafeInteger(candle.volume) || candle.volume < 0
      || candle.highMinor < candle.lowMinor || candle.openMinor < candle.lowMinor || candle.openMinor > candle.highMinor
      || candle.closeMinor < candle.lowMinor || candle.closeMinor > candle.highMinor)
      return freeze({ available: false, reason: "INVALID_CANDLE" });
    if (time + duration > evaluated) return freeze({ available: false, reason: "CANDLE_NOT_FINAL" });
    previous = time;
    series.push({ timestamp: new Date(time), open: candle.openMinor / 100, high: candle.highMinor / 100,
      low: candle.lowMinor / 100, close: candle.closeMinor / 100, volume: candle.volume });
  }
  // EMA50 is the longest warm-up dependency; RSI, ATR and slope are also ready at 50.
  if (series.length < 50) return freeze({ available: false, reason: "INSUFFICIENT_HISTORY" });
  let values: IndicatorSnapshot;
  try { values = computeAll(series); }
  catch { return freeze({ available: false, reason: "INVALID_CANDLE" }); }
  const trend = directionalTrend(series);
  if (values.ema20 === null || values.ema50 === null || values.atr === null || values.rsiSlope === null
    || Object.values(values).some(v => typeof v === "number" && !Number.isFinite(v))
    || Object.values(trend).some(v => !Number.isFinite(v)))
    return freeze({ available: false, reason: "INVALID_CANDLE" });
  return freeze({ available: true, snapshot: { version: "INDICATORS_V1", interval: input.interval,
    range: { from: series[0]!.timestamp.toISOString(), to: series[series.length - 1]!.timestamp.toISOString() },
    lastFinalizedAt: new Date(previous + duration).toISOString(), values, directionalTrend: trend } });
}
