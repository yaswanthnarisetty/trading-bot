import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyLossReached, dailyPnl, realizedDays, realizedPosition, releaseRisk, signedMinor, tradingDay } from "../../src/domain/realizedRisk";
const calendar = { kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" };
const f = (id: string, side: "BUY" | "SELL", units: number, price: number, date = "2026-09-11T04:00:00Z") => ({
  fillId: id, intentId: side === "BUY" ? "entry" : "close", legId: "a", brokerNamespace: "PAPER", brokerTradeKey: id,
  quantityUnits: units, priceMinor: price, side, executedAt: new Date(date),
});
for (const [price, pnl] of [[12000, 20000], [7000, -30000]]) test(`realized close ${price} produces signed ${pnl}`, () => {
  assert.equal(realizedPosition("entry", [f("e", "BUY", 10, 10000), f("c", "SELL", 10, price)]).realizedPnlMinor, pnl);
});
test("partial close uses weighted-average cost and exact cumulative paise allocation", () => {
  const entries = [f("e1", "BUY", 1, 100), f("e2", "BUY", 2, 101)];
  const closes = [f("c1", "SELL", 1, 100), f("c2", "SELL", 1, 100), f("c3", "SELL", 1, 100)];
  assert.equal(realizedPosition("entry", [...entries, closes[0]]).realizedPnlMinor, 0);
  assert.equal(realizedPosition("entry", [...entries, ...closes.slice(0, 2)]).realizedPnlMinor, -1);
  const result = realizedPosition("entry", [...entries, ...closes]);
  assert.deepEqual(result.realizations.map(r => r.pnlMinor), [0, -1, -1]); assert.equal(result.realizedPnlMinor, -2);
  assert.deepEqual(realizedPosition("entry", [...closes.reverse(), ...entries.reverse()]), result);
});
test("daily signed totals use Fill execution dates and aggregate winners with losers", () => {
  const days = realizedDays([{ executedAt: new Date("2026-09-11T04:00Z"), pnlMinor: -40000 },
    { executedAt: new Date("2026-09-11T05:00Z"), pnlMinor: 10000 }, { executedAt: new Date("2026-09-11T19:00Z"), pnlMinor: 5000 }], calendar);
  assert.deepEqual(days, [{ tradingDay: "2026-09-11", realizedPnlMinor: -30000 }, { tradingDay: "2026-09-12", realizedPnlMinor: 5000 }]);
  assert.equal(dailyPnl(days, "2026-09-13"), 0);
});
test("daily loss rejects at equality, preserves gains, and rejects beyond threshold", () => {
  assert.equal(dailyLossReached(-59999, 60000), false); assert.equal(dailyLossReached(-60000, 60000), true);
  assert.equal(dailyLossReached(-70000, 60000), true); assert.equal(dailyLossReached(60000, 60000), false);
});
test("day key requires qualified timezone and respects local midnight", () => {
  assert.equal(tradingDay(calendar, new Date("2026-09-11T18:29:59Z")), "2026-09-11");
  assert.equal(tradingDay(calendar, new Date("2026-09-11T18:30:00Z")), "2026-09-12");
  for (const bad of [undefined, { kind: "LOCAL_DATE_V1", timeZone: "bad/zone" }]) assert.throws(() => tradingDay(bad, new Date()), /TRADING_DAY_CONFIG_REQUIRED/);
  assert.throws(() => tradingDay(calendar, new Date("invalid")));
});
test("realized profit and daily aggregate overflow fail before conversion", () => {
  assert.throws(() => realizedPosition("entry", [f("e", "BUY", 2, 1), f("c", "SELL", 2, Number.MAX_SAFE_INTEGER)]), /OVERFLOW/);
  assert.throws(() => signedMinor(BigInt(Number.MIN_SAFE_INTEGER) - 1n), /OVERFLOW/);
  assert.throws(() => realizedDays([1, 2].map(() => ({ executedAt: new Date(), pnlMinor: Number.MAX_SAFE_INTEGER })), calendar), /OVERFLOW/);
});
test("over-close, fractional paise, duplicate evidence and SELL entry fail closed", () => {
  assert.throws(() => realizedPosition("entry", [f("e", "BUY", 1, 100), f("c", "SELL", 2, 100)]), /OVER_CLOSE/);
  assert.throws(() => realizedPosition("entry", [f("e", "BUY", 1, 0.5)]));
  assert.throws(() => realizedPosition("entry", [f("e", "BUY", 1, 100), f("e", "BUY", 1, 100)]), /DUPLICATE/);
  assert.throws(() => realizedPosition("close", [f("e", "SELL", 1, 100)]), /UNSUPPORTED/);
});
const current = { pending: 60000, committed: 46000, slots: 2, committedSlots: 2 };
test("settlement subtracts only owned pending, premium and one slot", () => {
  assert.deepEqual(releaseRisk(current, { pending: 60000, committed: 36000, reservedSlots: 0, committedSlots: 1 }),
    { pending: 0, committed: 10000, slots: 1, committedSlots: 1 });
});
test("settlement cannot release excess committed risk", () => {
  assert.throws(() => releaseRisk(current, { pending: 0, committed: 46001, reservedSlots: 0, committedSlots: 1 }));
});
test("settlement cannot release excess pending risk", () => {
  assert.throws(() => releaseRisk(current, { pending: 60001, committed: 0, reservedSlots: 0, committedSlots: 1 }));
});
test("settlement cannot release more than one slot or an unowned slot", () => {
  assert.throws(() => releaseRisk(current, { pending: 0, committed: 0, reservedSlots: 0, committedSlots: 2 }));
  assert.throws(() => releaseRisk({ ...current, slots: 0, committedSlots: 0 }, { pending: 0, committed: 0, reservedSlots: 0, committedSlots: 1 }));
});
