import test from "node:test";
import assert from "node:assert/strict";
import { planBtcDemoTrade, planBtcPriorDayTrade } from "../../src/domain/btcDemoPlan";

const base = {
  side: "LONG" as const, entryPrice: 60_000, atr: 100, equityUsd: 160,
  product: { id: 84, symbol: "BTCUSD" as const, contractValueBtc: 0.001, tickSize: 0.1 },
  openPositionCount: 0, activeOrderCount: 0,
};

test("Demo size is integer contracts within a 0.5% risk budget and 1x notional cap", () => {
  const plan = planBtcDemoTrade(base);
  assert.equal(plan.eligible, true);
  if (!plan.eligible) return;
  assert.equal(Number.isInteger(plan.contractCount), true);
  assert.equal(plan.contractCount, 2);
  assert.ok(plan.estimatedLossAtStopUsd <= plan.riskBudgetUsd);
  assert.ok(plan.notionalUsd <= base.equityUsd);
  assert.equal(plan.stopReferenceUsd, 59_850);
});

test("Demo preview refuses exposure, unaffordable minimum contracts and bad evidence", () => {
  assert.deepEqual(planBtcDemoTrade({ ...base, openPositionCount: 1 }).eligible, false);
  assert.deepEqual(planBtcDemoTrade({ ...base, activeOrderCount: 1 }).eligible, false);
  assert.match(String(planBtcDemoTrade({ ...base, equityUsd: 20 }).eligible), /false/);
  assert.equal(planBtcDemoTrade({ ...base, atr: 0 }).eligible, false);
});

test("short preview places stop above and target below reference", () => {
  const plan = planBtcDemoTrade({ ...base, side: "SHORT" });
  assert.equal(plan.eligible, true);
  if (!plan.eligible) return;
  assert.ok(plan.stopReferenceUsd > plan.entryReferenceUsd);
  assert.ok(plan.takeProfitReferenceUsd < plan.entryReferenceUsd);
});

test("prior-day Demo plan keeps stop, 2R target, 0.5% risk and 1x notional", () => {
  const plan = planBtcPriorDayTrade({ ...base, equityUsd: 1_000, entryPrice: 80_000,
    stopReferenceUsd: 79_500.03 });
  assert.equal(plan.eligible, true);
  if (!plan.eligible) return;
  assert.equal(plan.stopReferenceUsd, 79_500);
  assert.equal(plan.takeProfitReferenceUsd, 81_000);
  assert.ok(plan.estimatedLossAtStopUsd <= 5);
  assert.ok(plan.notionalUsd <= 1_000);
  assert.equal(plan.contractCount, 6);
});

test("small Demo account cannot force a daily stop through one-contract risk cap", () => {
  const blocked = planBtcPriorDayTrade({ ...base, entryPrice: 80_000,
    stopReferenceUsd: 79_000, equityUsd: 158.68 });
  assert.equal(blocked.eligible, false);
  if (blocked.eligible) return;
  assert.equal(blocked.reason, "MINIMUM_CONTRACT_EXCEEDS_RISK_OR_NOTIONAL_CAP");
  assert.ok(blocked.minimumContractLossUsd! > blocked.riskBudgetUsd);
  assert.equal(planBtcPriorDayTrade({ ...base, entryPrice: 80_000,
    stopReferenceUsd: 80_100, equityUsd: 1_000 }).eligible, false);
});
