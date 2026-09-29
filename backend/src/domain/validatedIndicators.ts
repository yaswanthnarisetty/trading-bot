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
}>;
export type IndicatorOutcome = Readonly<{ available: true; snapshot: ValidatedIndicators } |
  { available: false; reason: IndicatorFailure }>;

const intervalMs: Record<HistoricalInterval, number> = {
  minute: 60_000, "3minute": 180_000, "5minute": 300_000, "10minute": 600_000,
  "15minute": 900_000, "30minute": 1_800_000, "60minute": 3_600_000, day: 86_400_000,
};
const price = (n: number) => Number.isSafeInteger(n) && n > 0;

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
  if (values.ema20 === null || values.ema50 === null || values.atr === null || values.rsiSlope === null
    || Object.values(values).some(v => typeof v === "number" && !Number.isFinite(v)))
    return freeze({ available: false, reason: "INVALID_CANDLE" });
  return freeze({ available: true, snapshot: { version: "INDICATORS_V1", interval: input.interval,
    range: { from: series[0]!.timestamp.toISOString(), to: series[series.length - 1]!.timestamp.toISOString() },
    lastFinalizedAt: new Date(previous + duration).toISOString(), values } });
}
