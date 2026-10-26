import { test } from "node:test";
import assert from "node:assert/strict";
import { paperCapitalMinor } from "../../src/services/NsePaperAccountService";
import { NSE_PAPER_POLICY_V2, NSE_PAPER_POLICY_V3 } from "../../src/config/nsePaperPolicy";
import { entryRiskPolicySchema } from "../../src/domain/entryRisk";
import { tradingCalendarSchema } from "../../src/domain/realizedRisk";

test("approved NSE PAPER V2 policy is exact and passes the durable financial validators", () => {
  assert.equal(NSE_PAPER_POLICY_V2.initialCapitalMinor, 20_000_000);
  assert.deepEqual(NSE_PAPER_POLICY_V2.entryRiskPolicy, {
    policyVersion: 2, maxRiskPerEntryMinor: 1_600_000, maxReservedRiskMinor: 2_400_000,
    maxPositionSlots: 3, maxDailyLossMinor: 400_000,
  });
  assert.deepEqual(NSE_PAPER_POLICY_V2.riskTradingCalendar,
    { kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" });
  assert.deepEqual(entryRiskPolicySchema.parse(NSE_PAPER_POLICY_V2.entryRiskPolicy), NSE_PAPER_POLICY_V2.entryRiskPolicy);
  assert.deepEqual(tradingCalendarSchema.parse(NSE_PAPER_POLICY_V2.riskTradingCalendar), NSE_PAPER_POLICY_V2.riskTradingCalendar);
});

test("approved NSE PAPER V3 changes only per-entry risk to ₹20,000", () => {
  assert.equal(NSE_PAPER_POLICY_V3.initialCapitalMinor, NSE_PAPER_POLICY_V2.initialCapitalMinor);
  assert.deepEqual(NSE_PAPER_POLICY_V3.riskTradingCalendar, NSE_PAPER_POLICY_V2.riskTradingCalendar);
  assert.deepEqual(NSE_PAPER_POLICY_V3.entryRiskPolicy, {
    ...NSE_PAPER_POLICY_V2.entryRiskPolicy,
    policyVersion: 3,
    maxRiskPerEntryMinor: 2_000_000,
  });
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
