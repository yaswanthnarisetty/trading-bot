import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "./auth.middleware";
import { getDeltaPrice } from "../services/DeltaService";
import {
  closeCryptoPosition,
  getCryptoPositionHistory,
  getOpenCryptoPositions,
  getCryptoDailyPnL,
} from "../services/CryptoTradingService";
import {
  startCryptoEngine,
  stopCryptoEngine,
  forceCloseAllCryptoPositions,
} from "../services/CryptoMonitorService";
import { CryptoPositionModel } from "../models/CryptoPosition";
import { logger } from "../utils/logger";
import type { CryptoPosition } from "@trading-bot/shared";

// In-memory store for the active BTC session.
// A production system would persist this to MongoDB (MonitoringSession).
// For paper-trading MVP, a single concurrent session is the constraint.
interface CryptoSession {
  sessionId: string;
  asset: "BTCUSD";
  capital: number;
  startTime: string;
  status: "RUNNING" | "STOPPED";
}
let activeCryptoSession: CryptoSession | null = null;

const router = Router();

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * POST /api/crypto/session/start
 * Starts a new BTC trading session, initialises both the monitor and signal loops.
 * Only one BTC session can be RUNNING at a time.
 */
async function handleStartCryptoSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (activeCryptoSession?.status === "RUNNING") {
      res.status(409).json({ error: "BTC session already running", code: 409 });
      return;
    }

    const capital = Number(process.env.BTC_PAPER_CAPITAL ?? 100);
    const sessionId = uuidv4();

    activeCryptoSession = {
      sessionId,
      asset: "BTCUSD",
      capital,
      startTime: new Date().toISOString(),
      status: "RUNNING",
    };

    startCryptoEngine(sessionId, capital);

    logger.info("BTC session started", { sessionId, capital });
    res.json(activeCryptoSession);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/crypto/session/stop
 * Stops the running BTC session and force-closes all open positions.
 */
async function handleStopCryptoSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!activeCryptoSession || activeCryptoSession.status !== "RUNNING") {
      res.status(404).json({ error: "No active BTC session", code: 404 });
      return;
    }

    stopCryptoEngine();
    await forceCloseAllCryptoPositions(activeCryptoSession.sessionId);

    activeCryptoSession.status = "STOPPED";
    logger.info("BTC session stopped", { sessionId: activeCryptoSession.sessionId });
    res.json(activeCryptoSession);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/crypto/session/active
 * Returns the currently running BTC session or null.
 */
function handleGetActiveCryptoSession(
  _req: Request,
  res: Response
): void {
  res.json(activeCryptoSession?.status === "RUNNING" ? activeCryptoSession : null);
}

// ─── Price ────────────────────────────────────────────────────────────────────

/**
 * GET /api/crypto/price
 * Returns current BTC price from Delta Exchange (mock jitter in paper mode).
 */
async function handleGetBtcPrice(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const price = await getDeltaPrice("BTCUSD");
    res.json({ asset: "BTCUSD", price, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
}

// ─── Positions ────────────────────────────────────────────────────────────────

/**
 * GET /api/crypto/positions/:sessionId
 * Returns all positions for a session with optional status filter and pagination.
 */
async function handleGetCryptoPositions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const status = String(req.query.status ?? "ALL").toUpperCase();
    const limit  = Math.min(Number(req.query.limit ?? 50) || 50, 100);
    const offset = Number(req.query.offset ?? 0) || 0;

    const filter: Record<string, unknown> = { sessionId };
    if (status === "OPEN")   filter.status = "OPEN";
    if (status === "CLOSED") filter.status = "CLOSED";

    const [positions, total] = await Promise.all([
      CryptoPositionModel.find(filter)
        .sort({ entryTimestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      CryptoPositionModel.countDocuments(filter).exec(),
    ]);

    res.json({
      positions: positions.map((p) => p.toObject() as CryptoPosition),
      total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/crypto/positions/:sessionId/open
 * Returns only open positions for a session.
 */
async function handleGetOpenCryptoPositions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const positions = await getOpenCryptoPositions(sessionId);
    res.json(positions);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/crypto/positions/:positionId/close
 * Manually closes an open BTC position at current market price.
 */
async function handleManualCloseCryptoPosition(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { positionId } = req.params;

    const doc = await CryptoPositionModel.findOne({ positionId }).exec();
    if (!doc) {
      res.status(404).json({ error: "Position not found", code: 404 });
      return;
    }
    if (doc.status !== "OPEN") {
      res.status(400).json({ error: "Position already closed", code: 400 });
      return;
    }

    const currentPrice = await getDeltaPrice("BTCUSD");
    const closed = await closeCryptoPosition(positionId, currentPrice, "MANUAL");
    res.json(closed);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/crypto/history
 * Cross-session position history with optional date filter and pagination.
 */
async function handleGetCryptoHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 50) || 50, 100);
    const offset = Number(req.query.offset ?? 0) || 0;
    const { startDate, endDate } = req.query;

    const filter: Record<string, unknown> = {};
    if (startDate || endDate) {
      filter.entryTimestamp = {};
      if (startDate && typeof startDate === "string")
        (filter.entryTimestamp as any).$gte = startDate;
      if (endDate && typeof endDate === "string")
        (filter.entryTimestamp as any).$lte = endDate;
    }

    const [positions, total] = await Promise.all([
      CryptoPositionModel.find(filter)
        .sort({ entryTimestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      CryptoPositionModel.countDocuments(filter).exec(),
    ]);

    res.json({
      positions: positions.map((p) => p.toObject() as CryptoPosition),
      total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/crypto/pnl/:sessionId
 * Returns today's realized PnL for a BTC session.
 */
async function handleGetCryptoDailyPnl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const dailyPnL = await getCryptoDailyPnL(sessionId);
    res.json({ sessionId, dailyPnL });
  } catch (error) {
    next(error);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────
router.post("/session/start",  authMiddleware, handleStartCryptoSession);
router.post("/session/stop",   authMiddleware, handleStopCryptoSession);
router.get("/session/active",  authMiddleware, handleGetActiveCryptoSession);
router.get("/price",           authMiddleware, handleGetBtcPrice);
router.get("/positions/:sessionId/open", authMiddleware, handleGetOpenCryptoPositions);
router.get("/positions/:sessionId",      authMiddleware, handleGetCryptoPositions);
router.patch("/positions/:positionId/close", authMiddleware, handleManualCloseCryptoPosition);
router.get("/history",         authMiddleware, handleGetCryptoHistory);
router.get("/pnl/:sessionId",  authMiddleware, handleGetCryptoDailyPnl);

export default router;
