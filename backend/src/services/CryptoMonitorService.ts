import type { CryptoPosition } from "@trading-bot/shared";
import { CryptoPositionModel } from "../models/CryptoPosition";
import { getDeltaPrice } from "./DeltaService";
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
 * Called on session stop or server shutdown.
 */
export function stopCryptoEngine(): void {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  if (signalInterval)  { clearInterval(signalInterval);  signalInterval  = null; }
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
 * Evaluates entry signals and opens a position if conditions are met.
 * Guards:
 *   - max open positions not exceeded
 *   - daily loss limit not hit
 *   - signal confidence above CRYPTO_MIN_CONFIDENCE
 *
 * @param sessionId - Active BTC session identifier
 * @param capital   - Available capital for position sizing
 */
async function runCryptoSignalTick(
  sessionId: string,
  capital: number
): Promise<void> {
  // Guard: max positions
  const openPositions = await getOpenCryptoPositions(sessionId);
  if (openPositions.length >= CRYPTO_MAX_POSITIONS) {
    logger.debug("Crypto signal tick: max positions reached", {
      sessionId,
      count: openPositions.length,
    });
    return;
  }

  // Guard: daily loss limit
  const dailyPnL = await getCryptoDailyPnL(sessionId);
  const maxDailyLoss = -(capital * (CRYPTO_MAX_DAILY_LOSS_PCT / 100));
  if (dailyPnL <= maxDailyLoss) {
    logger.warn("⛔ Crypto daily loss limit hit — halting entries", {
      sessionId,
      dailyPnL,
      maxDailyLoss,
    });
    return;
  }

  const signal = await evaluateCryptoSignal("BTCUSD");

  WebSocketService.emit(sessionId, {
    type: "SIGNAL",  // reuse SIGNAL slot for crypto signal events
    payload: signal,
  } as any);

  if (!isActionableSignal(signal)) {
    logger.debug("Crypto signal: HOLD", { sessionId, reason: signal.reason });
    return;
  }

  const currentPrice = await getDeltaPrice("BTCUSD");
  const position = await openCryptoPosition(
    sessionId,
    signal.side as "LONG" | "SHORT",
    currentPrice,
    capital
  );

  WebSocketService.emit(sessionId, {
    type: "POSITION_OPENED",  // mapped from CRYPTO_POSITION_OPENED
    payload: position,
  } as any);
}
