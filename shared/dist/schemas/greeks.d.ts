import { z } from "zod";
/**
 * Zod schema representing a snapshot of options Greeks and implied volatility context.
 * This is used to summarize non-raw derivatives data for analysis and LLM inputs.
 */
export declare const greeksSnapshotSchema: z.ZodObject<{
    delta: z.ZodNumber;
    gamma: z.ZodNumber;
    theta: z.ZodNumber;
    vega: z.ZodNumber;
    currentIV: z.ZodNumber;
    ivRank: z.ZodNumber;
    ivPercentile: z.ZodNumber;
    ivTrend: z.ZodEnum<["expanding", "contracting", "stable"]>;
    pcr: z.ZodNumber;
    maxPain: z.ZodNumber;
    oiSkew: z.ZodEnum<["calls_heavy", "puts_heavy", "neutral"]>;
    nearWeekIV: z.ZodNumber;
    nextWeekIV: z.ZodNumber;
    expectedMoveUp: z.ZodNumber;
    expectedMoveDown: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    currentIV: number;
    ivRank: number;
    ivPercentile: number;
    ivTrend: "expanding" | "contracting" | "stable";
    pcr: number;
    maxPain: number;
    oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
    nearWeekIV: number;
    nextWeekIV: number;
    expectedMoveUp: number;
    expectedMoveDown: number;
}, {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    currentIV: number;
    ivRank: number;
    ivPercentile: number;
    ivTrend: "expanding" | "contracting" | "stable";
    pcr: number;
    maxPain: number;
    oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
    nearWeekIV: number;
    nextWeekIV: number;
    expectedMoveUp: number;
    expectedMoveDown: number;
}>;
export type GreeksSnapshot = z.infer<typeof greeksSnapshotSchema>;
//# sourceMappingURL=greeks.d.ts.map