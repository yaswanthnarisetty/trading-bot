import type { AssetKey } from "../config/assets";
import type { OHLCVData } from "../types/trading";
import {
  fetchMarketData,
  fetchOptionChain,
  fetchHistoricalOHLCV,
  fetchLatest5MinCandle,
  getPreviousDayOHLC,
  isMock,
} from "./KiteService";
import { computeAll as computeIndicators } from "./IndicatorService";
import { computeGreeksSnapshot } from "./GreeksEngine";
import {
  getDTE,
  getNextCycleDTE,
  getWeeklyExpiryDateStr,
  getISTDayOfWeek,
  shouldAutoStop,
} from "../utils/marketHours";
import { getPortfolioSummary } from "./PositionMonitorService";
import { fetchSentiment } from "./NewsSentimentService";
import {
  callPrimaryAnalyst,
  callVerifier,
  shouldRunVerifier,
} from "./LLMService";
import { evaluateRisk } from "./RiskGuardService";
import { computeSpreadDetails, selectStrategy } from "./StrategySelector";
import {
  openPosition,
  getOpenPositions,
  getTodayPositions,
  getDailyPnL,
} from "./PaperTradeService";
import { calculateSwingLevels, buildSRContext, detectBreakout } from "../utils/indicators";
import type { SRContext, BreakoutResult, BreakoutState } from "../utils/indicators";
import {
  TICK_INTERVAL_MS,
} from "../config/constants";
import { WebSocketService } from "./WebSocketService";
import { SignalLogModel } from "../models/SignalLog";
import { MonitoringSessionModel } from "../models/MonitoringSession";
import type {
  ExpiryContext,
  PrimarySignal,
  VerifierResult,
  IndicatorSnapshot,
  GreeksSnapshot,
  WSMessage,
} from "@trading-bot/shared";
import { expiryContextSchema } from "@trading-bot/shared";
import { logger } from "../utils/logger";

let tickInterval: NodeJS.Timeout | null = null;
let isTickRunning = false;
// Stores the ISO timestamp of the last candle that was fully processed.
// Prevents reprocessing the same candle across multiple ticks within a 5-min window.
let lastProcessedCandleTime: string | null = null;
// Accumulated candle history used for indicator computation.
// Seeded from Kite historical API at session start; appended each tick in LIVE mode.
// In MOCK mode this stays empty and marketData.ohlcv is used directly instead.
let candleHistory: OHLCVData = [];
// Tracks the breakout state across ticks so state changes can be logged.
let breakoutState: BreakoutState = "NONE";

/**
 * Seeds the in-memory candle history buffer from Kite's historical API.
 * Fetches the last 3 calendar days of 5-minute OHLCV data, filters to closed
 * candles only, and takes the most recent 60 bars (enough for EMA50 + buffer).
 *
 * In MOCK mode no API call is made — returns an empty array and the tick loop
 * falls back to using marketData.ohlcv from MockDataService.
 *
 * Any error during seeding is caught and logged; the loop continues with an
 * empty history rather than blocking the session start.
 *
 * @param asset - Asset key to fetch historical candles for.
 * @returns Promise resolving to the seeded candle array (may be empty).
 */
async function seedHistoricalCandles(asset: AssetKey): Promise<OHLCVData> {
  if (isMock()) {
    logger.info("📚 Mock mode — skipping historical candle seeding", { asset });
    return [];
  }

  try {
    const now = new Date();
    // 3 calendar days back to safely cross weekends and single-day holidays
    const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const raw = await fetchHistoricalOHLCV(asset, {
      from: from.toISOString(),
      to: now.toISOString(),
      interval: "5minute",
    });

    // Only keep candles that have fully closed (open time strictly before now)
    const closed = raw.filter((c) => c.timestamp < now);

    // 60 candles = EMA50 warmup (50) + 10-bar buffer
    const seeded = closed.slice(-60);

    if (seeded.length > 0) {
      logger.info(
        `📚 Historical candle seeding complete: ${seeded.length} candles for ${asset}`,
        {
          from: seeded[0]!.timestamp.toISOString(),
          to: seeded[seeded.length - 1]!.timestamp.toISOString(),
        }
      );
    } else {
      logger.warn(
        "📚 No closed 5-min candles found in 3-day lookback — starting with empty history",
        { asset }
      );
    }

    return seeded;
  } catch (error) {
    logger.error(
      "📚 Historical candle seeding failed — indicators will warm up from scratch",
      {
        asset,
        message: error instanceof Error ? error.message : String(error),
      }
    );
    return [];
  }
}

/**
 * Builds the current expiry context for an asset using market-hours utilities.
 * This is a deterministic transformation used by the LLM and risk guard.
 *
 * @param asset - Asset key for which to compute expiry information.
 * @returns A validated ExpiryContext instance.
 */
function buildExpiryContext(asset: AssetKey): ExpiryContext {
  const currentDTE = getDTE(asset);
  const nextExpiryDTE = getNextCycleDTE(asset);
  const nearestExpiry = getWeeklyExpiryDateStr(asset);

  const isExpiryWeek = currentDTE <= 5;
  const isExpiryDay = currentDTE === 0;

  let thetaRisk: ExpiryContext["thetaRisk"] = "low";
  if (currentDTE < 3) {
    thetaRisk = "high";
  } else if (currentDTE <= 7) {
    thetaRisk = "medium";
  }

  return expiryContextSchema.parse({
    currentDTE,
    nextExpiryDTE,
    nearestExpiry,
    isExpiryWeek,
    isExpiryDay,
    thetaRisk,
  });
}

/**
 * Fetches recent primary signals for a session to provide context to the LLM.
 * Only high-level fields are included; no raw OHLCV or sensitive internals are exposed.
 *
 * @param sessionId - Monitoring session identifier.
 * @param limit - Maximum number of recent signals to retrieve.
 * @returns Promise resolving to a list of compact signal summaries.
 */
async function getRecentSignals(
  sessionId: string,
  limit: number
): Promise<
  Array<{
    direction: PrimarySignal["direction"];
    strategy: PrimarySignal["strategy"];
    confidence: number;
    timestamp: string;
  }>
> {
  const docs = await SignalLogModel.find({ sessionId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .exec();

  return docs.map((d) => ({
    direction: d.signal.direction,
    strategy: d.signal.strategy,
    confidence: d.signal.confidence,
    timestamp: d.timestamp.toISOString(),
  }));
}

/**
 * Seeds candle history then starts the 60-second signal loop for a given session.
 * The first tick runs immediately after seeding, and subsequent ticks respect
 * the global concurrency guard.
 *
 * Seeding fetches the last 3 days of 5-min historical candles from Kite so that
 * EMA50 (needs 50 candles × 5 min = 4h10min) is ready from the very first tick.
 * In MOCK mode seeding is skipped and indicators warm up progressively as normal.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @param asset - Asset key (NIFTY, BANKNIFTY, FINNIFTY).
 */
export async function start(sessionId: string, asset: AssetKey): Promise<void> {
  if (tickInterval) {
    return;
  }

  // Pre-seed candle history before the first tick so indicators are warm
  candleHistory = await seedHistoricalCandles(asset);

  // Log indicator readiness immediately after seeding
  if (candleHistory.length > 0) {
    const seedIndicators = computeIndicators(candleHistory);
    logger.info("📊 Indicators at session start (post-seed):", {
      asset,
      candleCount: candleHistory.length,
      ema20: seedIndicators.ema20 !== null ? `${seedIndicators.ema20.toFixed(2)} ✅` : "warming…",
      ema50: seedIndicators.ema50 !== null ? `${seedIndicators.ema50.toFixed(2)} ✅` : "warming…",
      atr: seedIndicators.atr !== null ? `${seedIndicators.atr.toFixed(2)} ✅` : "warming…",
      regime: seedIndicators.regime,
    });
  }

  const run = async () => {
    try {
      const afterCutoff = shouldAutoStop();
      // In LIVE mode we fully respect market cut-off and auto-stop the loop.
      // In MOCK mode we keep the loop running so development and testing
      // can proceed outside market hours.
      if (afterCutoff && !isMock()) {
        stop();
        return;
      }
      await _runTick(sessionId, asset);
    } catch (error) {
      logger.error("Signal loop tick failed", { error, sessionId, asset });
    }
  };

  void run();
  tickInterval = setInterval(run, TICK_INTERVAL_MS);
}

/**
 * Stops the running signal loop, if any, and releases the concurrency guard.
 * This is typically invoked at end-of-day or explicit session stop.
 */
export function stop(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  isTickRunning = false;
  lastProcessedCandleTime = null;
  candleHistory = [];
  breakoutState = "NONE";
}

/**
 * Indicates whether the signal loop is currently scheduled.
 * This does not reflect whether a tick is in progress, only that a loop is active.
 *
 * @returns True if the loop has been started and not stopped.
 */
export function isRunning(): boolean {
  return Boolean(tickInterval);
}

/**
 * Executes a single signal loop tick with full error isolation and concurrency guard.
 * All thirteen steps are logged and any failure results in a safe HOLD / error message.
 *
 * @param sessionId - ID of the monitoring session.
 * @param asset - Asset key monitored in this tick.
 */
export async function _runTick(
  sessionId: string,
  asset: AssetKey
): Promise<void> {
  if (isTickRunning) {
    const message: WSMessage = {
      type: "TICK_SKIPPED",
      reason: "previous_tick_still_running",
      timestamp: Date.now(),
    };
    WebSocketService.emit(sessionId, message);
    logger.warn("Tick skipped due to concurrency guard", { sessionId, asset });
    return;
  }

  const startedAt = Date.now();
  isTickRunning = true;

  // Warn when expiry week rules are active (Mon/Tue)
  const dow = getISTDayOfWeek();
  if (dow === 1 || dow === 2) {
    logger.warn("⚠️ EXPIRY WEEK RULES ACTIVE: 75% confidence floor, tighter SL", {
      sessionId,
      asset,
      dayOfWeek: dow,
    });
  }

  try {
    // 1. Market data (parallel fetch)
    const [marketData, optionChain, newsSentiment] = await Promise.all([
      fetchMarketData(asset),
      fetchOptionChain(asset),
      fetchSentiment(asset),
    ]);

    // 1b. In LIVE mode: fetch the latest closed 5-min candle from Kite historical API
    // and append it to the persistent candle history buffer.
    // In MOCK mode: candleHistory is empty, so we fall back to marketData.ohlcv below.
    if (!isMock()) {
      const latestClosed = await fetchLatest5MinCandle(asset);
      if (latestClosed) {
        const alreadyExists = candleHistory.some(
          (c) => c.timestamp.getTime() === latestClosed.timestamp.getTime()
        );
        if (!alreadyExists) {
          candleHistory.push(latestClosed);
          // Keep last 100 candles in memory (covers 500 min = ~8.5 hours)
          if (candleHistory.length > 100) {
            candleHistory = candleHistory.slice(-100);
          }
          logger.debug("📊 Appended new 5-min candle to history", {
            candleTime: latestClosed.timestamp.toISOString(),
            historyLength: candleHistory.length,
            sessionId,
            asset,
          });
        }
      }
    }

    // Use the accumulated history for indicator computation in LIVE mode;
    // fall back to marketData.ohlcv (from MockDataService) in MOCK mode.
    const ohlcvForIndicators: OHLCVData =
      candleHistory.length > 0 ? candleHistory : marketData.ohlcv;

    // Same-candle deduplication: skip signal generation if the last candle hasn't changed.
    // Uses the last entry of ohlcvForIndicators — a proper 5-min bar timestamp in LIVE mode.
    // Position monitoring (separate 30s loop) is unaffected — this only skips LLM/indicator work.
    const latestCandle = ohlcvForIndicators[ohlcvForIndicators.length - 1];
    const candleTime = latestCandle?.timestamp.toISOString() ?? null;
    if (candleTime && candleTime === lastProcessedCandleTime) {
      logger.debug("⏭️ Skipping tick — same candle, no new data", { candleTime, sessionId, asset });
      WebSocketService.emit(sessionId, {
        type: "TICK_SKIPPED",
        reason: "same_candle",
        timestamp: Date.now(),
      });
      return;
    }
    // Mark this candle as processed before any await that could throw
    lastProcessedCandleTime = candleTime;
    if (candleTime) {
      logger.info(`📊 New candle closed at ${candleTime} — processing signal`, { sessionId, asset });
    }

    // 2. Indicators computation (on full history, not just today's single bar)
    const indicators: IndicatorSnapshot = computeIndicators(ohlcvForIndicators);

    // 2b. S/R context — fetch Previous Day OHLC + compute swing levels
    const [pdOHLC, swingLevels] = await Promise.all([
      getPreviousDayOHLC(asset),
      Promise.resolve(calculateSwingLevels(ohlcvForIndicators)),
    ]);
    // maxCallOIStrike and maxPutOIStrike are on the optionChain (computed below in step 3)
    // but we need spot now — use marketData.ltp as spot proxy for SR context
    const srContext: SRContext = buildSRContext(
      marketData.ltp,
      pdOHLC,
      swingLevels,
      null, // optionChain OI walls passed below after greeks computation
      indicators.atr ?? 0
    );

    // 2c. Breakout detection — scan last 6 candles for volume-confirmed S/R breach
    const breakoutResult: BreakoutResult = detectBreakout(
      ohlcvForIndicators,
      srContext,
      indicators.atr ?? 0
    );
    if (breakoutResult.state !== breakoutState) {
      logger.info(`🚨 Breakout state change: ${breakoutState} → ${breakoutResult.state}`, {
        sessionId,
        asset,
        breakLevel: breakoutResult.breakLevel,
        breachSize: breakoutResult.breachSize,
        candlesSinceBreak: breakoutResult.candlesSinceBreak,
      });
      breakoutState = breakoutResult.state;
    }

    // 3. Greeks computation
    const greeksSnapshot: GreeksSnapshot = computeGreeksSnapshot(
      optionChain,
      marketData.ltp
    );

    // 4. Expiry context
    const expiryContext: ExpiryContext = buildExpiryContext(asset);

    // 5. Portfolio summary
    const portfolioSummary = await getPortfolioSummary(sessionId);

    // 6. Recent signals (LLM context)
    const recentSignals = await getRecentSignals(sessionId, 5);
    const lastSignal: PrimarySignal | null =
      recentSignals.length > 0
        ? (await SignalLogModel.findOne({ sessionId })
            .sort({ timestamp: -1 })
            .exec())?.signal ?? null
        : null;

    // Deterministic pre-selection before LLM
    // Map INSUFFICIENT_DATA to "ranging" (conservative) since selectStrategy doesn't handle warmup
    const effectiveRegime =
      indicators.regime === "INSUFFICIENT_DATA" ? "ranging" : indicators.regime;
    const strategyPreSelection = selectStrategy(
      indicators.emaAlignment === "bullish"
        ? "BULLISH"
        : indicators.emaAlignment === "bearish"
        ? "BEARISH"
        : "NEUTRAL",
      greeksSnapshot.ivRank,
      expiryContext.currentDTE,
      effectiveRegime
    );

    const baseRiskFlags: string[] = [];

    // Add active breakout to LLM context via riskFlags so the analyst is aware
    if (breakoutResult.state !== "NONE") {
      baseRiskFlags.push(
        `breakout:${breakoutResult.state}:${breakoutResult.candlesSinceBreak ?? 0}bars_ago`
      );
    }

    // 7. LLM Primary Analyst call
    const primarySignal: PrimarySignal = await callPrimaryAnalyst({
      sessionId,
      asset,
      indicators,
      greeks: greeksSnapshot,
      expiryContext,
      newsSentiment,
      portfolio: portfolioSummary,
      recentSignals,
      riskFlags: baseRiskFlags,
      srContext,
    });

    // 8. LLM Verifier (conditional)
    let verifierResult: VerifierResult | null = null;
    if (shouldRunVerifier(primarySignal, lastSignal)) {
      verifierResult = await callVerifier(primarySignal, {
        indicators,
        greeks: greeksSnapshot,
        expiryContext,
        newsSentiment,
        portfolio: portfolioSummary,
        riskFlags: primarySignal.riskFlags,
      });
    }

    const effectiveStrategy =
      verifierResult?.adjustedStrategy ?? primarySignal.strategy;

    // Build the signal seen by RiskGuard: primary signal with verifier adjustments applied.
    // When the verifier runs it may raise or lower confidence and change strategy —
    // RiskGuard must evaluate the FINAL adjusted values, not the raw primary output.
    const signalForRisk: PrimarySignal =
      verifierResult !== null
        ? {
            ...primarySignal,
            strategy: effectiveStrategy,
            confidence: verifierResult.adjustedConfidence,
          }
        : primarySignal;

    // 9. Risk Guard check (fetch positions first for dedup rules)
    const [dailyPnL, openPositionsList, todayPositions] = await Promise.all([
      getDailyPnL(sessionId),
      getOpenPositions(sessionId),
      getTodayPositions(sessionId),
    ]);
    const dailyLossPct =
      portfolioSummary.dailyPnL === 0
        ? 0
        : (dailyPnL / portfolioSummary.dailyPnL) * 100;

    // Pre-compute spread details before risk check so netCreditPts is available
    // for the minimum-credit filter. If HOLD, spread is meaningless → credit = 0.
    let preComputedSpread: ReturnType<typeof computeSpreadDetails> | null = null;
    if (effectiveStrategy !== "HOLD") {
      preComputedSpread = computeSpreadDetails(
        marketData.ltp,
        {
          delta: greeksSnapshot.delta,
          gamma: greeksSnapshot.gamma,
          theta: greeksSnapshot.theta,
          vega: greeksSnapshot.vega,
        },
        asset,
        effectiveStrategy,
        srContext,
        indicators.atr ?? undefined
      );
    }

    // minutesSinceOpen: minutes elapsed since 9:15 IST (market open)
    const nowIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const minutesSinceOpen =
      (nowIST.getHours() - 9) * 60 + (nowIST.getMinutes() - 15);

    const riskResult = evaluateRisk({
      signal: signalForRisk,
      expiryContext,
      openPositions: portfolioSummary.openPositions,
      openPositionsList,
      todayTradeCount: todayPositions.length,
      dailyLossPct,
      paperCapital: Number(process.env.PAPER_CAPITAL || 200_000),
      asset,
      ivRank: greeksSnapshot.ivRank,
      minutesSinceOpen,
      atr: indicators.atr ?? null,
      rsi: indicators.rsi,
      rsiSlope: indicators.rsiSlope ?? null,
      volumeRatio: indicators.volumeRatio,
      pcr: greeksSnapshot.pcr,
      netCreditPts: preComputedSpread?.credit ?? 0,
      srContext,
      breakout: breakoutResult,
    });

    let openedPosition = null;

    // 10. Paper trade execution (if SUGGEST)
    if (
      riskResult.action === "SUGGEST" &&
      effectiveStrategy !== "HOLD"
    ) {
      // preComputedSpread is guaranteed non-null here: it was computed above
      // whenever effectiveStrategy !== "HOLD", which is the same condition.
      openedPosition = await openPosition(
        primarySignal,
        preComputedSpread!,
        sessionId,
        asset,
        Number(process.env.PAPER_CAPITAL || 200_000),
        marketData.ltp,
        expiryContext.currentDTE,
        marketData.dataMode,
        indicators.atr ?? null
      );

      WebSocketService.emit(sessionId, {
        type: "POSITION_OPENED",
        payload: openedPosition,
      });
    }

    // 11. Session update (PnL, signal count)
    await MonitoringSessionModel.updateOne(
      { sessionId },
      {
        $inc: {
          totalSignals: 1,
          totalTrades: openedPosition ? 1 : 0,
        },
        $set: {
          paperPnL: portfolioSummary.dailyPnL,
        },
      }
    ).exec();

    // 12. WebSocket emit
    const openPositions = await getOpenPositions(sessionId);

    const signalMessage: WSMessage = {
      type: "SIGNAL",
      payload: {
        sessionId,
        asset,
        ltp: marketData.ltp,
        signal: primarySignal,
        verifierResult,
        riskAction: riskResult.action,
        blockReason: riskResult.reason ?? null,
        indicators,
        greeksSnapshot,
        expiryContext,
        srContext,
        breakoutResult,
        paperPnL: portfolioSummary.dailyPnL,
        openPositions: openPositions.length,
        dataMode: marketData.dataMode,
        timestamp: Date.now(),
      },
    };

    WebSocketService.emit(sessionId, signalMessage);

    // 13. DB log (SignalLog)
    await SignalLogModel.create({
      sessionId,
      asset,
      ltp: marketData.ltp,
      signal: primarySignal,
      verifierResult,
      riskAction: riskResult.action,
      blockReason: riskResult.reason ?? null,
      indicators,
      greeksSnapshot,
      expiryContext,
      dataMode: marketData.dataMode,
      timestamp: new Date(),
    });

    const elapsed = Date.now() - startedAt;
    logger.info("Signal tick completed", {
      sessionId,
      asset,
      elapsedMs: elapsed,
    });
  } catch (error) {
    logger.error("Signal tick error", { error, sessionId, asset });

    const errorMessage: WSMessage = {
      type: "TICK_ERROR",
      error: "tick_failed",
      timestamp: Date.now(),
    };
    WebSocketService.emit(sessionId, errorMessage);
  } finally {
    isTickRunning = false;
  }
}

