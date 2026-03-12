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
export declare const indicatorSnapshotSchema: z.ZodObject<{
    rsi: z.ZodNumber;
    ema20: z.ZodNullable<z.ZodNumber>;
    ema50: z.ZodNullable<z.ZodNumber>;
    atr: z.ZodNullable<z.ZodNumber>;
    volumeRatio: z.ZodNumber;
    regime: z.ZodEnum<["trending", "ranging", "volatile", "INSUFFICIENT_DATA"]>;
    priceVsEma20: z.ZodEnum<["above", "below", "unknown"]>;
    priceVsEma50: z.ZodEnum<["above", "below", "unknown"]>;
    emaAlignment: z.ZodEnum<["bullish", "bearish", "mixed"]>;
    candleCount: z.ZodOptional<z.ZodNumber>;
    /**
     * RSI change over the last RSI_SLOPE_BARS (3) candles.
     * Positive = RSI rising, negative = RSI falling. Null during warmup.
     */
    rsiSlope: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    /**
     * 3-candle directional pattern: BULLISH if all green closing in upper 70%,
     * BEARISH if all red closing in lower 30%, otherwise NEUTRAL.
     */
    candleMomentum: z.ZodOptional<z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL"]>>;
}, "strip", z.ZodTypeAny, {
    rsi: number;
    ema20: number | null;
    ema50: number | null;
    atr: number | null;
    volumeRatio: number;
    regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
    priceVsEma20: "unknown" | "above" | "below";
    priceVsEma50: "unknown" | "above" | "below";
    emaAlignment: "bullish" | "bearish" | "mixed";
    candleCount?: number | undefined;
    rsiSlope?: number | null | undefined;
    candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
}, {
    rsi: number;
    ema20: number | null;
    ema50: number | null;
    atr: number | null;
    volumeRatio: number;
    regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
    priceVsEma20: "unknown" | "above" | "below";
    priceVsEma50: "unknown" | "above" | "below";
    emaAlignment: "bullish" | "bearish" | "mixed";
    candleCount?: number | undefined;
    rsiSlope?: number | null | undefined;
    candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
}>;
export type IndicatorSnapshot = z.infer<typeof indicatorSnapshotSchema>;
//# sourceMappingURL=indicators.d.ts.map