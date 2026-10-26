import { entryRiskPolicySchema } from "../domain/entryRisk";
import { tradingCalendarSchema } from "../domain/realizedRisk";

/** Operator-approved, fixed-capital financial policy for the internal NSE PAPER account. */
export const NSE_PAPER_POLICY_V2 = Object.freeze({
  initialCapitalMinor: 20_000_000,
  entryRiskPolicy: Object.freeze(entryRiskPolicySchema.parse({
    policyVersion: 2,
    maxRiskPerEntryMinor: 1_600_000,
    maxReservedRiskMinor: 2_400_000,
    maxPositionSlots: 3,
    maxDailyLossMinor: 400_000,
  })),
  riskTradingCalendar: Object.freeze(tradingCalendarSchema.parse({ kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" })),
});

/** Approved increase to ₹20,000 per entry; all independent account guards are unchanged. */
export const NSE_PAPER_POLICY_V3 = Object.freeze({
  ...NSE_PAPER_POLICY_V2,
  entryRiskPolicy: Object.freeze(entryRiskPolicySchema.parse({
    ...NSE_PAPER_POLICY_V2.entryRiskPolicy,
    policyVersion: 3,
    maxRiskPerEntryMinor: 2_000_000,
  })),
});
