import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateEntryRisk, EntryRiskError } from "../../src/domain/entryRisk";

const targets = () => [{ legId: "long", contractKey: "NFO:option-1", side: "BUY", targetUnits: 10 }];
const plan = () => ({ kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: new Date("2026-09-11T05:00:00Z"),
  legs: [{ legId: "long", contractKey: "NFO:option-1", instrumentKind: "NSE_OPTION", optionType: "CALL",
    expiry: new Date("2026-09-12T10:00:00Z"), qualificationRef: "instrument-snapshot-1", lotSizeUnits: 5, tickSizeMinor: 5, limitPriceMinor: 1000 }] });
const rejects = (work: () => unknown, reason = "INVALID_RISK_ECONOMICS") =>
  assert.throws(work, (error: unknown) => error instanceof EntryRiskError && error.reason === reason);

test("entry risk: exact BUY-only premium, multiple independent long legs, deterministic canonical replay", () => {
  assert.equal(calculateEntryRisk(targets(), plan()).requiredRiskMinor, 10000);
  const ts = [...targets(), { ...targets()[0], legId: "put", contractKey: "NFO:option-2", targetUnits: 5 }];
  const p = plan(); p.legs.push({ ...p.legs[0], legId: "put", contractKey: "NFO:option-2", optionType: "PUT", limitPriceMinor: 1500 });
  const result = calculateEntryRisk(ts, p); assert.equal(result.requiredRiskMinor, 17500);
  assert.deepEqual(calculateEntryRisk(ts.reverse(), { ...p, legs: p.legs.slice().reverse() }), result);
});
for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`entry risk: rejects quantity ${quantity}`, () => {
  rejects(() => calculateEntryRisk([{ ...targets()[0], targetUnits: quantity }], plan()));
});
for (const price of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`entry risk: rejects LIMIT price ${price}`, () => {
  const p = plan(); p.legs[0].limitPriceMinor = price; rejects(() => calculateEntryRisk(targets(), p));
});
test("entry risk: exact product overflow is rejected before Number conversion", () => {
  const p = plan(); p.legs[0].lotSizeUnits = 1; p.legs[0].tickSizeMinor = 1; p.legs[0].limitPriceMinor = 2;
  rejects(() => calculateEntryRisk([{ ...targets()[0], targetUnits: Number.MAX_SAFE_INTEGER }], p), "RISK_ARITHMETIC_OVERFLOW");
});
test("entry risk: naked and apparently hedged shorts remain unsupported", () => {
  rejects(() => calculateEntryRisk([{ ...targets()[0], side: "SELL" }], plan()), "UNSUPPORTED_RISK_SHAPE");
  rejects(() => calculateEntryRisk([...targets(), { ...targets()[0], legId: "short", side: "SELL" }], plan()), "UNSUPPORTED_RISK_SHAPE");
});
test("entry risk: malformed, mismatched and duplicate legs fail closed", () => {
  rejects(() => calculateEntryRisk([], plan()));
  rejects(() => calculateEntryRisk(targets(), undefined));
  rejects(() => calculateEntryRisk(targets(), { ...plan(), legs: [] }));
  rejects(() => calculateEntryRisk([{ ...targets()[0], contractKey: "wrong" }], plan()));
  rejects(() => calculateEntryRisk([...targets(), ...targets()], { ...plan(), legs: [...plan().legs, ...plan().legs] }));
});
test("entry risk: qualified tick and lot constraints are exact", () => {
  const p = plan(); p.legs[0].limitPriceMinor = 1001;
  rejects(() => calculateEntryRisk(targets(), p));
  rejects(() => calculateEntryRisk([{ ...targets()[0], targetUnits: 11 }], plan()));
});
