import { rejectDeltaExecution } from "../domain/ExecutionSafety";
import type { CryptoPosition } from "@trading-bot/shared";
import { CryptoPositionModel } from "../models/CryptoPosition";
// ─── PnL Calculation ─────────────────────────────────────────────────────────

/**
 * Computes unrealized PnL for an open crypto position at the given price.
 *
 * LONG:  PnL = (currentPrice - entryPrice) × size
 * SHORT: PnL = (entryPrice - currentPrice) × size
 *
 * @param position     - The open CryptoPosition
 * @param currentPrice - Current BTC mark price
 * @returns Unrealized PnL in USD, rounded to 2 decimal places
 */
export function calculateCryptoPnL(
  position: CryptoPosition,
  currentPrice: number
): number {
  const { side, entryPrice, size } = position;
  const pnl =
    side === "LONG"
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;
  return parseFloat(pnl.toFixed(2));
}

// ─── Legacy execution boundary ────────────────────────────────────────────
// The old local-position workflow cannot represent integer Delta contracts,
// broker fills or exchange-protected exits. Keep it unavailable to every
// caller. A future Demo executor must use a separate fill-derived ledger.

export async function openCryptoPosition(
  _sessionId: string, _side: "LONG" | "SHORT", _entryPrice: number,
  _capital: number, _atr: number
): Promise<CryptoPosition> {
  return rejectDeltaExecution();
}

export async function closeCryptoPosition(
  _positionId: string, _exitPrice: number, _exitReason: CryptoPosition["exitReason"]
): Promise<CryptoPosition> {
  return rejectDeltaExecution();
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns all open BTC positions for a session.
 */
export async function getOpenCryptoPositions(
  sessionId: string
): Promise<CryptoPosition[]> {
  const docs = await CryptoPositionModel.find({
    sessionId,
    status: "OPEN",
  }).sort({ entryTimestamp: -1 }).exec();
  return docs.map((d) => d.toObject() as CryptoPosition);
}

/**
 * Returns all BTC positions (open + closed) for a session, newest first.
 */
export async function getCryptoPositionHistory(
  sessionId: string,
  limit = 50,
  offset = 0
): Promise<CryptoPosition[]> {
  const docs = await CryptoPositionModel.find({ sessionId })
    .sort({ entryTimestamp: -1 })
    .skip(offset)
    .limit(limit)
    .exec();
  return docs.map((d) => d.toObject() as CryptoPosition);
}

/**
 * Returns total realized PnL for today's closed BTC positions.
 * Used by the daily loss guard to halt trading when the threshold is hit.
 */
export async function getCryptoDailyPnL(sessionId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const docs = await CryptoPositionModel.find({
    sessionId,
    exitTimestamp: { $regex: `^${today}` },
    status: "CLOSED",
  }).exec();
  return docs.reduce((sum, d) => sum + ((d as any).realizedPnL ?? 0), 0);
}
