import type { OHLCV } from "../types/trading";
import type { BtcDemoProduct } from "../domain/btcDemoPlan";

export type BtcResearchStrategy = "DONCHIAN_TREND" | "EMA_PULLBACK" | "TREND_CONTINUATION" | "RANGE_REVERSION";
export const BTC_RESEARCH_STRATEGIES: readonly BtcResearchStrategy[] =
  ["DONCHIAN_TREND", "EMA_PULLBACK", "TREND_CONTINUATION", "RANGE_REVERSION"];

type Side = "LONG" | "SHORT";
export interface BtcResearchDecision { side: Side; atr: number; stopAtr: number; targetAtr: number; maxHoldingHours: number }
export interface BtcResearchResult {
  strategy: BtcResearchStrategy; intervalMs: number; costBpsRoundTrip: number;
  bars: number; qualifiedBars: number; signals: number; trades: number; skippedForRisk: number;
  wins: number; losses: number; netPnlUsd: number; endingEquityUsd: number;
  profitFactor: number | null; maxDrawdownPct: number;
}

function ema(prices: readonly number[], period: number): number {
  let value = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  for (let i = period; i < prices.length; i++) value += (prices[i]! - value) * 2 / (period + 1);
  return value;
}

function rsi(prices: readonly number[]): number {
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    const change = prices[i]! - prices[i - 1]!;
    gain += Math.max(0, change); loss += Math.max(0, -change);
  }
  gain /= 14; loss /= 14;
  for (let i = 15; i < prices.length; i++) {
    const change = prices[i]! - prices[i - 1]!;
    gain = (gain * 13 + Math.max(0, change)) / 14;
    loss = (loss * 13 + Math.max(0, -change)) / 14;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function atr(bars: readonly OHLCV[]): number {
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!, previous = bars[i - 1]!;
    tr.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)));
  }
  let value = tr.slice(0, 14).reduce((sum, v) => sum + v, 0) / 14;
  for (let i = 14; i < tr.length; i++) value = (value * 13 + tr[i]!) / 14;
  return value;
}

/** Uses only the 120 completed bars supplied by the caller. No current/next bar enters the decision. */
export function decideBtcResearchStrategy(strategy: BtcResearchStrategy, completed: readonly OHLCV[]): BtcResearchDecision | null {
  if (completed.length !== 120) throw new Error("BTC_RESEARCH_WINDOW_REQUIRED");
  const closes = completed.map(bar => bar.close);
  const last = completed[119]!, previous = completed[118]!;
  const ema20 = ema(closes, 20), ema100 = ema(closes, 100);
  const previousEma20 = ema(closes.slice(0, -1), 20);
  const currentRsi = rsi(closes), currentAtr = atr(completed);
  const averageVolume = completed.slice(99, 119).reduce((sum, bar) => sum + bar.volume, 0) / 20;
  if (!Number.isFinite(currentAtr) || currentAtr <= 0 || !Number.isFinite(averageVolume) || averageVolume <= 0)
    return null;
  let side: Side | null = null;
  let stopAtr = 1.5, targetAtr = 3, maxHoldingHours = 6;
  if (strategy === "DONCHIAN_TREND") {
    const prior20 = completed.slice(99, 119);
    const high = Math.max(...prior20.map(bar => bar.high));
    const low = Math.min(...prior20.map(bar => bar.low));
    if (last.close > high && ema20 > ema100 && last.volume >= averageVolume * 1.1) side = "LONG";
    if (last.close < low && ema20 < ema100 && last.volume >= averageVolume * 1.1) side = "SHORT";
    stopAtr = 2; targetAtr = 4; maxHoldingHours = 8;
  } else if (strategy === "EMA_PULLBACK") {
    if (ema20 > ema100 && previous.close <= previousEma20 && last.close > ema20 &&
        currentRsi >= 45 && currentRsi <= 68 && last.volume >= averageVolume * 0.8) side = "LONG";
    if (ema20 < ema100 && previous.close >= previousEma20 && last.close < ema20 &&
        currentRsi >= 32 && currentRsi <= 55 && last.volume >= averageVolume * 0.8) side = "SHORT";
    stopAtr = 1.75; targetAtr = 3; maxHoldingHours = 6;
  } else if (strategy === "TREND_CONTINUATION") {
    if (ema20 > ema100 && last.close > ema20 && last.close > previous.close &&
        currentRsi >= 55 && currentRsi <= 68 && last.volume >= averageVolume * 1.2) side = "LONG";
    if (ema20 < ema100 && last.close < ema20 && last.close < previous.close &&
        currentRsi >= 32 && currentRsi <= 45 && last.volume >= averageVolume * 1.2) side = "SHORT";
    stopAtr = 1.5; targetAtr = 3; maxHoldingHours = 4;
  } else if (strategy === "RANGE_REVERSION") {
    if (Math.abs(ema20 - ema100) < currentAtr * 1.5) {
      if (currentRsi < 28 && last.close < ema20 - currentAtr * 1.5) side = "LONG";
      if (currentRsi > 72 && last.close > ema20 + currentAtr * 1.5) side = "SHORT";
    }
    stopAtr = 1.5; targetAtr = 1.75; maxHoldingHours = 4;
  } else throw new Error("BTC_RESEARCH_STRATEGY_UNKNOWN");
  return side ? { side, atr: currentAtr, stopAtr, targetAtr, maxHoldingHours } : null;
}

function validWindow(bars: readonly OHLCV[], from: number, intervalMs: number): boolean {
  for (let i = from; i < from + 120; i++) {
    const bar = bars[i]!, time = bar?.timestamp.getTime();
    if (!Number.isFinite(time) || time % intervalMs !== 0 ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0 || (i > from && time - bars[i - 1]!.timestamp.getTime() !== intervalMs)) return false;
  }
  return true;
}

/** Next-open entry, stop-first intrabar ordering, gap-aware stops, one position and 2% daily halt. */
export function backtestBtcResearchStrategy(input: {
  bars: readonly OHLCV[]; product: BtcDemoProduct; strategy: BtcResearchStrategy;
  startIndex: number; endIndex: number; intervalMs: number; startingEquityUsd: number;
  costBpsRoundTrip: number;
}): BtcResearchResult {
  const { bars, product, strategy, startIndex, endIndex, intervalMs, startingEquityUsd, costBpsRoundTrip } = input;
  if (!BTC_RESEARCH_STRATEGIES.includes(strategy) || !Number.isInteger(startIndex) || startIndex < 120 ||
      !Number.isInteger(endIndex) || endIndex > bars.length || endIndex <= startIndex ||
      ![300_000, 900_000, 3_600_000].includes(intervalMs) || !Number.isFinite(startingEquityUsd) || startingEquityUsd <= 0 ||
      !Number.isFinite(costBpsRoundTrip) || costBpsRoundTrip < 0 || costBpsRoundTrip > 100 ||
      !Number.isFinite(product.contractValueBtc) || product.contractValueBtc <= 0 ||
      !Number.isFinite(product.tickSize) || product.tickSize <= 0)
    throw new Error("BTC_RESEARCH_INPUT_INVALID");
  let equity = startingEquityUsd, highWater = equity, maxDrawdownPct = 0;
  let qualifiedBars = 0, signals = 0, trades = 0, skippedForRisk = 0, wins = 0, losses = 0;
  let grossWins = 0, grossLosses = 0, day = "", dayStartEquity = equity, dayTrades = 0, cooldownUntil = -1;
  for (let i = startIndex; i < endIndex;) {
    const currentDay = bars[i]!.timestamp.toISOString().slice(0, 10);
    if (currentDay !== day) { day = currentDay; dayStartEquity = equity; dayTrades = 0; }
    if (equity <= dayStartEquity * 0.98 || dayTrades >= 2 || i <= cooldownUntil) { i++; continue; }
    if (!validWindow(bars, i - 120, intervalMs)) { i++; continue; }
    qualifiedBars++;
    const decision = decideBtcResearchStrategy(strategy, bars.slice(i - 120, i));
    if (!decision) { i++; continue; }
    signals++;
    const entry = bars[i]!.open, tick = product.tickSize;
    const stopRaw = entry + (decision.side === "LONG" ? -1 : 1) * decision.atr * decision.stopAtr;
    const targetRaw = entry + (decision.side === "LONG" ? 1 : -1) * decision.atr * decision.targetAtr;
    const stop = (decision.side === "LONG" ? Math.floor(stopRaw / tick) : Math.ceil(stopRaw / tick)) * tick;
    const target = (decision.side === "LONG" ? Math.floor(targetRaw / tick) : Math.ceil(targetRaw / tick)) * tick;
    if (stop <= 0 || target <= 0 || !Number.isFinite(entry)) { skippedForRisk++; i++; continue; }
    const costPerContract = entry * product.contractValueBtc * costBpsRoundTrip / 10_000;
    const lossPerContract = Math.abs(entry - stop) * product.contractValueBtc + costPerContract;
    const size = Math.min(Math.floor(equity * 0.005 / lossPerContract),
      Math.floor(equity / (entry * product.contractValueBtc)));
    if (!Number.isSafeInteger(size) || size < 1) { skippedForRisk++; i++; continue; }
    const last = Math.min(endIndex - 1, i + Math.floor(decision.maxHoldingHours * 3_600_000 / intervalMs) - 1);
    let exit = last, exitPrice = bars[last]!.close;
    for (let j = i; j <= last; j++) {
      const bar = bars[j]!;
      const stopped = decision.side === "LONG" ? bar.low <= stop : bar.high >= stop;
      const targeted = decision.side === "LONG" ? bar.high >= target : bar.low <= target;
      if (stopped) {
        exit = j; exitPrice = decision.side === "LONG" ? Math.min(bar.open, stop) : Math.max(bar.open, stop);
        break;
      }
      if (targeted) { exit = j; exitPrice = target; break; }
    }
    const direction = decision.side === "LONG" ? 1 : -1;
    const net = (exitPrice - entry) * direction * product.contractValueBtc * size - costPerContract * size;
    equity += net; trades++; dayTrades++;
    if (net > 0) { wins++; grossWins += net; }
    else { losses++; grossLosses -= net; cooldownUntil = exit + 3; }
    highWater = Math.max(highWater, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (highWater - equity) / highWater * 100);
    i = exit + 1;
  }
  return { strategy, intervalMs, costBpsRoundTrip, bars: endIndex - startIndex,
    qualifiedBars, signals, trades, skippedForRisk, wins, losses,
    netPnlUsd: equity - startingEquityUsd, endingEquityUsd: equity,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null, maxDrawdownPct };
}

/** Selection looks only at training/validation; final holdout is evaluated once afterwards. */
export function selectBtcResearchCandidate(rows: readonly {
  strategy: BtcResearchStrategy; train: BtcResearchResult[]; validation: BtcResearchResult[];
}[]): BtcResearchStrategy | null {
  const eligible = rows.filter(row => BTC_RESEARCH_STRATEGIES.includes(row.strategy) &&
    [row.train, row.validation].every(phase => phase.length === 2 &&
      [300_000, 900_000].every(interval => phase.filter(result =>
        result.strategy === row.strategy && result.intervalMs === interval &&
        result.costBpsRoundTrip === 30).length === 1)) &&
    [...row.train, ...row.validation].every(result => result.trades >= 8 && result.netPnlUsd > 0 &&
      result.maxDrawdownPct <= 5 && result.profitFactor !== null && result.profitFactor >= 1.1));
  eligible.sort((a, b) => b.validation.reduce((sum, result) => sum + result.netPnlUsd, 0) -
    a.validation.reduce((sum, result) => sum + result.netPnlUsd, 0));
  return eligible[0]?.strategy ?? null;
}

export function btcHoldoutPasses(results: readonly BtcResearchResult[]): boolean {
  return results.length === 4 &&
    new Set(results.map(result => result.strategy)).size === 1 &&
    [300_000, 900_000].every(interval => [30, 60].every(cost => results.filter(result =>
      result.intervalMs === interval && result.costBpsRoundTrip === cost).length === 1)) &&
    results.every(result => result.trades >= 10 && result.netPnlUsd > 0 && result.maxDrawdownPct <= 5 &&
      result.profitFactor !== null && result.profitFactor >= 1.2);
}
