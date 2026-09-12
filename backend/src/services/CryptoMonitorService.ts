import { denyCryptoExecution } from "../domain/ExecutionSafety";
import type { CryptoPosition } from "@trading-bot/shared";
import { CryptoPositionModel } from "../models/CryptoPosition";
import { CryptoSignalLogModel } from "../models/CryptoSignalLog";
import { getDeltaPrice } from "./DeltaService";
import { isDeltaMock } from "./DeltaService";
import {
  calculateCryptoPnL,
  closeCryptoPosition,
  openCryptoPosition,
  getOpenCryptoPositions,
  getCryptoDailyPnL,
} from "./CryptoTradingService";
import { evaluateCryptoSignal, isActionableSignal } from "./CryptoSignalService";
import { WebSocketService } from "./WebSocketService";
import {
  CRYPTO_MONITOR_INTERVAL_MS,
  CRYPTO_TICK_INTERVAL_MS,
  CRYPTO_MAX_POSITIONS,
  CRYPTO_MAX_DAILY_LOSS_PCT,
} from "../config/constants";
import { logger } from "../utils/logger";

let monitorInterval: NodeJS.Timeout | null = null;
let signalInterval:  NodeJS.Timeout | null = null;
/** Prevents overlapping signal ticks — mirrors KiteService SignalLoopService pattern. */
let isTickRunning = false;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Starts the BTC position monitor and signal loop for a session.
 * The monitor runs every 10 s (CRYPTO_MONITOR_INTERVAL_MS) to check SL/TP.
 * The signal loop runs every 60 s (CRYPTO_TICK_INTERVAL_MS) to evaluate entry signals.
 * Both loops are 24/7 — no market-hour restrictions.
 *
 * @param sessionId   - Active BTC session identifier
 * @param capital     - Paper / live capital available
 */
export function startCryptoEngine(sessionId: string, capital: number): void {
  denyCryptoExecution();
  if (monitorInterval || signalInterval) {
    logger.warn("Crypto engine already running — skipping duplicate start", { sessionId });
    return;
  }

  logger.info("🚀 Crypto engine started", { sessionId, capital });

  // SL/TP monitor — runs frequently
  const monitorTick = async () => {
    try {
      await checkCryptoPositions(sessionId);
    } catch (err) {
      logger.error("Crypto monitor tick failed", { err, sessionId });
    }
  };

  // Signal loop — runs every minute to look for entries
  const signalTick = async () => {
    try {
      await runCryptoSignalTick(sessionId, capital);
    } catch (err) {
      logger.error("Crypto signal tick failed", { err, sessionId });
    }
  };

  void monitorTick();
  void signalTick();
  monitorInterval = setInterval(monitorTick,  CRYPTO_MONITOR_INTERVAL_MS);
  signalInterval  = setInterval(signalTick,   CRYPTO_TICK_INTERVAL_MS);
}

/**
 * Stops both the monitor and signal loop.
 * Waits for any in-flight signal tick to finish before returning so that
 * forceCloseAllCryptoPositions sees a fully consistent DB state.
 * Timeout: 30 s — after that the tick is considered stale and we proceed.
 */
export async function stopCryptoEngine(): Promise<void> {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  if (signalInterval)  { clearInterval(signalInterval);  signalInterval  = null; }

  // Wait for a running signal tick to finish (race-condition guard)
  if (isTickRunning) {
    logger.info("⏳ Waiting for in-flight signal tick to finish before closing positions…");
    const deadline = Date.now() + 30_000;
    while (isTickRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isTickRunning) {
      logger.warn("Signal tick did not finish within 30 s — proceeding with force-close anyway");
    }
  }

  isTickRunning = false;
  logger.info("🛑 Crypto engine stopped");
}

// ─── SL / TP Monitor ─────────────────────────────────────────────────────────

/**
 * Checks all open BTC positions for SL/TP triggers.
 * Emits WebSocket events to connected clients on each update.
 *
 * Exit priority:
 *   1. SL_HIT — current price crossed stop loss level
 *   2. TP_HIT — current price crossed take profit level
 *
 * @param sessionId - Active BTC session identifier
 */
export async function checkCryptoPositions(sessionId: string): Promise<void> {
  denyCryptoExecution();
  const openDocs = await CryptoPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();

  for (const doc of openDocs) {
    const position = doc.toObject() as CryptoPosition;

    try {
      const currentPrice = await getDeltaPrice("BTCUSD");
      const unrealizedPnL = calculateCryptoPnL(position, currentPrice);

      // Update unrealizedPnL in DB without triggering full close logic
      (doc as any).unrealizedPnL = unrealizedPnL;
      await doc.save();

      let exitReason: CryptoPosition["exitReason"] = null;

      if (position.side === "LONG") {
        if (currentPrice <= position.stopLoss)   exitReason = "SL_HIT";
        else if (currentPrice >= position.takeProfit) exitReason = "TP_HIT";
      } else {
        if (currentPrice >= position.stopLoss)   exitReason = "SL_HIT";
        else if (currentPrice <= position.takeProfit) exitReason = "TP_HIT";
      }

      if (exitReason) {
        const closed = await closeCryptoPosition(
          position.positionId,
          currentPrice,
          exitReason
        );
        WebSocketService.emit(sessionId, {
          type: "POSITION_CLOSED",  // mapped from CRYPTO_POSITION_CLOSED
          payload: closed,
        } as any);
        logger.info(`🔴 Crypto position closed (${exitReason})`, {
          positionId: position.positionId,
          exitReason,
          currentPrice,
          realizedPnL: closed.realizedPnL,
        });
      } else {
        WebSocketService.emit(sessionId, {
          type: "POSITION_UPDATE",  // mapped from CRYPTO_POSITION_UPDATE
          payload: {
            positionId: position.positionId,
            currentPnL: unrealizedPnL,
            currentLTP: currentPrice,
          },
        } as any);
      }
    } catch (err) {
      logger.error("Error checking crypto position", {
        sessionId,
        positionId: position.positionId,
        err,
      });
    }
  }
}

/**
 * Force-closes all open BTC positions for a session.
 * Used on session stop (SESSION_STOP reason).
 *
 * @param sessionId - Active BTC session identifier
 */
export async function forceCloseAllCryptoPositions(
  sessionId: string
): Promise<void> {
  denyCryptoExecution();
  const positions = await getOpenCryptoPositions(sessionId);
  if (positions.length === 0) return;

  logger.info("🔴 Force-closing all open BTC positions on session stop", {
    sessionId,
    count: positions.length,
  });

  for (const position of positions) {
    try {
      const currentPrice = await getDeltaPrice("BTCUSD");
      const closed = await closeCryptoPosition(
        position.positionId,
        currentPrice,
        "SESSION_STOP"
      );
      WebSocketService.emit(sessionId, {
          type: "POSITION_CLOSED",  // mapped from CRYPTO_POSITION_CLOSED
          payload: closed,
        } as any);
    } catch (err) {
      logger.error("Failed to force-close crypto position", {
        sessionId,
        positionId: position.positionId,
        err,
      });
    }
  }
}

// ─── Signal Loop ─────────────────────────────────────────────────────────────

/**
 * Evaluates entry signals and opens a position if all risk guards pass.
 *
 * Mirrors KiteService SignalLoopService pattern:
 *   1. Concurrency guard — skip if previous tick still running
 *   2. Always evaluate signal first (so WebSocket always gets a SIGNAL event)
 *   3. Run risk guards in priority order, collecting riskAction + blockReason
 *   4. Emit SIGNAL with riskAction + blockReason so UI shows why blocked
 *   5. Only open position when riskAction = "SUGGEST"
 *
 * Risk guards (in order):
 *   1. MAX_POSITIONS      — open positions ≥ CRYPTO_MAX_POSITIONS
 *   2. DAILY_LOSS_LIMIT   — today's realized PnL ≤ -(capital × CRYPTO_MAX_DAILY_LOSS_PCT%)
 *   3. SAME_DIRECTION_OPEN — an open position in the same direction already exists
 *   4. HOLD               — signal side is HOLD (no EMA/RSI alignment)
 *   5. LOW_CONFIDENCE     — signal confidence < CRYPTO_MIN_CONFIDENCE
 *
 * @param sessionId - Active BTC session identifier
 * @param capital   - Available capital for position sizing
 */
async function runCryptoSignalTick(
  sessionId: string,
  capital: number
): Promise<void> {
  denyCryptoExecution();
  // Concurrency guard — skip if previous tick still processing
  if (isTickRunning) {
    logger.debug("Crypto signal tick: previous tick still running, skipping", { sessionId });
    return;
  }
  isTickRunning = true;

  try {
    // Always evaluate the signal first so the WebSocket always fires
    const signal = await evaluateCryptoSignal("BTCUSD");

    // ── Risk guards ────────────────────────────────────────────────────────
    let riskAction: "SUGGEST" | "BLOCK" = "SUGGEST";
    let blockReason: string | undefined;

    const openPositions = await getOpenCryptoPositions(sessionId);

    // Guard 1: max concurrent positions
    if (openPositions.length >= CRYPTO_MAX_POSITIONS) {
      riskAction  = "BLOCK";
      blockReason = `MAX_POSITIONS: ${openPositions.length}/${CRYPTO_MAX_POSITIONS} open`;
    }

    // Guard 2: daily loss limit
    if (riskAction === "SUGGEST") {
      const dailyPnL = await getCryptoDailyPnL(sessionId);
      const maxDailyLoss = -(capital * (CRYPTO_MAX_DAILY_LOSS_PCT / 100));
      if (dailyPnL <= maxDailyLoss) {
        riskAction  = "BLOCK";
        blockReason = `DAILY_LOSS_LIMIT: dailyPnL=${dailyPnL.toFixed(2)} ≤ limit=${maxDailyLoss.toFixed(2)}`;
      }
    }

    // Guard 3: same-direction position already open (mirrors Kite SAME_DIRECTION_OPEN rule)
    if (riskAction === "SUGGEST" && signal.side !== "HOLD") {
      const sameDir = openPositions.find((p) => p.side === signal.side);
      if (sameDir) {
        riskAction  = "BLOCK";
        blockReason = `SAME_DIRECTION_OPEN: ${signal.side} position already open`;
      }
    }

    // Guard 4 + 5: signal not actionable (HOLD or low confidence)
    if (riskAction === "SUGGEST" && !isActionableSignal(signal)) {
      riskAction  = "BLOCK";
      blockReason = signal.side === "HOLD"
        ? `HOLD: ${signal.reason}`
        : `LOW_CONFIDENCE: ${signal.confidence} < ${CRYPTO_MAX_DAILY_LOSS_PCT}`;
    }

    // ── Persist signal to DB so page refresh restores history ─────────────
    try {
      await CryptoSignalLogModel.create({
        sessionId,
        asset:       signal.asset,
        side:        signal.side,
        confidence:  signal.confidence,
        rsi:         signal.rsi,
        ema9:        signal.ema9,
        ema21:       signal.ema21,
        ema50:       signal.ema50,
        atr:         signal.atr,
        volumeRatio: signal.volumeRatio,
        reason:      signal.reason,
        riskAction,
        blockReason:  blockReason ?? null,
        dataMode:     isDeltaMock() ? "MOCK" : "LIVE",
        timestamp:    new Date(signal.timestamp),
      });
    } catch (dbErr) {
      logger.warn("Failed to persist crypto signal log", {
        message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    // ── Always emit SIGNAL with risk context ──────────────────────────────
    WebSocketService.emit(sessionId, {
      type: "SIGNAL",
      payload: { ...signal, riskAction, blockReason },
    } as any);

    if (riskAction === "BLOCK") {
      logger.info("🚫 Crypto signal blocked", {
        sessionId,
        side: signal.side,
        confidence: signal.confidence,
        rsi: signal.rsi,
        volumeRatio: signal.volumeRatio,
        blockReason,
      });
      return;
    }

    // ── Open position ─────────────────────────────────────────────────────
    logger.info("✅ Crypto signal actionable — opening position", {
      sessionId,
      side: signal.side,
      confidence: signal.confidence,
      rsi: signal.rsi,
      ema9: signal.ema9,
      ema21: signal.ema21,
      ema50: signal.ema50,
      volumeRatio: signal.volumeRatio,
    });

    const currentPrice = await getDeltaPrice("BTCUSD");
    const position = await openCryptoPosition(
      sessionId,
      signal.side as "LONG" | "SHORT",
      currentPrice,
      capital,
      signal.atr
    );

    WebSocketService.emit(sessionId, {
      type: "POSITION_OPENED",
      payload: position,
    } as any);

  } finally {
    isTickRunning = false;
  }
}
