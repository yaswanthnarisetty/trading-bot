"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expiryContextSchema = void 0;
const zod_1 = require("zod");
/**
 * Zod schema representing the current options expiry context for an asset.
 * This captures DTE-based risk characteristics for use in strategy and risk management.
 */
exports.expiryContextSchema = zod_1.z.object({
    currentDTE: zod_1.z.number(),
    nextExpiryDTE: zod_1.z.number(),
    nearestExpiry: zod_1.z.string(),
    isExpiryWeek: zod_1.z.boolean(),
    isExpiryDay: zod_1.z.boolean(),
    thetaRisk: zod_1.z.enum(["high", "medium", "low"]),
});
