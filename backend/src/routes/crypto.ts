import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "./auth.middleware";
import { getDeltaPrice, isDeltaMock, getDeltaDemoAccount, getDeltaDemoProduct, getDeltaDemoBtcExposure,
  getDeltaDemoBtcBook } from "../services/DeltaService";
import { evaluateCryptoSignal, isActionableSignal } from "../services/CryptoSignalService";
import { planBtcDemoTrade } from "../domain/btcDemoPlan";
import { planBtcPriorDayTrade } from "../domain/btcDemoPlan";
import { getDeltaDemoCompletedDailyCandles } from "../services/DeltaService";
import { decideBtcDailyBreakout } from "../services/BtcDailyResearchService";
import { getBtcDemoAutoStatus, setBtcDemoAutoPaused } from "../services/BtcDemoAutoService";
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
import { BtcDemoOrderIntentModel } from "../models/BtcDemoOrderIntent";
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
// Only these GET routes are allowed through to side-effect-free read handlers.
export const cryptoReadPaths = ["/status", "/preview", "/session/active", "/price", "/history", "/positions/:sessionId/open", "/positions/:sessionId", "/pnl/:sessionId", "/signals/:sessionId"] as const;
export function cryptoRequestAllowed(method: string, path: string): boolean {
  return method === "GET" && cryptoReadPaths.some(route => new RegExp("^" + route.replace(/:[^/]+/g, "[^/]+") + "/?$").test(path));
}

/** A read-only candidate and sizing preview. No route from here places an order. */
async function handleDemoPreview(_req: Request, res: Response): Promise<void> {
  try {
    const [account, product, legacyOpenCount, legacyUnquarantinedCount, activeIntent, latestDemoTrade,
      latestDailyTrade] = await Promise.all([
      getDeltaDemoAccount(), getDeltaDemoProduct(), CryptoPositionModel.countDocuments({ status: "OPEN" }).exec(),
      CryptoPositionModel.countDocuments({ status: "OPEN", brokerVerification: { $ne: "UNVERIFIED_LEGACY" } }).exec(),
      BtcDemoOrderIntentModel.findOne({ activeSlot: "BTCUSD:DELTA_DEMO" })
        .select({ clientOrderId: 1, status: 1, attentionReason: 1, createdAt: 1 }).lean().exec(),
      BtcDemoOrderIntentModel.findOne({ status: "CLOSED_CONFIRMED", validationId: "BROKER_SMOKE_V1",
        entryFillIds: { $exists: true, $ne: [] }, exitFillIds: { $exists: true, $ne: [] } })
        .sort({ createdAt: -1 }).select({ clientOrderId: 1, side: 1, sizeContracts: 1,
          averageFillPriceUsd: 1, averageExitPriceUsd: 1, realizedPnlUsd: 1,
          orderId: 1, closeOrderId: 1, createdAt: 1, updatedAt: 1 }).lean().exec(),
      BtcDemoOrderIntentModel.findOne({ status: "CLOSED_CONFIRMED",
        validationId: "BTC_DAILY_FORWARD_DEMO_V1" }).sort({ createdAt: -1 })
        .select({ clientOrderId: 1, side: 1, sizeContracts: 1, averageFillPriceUsd: 1,
          averageExitPriceUsd: 1, realizedPnlUsd: 1, orderId: 1, closeOrderId: 1,
          createdAt: 1, updatedAt: 1 }).lean().exec(),
    ]);
    const exposure = await getDeltaDemoBtcExposure(product.id);
    const [signalResult, priceResult, bookResult] = await Promise.allSettled([
      evaluateCryptoSignal("BTCUSD"), getDeltaPrice("BTCUSD"), getDeltaDemoBtcBook(1),
    ]);
    const signal = signalResult.status === "fulfilled" ? signalResult.value : null;
    const entryPrice = priceResult.status === "fulfilled" ? priceResult.value : null;
    const book = bookResult.status === "fulfilled" ? bookResult.value : null;
    const signalError = signalResult.status === "rejected" ?
      (signalResult.reason instanceof Error ? signalResult.reason.message : "BTC_SIGNAL_UNAVAILABLE") : null;
    const priceError = priceResult.status === "rejected" ?
      (priceResult.reason instanceof Error ? priceResult.reason.message : "BTC_PRICE_UNAVAILABLE") : null;
    const bookError = bookResult.status === "rejected" ?
      (bookResult.reason instanceof Error ? bookResult.reason.message : "BTC_BOOK_UNAVAILABLE") : null;
    const blockers = ["DELTA_EXECUTION_DISABLED", "STRATEGY_NOT_VALIDATED"];
    if (!latestDemoTrade) blockers.push("BROKER_LIVE_SMOKE_NOT_VERIFIED");
    if (legacyUnquarantinedCount > 0) blockers.push("LEGACY_POSITION_LEDGER_UNRECONCILED");
    if (activeIntent) blockers.push("BROKER_INTENT_ACTIVE_OR_NEEDS_ATTENTION");
    if (exposure.sizeContracts !== 0 || exposure.activeOrders.length !== 0) blockers.push("EXCHANGE_EXPOSURE_OR_ORDER_PRESENT");
    if (!signal) blockers.push("SIGNAL_DATA_UNAVAILABLE");
    else if (!isActionableSignal(signal)) blockers.push(signal.side === "HOLD" ? "NO_TRADE_SIGNAL" : "LOW_SIGNAL_CONFIDENCE");
    if (entryPrice === null) blockers.push("MARKET_PRICE_UNAVAILABLE");
    if (!book) blockers.push("ORDER_BOOK_UNAVAILABLE_OR_ILLIQUID");
    else if (entryPrice !== null && Math.abs((book.bidUsd + book.askUsd) / 2 - entryPrice) / entryPrice > 0.002)
      blockers.push("BOOK_MARK_DIVERGENCE");
    const plan = !signal || signal.side === "HOLD" || entryPrice === null ? null : planBtcDemoTrade({
      side: signal.side, entryPrice, atr: signal.atr, equityUsd: account.equity, product,
      openPositionCount: exposure.sizeContracts === 0 ? 0 : 1, activeOrderCount: exposure.activeOrders.length,
    });
    if (plan && !plan.eligible) blockers.push(plan.reason);
    let daily: { completedDay: string | null; side: "LONG" | "SHORT" | null;
      plan: ReturnType<typeof planBtcPriorDayTrade> | null; reason: string | null };
    try {
      const bars = await getDeltaDemoCompletedDailyCandles();
      const decision = decideBtcDailyBreakout(bars);
      const dailyPlan = decision && entryPrice !== null ? planBtcPriorDayTrade({
        side: decision.side, entryPrice, stopReferenceUsd: decision.stopReferenceUsd,
        equityUsd: account.equity, product, openPositionCount: account.openPositionCount,
        activeOrderCount: account.activeOrderCount }) : null;
      daily = { completedDay: bars[59]!.timestamp.toISOString().slice(0, 10),
        side: decision?.side ?? null, plan: dailyPlan,
        reason: !decision ? "BTC_DAILY_NO_CLEAN_SETUP" : entryPrice === null ? "MARKET_PRICE_UNAVAILABLE" :
          dailyPlan && !dailyPlan.eligible ? dailyPlan.reason : null };
    } catch (error) {
      daily = { completedDay: null, side: null, plan: null,
        reason: error instanceof Error ? error.message : "BTC_DAILY_DATA_UNAVAILABLE" };
    }
    res.json({ product, account, exposure, signal, signalError, priceError, book, bookError,
      plan, daily, auto: getBtcDemoAutoStatus(), legacyOpenCount, legacyUnquarantinedCount,
      activeIntent: activeIntent ? { clientOrderId: activeIntent.clientOrderId, status: activeIntent.status,
        attentionReason: activeIntent.attentionReason ?? null } : null,
      latestDemoTrade: latestDemoTrade ? { clientOrderId: latestDemoTrade.clientOrderId,
        side: latestDemoTrade.side, sizeContracts: latestDemoTrade.sizeContracts,
        entryPriceUsd: latestDemoTrade.averageFillPriceUsd,
        exitPriceUsd: latestDemoTrade.averageExitPriceUsd ?? null,
        realizedPnlUsd: latestDemoTrade.realizedPnlUsd,
        entryOrderId: latestDemoTrade.orderId, exitOrderId: latestDemoTrade.closeOrderId,
        closedAt: latestDemoTrade.updatedAt } : null,
      latestDailyTrade: latestDailyTrade ? { clientOrderId: latestDailyTrade.clientOrderId,
        side: latestDailyTrade.side, sizeContracts: latestDailyTrade.sizeContracts,
        entryPriceUsd: latestDailyTrade.averageFillPriceUsd,
        exitPriceUsd: latestDailyTrade.averageExitPriceUsd,
        realizedPnlUsd: latestDailyTrade.realizedPnlUsd,
        entryOrderId: latestDailyTrade.orderId, exitOrderId: latestDailyTrade.closeOrderId,
        closedAt: latestDailyTrade.updatedAt } : null,
      legacyRecordState: legacyOpenCount > 0 && legacyUnquarantinedCount === 0 ? "QUARANTINED_UNVERIFIED" :
        legacyOpenCount > 0 ? "UNVERIFIED_LOCAL_ONLY" : "NONE", blockers, executionEnabled: false });
  } catch (error) {
    const code = error instanceof Error ? error.message : "BTC_PREVIEW_UNAVAILABLE";
    res.status(503).json({ code, error: "BTC Demo preview unavailable", executionEnabled: false });
  }
}
router.post("/demo-auto/pause", authMiddleware, async (_req, res) => {
  try { res.json(await setBtcDemoAutoPaused(true)); }
  catch (error) { res.status(503).json({ code: error instanceof Error ? error.message : "BTC_AUTO_PAUSE_FAILED" }); }
});
router.post("/demo-auto/resume", authMiddleware, async (_req, res) => {
  try { res.json(await setBtcDemoAutoPaused(false)); }
  catch (error) { res.status(503).json({ code: error instanceof Error ? error.message : "BTC_AUTO_RESUME_FAILED" }); }
});

router.use((req, res, next) => {
  if (cryptoRequestAllowed(req.method, req.path)) { next(); return; }
  res.status(503).json({ error: "BTC/Delta execution is disabled", code: "DELTA_EXECUTION_DISABLED" });
});

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * GET /api/crypto/status
 * Returns Delta Exchange connection status, data mode, and masked API key.
 *
 * Uses signed Demo account reads; a public ticker is not proof of access.
 *   connected   — whether the Demo account read succeeds
 *   dataMode    — DEMO, UNAVAILABLE, or an explicit development MOCK fixture
 *   apiKey      — masked to last 4 chars e.g. "***fre0", or "not set"
 *   environment — always TESTNET
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
    let account: Awaited<ReturnType<typeof getDeltaDemoAccount>> | null = null;
    let connectionError: string | null = null;
    if (!mock) {
      try { account = await getDeltaDemoAccount(); }
      catch (error) { connectionError = error instanceof Error ? error.message : "DELTA_ACCOUNT_UNAVAILABLE"; }
    }
    const connected = account !== null;
    const dataMode = mock ? "MOCK" : connected ? "DEMO" : "UNAVAILABLE";
    const message = mock ? "Test fixture data only" : connected
      ? "Delta Demo account verified"
      : "Delta Demo account unavailable; check credentials, network, and IP allowlist";

    res.json({
      connected,
      dataMode,
      apiKey: maskedApiKey,
      environment: "TESTNET",
      message,
      executionEnabled: false,
      autoTrading: getBtcDemoAutoStatus(),
      accountEquity: account?.equity ?? null,
      openPositionCount: account?.openPositionCount ?? null,
      activeOrderCount: account?.activeOrderCount ?? null,
      connectionError,
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
 * Returns null while execution is gated. Historical RUNNING rows are not
 * exchange-authoritative and must not be revived by this read request.
 */
async function handleGetActiveCryptoSession(
  _req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  // Legacy RUNNING records cannot be trusted as exchange state. Never restart
  // the old execution loop from a GET or show those records as an active session.
  res.json(null);
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
router.get("/preview",         authMiddleware, handleDemoPreview);
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
