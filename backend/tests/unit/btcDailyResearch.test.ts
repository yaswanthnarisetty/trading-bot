import test from "node:test";
import assert from "node:assert/strict";
import { backtestBtcDailyBreakout, decideBtcDailyBreakout } from "../../src/services/BtcDailyResearchService";
import type { OHLCV } from "../../src/types/trading";

const day = 86_400_000;
const start = Date.UTC(2024, 0, 1);
const product = { id: 84, symbol: "BTCUSD" as const, contractValueBtc: 0.001, tickSize: 0.1 };

function risingBars(count: number): OHLCV[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 80_000 + i * 10;
    return { timestamp: new Date(start + i * day), open, high: open + 12,
      low: open - 5, close: open + 10, volume: 10 };
  });
}

test("daily breakout uses only completed bars and anchors its stop beyond the prior day's low", () => {
  const prior = risingBars(60);
  const decision = decideBtcDailyBreakout(prior);
  assert.equal(decision?.side, "LONG");
  assert.ok(decision!.stopReferenceUsd < prior[59]!.low);
  assert.throws(() => decideBtcDailyBreakout(risingBars(61)), /BTC_DAILY_WINDOW_REQUIRED/);
});

test("an ambiguous daily stop and target hits the stop first, including costs", () => {
  const bars = risingBars(65);
  bars[60] = { ...bars[60]!, low: bars[59]!.low - 20, high: bars[60]!.open + 100 };
  const result = backtestBtcDailyBreakout({ bars, product, startIndex: 60, endIndex: 65,
    startingEquityUsd: 1_000, costBpsRoundTrip: 30 });
  assert.equal(result.trades, 1);
  assert.equal(result.losses, 1);
  assert.ok(result.netPnlUsd < 0);
});

test("a gap through the stop uses the worse open and can exceed estimated risk", () => {
  const bars = risingBars(66);
  bars[60] = { ...bars[60]!, high: bars[60]!.open + 5,
    low: bars[60]!.open - 5, close: bars[60]!.open };
  bars[61] = { ...bars[61]!, open: 79_000, high: 79_100,
    low: 78_900, close: 79_000 };
  const result = backtestBtcDailyBreakout({ bars, product, startIndex: 60, endIndex: 66,
    startingEquityUsd: 1_000, costBpsRoundTrip: 30 });
  assert.equal(result.trades, 1);
  assert.ok(result.netPnlUsd < -5);
});

test("three consecutive losing trades suspend entry for the next three UTC days", () => {
  const bars = risingBars(69);
  for (let i = 60; i < bars.length; i++)
    bars[i] = { ...bars[i]!, low: bars[59]!.low - (i - 59) * 200 };
  const result = backtestBtcDailyBreakout({ bars, product, startIndex: 60, endIndex: 69,
    startingEquityUsd: 1_000_000, costBpsRoundTrip: 30 });
  assert.equal(result.losses, 3);
  assert.equal(result.trades, 3);
  assert.equal(result.skippedCooldownDays, 3);
});

test("a small account cannot force one contract through the 0.5% risk cap", () => {
  const bars = risingBars(65);
  bars[59] = { ...bars[59]!, low: 70_000 };
  const result = backtestBtcDailyBreakout({ bars, product, startIndex: 60, endIndex: 65,
    startingEquityUsd: 158, costBpsRoundTrip: 30 });
  assert.equal(result.trades, 0);
  assert.equal(result.skippedForRisk, 1);
  assert.ok(result.minimumEquityForOneObservedSignalUsd! > 158);
});

test("gapped daily candles fail closed before evaluating any trade", () => {
  const bars = risingBars(65);
  bars[40] = { ...bars[40]!, timestamp: new Date(start + 39 * day) };
  assert.throws(() => backtestBtcDailyBreakout({ bars, product, startIndex: 60, endIndex: 65,
    startingEquityUsd: 1_000, costBpsRoundTrip: 30 }), /BTC_DAILY_BARS_INVALID_OR_GAPPED/);
});
