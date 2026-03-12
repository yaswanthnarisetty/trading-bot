import { z } from "zod";

/**
 * Zod schema for the verifier LLM output that audits and potentially adjusts the primary signal.
 * This acts as a secondary safety layer to capture additional risk flags and override strategies when needed.
 */
export const verifierResultSchema = z.object({
  verified: z.boolean(),
  adjustedStrategy: z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]),
  adjustedConfidence: z.number().min(0).max(1),
  auditNotes: z.string().max(500),
  overruled: z.boolean(),
  additionalRiskFlags: z.array(z.string()),
});

export type VerifierResult = z.infer<typeof verifierResultSchema>;

