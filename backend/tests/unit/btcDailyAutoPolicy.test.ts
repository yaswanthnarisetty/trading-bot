import test from "node:test";
import assert from "node:assert/strict";
import { btcThreeLossCooldownActive } from "../../src/domain/btcDailyAutoPolicy";

test("three daily losses pause entries for the following three UTC dates", () => {
  const close = new Date("2026-10-12T23:59:00.000Z");
  const losses = [{ realizedPnlUsd: -0.5, updatedAt: close },
    { realizedPnlUsd: -0.2, updatedAt: new Date("2026-10-11T18:00:00.000Z") },
    { realizedPnlUsd: -0.1, updatedAt: new Date("2026-10-10T18:00:00.000Z") }];
  assert.equal(btcThreeLossCooldownActive(losses, Date.parse("2026-10-13T00:01:00Z")), true);
  assert.equal(btcThreeLossCooldownActive(losses, Date.parse("2026-10-15T23:59:00Z")), true);
  assert.equal(btcThreeLossCooldownActive(losses, Date.parse("2026-10-16T00:00:00Z")), false);
  assert.equal(btcThreeLossCooldownActive([{ ...losses[0]!, realizedPnlUsd: 1 }, ...losses.slice(1)],
    Date.parse("2026-10-13T00:01:00Z")), false);
});
