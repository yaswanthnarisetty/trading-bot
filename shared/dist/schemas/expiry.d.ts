import { z } from "zod";
/**
 * Zod schema representing the current options expiry context for an asset.
 * This captures DTE-based risk characteristics for use in strategy and risk management.
 */
export declare const expiryContextSchema: z.ZodObject<{
    currentDTE: z.ZodNumber;
    nextExpiryDTE: z.ZodNumber;
    nearestExpiry: z.ZodString;
    isExpiryWeek: z.ZodBoolean;
    isExpiryDay: z.ZodBoolean;
    thetaRisk: z.ZodEnum<["high", "medium", "low"]>;
}, "strip", z.ZodTypeAny, {
    currentDTE: number;
    nextExpiryDTE: number;
    nearestExpiry: string;
    isExpiryWeek: boolean;
    isExpiryDay: boolean;
    thetaRisk: "high" | "medium" | "low";
}, {
    currentDTE: number;
    nextExpiryDTE: number;
    nearestExpiry: string;
    isExpiryWeek: boolean;
    isExpiryDay: boolean;
    thetaRisk: "high" | "medium" | "low";
}>;
export type ExpiryContext = z.infer<typeof expiryContextSchema>;
//# sourceMappingURL=expiry.d.ts.map