import { z } from "zod";
/**
 * Zod schema for the primary analyst signal produced by the LLM layer.
 * This defines the exact contract for strategy direction and spread selection that must be strictly validated.
 */
export declare const primarySignalSchema: z.ZodObject<{
    direction: z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]>;
    strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
    strikeSelection: z.ZodObject<{
        rationale: z.ZodString;
        preferredDelta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        preferredDTE: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        rationale: string;
        preferredDelta?: number | null | undefined;
        preferredDTE?: number | null | undefined;
    }, {
        rationale: string;
        preferredDelta?: number | null | undefined;
        preferredDTE?: number | null | undefined;
    }>;
    ivContext: z.ZodEnum<["selling_cheap", "selling_fair", "selling_expensive"]>;
    confidence: z.ZodNumber;
    reasoning: z.ZodString;
    keyFactors: z.ZodArray<z.ZodString, "many">;
    riskFlags: z.ZodArray<z.ZodString, "many">;
    suggestedEntry: z.ZodNullable<z.ZodNumber>;
    suggestedSL: z.ZodNullable<z.ZodNumber>;
    suggestedTarget: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
    strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    strikeSelection: {
        rationale: string;
        preferredDelta?: number | null | undefined;
        preferredDTE?: number | null | undefined;
    };
    ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
    confidence: number;
    reasoning: string;
    keyFactors: string[];
    riskFlags: string[];
    suggestedEntry: number | null;
    suggestedSL: number | null;
    suggestedTarget: number | null;
}, {
    direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
    strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
    strikeSelection: {
        rationale: string;
        preferredDelta?: number | null | undefined;
        preferredDTE?: number | null | undefined;
    };
    ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
    confidence: number;
    reasoning: string;
    keyFactors: string[];
    riskFlags: string[];
    suggestedEntry: number | null;
    suggestedSL: number | null;
    suggestedTarget: number | null;
}>;
export type PrimarySignal = z.infer<typeof primarySignalSchema>;
//# sourceMappingURL=signal.d.ts.map