import type { AssetKey } from "../config/assets";
import { ALLOWED_ASSETS } from "../config/assets";
import {
  RISK_PER_TRADE_PCT,
  TARGET_PROFIT_PCT,
  STOP_LOSS_PCT,
  MAX_HOLD_BARS,
  EOD_CLOSE_HOUR,
  EOD_CLOSE_MINUTE,
  BASE_CAPITAL_FOR_LOTS,
  MAX_POSITIONS_DEFAULT,
  MAX_DAILY_TRADES,
  DIRECTIONAL_STOP_ATR_MULT,
  DIRECTIONAL_STOP_FALLBACK_PTS,
  SLIPPAGE_PTS,
  SKIP_OPEN_MINUTES,
  ATR_MAX_ENTRY,
  RSI_ENTRY_MIN,
  RSI_ENTRY_MAX,
  RSI_SLOPE_MIN,
  VOLUME_RATIO_MIN,
  MIN_CREDIT_PTS,
  SR_MIN_RANGE_PTS,
  SR_ATR_BUFFER,
} from "../config/constants";
import { computeAll } from "./IndicatorService";
import { selectStrategy, computeSpreadDetails } from "./StrategySelector";
import { calculateSwingLevels, buildSRContext, detectBreakout } from "../utils/indicators";
import {
  fetchHistoricalOHLCV,
  type HistoricalInterval,
} from "./KiteService";

export interface BacktestRunParams {
  asset: AssetKey;
  from: string;
  to: string;
  interval: HistoricalInterval;
  initialCapital: number;
  riskPerTradePct: number;
  targetProfitPct: number;
  stopLossPct: number;
  maxHoldingBars: number;
  apiKey?: string;
  accessToken?: string;
  /**
   * ATR multiplier for directional stop. null = disabled entirely (Option A).
   * Default: DIRECTIONAL_STOP_ATR_MULT (1.5). Set to 3.0 for Option B.
   */
  directionalStopMult?: number | null;
  /**
   * Minimum bars held before directional stop activates. 0 = immediate (Options A/B).
   * Set to 6 for Option C (6 × 5min = 30 minutes).
   */
  directionalStopMinBars?: number;
}

export interface BacktestTrade {
  tradeId: string;
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  /** Underlying entry timestamp (candle time) */
  entryTimestamp: string;
  /** Underlying exit timestamp (candle time) */
  exitTimestamp: string;
  /** Underlying index level at entry */
  entrySpot: number;
  /** Underlying index level at exit */
  exitSpot: number;
  /** Number of bars the position was held for */
  barsHeld: number;
  /** Lots traded in this spread */
  lots: number;
  /** Option type for the spread legs */
  optionType: "CALL" | "PUT";
  /** Short leg strike */
  sellStrike: number;
  /** Long leg strike */
  buyStrike: number;
  /** Width between short and long strikes */
  width: number;
  /** Net credit received per lot at entry */
  credit: number;
  /** Theoretical breakeven of the spread at expiry */
  breakeven: number;
  /** Maximum profit for this trade (all lots combined) */
  maxProfit: number;
  /** Maximum loss for this trade (all lots combined) */
  maxLoss: number;
  /** Realized PnL for this trade (all lots combined) */
  pnl: number;
  /** Why the trade was closed */
  exitReason: "TARGET_HIT" | "STOP_HIT" | "TIME_EXIT" | "EOD_CLOSE" | "END_OF_DATA";
}

export interface BacktestBlockReasons {
  duplicate_strategy: number;
  same_direction_open: number;
  max_positions: number;
  daily_limit: number;
  /** Not implemented in backtest — always 0. Placeholder for future confidence gate. */
  low_confidence: number;
  /** After-cutoff candles skipped — not counted since indicators aren't computed. */
  time_restriction: number;
  opening_volatility: number;
  high_volatility_atr: number;
  rsi_exhausted: number;
  weak_momentum: number;
  low_volume: number;
  /** Always 0 in backtest — PCR defaults to 1.0 (neutral). */
  pcr_extreme: number;
  insufficient_credit: number;
  /** SR: compressed S/R range (< SR_MIN_RANGE_PTS) */
  blocked_compressed_range: number;
  /** SR: BEAR_CALL_SPREAD blocked because resistance was within ATR×SR_ATR_BUFFER of spot */
  blocked_resistance_too_close: number;
  /** SR: BULL_PUT_SPREAD blocked because support was within ATR×SR_ATR_BUFFER of spot */
  blocked_support_too_close: number;
  /** Breakout: BULLISH_BREAKOUT active but signal is BEAR_CALL_SPREAD (fighting the move) */
  blocked_breakout_conflict: number;
  /** Breakout: BEARISH_BREAKDOWN active but signal is BULL_PUT_SPREAD (fighting the move) */
  blocked_breakdown_conflict: number;
}

export interface BacktestResult {
  provider: "KITE";
  asset: AssetKey;
  interval: HistoricalInterval;
  from: string;
  to: string;
  dataPoints: number;
  initialCapital: number;
  finalCapital: number;
  netPnL: number;
  /** All non-HOLD signals generated (independent of whether they were traded or blocked). */
  totalSignals: number;
  /** Signals blocked by deduplication rules. */
  totalBlocked: number;
  /** Positions actually opened (mirrors totalTrades). */
  totalTraded: number;
  /** Per-reason breakdown of blocked signals. */
  blockReasons: BacktestBlockReasons;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnLPerTrade: number;
  maxDrawdown: number;
  equityCurve: Array<{ timestamp: string; equity: number }>;
  trades: BacktestTrade[];
  /** Count of trades where SR context caused the sell strike to be adjusted vs the default */
  strikesAdjustedForSR: number;
}

interface SimPosition {
  id: string;
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  entryIndex: number;
  entryTimestamp: string;
  entrySpot: number;
  lots: number;
  lotSize: number;
  /** Short leg strike */
  sellStrike: number;
  /** Long leg strike */
  buyStrike: number;
  /** Net credit received per lot at entry */
  credit: number;
  /** Theoretical breakeven of the spread at expiry */
  breakeven: number;
  maxProfit: number;
  maxLoss: number;
  entryATR: number | null;
}

function computeWeeklyDte(timestamp: Date, expiryDay: number): number {
  const day = timestamp.getDay();
  let days = (expiryDay - day + 7) % 7;

  if (days === 0) {
    const hours = timestamp.getHours();
    const minutes = timestamp.getMinutes();
    const isAfterClose = hours > 15 || (hours === 15 && minutes >= 30);
    if (isAfterClose) {
      days = 7;
    }
  }

  return days;
}

function cappedPnL(position: SimPosition, spot: number): number {
  const direction = position.strategy === "BULL_PUT_SPREAD" ? 1 : -1;
  const move = (spot - position.entrySpot) * direction;
  const sensitivity = 0.3;

  const raw = move * sensitivity * position.lotSize * position.lots;
  return Math.max(-position.maxLoss, Math.min(position.maxProfit, raw));
}

function computeMaxDrawdown(equityCurve: Array<{ equity: number }>): number {
  let peak = equityCurve.length > 0 ? equityCurve[0]!.equity : 0;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
    }
    const drawdown = peak - point.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

export async function runHistoricalBacktest(
  params: BacktestRunParams
): Promise<BacktestResult> {
  const candles = await fetchHistoricalOHLCV(params.asset, {
    from: params.from,
    to: params.to,
    interval: params.interval,
    apiKey: params.apiKey,
    accessToken: params.accessToken,
  });

  if (candles.length < 60) {
    throw new Error("Not enough historical candles for backtest (minimum 60)");
  }

  const assetConfig = ALLOWED_ASSETS[params.asset];
  let equity = params.initialCapital;
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ timestamp: string; equity: number }> = [];

  // Multiple concurrent positions — mirrors live MAX_POSITIONS_DEFAULT
  let openPositions: SimPosition[] = [];

  // Signal-filter tracking
  let totalSignals = 0;
  const blockReasons: BacktestBlockReasons = {
    duplicate_strategy: 0,
    same_direction_open: 0,
    max_positions: 0,
    daily_limit: 0,
    low_confidence: 0,
    time_restriction: 0,
    opening_volatility: 0,
    high_volatility_atr: 0,
    rsi_exhausted: 0,
    weak_momentum: 0,
    low_volume: 0,
    pcr_extreme: 0,
    insufficient_credit: 0,
    blocked_compressed_range: 0,
    blocked_resistance_too_close: 0,
    blocked_support_too_close: 0,
    blocked_breakout_conflict: 0,
    blocked_breakdown_conflict: 0,
  };
  let strikesAdjustedForSR = 0;

  // Daily trade count: key = "YYYY-MM-DD" from candle UTC timestamp
  // Indian market closes at 15:30 IST so no candles cross UTC midnight
  const dailyTradeCounts = new Map<string, number>();

  for (let i = 59; i < candles.length; i += 1) {
    const candle = candles[i]!;

    // ── Phase 1: Exit checks for every open position ─────────────────────────
    // EOD + barsHeld + target + stop evaluated per-position.
    // Mirror live forceCloseAllPositions — no positions held past EOD cutoff.
    const ch = candle.timestamp.getHours();
    const cm = candle.timestamp.getMinutes();
    const dayOfWeek = candle.timestamp.getDay(); // 0=Sun, 2=Tue, 5=Fri, 6=Sat
    const isTuesdayCandle = dayOfWeek === 2;
    const isEOD = isTuesdayCandle
      ? ch >= 15
      : ch > EOD_CLOSE_HOUR || (ch === EOD_CLOSE_HOUR && cm >= EOD_CLOSE_MINUTE);
    const isLastCandle = i === candles.length - 1;
    const isExpiryWeekEnd = dayOfWeek === 1 || dayOfWeek === 2;

    let exitedThisBar = false;
    const stillOpen: SimPosition[] = [];

    for (const pos of openPositions) {
      const barsHeld = i - pos.entryIndex;
      // rawPnL: used for exit trigger decisions (before slippage — you don't pay
      // slippage until you actually close, so triggers should not see it).
      const rawPnL = cappedPnL(pos, candle.close);

      let shouldExit = false;
      let exitReason: BacktestTrade["exitReason"] = "TIME_EXIT";

      if (isEOD) {
        shouldExit = true;
        exitReason = "EOD_CLOSE";
      } else if (barsHeld >= params.maxHoldingBars) {
        shouldExit = true;
        exitReason = "TIME_EXIT";
      } else if (rawPnL >= pos.maxProfit * params.targetProfitPct) {
        shouldExit = true;
        exitReason = "TARGET_HIT";
      } else {
        // Directional stop — only if not disabled (null = Option A)
        const dsMult = params.directionalStopMult !== undefined
          ? params.directionalStopMult
          : DIRECTIONAL_STOP_ATR_MULT;
        const dsMinBars = params.directionalStopMinBars ?? 0;
        const dsEnabled = dsMult !== null && barsHeld >= dsMinBars;

        if (dsEnabled) {
          const dsThreshold =
            pos.entryATR != null
              ? pos.entryATR * dsMult
              : DIRECTIONAL_STOP_FALLBACK_PTS;
          const spotMove = candle.close - pos.entrySpot;
          const isDirectionalStop =
            (pos.strategy === "BEAR_CALL_SPREAD" && spotMove > dsThreshold) ||
            (pos.strategy === "BULL_PUT_SPREAD" && spotMove < -dsThreshold);
          if (isDirectionalStop) {
            shouldExit = true;
            exitReason = "STOP_HIT";
          }
        }

        if (!shouldExit) {
          // Mon/Tue expiry-week: 30% tighter stop loss — mirrors live PortfolioMonitor
          const effectiveStopLossPct = isExpiryWeekEnd ? 0.30 : params.stopLossPct;
          if (rawPnL <= -pos.maxLoss * effectiveStopLossPct) {
            shouldExit = true;
            exitReason = "STOP_HIT";
          }
        }
      }

      // END_OF_DATA — close whatever is open on the last candle
      if (!shouldExit && isLastCandle) {
        shouldExit = true;
        exitReason = "END_OF_DATA";
      }

      if (shouldExit) {
        // Apply exit slippage only when actually closing — bid-ask cost on 2 legs
        const exitSlippageRupees = SLIPPAGE_PTS * 2 * pos.lotSize * pos.lots;
        const pnl = rawPnL - exitSlippageRupees;
        equity += pnl;
        trades.push({
          tradeId: pos.id,
          strategy: pos.strategy,
          entryTimestamp: pos.entryTimestamp,
          exitTimestamp: candle.timestamp.toISOString(),
          entrySpot: pos.entrySpot,
          exitSpot: candle.close,
          barsHeld,
          lots: pos.lots,
          optionType: pos.strategy === "BULL_PUT_SPREAD" ? "PUT" : "CALL",
          sellStrike: pos.sellStrike,
          buyStrike: pos.buyStrike,
          width: Math.abs(pos.sellStrike - pos.buyStrike),
          credit: pos.credit,
          breakeven: pos.breakeven,
          maxProfit: pos.maxProfit,
          maxLoss: pos.maxLoss,
          pnl,
          exitReason,
        });
        equityCurve.push({ timestamp: candle.timestamp.toISOString(), equity });
        exitedThisBar = true;
      } else {
        stillOpen.push(pos);
      }
    }

    openPositions = stillOpen;

    // No same-bar re-entry after any exit — mirrors live tick loop behavior
    if (exitedThisBar) continue;

    // ── Phase 2: Entry gate checks ────────────────────────────────────────────

    // No new entries after 15:00 IST — mirrors live isAfterCutoff()
    const entryHour = candle.timestamp.getHours();
    const entryMin = candle.timestamp.getMinutes();
    if (entryHour > 15 || (entryHour === 15 && entryMin >= 0)) continue;

    // ── Phase 3: Indicator computation + strategy selection ──────────────────
    // No look-ahead bias: computeAll() uses only candles[0..i] (history up to
    // current bar). PCR and MaxPain are NOT used here — those live in GreeksEngine
    // which is only called from the live signal loop (SignalLoopService), never
    // from the backtest. ivRank=50 is a neutral constant (no live option chain call).
    const history = candles.slice(0, i + 1);
    const indicators = computeAll(history);
    const direction =
      indicators.emaAlignment === "bullish"
        ? "BULLISH"
        : indicators.emaAlignment === "bearish"
        ? "BEARISH"
        : "NEUTRAL";

    const dte = computeWeeklyDte(candle.timestamp, assetConfig.expiryDay);
    const selection = selectStrategy(direction, 50, dte, indicators.regime);

    if (selection.strategy === "HOLD") continue;

    // Non-HOLD signal generated — count it regardless of whether it's blocked
    totalSignals++;

    const signalTs = candle.timestamp.toISOString();
    const candleDate = signalTs.slice(0, 10); // "YYYY-MM-DD"
    const todayCount = dailyTradeCounts.get(candleDate) ?? 0;

    // ── Phase 4: Deduplication checks — mirrors live RiskGuardService ────────

    // CHECK 1: No duplicate strategy already open (rule 11 in live)
    const hasDuplicate = openPositions.some(
      (p) => p.strategy === selection.strategy
    );
    if (hasDuplicate) {
      blockReasons.duplicate_strategy++;
      continue;
    }

    // CHECK 2: No same-direction position open (rule 12 in live)
    const signalDirection =
      selection.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH";
    const hasSameDirection = openPositions.some(
      (p) =>
        (p.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH") ===
        signalDirection
    );
    if (hasSameDirection) {
      blockReasons.same_direction_open++;
      continue;
    }

    // CHECK 3: Daily trade limit (rule 13 in live)
    if (todayCount >= MAX_DAILY_TRADES) {
      blockReasons.daily_limit++;
      continue;
    }

    // CHECK 4: Max concurrent positions (rule 14 in live)
    if (openPositions.length >= MAX_POSITIONS_DEFAULT) {
      blockReasons.max_positions++;
      continue;
    }

    // ── Phase 4b: Entry quality filters — mirrors RiskGuardService new rules ──
    // minutesSinceOpen: candle timestamps are in IST; 9:15 IST = 555 min from midnight
    const minutesSinceOpen = entryHour * 60 + entryMin - 555;

    // CHECK 5: Opening volatility block
    if (minutesSinceOpen < SKIP_OPEN_MINUTES) {
      blockReasons.opening_volatility++;
      continue;
    }

    // CHECK 6: ATR too high
    if (indicators.atr !== null && indicators.atr > ATR_MAX_ENTRY) {
      blockReasons.high_volatility_atr++;
      continue;
    }

    // CHECK 7: RSI entry zone (exhaustion filter)
    const isBearSignal = selection.strategy === "BEAR_CALL_SPREAD";
    const isBullSignal = selection.strategy === "BULL_PUT_SPREAD";
    if (isBearSignal && indicators.rsi < RSI_ENTRY_MIN) {
      blockReasons.rsi_exhausted++;
      continue;
    }
    if (isBullSignal && indicators.rsi > RSI_ENTRY_MAX) {
      blockReasons.rsi_exhausted++;
      continue;
    }

    // CHECK 8: RSI slope too weak
    const rsiSlope = indicators.rsiSlope ?? null;
    if (rsiSlope !== null && Math.abs(rsiSlope) < RSI_SLOPE_MIN) {
      blockReasons.weak_momentum++;
      continue;
    }

    // CHECK 9: Volume too low
    if (indicators.volumeRatio < VOLUME_RATIO_MIN) {
      blockReasons.low_volume++;
      continue;
    }
    // PCR check not applied in backtest (default pcr=1.0, always passes)

    // ── Phase 4c: SR checks — mirrors RiskGuardService rules 23–25 ────────────
    // Compute swing levels from all candles up to (and including) current bar
    const swingLevels = calculateSwingLevels(history);

    // Approximate PDH/PDL: find the last completed trading day in the candle slice
    // Group candles by date (YYYY-MM-DD), take the second-to-last group as previous day
    const candlesByDate = new Map<string, typeof history>();
    for (const c of history) {
      const dateKey = c.timestamp.toISOString().slice(0, 10);
      if (!candlesByDate.has(dateKey)) candlesByDate.set(dateKey, []);
      candlesByDate.get(dateKey)!.push(c);
    }
    const dateKeys = [...candlesByDate.keys()].sort();
    const prevDateKey = dateKeys.length >= 2 ? dateKeys[dateKeys.length - 2] : null;
    const prevDayCandles = prevDateKey ? candlesByDate.get(prevDateKey)! : [];
    const pdOHLC = prevDayCandles.length > 0
      ? {
          pdHigh:  Math.max(...prevDayCandles.map((c) => c.high)),
          pdLow:   Math.min(...prevDayCandles.map((c) => c.low)),
          pdClose: prevDayCandles[prevDayCandles.length - 1]!.close,
          pdOpen:  prevDayCandles[0]!.open,
        }
      : null;

    const srContext = buildSRContext(
      candle.close,
      pdOHLC,
      swingLevels,
      null, // no live option chain in backtest
      indicators.atr ?? 0
    );

    // CHECK 10a: Compressed range
    if (srContext.rangeWidth !== null && srContext.rangeWidth < SR_MIN_RANGE_PTS) {
      blockReasons.blocked_compressed_range++;
      continue;
    }

    // CHECK 10b: Bear call — resistance too close
    if (
      isBearSignal &&
      srContext.spotToResistance !== null &&
      (indicators.atr ?? 0) > 0 &&
      srContext.spotToResistance < (indicators.atr ?? 0) * SR_ATR_BUFFER
    ) {
      blockReasons.blocked_resistance_too_close++;
      continue;
    }

    // CHECK 10c: Bull put — support too close
    if (
      isBullSignal &&
      srContext.spotToSupport !== null &&
      (indicators.atr ?? 0) > 0 &&
      srContext.spotToSupport < (indicators.atr ?? 0) * SR_ATR_BUFFER
    ) {
      blockReasons.blocked_support_too_close++;
      continue;
    }

    // ── Phase 4d: Breakout conflict checks ────────────────────────────
    const breakoutResult = detectBreakout(history, srContext, indicators.atr ?? 0);

    // CHECK 11: BULLISH_BREAKOUT + BEAR_CALL_SPREAD — fighting the breakout
    if (breakoutResult.state === "BULLISH_BREAKOUT" && isBearSignal) {
      blockReasons.blocked_breakout_conflict++;
      continue;
    }

    // CHECK 12: BEARISH_BREAKDOWN + BULL_PUT_SPREAD — fighting the breakdown
    if (breakoutResult.state === "BEARISH_BREAKDOWN" && isBullSignal) {
      blockReasons.blocked_breakdown_conflict++;
      continue;
    }

    // ── Phase 5: All checks passed — compute spread ──────────────────────
    const defaultSellStrike = isBearSignal
      ? Math.round((candle.close + (ALLOWED_ASSETS[params.asset].expiryDay === 2 ? 200 : 100)) / 50) * 50
      : Math.round((candle.close - (ALLOWED_ASSETS[params.asset].expiryDay === 2 ? 200 : 100)) / 50) * 50;

    const spread = computeSpreadDetails(
      candle.close,
      {
        delta: 0.3,
        gamma: 0,
        theta: -0.02,
        vega: 0.1,
      },
      params.asset,
      selection.strategy,
      srContext,
      indicators.atr ?? undefined
    );

    // Track if SR caused the strike to be adjusted from the default
    if (spread.sellStrike !== defaultSellStrike) {
      strikesAdjustedForSR++;
    }

    // ── Slippage model — bid-ask cost per leg at entry (2 legs) ─────────────
    // Reduces net credit received and widens effective max loss.
    // Exit slippage applied separately when closing (see exit block below).
    const entrySlippagePts = SLIPPAGE_PTS * 2; // sell leg + buy leg
    const adjCredit  = Math.max(0, spread.credit - entrySlippagePts);
    const adjMaxLoss = spread.maxLoss + entrySlippagePts; // wider loss since credit is lower

    // CHECK 10: Minimum credit — post-slippage credit must be worth opening
    if (adjCredit < MIN_CREDIT_PTS) {
      blockReasons.insufficient_credit++;
      continue;
    }

    const capitalScale = Math.max(1, equity / BASE_CAPITAL_FOR_LOTS);
    const effectiveRiskPct = Math.min(10, params.riskPerTradePct * capitalScale);
    const maxRiskAmount = (equity * effectiveRiskPct) / 100;
    const maxLossPerLot = adjMaxLoss * assetConfig.lotSize;
    const lots =
      maxLossPerLot <= 0
        ? 1
        : Math.max(1, Math.floor(maxRiskAmount / maxLossPerLot));

    openPositions.push({
      id: `bt-${params.asset}-${i}`,
      strategy: selection.strategy,
      entryIndex: i,
      entryTimestamp: signalTs,
      entrySpot: candle.close,
      lots,
      lotSize: assetConfig.lotSize,
      sellStrike: spread.sellStrike,
      buyStrike: spread.buyStrike,
      credit: adjCredit,
      breakeven: spread.breakeven,
      maxProfit: adjCredit  * assetConfig.lotSize * lots,
      maxLoss:   adjMaxLoss * assetConfig.lotSize * lots,
      entryATR: indicators.atr ?? null,
    });

    dailyTradeCounts.set(candleDate, todayCount + 1);
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const totalTrades = trades.length;
  const totalBlocked =
    blockReasons.duplicate_strategy +
    blockReasons.same_direction_open +
    blockReasons.max_positions +
    blockReasons.daily_limit +
    blockReasons.low_confidence +
    blockReasons.time_restriction +
    blockReasons.opening_volatility +
    blockReasons.high_volatility_atr +
    blockReasons.rsi_exhausted +
    blockReasons.weak_momentum +
    blockReasons.low_volume +
    blockReasons.pcr_extreme +
    blockReasons.insufficient_credit +
    blockReasons.blocked_compressed_range +
    blockReasons.blocked_resistance_too_close +
    blockReasons.blocked_support_too_close +
    blockReasons.blocked_breakout_conflict +
    blockReasons.blocked_breakdown_conflict;
  const netPnL = equity - params.initialCapital;

  return {
    provider: "KITE",
    asset: params.asset,
    interval: params.interval,
    from: params.from,
    to: params.to,
    dataPoints: candles.length,
    initialCapital: params.initialCapital,
    finalCapital: equity,
    netPnL,
    totalSignals,
    totalBlocked,
    totalTraded: totalTrades,
    blockReasons,
    totalTrades,
    wins,
    losses,
    winRate: totalTrades === 0 ? 0 : (wins / totalTrades) * 100,
    avgPnLPerTrade: totalTrades === 0 ? 0 : netPnL / totalTrades,
    maxDrawdown: computeMaxDrawdown(equityCurve),
    equityCurve,
    trades,
    strikesAdjustedForSR,
  };
}

export function getDefaultBacktestParams(
  asset: AssetKey,
  input: Partial<BacktestRunParams>
): BacktestRunParams {
  return {
    asset,
    from: input.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: input.to ?? new Date().toISOString(),
    interval: input.interval ?? "5minute",
    initialCapital: input.initialCapital ?? Number(process.env.PAPER_CAPITAL || 200_000),
    riskPerTradePct: input.riskPerTradePct ?? RISK_PER_TRADE_PCT,
    targetProfitPct: input.targetProfitPct ?? TARGET_PROFIT_PCT,
    stopLossPct: input.stopLossPct ?? STOP_LOSS_PCT,
    maxHoldingBars: input.maxHoldingBars ?? MAX_HOLD_BARS,
    apiKey: input.apiKey,
    accessToken: input.accessToken,
  };
}
