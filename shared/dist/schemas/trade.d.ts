import { z } from "zod";
/**
 * Zod schema for a single options trade leg within a multi-leg paper position.
 * This describes direction, option type, pricing, and realized leg-level PnL.
 */
export declare const tradeLegSchema: z.ZodObject<{
    action: z.ZodEnum<["BUY", "SELL"]>;
    type: z.ZodEnum<["CALL", "PUT"]>;
    strike: z.ZodNumber;
    expiry: z.ZodString;
    lotSize: z.ZodNumber;
    lots: z.ZodNumber;
    entryPremium: z.ZodNumber;
    exitPremium: z.ZodNullable<z.ZodNumber>;
    legPnL: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "CALL" | "PUT";
    action: "BUY" | "SELL";
    strike: number;
    expiry: string;
    lotSize: number;
    lots: number;
    entryPremium: number;
    exitPremium: number | null;
    legPnL: number | null;
}, {
    type: "CALL" | "PUT";
    action: "BUY" | "SELL";
    strike: number;
    expiry: string;
    lotSize: number;
    lots: number;
    entryPremium: number;
    exitPremium: number | null;
    legPnL: number | null;
}>;
export type TradeLeg = z.infer<typeof tradeLegSchema>;
/**
 * Zod schema for a full paper options position consisting of one or more legs.
 * This captures lifecycle, risk, and performance metrics for backtesting and monitoring.
 */
export declare const optionsPositionSchema: z.ZodObject<{
    positionId: z.ZodString;
    sessionId: z.ZodString;
    asset: z.ZodString;
    strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]>;
    legs: z.ZodArray<z.ZodObject<{
        action: z.ZodEnum<["BUY", "SELL"]>;
        type: z.ZodEnum<["CALL", "PUT"]>;
        strike: z.ZodNumber;
        expiry: z.ZodString;
        lotSize: z.ZodNumber;
        lots: z.ZodNumber;
        entryPremium: z.ZodNumber;
        exitPremium: z.ZodNullable<z.ZodNumber>;
        legPnL: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        type: "CALL" | "PUT";
        action: "BUY" | "SELL";
        strike: number;
        expiry: string;
        lotSize: number;
        lots: number;
        entryPremium: number;
        exitPremium: number | null;
        legPnL: number | null;
    }, {
        type: "CALL" | "PUT";
        action: "BUY" | "SELL";
        strike: number;
        expiry: string;
        lotSize: number;
        lots: number;
        entryPremium: number;
        exitPremium: number | null;
        legPnL: number | null;
    }>, "many">;
    entrySpot: z.ZodNumber;
    entryDTE: z.ZodNumber;
    entryIVRank: z.ZodNumber;
    entryTimestamp: z.ZodString;
    maxProfit: z.ZodNumber;
    maxLoss: z.ZodNumber;
    breakevenPoint: z.ZodNumber;
    riskRewardRatio: z.ZodNumber;
    status: z.ZodEnum<["OPEN", "CLOSED_SL", "CLOSED_TARGET", "CLOSED_EXPIRY", "CLOSED_MANUAL"]>;
    exitSpot: z.ZodNullable<z.ZodNumber>;
    exitTimestamp: z.ZodNullable<z.ZodString>;
    exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"]>>;
    realizedPnL: z.ZodNullable<z.ZodNumber>;
    /**
     * ATR (14-period, 5-min candles) at the moment the position was opened.
     * Used by PositionMonitorService to compute the directional stop threshold (ATR × 1.5).
     * Null when ATR was unavailable during warmup.
     */
    entryATR: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
    /**
     * Tracks where the entry premiums came from.
     * KITE_LTP = real live LTP fetched from Kite at open (accurate).
     * BLACK_SCHOLES = theoretical estimate used in mock mode.
     * BLACK_SCHOLES_FALLBACK = Kite fetch failed at open, fell back to estimate.
     */
    premiumSource: z.ZodOptional<z.ZodEnum<["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]>>;
    /**
     * SPAN + exposure margin required to hold this spread, in rupees.
     * KITE_API = fetched from POST /margins/orders (accurate SPAN netting).
     * ESTIMATED = spreadWidth × lotSize × lots × MARGIN_ESTIMATE_MULTIPLIER (fallback).
     */
    requiredMargin: z.ZodOptional<z.ZodNumber>;
    marginSource: z.ZodOptional<z.ZodEnum<["KITE_API", "ESTIMATED"]>>;
}, "strip", z.ZodTypeAny, {
    status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
    strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    positionId: string;
    sessionId: string;
    asset: string;
    legs: {
        type: "CALL" | "PUT";
        action: "BUY" | "SELL";
        strike: number;
        expiry: string;
        lotSize: number;
        lots: number;
        entryPremium: number;
        exitPremium: number | null;
        legPnL: number | null;
    }[];
    entrySpot: number;
    entryDTE: number;
    entryIVRank: number;
    entryTimestamp: string;
    maxProfit: number;
    maxLoss: number;
    breakevenPoint: number;
    riskRewardRatio: number;
    exitSpot: number | null;
    exitTimestamp: string | null;
    exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
    realizedPnL: number | null;
    dataMode: "LIVE" | "MOCK";
    entryATR?: number | null | undefined;
    premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
    requiredMargin?: number | undefined;
    marginSource?: "KITE_API" | "ESTIMATED" | undefined;
}, {
    status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
    strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    positionId: string;
    sessionId: string;
    asset: string;
    legs: {
        type: "CALL" | "PUT";
        action: "BUY" | "SELL";
        strike: number;
        expiry: string;
        lotSize: number;
        lots: number;
        entryPremium: number;
        exitPremium: number | null;
        legPnL: number | null;
    }[];
    entrySpot: number;
    entryDTE: number;
    entryIVRank: number;
    entryTimestamp: string;
    maxProfit: number;
    maxLoss: number;
    breakevenPoint: number;
    riskRewardRatio: number;
    exitSpot: number | null;
    exitTimestamp: string | null;
    exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
    realizedPnL: number | null;
    dataMode: "LIVE" | "MOCK";
    entryATR?: number | null | undefined;
    premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
    requiredMargin?: number | undefined;
    marginSource?: "KITE_API" | "ESTIMATED" | undefined;
}>;
export type OptionsPosition = z.infer<typeof optionsPositionSchema>;
//# sourceMappingURL=trade.d.ts.map