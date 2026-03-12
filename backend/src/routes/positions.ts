import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { OptionsPositionModel } from "../models/OptionsPosition";
import { closePosition } from "../services/PaperTradeService";
import { getLTP } from "../services/KiteService";
import { WebSocketService } from "../services/WebSocketService";
import type { OptionsPosition } from "@trading-bot/shared";
import type { AssetKey } from "../config/assets";
import { authMiddleware } from "./auth.middleware";

const router = Router();

type StatusFilter = "OPEN" | "CLOSED" | "ALL";

/**
 * Normalizes and validates the requested status filter for positions listing.
 * Unsupported values are treated as "ALL" to keep the API lenient but predictable.
 *
 * @param raw - Raw status filter string from the query.
 * @returns A normalized StatusFilter value.
 */
function parseStatusFilter(raw: unknown): StatusFilter {
  const value = typeof raw === "string" ? raw.toUpperCase() : "ALL";
  if (value === "OPEN" || value === "CLOSED" || value === "ALL") {
    return value;
  }
  return "ALL";
}

/**
 * Handles GET /api/positions/:sessionId to list positions for a session.
 * Supports filtering by OPEN/CLOSED/ALL and simple limit/offset pagination.
 *
 * @param req - The HTTP request with sessionId path param and filters.
 * @param res - The HTTP response used to send the position page.
 * @param next - Express next function for error propagation.
 */
async function handleGetPositionsForSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const status = parseStatusFilter(req.query.status);

    const requestedLimit = Number(req.query.limit ?? 50) || 50;
    const limit = Math.min(requestedLimit, 50);
    const offset = Number(req.query.offset ?? 0) || 0;

    const baseFilter: Record<string, unknown> = { sessionId };
    if (status === "OPEN") {
      baseFilter.status = "OPEN";
    } else if (status === "CLOSED") {
      baseFilter.status = { $ne: "OPEN" };
    }

    const [positions, total] = await Promise.all([
      OptionsPositionModel.find(baseFilter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      OptionsPositionModel.countDocuments(baseFilter).exec(),
    ]);

    res.json({
      positions: positions.map((p) => p.toObject() as OptionsPosition),
      total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/positions/:sessionId/open to list all open positions for a session.
 * This endpoint is unpaginated by design and capped by system-wide max positions.
 *
 * @param req - The HTTP request containing the sessionId.
 * @param res - The HTTP response used to send the open position list.
 * @param next - Express next function for error propagation.
 */
async function handleGetOpenPositions(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const positions = await OptionsPositionModel.find({
      sessionId,
      status: "OPEN",
    })
      .sort({ timestamp: -1 })
      .limit(3)
      .exec();

    res.json(positions.map((p) => p.toObject() as OptionsPosition));
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/positions/detail/:positionId to fetch a single detailed position.
 * This includes all leg-level information for inspection and troubleshooting.
 *
 * @param req - The HTTP request with positionId path parameter.
 * @param res - The HTTP response used to send the position or 404.
 * @param next - Express next function for error propagation.
 */
async function handleGetPositionDetail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { positionId } = req.params;
    const position = await OptionsPositionModel.findOne({
      positionId,
    }).exec();

    if (!position) {
      res.status(404).json({ error: "Position not found", code: 404 });
      return;
    }

    res.json(position.toObject() as OptionsPosition);
  } catch (error) {
    next(error);
  }
}

/**
 * Handles PATCH /api/positions/:positionId/close to perform a manual close.
 * This closes the target position at current LTP with exit reason MANUAL.
 *
 * @param req - The HTTP request specifying the positionId and close reason.
 * @param res - The HTTP response used to send the updated position.
 * @param next - Express next function for error propagation.
 */
async function handleClosePositionManual(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { positionId } = req.params;
    const reason = req.body?.reason;

    if (reason !== "MANUAL") {
      res.status(400).json({
        error: 'Only reason "MANUAL" is supported in MVP-1',
        code: 400,
      });
      return;
    }

    const existing = await OptionsPositionModel.findOne({
      positionId,
    }).exec();

    if (!existing) {
      res.status(404).json({ error: "Position not found", code: 404 });
      return;
    }

    if (existing.status !== "OPEN") {
      res
        .status(400)
        .json({ error: "Position already closed", code: 400 });
      return;
    }

    const asset = existing.asset as AssetKey;
    const ltp = await getLTP(asset);

    const updated = await closePosition(positionId, ltp, "MANUAL");

    WebSocketService.emit(existing.sessionId, {
      type: "POSITION_CLOSED",
      payload: updated,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
}

/**
 * Handles GET /api/positions/history to provide cross-session position history.
 * Results can be filtered by date window and strategy to support analytics views.
 *
 * @param req - The HTTP request containing filter and pagination query params.
 * @param res - The HTTP response used to send paginated position history.
 * @param next - Express next function for error propagation.
 */
async function handleGetPositionHistory(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { startDate, endDate, strategy } = req.query;

    const filter: Record<string, unknown> = {};

    if (strategy && typeof strategy === "string") {
      filter.strategy = strategy;
    }

    if (startDate || endDate) {
      filter.entryTimestamp = {};
      if (startDate && typeof startDate === "string") {
        (filter.entryTimestamp as any).$gte = startDate;
      }
      if (endDate && typeof endDate === "string") {
        (filter.entryTimestamp as any).$lte = endDate;
      }
    }

    const requestedLimit = Number(req.query.limit ?? 50) || 50;
    const limit = Math.min(requestedLimit, 50);
    const offset = Number(req.query.offset ?? 0) || 0;

    const [positions, total] = await Promise.all([
      OptionsPositionModel.find(filter)
        .sort({ entryTimestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      OptionsPositionModel.countDocuments(filter).exec(),
    ]);

    res.json({
      positions: positions.map((p) => p.toObject() as OptionsPosition),
      total,
    });
  } catch (error) {
    next(error);
  }
}

router.get("/:sessionId", authMiddleware, handleGetPositionsForSession);
router.get("/:sessionId/open", authMiddleware, handleGetOpenPositions);
router.get("/detail/:positionId", authMiddleware, handleGetPositionDetail);
router.patch("/:positionId/close", authMiddleware, handleClosePositionManual);
router.get("/history", authMiddleware, handleGetPositionHistory);

export default router;

