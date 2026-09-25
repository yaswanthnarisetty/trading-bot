import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateEntryRisk, entryProjection, entryProjectionFromFills } from "../../src/domain/entryRisk";
const requirement = (multi = false) => {
  const legs = [{ legId: "a", contractKey: "NFO:a", side: "BUY", targetUnits: 10 },
    ...(multi ? [{ legId: "b", contractKey: "NFO:b", side: "BUY", targetUnits: 10 }] : [])];
  return calculateEntryRisk(legs, { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: new Date("2026-10-01"),
    legs: legs.map(({ legId, contractKey }) => ({
      legId, contractKey, instrumentKind: "NSE_OPTION", optionType: "CALL", expiry: new Date("2026-10-01"),
      qualificationRef: "qualified", lotSizeUnits: 1, tickSizeMinor: 1, limitPriceMinor: 10000,
    })) });
};
const fill = (fillId = "f1", quantityUnits = 4, priceMinor = 9000, legId = "a") => ({
  fillId, intentId: "entry", legId, contractKey: `NFO:${legId}`, side: "BUY", quantityUnits, priceMinor,
});
test("unfilled admission remains fully pending with one reserved slot", () => {
  assert.deepEqual(entryProjection(requirement()), { progress: [{ legId: "a", transferredUnits: 0, committedMinor: 0 }],
    pendingMinor: 100000, committedMinor: 0, reservedSlots: 1, committedSlots: 0 });
});
test("partial Fill transfers exact units at actual premium and releases only proven improvement", () => {
  assert.deepEqual(entryProjectionFromFills(requirement(), "entry", [fill()]), { progress: [{ legId: "a", transferredUnits: 4, committedMinor: 36000 }],
    pendingMinor: 60000, committedMinor: 36000, reservedSlots: 0, committedSlots: 1 });
});
test("multiple Fill delivery orders yield identical exact economics", () => {
  const fills = [fill(), fill("f2", 3, 9500)]; const result = entryProjectionFromFills(requirement(), "entry", fills);
  assert.equal(result.pendingMinor, 30000); assert.equal(result.committedMinor, 64500);
  assert.deepEqual(entryProjectionFromFills(requirement(), "entry", fills.reverse()), result);
});
test("multiple BUY legs preserve separate pending risk and share one committed slot", () => {
  const result = entryProjectionFromFills(requirement(true), "entry", [fill(), fill("f2", 3, 9500, "b")]);
  assert.equal(result.pendingMinor, 130000); assert.equal(result.committedMinor, 64500); assert.equal(result.committedSlots, 1);
  assert.deepEqual(result.progress.map(p => p.transferredUnits), [4, 3]);
});
test("full Fill above authorized limit remains truth with zero pending risk", () => {
  const result = entryProjectionFromFills(requirement(), "entry", [fill("f1", 10, 10500)]);
  assert.equal(result.pendingMinor, 0); assert.equal(result.committedMinor, 105000); assert.equal(result.committedSlots, 1);
});
test("zero-premium executed units still consume a committed position slot", () => {
  const result = entryProjectionFromFills(requirement(), "entry", [fill("f1", 10, 0)]);
  assert.equal(result.committedMinor, 0); assert.equal(result.pendingMinor, 0); assert.equal(result.committedSlots, 1);
});
test("Fill premium overflow rejects checked conversion", () => {
  assert.throws(() => entryProjectionFromFills(requirement(), "entry", [fill("f1", 2, Number.MAX_SAFE_INTEGER)]), /OVERFLOW/);
});
for (const quantity of [-1, 0, 1.5, 11]) test(`invalid or excess transferred units ${quantity} cannot create negative pending risk`, () => {
  assert.throws(() => entryProjectionFromFills(requirement(), "entry", [fill("f1", quantity)]));
});
test("fractional paise and unsupported SELL truth cannot enter BUY risk projection", () => {
  assert.throws(() => entryProjectionFromFills(requirement(), "entry", [fill("f1", 1, 0.5)]));
  assert.throws(() => entryProjectionFromFills(requirement(), "entry", [{ ...fill(), side: "SELL" }]));
});
test("duplicate and foreign Fill identities fail closed", () => {
  assert.throws(() => entryProjectionFromFills(requirement(), "entry", [fill(), fill()]), /RISK_PROJECTION_MISMATCH/);
  for (const override of [{ intentId: "other" }, { legId: "other" }, { contractKey: "NFO:other" }])
    assert.throws(() => entryProjectionFromFills(requirement(), "entry", [{ ...fill(), ...override }]), /STALE_EXECUTION_CHAIN/);
});
test("progress cannot invent committed premium without transferred units", () => {
  assert.throws(() => entryProjection(requirement(), [{ legId: "a", transferredUnits: 0, committedMinor: 1 }]), /RISK_PROJECTION_MISMATCH/);
});
