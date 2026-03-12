"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifierResultSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema for the verifier LLM output that audits and potentially adjusts the primary signal.
 * This acts as a secondary safety layer to capture additional risk flags and override strategies when needed.
 */
exports.verifierResultSchema = zod_1.z.object({
    verified: zod_1.z.boolean(),
    adjustedStrategy: zod_1.z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]),
    adjustedConfidence: zod_1.z.number().min(0).max(1),
    auditNotes: zod_1.z.string().max(500),
    overruled: zod_1.z.boolean(),
    additionalRiskFlags: zod_1.z.array(zod_1.z.string()),
});
