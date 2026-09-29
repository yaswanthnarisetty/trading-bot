/** Explicit fixture smoke. No broker credentials, API calls or financial persistence. */
import assert from "node:assert/strict";
import { historicalFixture, fixtureParams } from "../tests/fixtures/historicalReplay";
import { runHistoricalBacktest } from "../src/services/BacktestService";

async function run() {
  const data = await historicalFixture();
  const result = await runHistoricalBacktest(fixtureParams(data), {
    provider: { load: async () => data }, runTimestamp: "2026-09-30T12:00:00.000Z",
  });
  assert.equal(result.totalTrades, 1);
  assert.equal(result.netPnL, result.trades.reduce((sum, trade) => sum + trade.pnlMinor, 0) / 100);
  assert.equal(result.equityCurve[result.equityCurve.length - 1]!.equity, result.finalCapital);
  assert.ok(result.decisions.every(d => d.evaluatedAt >= result.from && d.evaluatedAt <= result.to));
  assert.ok(result.trades.every(t => t.entryTimestamp < t.exitTimestamp));
  console.log(JSON.stringify({ source: result.provider, status: result.status,
    strategyVersion: result.metadata.strategyEvaluatorVersion, dateRange: [result.from, result.to],
    decisions: result.decisions.length, trades: result.totalTrades, grossPnL: result.grossPnL,
    slippage: result.slippageCost, pnlExcludingCharges: result.netPnL, finalCapital: result.finalCapital,
    finalEquity: result.equityCurve[result.equityCurve.length - 1]!.equity,
    firstDecision: result.decisions[0], trade: result.trades[0] }, null, 2));
}
run().catch(error => { console.error(error instanceof Error ? error.message : "BACKTEST_SMOKE_FAILED"); process.exitCode = 1; });
