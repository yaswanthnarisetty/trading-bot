import type { AssetKey } from "../config/assets";
import { OptionsPositionModel } from "../models/OptionsPosition";
import { getLTP } from "./KiteService";
import {
  isEODClose,
  getISTDayOfWeek,
} from "../utils/marketHours";
import {
  TARGET_PROFIT_PCT,
  STOP_LOSS_PCT,
  POSITION_MONITOR_INTERVAL_MS,
  MAX_HOLDING_MINUTES,
  DIRECTIONAL_STOP_ATR_MULT,
  DIRECTIONAL_STOP_FALLBACK_PTS,
} from "../config/constants";
import {
  closePosition,
  calculateCurrentPnL,
  getDailyPnL,
} from "./PaperTradeService";
import type { PortfolioSummary } from "../types/trading";
import { WebSocketService } from "./WebSocketService";
import type { OptionsPosition } from "@trading-bot/shared";
import { logger } from "../utils/logger";

let monitorInterval: NodeJS.Timeout | null = null;

/**
 * Starts the periodic position monitor for a given session.
 * This loop is independent from the signal loop and focuses purely on exit conditions.
 *
 * @param sessionId - Identifier for the trading session to monitor.
 */
export function start(_sessionId: string): void {
  throw new Error("LEGACY_POSITION_MONITOR_DISABLED");
}

/**
 * Stops the active position monitor loop, if any.
 * This is typically called at session stop or after trading hours.
 */
export function stop(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

/**
 * Unconditionally closes every open position for a session at end-of-day.
 * This is called on every 30-second monitor tick and acts only after 15:25 IST.
 * Guarantees no position is ever held overnight regardless of exit condition.
 *
 * @param sessionId - Identifier of the session whose positions are force-closed.
 * @returns A promise that resolves once all positions have been closed or errored.
 */
export async function forceCloseAllPositions(sessionId: string): Promise<void> {
  if (!isEODClose()) {
    return;
  }

  const positions = await OptionsPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();

  if (positions.length === 0) {
    return;
  }

  logger.info("EOD force-closing all open positions", {
    sessionId,
    count: positions.length,
  });

  for (const doc of positions) {
    try {
      const position = doc.toObject() as OptionsPosition;
      const currentLTP = await getLTP(position.asset as AssetKey);
      const currentPnL = calculateCurrentPnL(position, currentLTP);
      logger.info(
        `🔴 EOD force close: ${position.positionId} PnL: ${currentPnL.toFixed(2)}`
      );
      const closed = await closePosition(
        position.positionId,
        currentLTP,
        "EOD_FORCED_CLOSE"
      );
      WebSocketService.emit(sessionId, {
        type: "POSITION_CLOSED",
        payload: closed,
      });
    } catch (error) {
      logger.error("Failed to force-close position at EOD", {
        sessionId,
        positionId: doc.positionId,
        error,
      });
    }
  }
}

/**
 * Evaluates all open positions for a session and performs closes as needed.
 * Priority order:
 *   1. EOD_CLOSE         — after 15:20 IST (Tuesday: 13:00), no overnight positions
 *   2. TIME_EXIT         — held >= MAX_HOLDING_MINUTES (60 min), stale position
 *   3. TARGET_HIT        — PnL >= TARGET_PROFIT_PCT (50%) of max profit
 *   4. DIRECTIONAL_STOP  — underlying moved ATR×3 against the spread
 *   5. SL_HIT            — PnL <= -STOP_LOSS_PCT of max loss
 *
 * NEAR_EXPIRY is intentionally NOT an exit trigger here.
 * It is an ENTRY block only (enforced in RiskGuardService).
 * Existing positions on expiry day are allowed to run to EOD_FORCED_CLOSE.
 *
 * @param sessionId - Identifier of the session whose positions are checked.
 * @returns A promise that resolves once all checks have completed.
 */
export async function checkPositions(sessionId: string): Promise<void> {
  const positions = await OptionsPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();

  for (const doc of positions) {
    try {
      const position = doc.toObject() as OptionsPosition;
      const asset = position.asset as AssetKey;

      const currentLTP = await getLTP(asset);
      const currentPnL = calculateCurrentPnL(position, currentLTP);

      let shouldClose = false;
      let reason: OptionsPosition["exitReason"] = null;

      const holdingMs = Date.now() - new Date(position.entryTimestamp).getTime();
      const maxHoldingMs = MAX_HOLDING_MINUTES * 60 * 1000;

      if (isEODClose()) {
        // 1. EOD — no overnight positions (forceCloseAllPositions also handles this,
        //    but this acts as a belt-and-suspenders catch inside checkPositions)
        shouldClose = true;
        reason = "EOD_CLOSE";
      } else if (holdingMs >= maxHoldingMs) {
        // 2. Time exit — stale position, free up capital
        shouldClose = true;
        reason = "TIME_EXIT";
      } else if (currentPnL >= position.maxProfit * TARGET_PROFIT_PCT) {
        // 3. Target hit — 50% of max credit
        shouldClose = true;
        reason = "TARGET_HIT";
      } else {
        // 5. Directional stop — underlying moved strongly against the spread
        const dsThreshold =
          position.entryATR != null
            ? position.entryATR * DIRECTIONAL_STOP_ATR_MULT
            : DIRECTIONAL_STOP_FALLBACK_PTS;
        const spotMove = currentLTP - position.entrySpot;
        const isDirectionalStop =
          (position.strategy === "BEAR_CALL_SPREAD" && spotMove > dsThreshold) ||
          (position.strategy === "BULL_PUT_SPREAD" && spotMove < -dsThreshold);
        if (isDirectionalStop) {
          shouldClose = true;
          reason = "DIRECTIONAL_STOP";
        } else {
          // 6. Stop loss — tighter on Mon/Tue (expiry week): 30% instead of 50%
          const dow = getISTDayOfWeek();
          const stopLossPct = (dow === 1 || dow === 2) ? 0.30 : STOP_LOSS_PCT;
          if (currentPnL <= -position.maxLoss * stopLossPct) {
            shouldClose = true;
            reason = "SL_HIT";
          }
        }
      }

      if (shouldClose && reason) {
        // Pass currentPnL for TIME_EXIT, SL_HIT, and DIRECTIONAL_STOP so realized
        // PnL is accurate, not the max-profit/max-loss heuristic.
        const pnlOverride =
          reason === "TIME_EXIT" || reason === "SL_HIT" || reason === "DIRECTIONAL_STOP"
            ? currentPnL
            : undefined;

        const closed = await closePosition(
          position.positionId,
          currentLTP,
          reason,
          pnlOverride
        );

        WebSocketService.emit(sessionId, {
          type: "POSITION_CLOSED",
          payload: closed,
        });
      }

      WebSocketService.emit(sessionId, {
        type: "POSITION_UPDATE",
        payload: {
          positionId: position.positionId,
          currentPnL,
          currentLTP,
        },
      });
    } catch (error) {
      logger.error("Error while checking position", {
        sessionId,
        positionId: (doc as any).positionId,
        error,
      });
    }
  }
}

/**
 * Computes a high-level portfolio summary for the given session.
 * This summary is used for dashboards, LLM context, and risk management.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @returns Promise resolving to a PortfolioSummary object.
 */
export async function getPortfolioSummary(
  sessionId: string
): Promise<PortfolioSummary> {
  const openDocs = await OptionsPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();

  const openPositions = openDocs.length;

  let netDelta = 0;
  let netTheta = 0;
  let totalCapitalAtRisk = 0;

  for (const doc of openDocs) {
    const position = doc.toObject() as OptionsPosition;

    const lots = position.legs[0]?.lots ?? 0;
    const lotSize = position.legs[0]?.lotSize ?? 0;

    const direction =
      position.strategy === "BULL_PUT_SPREAD" ? 1 : -1;

    netDelta += direction * 0.2 * lots * lotSize;
    netTheta += direction * 0.5 * lots * lotSize;
    totalCapitalAtRisk += position.maxLoss;
  }

  const dailyPnL = await getDailyPnL(sessionId);

  return {
    openPositions,
    netDelta,
    netTheta,
    totalCapitalAtRisk,
    dailyPnL,
  };
}

