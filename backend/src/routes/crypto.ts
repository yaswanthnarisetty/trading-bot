import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "./auth.middleware";
import { getDeltaPrice, isDeltaMock, checkDeltaConnection } from "../services/DeltaService";
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
import { CryptoSignalLogModel } from "../models/CryptoSignalLog";
import { CryptoSessionModel } from "../models/CryptoSession";
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

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * GET /api/crypto/status
 * Returns Delta Exchange connection status, data mode, and masked API key.
 *
 * Response mirrors the shape of GET /api/kite/status:
 *   connected   — whether the Delta API is reachable (false in mock mode)
 *   dataMode    — "LIVE" when key is set and API reachable, "MOCK" otherwise
 *   apiKey      — masked to last 4 chars e.g. "***fre0", or "not set"
 *   environment — "TESTNET" or "MAINNET" based on the configured base URL
 *   message     — human-readable status string
 */
async function handleDeltaStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const apiKey = process.env.DELTA_API_KEY ?? "";
    const maskedApiKey =
      apiKey.length > 4 ? `***${apiKey.slice(-4)}` : apiKey ? "****" : "not set";

    const mock = isDeltaMock();
    let connected = false;

    if (!mock) {
      connected = await checkDeltaConnection();
    }

    const dataMode: "LIVE" | "MOCK" = !mock && connected ? "LIVE" : "MOCK";

    const message = mock
      ? "No API key configured — running in mock mode"
      : connected
        ? "Delta Exchange API connected"
        : "Delta Exchange API unreachable — check credentials";

    res.json({
      connected,
      dataMode,
      apiKey: maskedApiKey,
      environment: "TESTNET",
      message,
    });
  } catch (error) {
    next(error);
  }
}

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

    // Persist so it survives a server restart
    await CryptoSessionModel.create(activeCryptoSession);

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

    await stopCryptoEngine();
    await forceCloseAllCryptoPositions(activeCryptoSession.sessionId);

    activeCryptoSession.status = "STOPPED";

    // Persist stopped status
    await CryptoSessionModel.updateOne(
      { sessionId: activeCryptoSession.sessionId },
      { $set: { status: "STOPPED" } }
    ).exec();

    logger.info("BTC session stopped", { sessionId: activeCryptoSession.sessionId });
    res.json(activeCryptoSession);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/crypto/session/active
 * Returns the currently running BTC session or null.
 * Falls back to MongoDB when the in-memory variable is missing (e.g. after a server restart)
 * and re-attaches the engine so position monitoring + signals resume automatically.
 */
async function handleGetActiveCryptoSession(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Fast path: in-memory session already present
    if (activeCryptoSession?.status === "RUNNING") {
      res.json(activeCryptoSession);
      return;
    }

    // Slow path: look up the last RUNNING session in DB (covers server restarts)
    const doc = await CryptoSessionModel.findOne({ status: "RUNNING" })
      .sort({ startTime: -1 })
      .lean()
      .exec();

    if (!doc) {
      res.json(null);
      return;
    }

    // Restore in-memory session and re-attach the engine
    activeCryptoSession = {
      sessionId: doc.sessionId,
      asset:     doc.asset,
      capital:   doc.capital,
      startTime: doc.startTime,
      status:    "RUNNING",
    };

    startCryptoEngine(activeCryptoSession.sessionId, activeCryptoSession.capital);
    logger.info("BTC session restored from DB after server restart", {
      sessionId: activeCryptoSession.sessionId,
    });

    res.json(activeCryptoSession);
  } catch (error) {
    next(error);
  }
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

// ─── Signal History ───────────────────────────────────────────────────────────

/**
 * GET /api/crypto/signals/:sessionId
 * Returns the most recent evaluated signals for a session, newest first.
 * Used by the BTC page on mount to restore signal history after a page refresh.
 *
 * Query params:
 *   limit  — max results, capped at 50 (default 20)
 *   offset — pagination offset (default 0)
 */
async function handleGetCryptoSignals(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const limit  = Math.min(Number(req.query.limit  ?? 20) || 20, 50);
    const offset = Number(req.query.offset ?? 0) || 0;

    const [signals, total] = await Promise.all([
      CryptoSignalLogModel.find({ sessionId })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      CryptoSignalLogModel.countDocuments({ sessionId }).exec(),
    ]);

    res.json({ signals, total });
  } catch (error) {
    next(error);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────
router.get("/status",          authMiddleware, handleDeltaStatus);
router.post("/session/start",  authMiddleware, handleStartCryptoSession);
router.post("/session/stop",   authMiddleware, handleStopCryptoSession);
router.get("/session/active",  authMiddleware, handleGetActiveCryptoSession);
router.get("/price",           authMiddleware, handleGetBtcPrice);
router.get("/positions/:sessionId/open", authMiddleware, handleGetOpenCryptoPositions);
router.get("/positions/:sessionId",      authMiddleware, handleGetCryptoPositions);
router.patch("/positions/:positionId/close", authMiddleware, handleManualCloseCryptoPosition);
router.get("/history",                    authMiddleware, handleGetCryptoHistory);
router.get("/pnl/:sessionId",             authMiddleware, handleGetCryptoDailyPnl);
router.get("/signals/:sessionId",         authMiddleware, handleGetCryptoSignals);

export default router;
