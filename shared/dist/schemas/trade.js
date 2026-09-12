"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionsPositionSchema = exports.tradeLegSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema for a single options trade leg within a multi-leg paper position.
 * This describes direction, option type, pricing, and realized leg-level PnL.
 */
exports.tradeLegSchema = zod_1.z.object({
    action: zod_1.z.enum(["BUY", "SELL"]),
    type: zod_1.z.enum(["CALL", "PUT"]),
    strike: zod_1.z.number(),
    expiry: zod_1.z.string(),
    lotSize: zod_1.z.number(),
    lots: zod_1.z.number(),
    entryPremium: zod_1.z.number(),
    exitPremium: zod_1.z.number().nullable(),
    legPnL: zod_1.z.number().nullable(),
});
/**
 * Zod schema for a full paper options position consisting of one or more legs.
 * This captures lifecycle, risk, and performance metrics for backtesting and monitoring.
 */
exports.optionsPositionSchema = zod_1.z.object({
    executionMode: zod_1.z.literal("LEGACY_PAPER").optional(),
    positionId: zod_1.z.string(),
    sessionId: zod_1.z.string(),
    asset: zod_1.z.string(),
    strategy: zod_1.z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]),
    legs: zod_1.z.array(exports.tradeLegSchema),
    entrySpot: zod_1.z.number(),
    entryDTE: zod_1.z.number(),
    entryIVRank: zod_1.z.number(),
    entryTimestamp: zod_1.z.string(),
    maxProfit: zod_1.z.number(),
    maxLoss: zod_1.z.number(),
    breakevenPoint: zod_1.z.number(),
    riskRewardRatio: zod_1.z.number(),
    status: zod_1.z.enum([
        "OPEN",
        "CLOSED_SL",
        "CLOSED_TARGET",
        "CLOSED_EXPIRY",
        "CLOSED_MANUAL",
    ]),
    exitSpot: zod_1.z.number().nullable(),
    exitTimestamp: zod_1.z.string().nullable(),
    exitReason: zod_1.z
        .enum(["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"])
        .nullable(),
    realizedPnL: zod_1.z.number().nullable(),
    /**
     * ATR (14-period, 5-min candles) at the moment the position was opened.
     * Used by PositionMonitorService to compute the directional stop threshold (ATR × 1.5).
     * Null when ATR was unavailable during warmup.
     */
    entryATR: zod_1.z.number().nullable().optional(),
    dataMode: zod_1.z.enum(["LIVE", "MOCK"]),
    /**
     * Tracks where the entry premiums came from.
     * KITE_LTP = real live LTP fetched from Kite at open (accurate).
     * BLACK_SCHOLES = theoretical estimate used in mock mode.
     * BLACK_SCHOLES_FALLBACK = Kite fetch failed at open, fell back to estimate.
     */
    premiumSource: zod_1.z.enum(["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]).optional(),
    /**
     * SPAN + exposure margin required to hold this spread, in rupees.
     * KITE_API = fetched from POST /margins/orders (accurate SPAN netting).
     * ESTIMATED = spreadWidth × lotSize × lots × MARGIN_ESTIMATE_MULTIPLIER (fallback).
     */
    requiredMargin: zod_1.z.number().optional(),
    marginSource: zod_1.z.enum(["KITE_API", "ESTIMATED"]).optional(),
});
