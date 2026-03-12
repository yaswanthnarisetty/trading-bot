import { z } from "zod";
/**
 * Zod schema for the verifier LLM output that audits and potentially adjusts the primary signal.
 * This acts as a secondary safety layer to capture additional risk flags and override strategies when needed.
 */
export declare const verifierResultSchema: z.ZodObject<{
    verified: z.ZodBoolean;
    adjustedStrategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
    adjustedConfidence: z.ZodNumber;
    auditNotes: z.ZodString;
    overruled: z.ZodBoolean;
    additionalRiskFlags: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    verified: boolean;
    adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    adjustedConfidence: number;
    auditNotes: string;
    overruled: boolean;
    additionalRiskFlags: string[];
}, {
    verified: boolean;
    adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    adjustedConfidence: number;
    auditNotes: string;
    overruled: boolean;
    additionalRiskFlags: string[];
}>;
export type VerifierResult = z.infer<typeof verifierResultSchema>;
//# sourceMappingURL=verifier.d.ts.map