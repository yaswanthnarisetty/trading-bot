// Read-only Delta Demo research. Usage from backend/: node -r ts-node/register -r dotenv/config scripts/btcResearch.cjs
const { getDeltaDemoAccount, getDeltaDemoProduct } = require("../src/services/DeltaService");
const { backtestBtcDemoStrategy } = require("../src/services/BtcResearchService");

async function run() {
  const resolution = process.env.BTC_RESEARCH_RESOLUTION || "1m";
  const seconds = { "1m": 60, "5m": 300, "15m": 900 }[resolution];
  if (!seconds) throw new Error("BTC_RESEARCH_RESOLUTION_UNSUPPORTED");
  const intervalMs = seconds * 1000;
  const [account, product] = await Promise.all([getDeltaDemoAccount(), getDeltaDemoProduct()]);
  const end = Math.floor(Date.now() / intervalMs) * seconds;
  const start = end - 30 * 24 * 60 * 60;
  const byTime = new Map();
  for (let from = start; from < end; from += 1800 * seconds) {
    const until = Math.min(from + 1800 * seconds, end);
    const query = new URLSearchParams({ symbol: "BTCUSD", resolution, start: String(from), end: String(until) });
    const response = await fetch(`https://cdn-ind.testnet.deltaex.org/v2/history/candles?${query}`, {
      headers: { Accept: "application/json", "User-Agent": "trading-bot-demo/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`DELTA_HISTORY_HTTP_${response.status}`);
    const body = await response.json();
    if (body?.success !== true || !Array.isArray(body.result)) throw new Error("DELTA_HISTORY_INVALID");
    for (const c of body.result) {
      const timestamp = Number(c.time) * 1000;
      if (timestamp < start * 1000 || timestamp >= end * 1000) continue;
      const bar = { timestamp: new Date(timestamp), open: Number(c.open), high: Number(c.high),
        low: Number(c.low), close: Number(c.close), volume: Number(c.volume) };
      if (!Number.isFinite(timestamp) || timestamp % intervalMs !== 0 ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.volume < 0)
        throw new Error("DELTA_HISTORY_MALFORMED_BAR");
      const previous = byTime.get(timestamp);
      if (previous && JSON.stringify(previous) !== JSON.stringify(bar)) throw new Error("DELTA_HISTORY_CONFLICTING_DUPLICATE");
      byTime.set(timestamp, bar);
    }
  }
  const bars = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (bars.length < 1000) throw new Error("DELTA_HISTORY_INSUFFICIENT");
  let missingBars = (bars[0].timestamp.getTime() - start * 1000) / intervalMs
    + (end * 1000 - bars.at(-1).timestamp.getTime()) / intervalMs - 1;
  for (let i = 1; i < bars.length; i++) missingBars += (bars[i].timestamp - bars[i - 1].timestamp) / intervalMs - 1;
  const split = Math.floor(bars.length * 0.7);
  const train = backtestBtcDemoStrategy(bars, product, 50, split, account.equity, intervalMs);
  const test = backtestBtcDemoStrategy(bars, product, split, bars.length, account.equity, intervalMs);
  const zeroCost = backtestBtcDemoStrategy(bars, product, split, bars.length, account.equity, intervalMs, 0);
  const tenBpsCost = backtestBtcDemoStrategy(bars, product, split, bars.length, account.equity, intervalMs, 10);
  const timeframePassed = missingBars === 0 && train.trades >= 30 && test.trades >= 20 &&
    train.netPnlUsd > 0 && test.netPnlUsd > 0 && test.profitFactor !== null && test.profitFactor >= 1.2 &&
    test.maxDrawdownPct <= 5;
  process.stdout.write(JSON.stringify({ source: `Delta Demo BTCUSD ${resolution}`, from: bars[0].timestamp.toISOString(),
    to: bars.at(-1).timestamp.toISOString(), bars: bars.length, missingBars, split: "70% earlier / 30% later",
    train, test, sensitivity: { outOfSampleZeroCostPnlUsd: zeroCost.netPnlUsd,
      outOfSampleTenBpsPnlUsd: tenBpsCost.netPnlUsd },
    timeframePassed, strategyValidated: false, executionEnabled: false }, null, 2) + "\n");
}

run().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
