import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { SignalLogModel } from "../models/SignalLog";
import { authMiddleware } from "./auth.middleware";

const router = Router();

/**
 * Handles GET /api/signals/:sessionId to return paginated signal logs.
 * This powers the Signal History dashboard by exposing recent LLM decisions and context.
 *
 * @param req - The HTTP request containing sessionId and pagination query params.
 * @param res - The HTTP response used to send paginated signal logs.
 * @param next - Express next function for error propagation.
 */
async function handleGetSignalsForSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const requestedLimit = Number(req.query.limit ?? 10) || 10;
    const limit = Math.min(requestedLimit, 50);
    const offset = Number(req.query.offset ?? 0) || 0;

    const [signals, total] = await Promise.all([
      SignalLogModel.find({ sessionId })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      SignalLogModel.countDocuments({ sessionId }).exec(),
    ]);

    res.json({
      signals: signals.map((s) => s.toObject()),
      total,
    });
  } catch (error) {
    next(error);
  }
}

router.get("/:sessionId", authMiddleware, handleGetSignalsForSession);

export default router;

