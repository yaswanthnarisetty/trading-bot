"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cryptoSignalSchema = exports.cryptoPositionSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema for a single BTC perpetual position.
 * Stored in the crypto_positions collection.
 */
exports.cryptoPositionSchema = zod_1.z.object({
    positionId: zod_1.z.string(),
    sessionId: zod_1.z.string(),
    asset: zod_1.z.literal("BTCUSD"),
    side: zod_1.z.enum(["LONG", "SHORT"]),
    entryPrice: zod_1.z.number(),
    exitPrice: zod_1.z.number().nullable(),
    /** BTC contract size (e.g. 0.001 BTC) */
    size: zod_1.z.number(),
    entryTimestamp: zod_1.z.string(),
    exitTimestamp: zod_1.z.string().nullable(),
    stopLoss: zod_1.z.number(),
    takeProfit: zod_1.z.number(),
    realizedPnL: zod_1.z.number().nullable(),
    unrealizedPnL: zod_1.z.number().nullable(),
    exitReason: zod_1.z.enum(["SL_HIT", "TP_HIT", "MANUAL", "SESSION_STOP"]).nullable(),
    status: zod_1.z.enum(["OPEN", "CLOSED"]),
    /** LIVE when DELTA_API_KEY is set, else MOCK (paper) */
    dataMode: zod_1.z.enum(["LIVE", "MOCK"]),
});
/**
 * Signal evaluation result from CryptoSignalService.
 */
exports.cryptoSignalSchema = zod_1.z.object({
    asset: zod_1.z.literal("BTCUSD"),
    side: zod_1.z.enum(["LONG", "SHORT", "HOLD"]),
    confidence: zod_1.z.number().min(0).max(1),
    rsi: zod_1.z.number(),
    ema9: zod_1.z.number(),
    ema21: zod_1.z.number(),
    ema50: zod_1.z.number(),
    atr: zod_1.z.number(),
    volumeRatio: zod_1.z.number(),
    timestamp: zod_1.z.string(),
    reason: zod_1.z.string(),
});
