import { z } from "zod";
/**
 * Zod schema for a single BTC perpetual position.
 * Stored in the crypto_positions collection.
 */
export declare const cryptoPositionSchema: z.ZodObject<{
    positionId: z.ZodString;
    sessionId: z.ZodString;
    asset: z.ZodLiteral<"BTCUSD">;
    side: z.ZodEnum<["LONG", "SHORT"]>;
    entryPrice: z.ZodNumber;
    exitPrice: z.ZodNullable<z.ZodNumber>;
    /** BTC contract size (e.g. 0.001 BTC) */
    size: z.ZodNumber;
    entryTimestamp: z.ZodString;
    exitTimestamp: z.ZodNullable<z.ZodString>;
    stopLoss: z.ZodNumber;
    takeProfit: z.ZodNumber;
    realizedPnL: z.ZodNullable<z.ZodNumber>;
    unrealizedPnL: z.ZodNullable<z.ZodNumber>;
    exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TP_HIT", "MANUAL", "SESSION_STOP"]>>;
    status: z.ZodEnum<["OPEN", "CLOSED"]>;
    /** LIVE when DELTA_API_KEY is set, else MOCK (paper) */
    dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
}, "strip", z.ZodTypeAny, {
    status: "OPEN" | "CLOSED";
    positionId: string;
    sessionId: string;
    asset: "BTCUSD";
    entryTimestamp: string;
    exitTimestamp: string | null;
    exitReason: "SL_HIT" | "SESSION_STOP" | "MANUAL" | "TP_HIT" | null;
    realizedPnL: number | null;
    dataMode: "LIVE" | "MOCK";
    side: "LONG" | "SHORT";
    entryPrice: number;
    exitPrice: number | null;
    size: number;
    stopLoss: number;
    takeProfit: number;
    unrealizedPnL: number | null;
}, {
    status: "OPEN" | "CLOSED";
    positionId: string;
    sessionId: string;
    asset: "BTCUSD";
    entryTimestamp: string;
    exitTimestamp: string | null;
    exitReason: "SL_HIT" | "SESSION_STOP" | "MANUAL" | "TP_HIT" | null;
    realizedPnL: number | null;
    dataMode: "LIVE" | "MOCK";
    side: "LONG" | "SHORT";
    entryPrice: number;
    exitPrice: number | null;
    size: number;
    stopLoss: number;
    takeProfit: number;
    unrealizedPnL: number | null;
}>;
export type CryptoPosition = z.infer<typeof cryptoPositionSchema>;
/**
 * Signal evaluation result from CryptoSignalService.
 */
export declare const cryptoSignalSchema: z.ZodObject<{
    asset: z.ZodLiteral<"BTCUSD">;
    side: z.ZodEnum<["LONG", "SHORT", "HOLD"]>;
    confidence: z.ZodNumber;
    rsi: z.ZodNumber;
    ema9: z.ZodNumber;
    ema21: z.ZodNumber;
    ema50: z.ZodNumber;
    atr: z.ZodNumber;
    volumeRatio: z.ZodNumber;
    timestamp: z.ZodString;
    reason: z.ZodString;
}, "strip", z.ZodTypeAny, {
    rsi: number;
    ema50: number;
    atr: number;
    volumeRatio: number;
    confidence: number;
    asset: "BTCUSD";
    side: "HOLD" | "LONG" | "SHORT";
    ema9: number;
    ema21: number;
    timestamp: string;
    reason: string;
}, {
    rsi: number;
    ema50: number;
    atr: number;
    volumeRatio: number;
    confidence: number;
    asset: "BTCUSD";
    side: "HOLD" | "LONG" | "SHORT";
    ema9: number;
    ema21: number;
    timestamp: string;
    reason: string;
}>;
export type CryptoSignal = z.infer<typeof cryptoSignalSchema>;
//# sourceMappingURL=crypto.d.ts.map