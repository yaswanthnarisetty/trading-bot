"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wsMessageSchema = exports.heartbeatMessageSchema = exports.tickErrorMessageSchema = exports.tickSkippedMessageSchema = exports.sessionStoppedMessageSchema = exports.sessionStoppedPayloadSchema = exports.sessionStartedMessageSchema = exports.sessionStartedPayloadSchema = exports.positionUpdateMessageSchema = exports.positionUpdatePayloadSchema = exports.positionClosedMessageSchema = exports.positionOpenedMessageSchema = exports.signalMessageSchema = exports.signalPayloadSchema = void 0;
const zod_1 = require("zod");
const signal_1 = require("./signal");
const verifier_1 = require("./verifier");
const indicators_1 = require("./indicators");
const greeks_1 = require("./greeks");
const expiry_1 = require("./expiry");
const trade_1 = require("./trade");
/**
 * Zod schema describing the payload for a real-time trading signal message.
 * This message is pushed over WebSocket to synchronize LLM decisions and analysis context.
 */
exports.signalPayloadSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    asset: zod_1.z.string(),
    ltp: zod_1.z.number(),
    signal: signal_1.primarySignalSchema,
    verifierResult: verifier_1.verifierResultSchema.nullable(),
    riskAction: zod_1.z.enum(["SUGGEST", "BLOCK"]),
    blockReason: zod_1.z.string().nullable(),
    indicators: indicators_1.indicatorSnapshotSchema,
    greeksSnapshot: greeks_1.greeksSnapshotSchema.nullable(),
    expiryContext: expiry_1.expiryContextSchema,
    paperPnL: zod_1.z.number(),
    openPositions: zod_1.z.number(),
    dataMode: zod_1.z.enum(["LIVE", "MOCK"]),
    timestamp: zod_1.z.number(),
    /** S/R context — optional, present when SR data is available for the tick */
    srContext: zod_1.z.unknown().optional(),
    /** Breakout detection result — optional, present when breakout analysis ran */
    breakoutResult: zod_1.z.unknown().optional(),
});
/**
 * Zod schemas for individual WebSocket message variants used between backend and frontend.
 * Every message carries a type discriminator to enable robust union parsing and validation.
 */
exports.signalMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("SIGNAL"),
    payload: exports.signalPayloadSchema,
});
exports.positionOpenedMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("POSITION_OPENED"),
    payload: trade_1.optionsPositionSchema,
});
exports.positionClosedMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("POSITION_CLOSED"),
    payload: trade_1.optionsPositionSchema,
});
exports.positionUpdatePayloadSchema = zod_1.z.object({
    positionId: zod_1.z.string(),
    currentPnL: zod_1.z.number(),
    currentLTP: zod_1.z.number(),
});
exports.positionUpdateMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("POSITION_UPDATE"),
    payload: exports.positionUpdatePayloadSchema,
});
exports.sessionStartedPayloadSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    asset: zod_1.z.string(),
    paperCapital: zod_1.z.number(),
});
exports.sessionStartedMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("SESSION_STARTED"),
    payload: exports.sessionStartedPayloadSchema,
});
exports.sessionStoppedPayloadSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    finalPnL: zod_1.z.number(),
    totalTrades: zod_1.z.number(),
});
exports.sessionStoppedMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("SESSION_STOPPED"),
    payload: exports.sessionStoppedPayloadSchema,
});
exports.tickSkippedMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("TICK_SKIPPED"),
    reason: zod_1.z.string(),
    timestamp: zod_1.z.number(),
});
exports.tickErrorMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("TICK_ERROR"),
    error: zod_1.z.string(),
    timestamp: zod_1.z.number(),
});
exports.heartbeatMessageSchema = zod_1.z.object({
    type: zod_1.z.literal("HEARTBEAT"),
    timestamp: zod_1.z.number(),
});
/**
 * Discriminated union Zod schema for all supported WebSocket messages.
 * This is the single source of truth for real-time protocol validation.
 */
exports.wsMessageSchema = zod_1.z.discriminatedUnion("type", [
    exports.signalMessageSchema,
    exports.positionOpenedMessageSchema,
    exports.positionClosedMessageSchema,
    exports.positionUpdateMessageSchema,
    exports.sessionStartedMessageSchema,
    exports.sessionStoppedMessageSchema,
    exports.tickSkippedMessageSchema,
    exports.tickErrorMessageSchema,
    exports.heartbeatMessageSchema,
]);
