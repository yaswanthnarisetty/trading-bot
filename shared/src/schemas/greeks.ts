import { z } from "zod";

/**
 * Zod schema representing a snapshot of options Greeks and implied volatility context.
 * This is used to summarize non-raw derivatives data for analysis and LLM inputs.
 */
export const greeksSnapshotSchema = z.object({
  delta: z.number().min(-1).max(1),
  gamma: z.number().nonnegative(),
  theta: z.number().max(0),
  vega: z.number().nonnegative(),
  currentIV: z.number().nonnegative(),
  ivRank: z.number().min(0).max(100),
  ivPercentile: z.number().min(0).max(100),
  ivTrend: z.enum(["expanding", "contracting", "stable"]),
  pcr: z.number(),
  maxPain: z.number(),
  oiSkew: z.enum(["calls_heavy", "puts_heavy", "neutral"]),
  nearWeekIV: z.number(),
  nextWeekIV: z.number(),
  expectedMoveUp: z.number(),
  expectedMoveDown: z.number(),
});

export type GreeksSnapshot = z.infer<typeof greeksSnapshotSchema>;

