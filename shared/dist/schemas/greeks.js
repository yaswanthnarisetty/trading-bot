"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.greeksSnapshotSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema representing a snapshot of options Greeks and implied volatility context.
 * This is used to summarize non-raw derivatives data for analysis and LLM inputs.
 */
exports.greeksSnapshotSchema = zod_1.z.object({
    delta: zod_1.z.number().min(-1).max(1),
    gamma: zod_1.z.number().nonnegative(),
    theta: zod_1.z.number().max(0),
    vega: zod_1.z.number().nonnegative(),
    currentIV: zod_1.z.number().nonnegative(),
    ivRank: zod_1.z.number().min(0).max(100),
    ivPercentile: zod_1.z.number().min(0).max(100),
    ivTrend: zod_1.z.enum(["expanding", "contracting", "stable"]),
    pcr: zod_1.z.number(),
    maxPain: zod_1.z.number(),
    oiSkew: zod_1.z.enum(["calls_heavy", "puts_heavy", "neutral"]),
    nearWeekIV: zod_1.z.number(),
    nextWeekIV: zod_1.z.number(),
    expectedMoveUp: zod_1.z.number(),
    expectedMoveDown: zod_1.z.number(),
});
