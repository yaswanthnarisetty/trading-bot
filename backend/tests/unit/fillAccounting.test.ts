import { test } from "node:test";
import assert from "node:assert/strict";
import { fillAccounting } from "../../src/domain/fillAccounting";
const fill = (quantityUnits: number, priceMinor: number, side: "BUY" | "SELL" = "BUY", intentId = "entry") => ({ quantityUnits, priceMinor, side, intentId });
test("entry cost basis is exact paise numerator, independent of order and signed side", () => {
  const fills = [fill(3, 101), fill(2, 102)];
  assert.deepEqual(fillAccounting(fills, "entry"), { entryNotionalMinor: 507, netQuantityUnits: 5 });
  assert.deepEqual(fillAccounting(fills.reverse(), "entry"), { entryNotionalMinor: 507, netQuantityUnits: 5 });
  assert.deepEqual(fillAccounting([fill(3, 101, "SELL")], "entry"), { entryNotionalMinor: 303, netQuantityUnits: -3 });
});
test("existing exit evidence changes signed units but preserves gross opening cost, with no realized PnL", () => {
  assert.deepEqual(fillAccounting([fill(3, 101), fill(2, 120, "SELL", "exit")], "entry"), { entryNotionalMinor: 303, netQuantityUnits: 1 });
});
test("exact accounting supports safe bounds and rejects product, sum and unit overflow", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(fillAccounting([fill(1, max)], "entry").entryNotionalMinor, max);
  for (const fills of [[fill(2, max)], [fill(1, max), fill(1, 1)], [fill(max, 0), fill(1, 0)]])
    assert.throws(() => fillAccounting(fills, "entry"), /OVERFLOW/);
});
test("accounting rejects fractional, negative and unsafe financial inputs", () => {
  for (const bad of [fill(0, 1), fill(1.1, 1), fill(1, -1), fill(1, 0.1), fill(1, Infinity), fill(Number.MAX_SAFE_INTEGER + 1, 0)])
    assert.throws(() => fillAccounting([bad], "entry"), /INVALID_FILL_ACCOUNTING/);
});
