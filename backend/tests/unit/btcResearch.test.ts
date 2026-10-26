import test from "node:test";
import assert from "node:assert/strict";
import { backtestBtcDemoStrategy, btcDemoStrategyMeetsResearchGate } from "../../src/services/BtcResearchService";
import { evaluateCryptoSignalFromClosedCandles } from "../../src/services/CryptoSignalService";
import type { OHLCV } from "../../src/types/trading";

const product = { id: 84, symbol: "BTCUSD" as const, contractValueBtc: 0.001, tickSize: 0.1 };
const first = 1_700_000_040_000;

test("research signal can be evaluated from completed bars without network calls", () => {
  let price = 100;
  const bars: OHLCV[] = Array.from({ length: 50 }, (_, i) => {
    const open = price;
    price += i % 2 ? -0.8 : 1;
    return { timestamp: new Date(first + i * 60_000), open, close: price,
      high: Math.max(open, price) + 0.5, low: Math.min(open, price) - 0.5,
      volume: i === 49 ? 30 : 10 };
  });
  const signal = evaluateCryptoSignalFromClosedCandles("BTCUSD", bars, new Date(first + 50 * 60_000).toISOString());
  assert.equal(signal.side, "LONG");
  assert.ok(signal.confidence >= 0.6);

  const entry: OHLCV = { timestamp: new Date(first + 50 * 60_000), open: price,
    high: price + 1, low: price - 1, close: price + 0.5, volume: 10 };
  const future: OHLCV = { timestamp: new Date(first + 51 * 60_000), open: price + 0.5,
    high: price + 100, low: price - 100, close: price + 50, volume: 10 };
  const baseline = backtestBtcDemoStrategy([...bars, entry, future], product, 50, 51, 160);
  const changedFuture = { ...future, high: price + 1000, low: 1, close: 1 };
  assert.deepEqual(backtestBtcDemoStrategy([...bars, entry, changedFuture], product, 50, 51, 160), baseline);
  assert.equal(baseline.trades, 1);
});

test("research refuses to fabricate entries from gapped or flat evidence", () => {
  const flat: OHLCV[] = Array.from({ length: 60 }, (_, i) => ({ timestamp: new Date(first + i * 60_000),
    open: 100, high: 101, low: 99, close: 100, volume: 10 }));
  assert.equal(backtestBtcDemoStrategy(flat, product, 50, 60, 160).trades, 0);
  flat[25] = { ...flat[25]!, timestamp: new Date(first + 26 * 60_000) };
  assert.equal(backtestBtcDemoStrategy(flat, product, 50, 51, 160).qualifiedBars, 0);
});

test("strategy gate requires two distinct profitable held-out intervals after costs", () => {
  const one = { intervalMs: 60_000, startingEquityUsd: 100, endingEquityUsd: 103,
    netPnlUsd: 3, bars: 3000, qualifiedBars: 3000, actionableSignals: 30,
    trades: 25, wins: 15, losses: 10, winRate: 0.6, profitFactor: 1.3,
    maxDrawdownPct: 2, costAllowanceBpsRoundTrip: 30 };
  assert.equal(btcDemoStrategyMeetsResearchGate([one, one]), false);
  assert.equal(btcDemoStrategyMeetsResearchGate([one, { ...one, intervalMs: 300_000 }]), true);
  assert.equal(btcDemoStrategyMeetsResearchGate([one, { ...one, intervalMs: 300_000, netPnlUsd: -1 }]), false);
  assert.equal(btcDemoStrategyMeetsResearchGate([one, { ...one, intervalMs: 300_000, costAllowanceBpsRoundTrip: 10 }]), false);
});
