import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { v4 as uuidv4 } from "uuid";
import { ALLOWED_ASSETS, type AssetKey } from "../config/assets";
import { MonitoringSessionModel } from "../models/MonitoringSession";
import { OptionsPositionModel } from "../models/OptionsPosition";
import {
  start as startSignalLoop,
  stop as stopSignalLoop,
} from "../services/SignalLoopService";
import {
  start as startPositionMonitor,
  stop as stopPositionMonitor,
} from "../services/PositionMonitorService";
import { closePosition, calculateCurrentPnL, getDailyPnL } from "../services/PaperTradeService";
import { getLTP } from "../services/KiteService";
import { WebSocketService } from "../services/WebSocketService";
import { logger } from "../utils/logger";
import type { OptionsPosition } from "@trading-bot/shared";
import { authMiddleware } from "./auth.middleware";

const router = Router();

/**
 * Extracts and validates an AssetKey from a raw request body value.
 * This ensures sessions can only be started for explicitly allowed assets.
 *
 * @param raw - The raw asset value from the request body.
 * @returns A valid AssetKey or null if the asset is not allowed.
 */
function parseAssetKey(raw: unknown): AssetKey | null {
  const key = typeof raw === "string" ? raw : "";
  if (key in ALLOWED_ASSETS) {
    return key as AssetKey;
  }
  return null;
}

/**
 * Handles POST /api/session/start to create and start a new monitoring session.
 * Enforces single RUNNING session constraint, seeds DB record, and starts both loops.
 *
 * @param req - The HTTP request containing the desired asset in the body.
 * @param res - The HTTP response used to send the session summary.
 * @param next - Express next function for error propagation.
 */
async function handleStartSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const assetKey = parseAssetKey(req.body?.asset);
    if (!assetKey) {
      res.status(400).json({ error: "Invalid asset", code: 400 });
      return;
    }

    const existing = await MonitoringSessionModel.findOne({
      status: "RUNNING",
    }).exec();

    if (existing) {
      res
        .status(409)
        .json({ error: "Session already running", code: 409 });
      return;
    }

    const sessionId = uuidv4();
    const nowIso = new Date().toISOString();
    const paperCapital = Number(process.env.PAPER_CAPITAL || 200_000);
    const dataMode = process.env.KITE_API_KEY ? "LIVE" : "MOCK";

    const sessionDoc = await MonitoringSessionModel.create({
      sessionId,
      asset: assetKey,
      startTime: nowIso,
      stopTime: null,
      status: "RUNNING",
      totalSignals: 0,
      totalTrades: 0,
      winRate: 0,
      paperPnL: 0,
      paperCapital,
      ticksSkipped: 0,
      dataMode,
    });

    await startSignalLoop(sessionId, assetKey);
    startPositionMonitor(sessionId);

    logger.info("Monitoring session started", {
      sessionId,
      asset: assetKey,
      paperCapital,
      dataMode,
    });

    res.json({
      sessionId,
      asset: assetKey,
      paperCapital,
      dataMode,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Forces closure of all open positions for a session with EOD reason.
 * This is used when stopping a session to remove any residual exposure.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @returns Promise that resolves once all positions are closed.
 */
async function forceCloseAllPositions(sessionId: string): Promise<void> {
  const openPositions = await OptionsPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();

  for (const doc of openPositions) {
    const pos = doc.toObject() as OptionsPosition;
    try {
      // Fetch current market price for accurate exit P&L
      const currentLTP = await getLTP(pos.asset as AssetKey);
      const pnlAtClose = calculateCurrentPnL(pos, currentLTP);
      const closed = await closePosition(
        pos.positionId,
        currentLTP,
        "SESSION_STOP",
        pnlAtClose
      );
      WebSocketService.emit(sessionId, {
        type: "POSITION_CLOSED",
        payload: closed,
      });
    } catch (error) {
      logger.error("Failed to force-close position on session stop", {
        sessionId,
        positionId: pos.positionId,
        error,
      });
    }
  }
}

/**
 * Handles POST /api/session/stop to gracefully stop an active monitoring session.
 * Stops loops, force-closes positions, updates session stats, and emits WS notification.
 *
 * @param req - The HTTP request containing the sessionId in the body.
 * @param res - The HTTP response used to send the final session summary.
 * @param next - Express next function for error propagation.
 */
async function handleStopSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required", code: 400 });
      return;
    }

    const session = await MonitoringSessionModel.findOne({
      sessionId,
    }).exec();

    if (!session) {
      res.status(404).json({ error: "Session not found", code: 404 });
      return;
    }

    stopSignalLoop();
    stopPositionMonitor();

    await forceCloseAllPositions(sessionId);

    const closedPositions = await OptionsPositionModel.find({
      sessionId,
      status: { $ne: "OPEN" },
    }).exec();

    const wins = closedPositions.filter(
      (p) => (p.realizedPnL ?? 0) > 0
    ).length;
    const totalTrades = closedPositions.length;
    const winRate =
      totalTrades === 0 ? 0 : (wins / totalTrades) * 100;

    const paperPnL = await getDailyPnL(sessionId);

    session.status = "STOPPED";
    session.stopTime = new Date().toISOString();
    session.winRate = winRate;
    session.paperPnL = paperPnL;
    session.totalTrades = totalTrades;

    await session.save();

    WebSocketService.emit(sessionId, {
      type: "SESSION_STOPPED",
      payload: {
        sessionId,
        finalPnL: paperPnL,
        totalTrades,
      },
    });

    logger.info("Monitoring session stopped", {
      sessionId,
      totalTrades,
      winRate,
      paperPnL,
    });

    res.json(session.toObject());
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/session/active to return the currently running session, if any.
 * This allows the frontend to restore state on page load.
 *
 * @param _req - The incoming request (unused).
 * @param res - The HTTP response used to send the active session or null.
 * @param next - Express next function for error propagation.
 */
async function handleGetActiveSession(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const session = await MonitoringSessionModel.findOne({
      status: "RUNNING",
    }).exec();
    res.json(session ? session.toObject() : null);
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/session/:sessionId to return full session details.
 * This includes stored stats on signals, trades, PnL, and lifecycle timestamps.
 *
 * @param req - The HTTP request containing the sessionId path parameter.
 * @param res - The HTTP response used to send the session document.
 * @param next - Express next function for error propagation.
 */
async function handleGetSessionById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const session = await MonitoringSessionModel.findOne({
      sessionId,
    }).exec();

    if (!session) {
      res.status(404).json({ error: "Session not found", code: 404 });
      return;
    }

    res.json(session.toObject());
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/session/history to list past sessions.
 * Results are ordered by creation time descending and support basic pagination.
 *
 * @param req - The HTTP request containing limit and offset query parameters.
 * @param res - The HTTP response used to send the paginated session list.
 * @param next - Express next function for error propagation.
 */
async function handleGetSessionHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const limit = Math.min(
      Number(req.query.limit ?? 20) || 20,
      100
    );
    const offset = Number(req.query.offset ?? 0) || 0;

    const [sessions, total] = await Promise.all([
      MonitoringSessionModel.find({})
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      MonitoringSessionModel.countDocuments({}).exec(),
    ]);

    res.json({
      sessions: sessions.map((s) => s.toObject()),
      total,
    });
  } catch (error) {
    next(error);
  }
}

router.post("/start", authMiddleware, handleStartSession);
router.post("/stop", authMiddleware, handleStopSession);
router.get("/active", authMiddleware, handleGetActiveSession);
router.get("/history", authMiddleware, handleGetSessionHistory);
router.get("/:sessionId", authMiddleware, handleGetSessionById);

export default router;

