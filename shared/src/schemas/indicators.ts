import { z } from "zod";

/**
 * Zod schema representing a snapshot of key technical indicators for an asset.
 * Fields ema20, ema50, atr are nullable to represent warmup state at market open.
 * candleCount tracks how many candles have been seen — drives warmup status display.
 *
 * Warmup timeline (5-min candles, market opens 09:15 IST):
 *   ATR(14) ready:  14 candles → ~10:25 AM (70 min after open)
 *   EMA(20) ready:  20 candles → ~10:55 AM (100 min after open)
 *   EMA(50) ready:  50 candles → ~12:25 PM (250 min after open)
 *   All indicators: 50+ candles → 12:25 PM onwards
 */
export const indicatorSnapshotSchema = z.object({
  rsi: z.number().min(0).max(100),
  ema20: z.number().nullable(),
  ema50: z.number().nullable(),
  atr: z.number().nonnegative().nullable(),
  volumeRatio: z.number().nonnegative(),
  regime: z.enum(["trending", "ranging", "volatile", "INSUFFICIENT_DATA"]),
  priceVsEma20: z.enum(["above", "below", "unknown"]),
  priceVsEma50: z.enum(["above", "below", "unknown"]),
  emaAlignment: z.enum(["bullish", "bearish", "mixed"]),
  candleCount: z.number().optional(),
  /**
   * RSI change over the last RSI_SLOPE_BARS (3) candles.
   * Positive = RSI rising, negative = RSI falling. Null during warmup.
   */
  rsiSlope: z.number().nullable().optional(),
  /**
   * 3-candle directional pattern: BULLISH if all green closing in upper 70%,
   * BEARISH if all red closing in lower 30%, otherwise NEUTRAL.
   */
  candleMomentum: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]).optional(),
});

export type IndicatorSnapshot = z.infer<typeof indicatorSnapshotSchema>;
