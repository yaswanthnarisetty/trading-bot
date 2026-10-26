import { test } from "node:test";
import assert from "node:assert/strict";
import { kitePaperBuyLimitMinor } from "../../src/domain/paperBuyLimit";

test("Kite PAPER buy limit rounds a one-percent ask allowance up to the contract tick", () => {
  assert.equal(kitePaperBuyLimitMinor(23_900, 5), 24_140);
  assert.equal(kitePaperBuyLimitMinor(16_850, 5), 17_020);
  assert.equal(kitePaperBuyLimitMinor(101, 5), 105);
});

test("Kite PAPER buy limit rejects invalid or overflowing prices", () => {
  for (const [ask, tick] of [[0, 5], [100, 0], [1.5, 5], [100, 2.5], [Number.MAX_SAFE_INTEGER, 5]])
    assert.throws(() => kitePaperBuyLimitMinor(ask, tick));
});
