import type { OHLCV } from "../types/trading";
import type { BtcDemoProduct } from "../domain/btcDemoPlan";
import { planBtcDemoTrade } from "../domain/btcDemoPlan";
import { evaluateCryptoSignalFromClosedCandles, isActionableSignal, qualifyClosedCryptoCandles } from "./CryptoSignalService";

export interface BtcBacktestResult {
  intervalMs: number;
  startingEquityUsd: number; endingEquityUsd: number; netPnlUsd: number;
  bars: number; qualifiedBars: number; actionableSignals: number; trades: number;
  wins: number; losses: number; winRate: number | null; profitFactor: number | null;
  maxDrawdownPct: number; costAllowanceBpsRoundTrip: number;
}

/** A report is advisory; a profitable replay cannot guarantee future returns. */
export function btcDemoStrategyMeetsResearchGate(results: readonly BtcBacktestResult[]): boolean {
  // Require an out-of-sample test at the conservative round-trip cost on
  // multiple timeframes. The current EMA/RSI/volume strategy fails this gate.
  return new Set(results.map(result => result.intervalMs)).size >= 2 && results.every(result =>
    result.costAllowanceBpsRoundTrip >= 30 && result.trades >= 20 &&
    result.netPnlUsd > 0 && result.profitFactor !== null && result.profitFactor >= 1.2 &&
    result.maxDrawdownPct <= 5 && result.endingEquityUsd > result.startingEquityUsd);
}

/** Historical research only. Entries use the next bar's open; ambiguous intrabar exits lose. */
export function backtestBtcDemoStrategy(
  bars: readonly OHLCV[], product: BtcDemoProduct, startIndex: number, endIndex: number,
  startingEquityUsd: number, intervalMs = 60_000, costBpsRoundTrip = 30
): BtcBacktestResult {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 50 ||
      endIndex > bars.length || startIndex >= endIndex || !Number.isFinite(startingEquityUsd) || startingEquityUsd <= 0 ||
      ![60_000, 300_000, 900_000].includes(intervalMs) ||
      !Number.isFinite(costBpsRoundTrip) || costBpsRoundTrip < 0 || costBpsRoundTrip > 100)
    throw new Error("BTC_BACKTEST_INPUT_INVALID");
  let equity = startingEquityUsd;
  let highWater = equity, maxDrawdownPct = 0, qualifiedBars = 0, actionableSignals = 0;
  let trades = 0, wins = 0, losses = 0, grossWins = 0, grossLosses = 0;
  let day = "", dayStartEquity = equity;
  for (let i = startIndex; i < endIndex;) {
    const entryBar = bars[i]!;
    const currentDay = entryBar.timestamp.toISOString().slice(0, 10);
    if (currentDay !== day) { day = currentDay; dayStartEquity = equity; }
    if (equity <= dayStartEquity * 0.98) { i++; continue; }
    let window: OHLCV[];
    try { window = qualifyClosedCryptoCandles(bars.slice(i - 50, i), entryBar.timestamp.getTime(), intervalMs); }
    catch { i++; continue; }
    qualifiedBars++;
    const signal = evaluateCryptoSignalFromClosedCandles("BTCUSD", window, entryBar.timestamp.toISOString());
    if (!isActionableSignal(signal)) { i++; continue; }
    actionableSignals++;
    const plan = planBtcDemoTrade({ side: signal.side as "LONG" | "SHORT", entryPrice: entryBar.open,
      atr: signal.atr, equityUsd: equity, product, openPositionCount: 0, activeOrderCount: 0 });
    if (!plan.eligible) { i++; continue; }
    const maxHoldingBars = Math.max(1, Math.floor(60 * 60_000 / intervalMs));
    const last = Math.min(i + maxHoldingBars - 1, endIndex - 1);
    let exit = last, exitPrice = bars[last]!.close;
    for (let j = i; j <= last; j++) {
      const bar = bars[j]!;
      const stopHit = signal.side === "LONG" ? bar.low <= plan.stopReferenceUsd : bar.high >= plan.stopReferenceUsd;
      const targetHit = signal.side === "LONG" ? bar.high >= plan.takeProfitReferenceUsd : bar.low <= plan.takeProfitReferenceUsd;
      if (stopHit) {
        exit = j;
        exitPrice = signal.side === "LONG"
          ? Math.min(bar.open, plan.stopReferenceUsd) : Math.max(bar.open, plan.stopReferenceUsd);
        break;
      }
      if (targetHit) { exit = j; exitPrice = plan.takeProfitReferenceUsd; break; }
    }
    const direction = signal.side === "LONG" ? 1 : -1;
    const gross = (exitPrice - entryBar.open) * direction * product.contractValueBtc * plan.contractCount;
    const roundTripCosts = plan.notionalUsd * costBpsRoundTrip / 10_000;
    const net = gross - roundTripCosts;
    equity += net; trades++;
    if (net > 0) { wins++; grossWins += net; } else { losses++; grossLosses -= net; }
    highWater = Math.max(highWater, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (highWater - equity) / highWater * 100);
    i = exit + 1;
  }
  return { intervalMs, startingEquityUsd, endingEquityUsd: equity, netPnlUsd: equity - startingEquityUsd,
    bars: endIndex - startIndex, qualifiedBars, actionableSignals, trades, wins, losses,
    winRate: trades ? wins / trades : null, profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    maxDrawdownPct, costAllowanceBpsRoundTrip: costBpsRoundTrip };
}
