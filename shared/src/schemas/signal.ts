import { z } from "zod";

/**
 * Zod schema for the primary analyst signal produced by the LLM layer.
 * This defines the exact contract for strategy direction and spread selection that must be strictly validated.
 */
export const primarySignalSchema = z.object({
  direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]),
  strategy: z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]),
  strikeSelection: z.object({
    rationale: z.string().max(300),
    preferredDelta: z.number().min(0.1).max(0.6).nullable().optional(),
    preferredDTE: z.number().min(1).max(30).nullable().optional(),
  }),
  ivContext: z.enum(["selling_cheap", "selling_fair", "selling_expensive"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(500),
  keyFactors: z.array(z.string()).min(1).max(10),
  riskFlags: z.array(z.string()),
  suggestedEntry: z.number().nullable(),
  suggestedSL: z.number().nullable(),
  suggestedTarget: z.number().nullable(),
});

export type PrimarySignal = z.infer<typeof primarySignalSchema>;

