"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoringSessionSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema describing a monitoring session for the options paper trading system.
 * This tracks lifecycle, performance, and configuration for a given trading session.
 */
exports.monitoringSessionSchema = zod_1.z.object({
    executionMode: zod_1.z.enum(["LEGACY_PAPER", "PAPER"]).optional(),
    strategyFamily: zod_1.z.enum(["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"]).optional(),
    accountId: zod_1.z.string().optional(),
    lastCycleOutcome: zod_1.z.string().optional(),
    blockingReason: zod_1.z.string().optional(),
    lastCycleAt: zod_1.z.string().optional(),
    sessionId: zod_1.z.string(),
    asset: zod_1.z.string(),
    startTime: zod_1.z.string(),
    stopTime: zod_1.z.string().nullable(),
    status: zod_1.z.enum(["RUNNING", "STOPPED", "CRASHED"]),
    totalSignals: zod_1.z.number(),
    totalTrades: zod_1.z.number(),
    winRate: zod_1.z.number(),
    paperPnL: zod_1.z.number(),
    paperCapital: zod_1.z.number(),
    ticksSkipped: zod_1.z.number(),
    dataMode: zod_1.z.enum(["LIVE", "MOCK", "KITE_REAL"]),
});
