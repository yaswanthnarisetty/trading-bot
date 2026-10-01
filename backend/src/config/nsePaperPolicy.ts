import { entryRiskPolicySchema } from "../domain/entryRisk";
import { tradingCalendarSchema } from "../domain/realizedRisk";

/** Operator-approved, fixed-capital financial policy for the internal NSE PAPER account. */
export const NSE_PAPER_POLICY_V1 = Object.freeze({
  initialCapitalMinor: 20_000_000,
  entryRiskPolicy: Object.freeze(entryRiskPolicySchema.parse({
    policyVersion: 1,
    maxRiskPerEntryMinor: 800_000,
    maxReservedRiskMinor: 2_400_000,
    maxPositionSlots: 3,
    maxDailyLossMinor: 400_000,
  })),
  riskTradingCalendar: Object.freeze(tradingCalendarSchema.parse({ kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" })),
});
