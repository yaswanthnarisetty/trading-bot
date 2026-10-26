import type { OHLCV } from "../types/trading";
import type { BtcDemoProduct } from "../domain/btcDemoPlan";

const DAY_MS = 86_400_000;
const WINDOW = 60;
const MAX_HOLD_DAYS = 5;

export interface BtcDailyDecision {
  side: "LONG" | "SHORT";
  stopReferenceUsd: number;
}

export interface BtcDailyResearchResult {
  costBpsRoundTrip: number;
  bars: number;
  signals: number;
  trades: number;
  skippedForRisk: number;
  minimumEquityForOneObservedSignalUsd: number | null;
  skippedCooldownDays: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  endingEquityUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

function ema(prices: readonly number[], period: number): number {
  let value = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  for (let i = period; i < prices.length; i++) value += (prices[i]! - value) * 2 / (period + 1);
  return value;
}

function atr(bars: readonly OHLCV[]): number {
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!, previous = bars[i - 1]!;
    trueRanges.push(Math.max(bar.high - bar.low,
      Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)));
  }
  let value = trueRanges.slice(0, 14).reduce((sum, range) => sum + range, 0) / 14;
  for (let i = 14; i < trueRanges.length; i++) value = (value * 13 + trueRanges[i]!) / 14;
  return value;
}

/** A fixed hypothesis, evaluated only after a UTC daily candle has closed. */
export function decideBtcDailyBreakout(completed: readonly OHLCV[]): BtcDailyDecision | null {
  if (completed.length !== WINDOW) throw new Error("BTC_DAILY_WINDOW_REQUIRED");
  validateDailyBars(completed, 0, WINDOW);
  const last = completed[WINDOW - 1]!;
  const prior20 = completed.slice(WINDOW - 21, WINDOW - 1);
  const closes = completed.map(bar => bar.close);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), currentAtr = atr(completed);
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;
  const stopBuffer = currentAtr * 0.1;
  if (last.close > Math.max(...prior20.map(bar => bar.high)) && ema20 > ema50)
    return { side: "LONG", stopReferenceUsd: last.low - stopBuffer };
  if (last.close < Math.min(...prior20.map(bar => bar.low)) && ema20 < ema50)
    return { side: "SHORT", stopReferenceUsd: last.high + stopBuffer };
  return null;
}

function validateDailyBars(bars: readonly OHLCV[], first: number, end: number): void {
  for (let i = first; i < end; i++) {
    const bar = bars[i]!, time = bar?.timestamp instanceof Date ? bar.timestamp.getTime() : NaN;
    if (!Number.isFinite(time) || time % DAY_MS !== 0 ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.open <= 0 || bar.close <= 0 || bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0 || (i > first && time - bars[i - 1]!.timestamp.getTime() !== DAY_MS))
      throw new Error("BTC_DAILY_BARS_INVALID_OR_GAPPED");
  }
}

/**
 * Next-day-open entries, one position at a time and at most one new entry per UTC day.
 * The stop is beyond the preceding day's extreme. Stops win ambiguous daily bars;
 * gaps through a stop use the worse open. Three consecutive losses skip three days.
 * This is a research model, not an executable broker plan or a profit forecast.
 */
export function backtestBtcDailyBreakout(input: {
  bars: readonly OHLCV[]; product: BtcDemoProduct; startIndex: number; endIndex: number;
  startingEquityUsd: number; costBpsRoundTrip: number;
}): BtcDailyResearchResult {
  const { bars, product, startIndex, endIndex, startingEquityUsd, costBpsRoundTrip } = input;
  if (!Number.isInteger(startIndex) || startIndex < WINDOW || !Number.isInteger(endIndex) ||
      endIndex > bars.length || endIndex <= startIndex ||
      !Number.isFinite(startingEquityUsd) || startingEquityUsd <= 0 ||
      !Number.isFinite(costBpsRoundTrip) || costBpsRoundTrip < 0 || costBpsRoundTrip > 100 ||
      product.symbol !== "BTCUSD" || !Number.isSafeInteger(product.id) || product.id <= 0 ||
      !Number.isFinite(product.contractValueBtc) || product.contractValueBtc <= 0 ||
      !Number.isFinite(product.tickSize) || product.tickSize <= 0)
    throw new Error("BTC_DAILY_RESEARCH_INPUT_INVALID");
  validateDailyBars(bars, startIndex - WINDOW, endIndex);
  let equity = startingEquityUsd, highWater = equity, maxDrawdownPct = 0;
  let signals = 0, trades = 0, skippedForRisk = 0, skippedCooldownDays = 0;
  let minimumEquityForOneObservedSignalUsd: number | null = null;
  let wins = 0, losses = 0, grossWins = 0, grossLosses = 0;
  let consecutiveLosses = 0, cooldownThrough = -1;
  for (let i = startIndex; i < endIndex;) {
    if (i <= cooldownThrough) { skippedCooldownDays++; i++; continue; }
    // Keep every position inside its chronological research partition.
    if (i + MAX_HOLD_DAYS > endIndex) break;
    const decision = decideBtcDailyBreakout(bars.slice(i - WINDOW, i));
    if (!decision) { i++; continue; }
    signals++;
    const entry = bars[i]!.open, tick = product.tickSize;
    const stop = (decision.side === "LONG"
      ? Math.floor(decision.stopReferenceUsd / tick)
      : Math.ceil(decision.stopReferenceUsd / tick)) * tick;
    const distance = Math.abs(entry - stop);
    if (stop <= 0 || !(decision.side === "LONG" ? stop < entry : stop > entry)) {
      skippedForRisk++; i++; continue;
    }
    const rawTarget = entry + (decision.side === "LONG" ? 1 : -1) * distance * 2;
    const target = (decision.side === "LONG" ? Math.floor(rawTarget / tick)
      : Math.ceil(rawTarget / tick)) * tick;
    if (target <= 0 || !(decision.side === "LONG" ? target > entry : target < entry)) {
      skippedForRisk++; i++; continue;
    }
    const costPerContract = entry * product.contractValueBtc * costBpsRoundTrip / 10_000;
    const lossPerContract = distance * product.contractValueBtc + costPerContract;
    const requiredEquity = Math.max(lossPerContract / 0.005, entry * product.contractValueBtc);
    minimumEquityForOneObservedSignalUsd = minimumEquityForOneObservedSignalUsd === null
      ? requiredEquity : Math.min(minimumEquityForOneObservedSignalUsd, requiredEquity);
    const size = Math.min(Math.floor(equity * 0.005 / lossPerContract),
      Math.floor(equity / (entry * product.contractValueBtc)));
    if (!Number.isSafeInteger(size) || size < 1) { skippedForRisk++; i++; continue; }
    const last = Math.min(endIndex - 1, i + MAX_HOLD_DAYS - 1);
    let exit = last, exitPrice = bars[last]!.close;
    for (let j = i; j <= last; j++) {
      const bar = bars[j]!;
      const stopped = decision.side === "LONG" ? bar.low <= stop : bar.high >= stop;
      const targeted = decision.side === "LONG" ? bar.high >= target : bar.low <= target;
      if (stopped) {
        exit = j;
        exitPrice = decision.side === "LONG" ? Math.min(bar.open, stop) : Math.max(bar.open, stop);
        break;
      }
      if (targeted) { exit = j; exitPrice = target; break; }
    }
    const direction = decision.side === "LONG" ? 1 : -1;
    const net = (exitPrice - entry) * direction * product.contractValueBtc * size - costPerContract * size;
    equity += net; trades++;
    if (net > 0) { wins++; grossWins += net; consecutiveLosses = 0; }
    else {
      losses++; grossLosses -= net; consecutiveLosses++;
      if (consecutiveLosses === 3) { cooldownThrough = exit + 3; consecutiveLosses = 0; }
    }
    highWater = Math.max(highWater, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (highWater - equity) / highWater * 100);
    i = exit + 1;
  }
  return { costBpsRoundTrip, bars: endIndex - startIndex, signals, trades,
    skippedForRisk, minimumEquityForOneObservedSignalUsd, skippedCooldownDays,
    wins, losses, netPnlUsd: equity - startingEquityUsd,
    endingEquityUsd: equity, profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    maxDrawdownPct };
}
