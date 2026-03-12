import { z } from "zod";

/**
 * Zod schema representing the current options expiry context for an asset.
 * This captures DTE-based risk characteristics for use in strategy and risk management.
 */
export const expiryContextSchema = z.object({
  currentDTE: z.number(),
  nextExpiryDTE: z.number(),
  nearestExpiry: z.string(),
  isExpiryWeek: z.boolean(),
  isExpiryDay: z.boolean(),
  thetaRisk: z.enum(["high", "medium", "low"]),
});

export type ExpiryContext = z.infer<typeof expiryContextSchema>;

