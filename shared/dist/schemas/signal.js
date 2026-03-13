"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.primarySignalSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema for the primary analyst signal produced by the LLM layer.
 * This defines the exact contract for strategy direction and spread selection that must be strictly validated.
 */
exports.primarySignalSchema = zod_1.z.object({
    direction: zod_1.z.enum(["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]),
    strategy: zod_1.z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]),
    strikeSelection: zod_1.z.object({
        rationale: zod_1.z.string().max(300),
        preferredDelta: zod_1.z.number().min(0.1).max(0.6).nullable().optional(),
        preferredDTE: zod_1.z.number().min(1).max(30).nullable().optional(),
    }),
    ivContext: zod_1.z.enum(["selling_cheap", "selling_fair", "selling_expensive"]),
    confidence: zod_1.z.number().min(0).max(1),
    reasoning: zod_1.z.string().max(500),
    keyFactors: zod_1.z.array(zod_1.z.string()).min(1).max(10),
    riskFlags: zod_1.z.array(zod_1.z.string()),
    suggestedEntry: zod_1.z.number().nullable(),
    suggestedSL: zod_1.z.number().nullable(),
    suggestedTarget: zod_1.z.number().nullable(),
});
