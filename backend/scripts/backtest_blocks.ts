/**
 * Diagnostic: run backtest and print block reason breakdown + P&L.
 */
import { runHistoricalBacktest } from "../src/services/BacktestService";

const API_KEY      = "1elbgsxv3vhjfre0";
const ACCESS_TOKEN = "dj77CwtR1rRjA2t1QFSXcbMV2HDfbKE6";

async function run() {
  const result = await runHistoricalBacktest({
    asset: "NIFTY",
    from: "2026-02-02T03:45:00.000Z",
    to:   "2026-03-09T10:00:00.000Z",
    interval: "5minute",
    initialCapital: 200_000,
    riskPerTradePct: 4,
    targetProfitPct: 0.5,
    stopLossPct: 0.5,
    maxHoldingBars: 12,
    directionalStopMult: 3.0,
    apiKey: API_KEY,
    accessToken: ACCESS_TOKEN,
  });

  const br = result.blockReasons;
  const total = result.totalSignals;

  console.log("\n=== BACKTEST BLOCK REASON BREAKDOWN ===");
  console.log(`Total non-HOLD signals:  ${total}`);
  console.log(`Trades executed:         ${result.totalTrades}`);
  console.log(`Total blocked:           ${result.totalBlocked}`);
  console.log(`Net P&L:                 ₹${result.netPnL.toFixed(0)}`);
  console.log(`Win rate:                ${result.winRate.toFixed(1)}%`);
  console.log(`Max DD:                  ₹${result.maxDrawdown.toFixed(0)}`);
  console.log();
  console.log("--- Block reasons ---");

  const rows: [string, number][] = [
    ["opening_volatility",  br.opening_volatility],
    ["high_volatility_atr", br.high_volatility_atr],
    ["rsi_exhausted",       br.rsi_exhausted],
    ["weak_momentum",       br.weak_momentum],
    ["low_volume",          br.low_volume],
    ["pcr_extreme",         br.pcr_extreme],
    ["insufficient_credit", br.insufficient_credit],
    ["duplicate_strategy",  br.duplicate_strategy],
    ["same_direction_open", br.same_direction_open],
    ["daily_limit",         br.daily_limit],
    ["max_positions",       br.max_positions],
  ];

  for (const [reason, count] of rows) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${reason.padEnd(22)} ${String(count).padStart(4)}  (${pct}%)`);
  }
}

run().catch(console.error);
