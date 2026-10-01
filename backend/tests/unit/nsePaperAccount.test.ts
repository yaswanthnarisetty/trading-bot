import { test } from "node:test";
import assert from "node:assert/strict";
import { paperCapitalMinor } from "../../src/services/NsePaperAccountService";
import { NSE_PAPER_POLICY_V1 } from "../../src/config/nsePaperPolicy";
import { entryRiskPolicySchema } from "../../src/domain/entryRisk";
import { tradingCalendarSchema } from "../../src/domain/realizedRisk";

test("approved NSE PAPER V1 policy is exact and passes the durable financial validators", () => {
  assert.equal(NSE_PAPER_POLICY_V1.initialCapitalMinor, 20_000_000);
  assert.deepEqual(NSE_PAPER_POLICY_V1.entryRiskPolicy, {
    policyVersion: 1, maxRiskPerEntryMinor: 800_000, maxReservedRiskMinor: 2_400_000,
    maxPositionSlots: 3, maxDailyLossMinor: 400_000,
  });
  assert.deepEqual(NSE_PAPER_POLICY_V1.riskTradingCalendar,
    { kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" });
  assert.deepEqual(entryRiskPolicySchema.parse(NSE_PAPER_POLICY_V1.entryRiskPolicy), NSE_PAPER_POLICY_V1.entryRiskPolicy);
  assert.deepEqual(tradingCalendarSchema.parse(NSE_PAPER_POLICY_V1.riskTradingCalendar), NSE_PAPER_POLICY_V1.riskTradingCalendar);
});

test("PAPER_CAPITAL converts decimal rupees to paise exactly", () => {
  assert.equal(paperCapitalMinor("200000"), 20000000);
  assert.equal(paperCapitalMinor("200000.37"), 20000037);
  assert.equal(paperCapitalMinor("0.01"), 1);
});

test("PAPER_CAPITAL rejects absent, rounded, exponent, signed and unsafe amounts", () => {
  for (const value of [undefined, "", "0", "200000.001", "2e5", "+200000", "-1", "90071992547410"])
    assert.throws(() => paperCapitalMinor(value), /PAPER_CAPITAL_/);
});
