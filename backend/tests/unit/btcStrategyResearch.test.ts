import test from "node:test";
import assert from "node:assert/strict";
import { backtestBtcResearchStrategy, btcHoldoutPasses, decideBtcResearchStrategy,
  selectBtcResearchCandidate, type BtcResearchResult } from "../../src/services/BtcStrategyResearchService";
import type { OHLCV } from "../../src/types/trading";

const intervalMs = 300_000;
const start = 1_700_000_100_000;
const product = { id: 84, symbol: "BTCUSD" as const, contractValueBtc: 0.001, tickSize: 0.1 };
const prior: OHLCV[] = Array.from({ length: 120 }, (_, i) => {
  const open = 80_000 + i * 5, close = open + 3;
  return { timestamp: new Date(start + i * intervalMs), open, close,
    high: close + 1, low: open - 1, volume: i === 119 ? 100 : 10 };
});

test("breakout decision uses completed bars and next-bar stop wins an ambiguous intrabar race", () => {
  const decision = decideBtcResearchStrategy("DONCHIAN_TREND", prior);
  assert.equal(decision?.side, "LONG");
  const entry = prior[119]!.close;
  const ambiguous: OHLCV = { timestamp: new Date(start + 120 * intervalMs), open: entry,
    high: entry + 100, low: entry - 100, close: entry + 50, volume: 10 };
  const input = { bars: [...prior, ambiguous], product, strategy: "DONCHIAN_TREND" as const,
    startIndex: 120, endIndex: 121, intervalMs, startingEquityUsd: 160, costBpsRoundTrip: 30 };
  const result = backtestBtcResearchStrategy(input);
  assert.equal(result.trades, 1);
  assert.equal(result.losses, 1);
  assert.ok(result.netPnlUsd < 0);
  const future: OHLCV = { ...ambiguous, timestamp: new Date(start + 121 * intervalMs),
    high: entry + 1000, low: 1, close: 1 };
  assert.deepEqual(backtestBtcResearchStrategy({ ...input, bars: [...input.bars, future] }), result);
});

test("minimum contract and cost budget prevent an oversized historical trade", () => {
  const entry = prior[119]!.close;
  const bar: OHLCV = { timestamp: new Date(start + 120 * intervalMs), open: entry,
    high: entry + 10, low: entry - 10, close: entry, volume: 10 };
  const result = backtestBtcResearchStrategy({ bars: [...prior, bar],
    product: { ...product, contractValueBtc: 0.1 }, strategy: "DONCHIAN_TREND",
    startIndex: 120, endIndex: 121, intervalMs, startingEquityUsd: 160, costBpsRoundTrip: 30 });
  assert.equal(result.signals, 1);
  assert.equal(result.skippedForRisk, 1);
  assert.equal(result.trades, 0);
});

test("selection and final gate refuse losses, duplicate cost assumptions and thin evidence", () => {
  const sample: BtcResearchResult = { strategy: "DONCHIAN_TREND", intervalMs: 300_000,
    costBpsRoundTrip: 30, bars: 2000, qualifiedBars: 2000, signals: 30, trades: 20,
    skippedForRisk: 0, wins: 12, losses: 8, netPnlUsd: 2, endingEquityUsd: 162,
    profitFactor: 1.4, maxDrawdownPct: 2 };
  assert.equal(selectBtcResearchCandidate([{ strategy: "DONCHIAN_TREND",
    train: [sample, { ...sample, intervalMs: 900_000 }],
    validation: [sample, { ...sample, intervalMs: 900_000, netPnlUsd: -1 }] }]), null);
  assert.equal(selectBtcResearchCandidate([{ strategy: "DONCHIAN_TREND",
    train: [sample, { ...sample, intervalMs: 900_000 }],
    validation: [{ ...sample, strategy: "EMA_PULLBACK" }, { ...sample, intervalMs: 900_000 }] }]), null);
  assert.equal(selectBtcResearchCandidate([{ strategy: "DONCHIAN_TREND",
    train: [sample, { ...sample, intervalMs: 900_000 }],
    validation: [{ ...sample, costBpsRoundTrip: 0 }, { ...sample, intervalMs: 900_000 }] }]), null);
  assert.equal(btcHoldoutPasses([sample, sample, sample, sample]), false);
  assert.equal(btcHoldoutPasses([sample, { ...sample, costBpsRoundTrip: 60 },
    { ...sample, intervalMs: 3_600_000 }, { ...sample, intervalMs: 3_600_000, costBpsRoundTrip: 60 }]), false);
  assert.equal(btcHoldoutPasses([sample, { ...sample, costBpsRoundTrip: 60 },
    { ...sample, intervalMs: 900_000 }, { ...sample, intervalMs: 900_000, costBpsRoundTrip: 60 }]), true);
});
