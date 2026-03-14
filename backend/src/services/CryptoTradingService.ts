import { v4 as uuidv4 } from "uuid";
import type { CryptoPosition } from "@trading-bot/shared";
import { CryptoPositionModel } from "../models/CryptoPosition";
import {
  CRYPTO_RISK_PER_TRADE_PCT,
  CRYPTO_STOP_LOSS_PCT,
  CRYPTO_TAKE_PROFIT_PCT,
} from "../config/constants";
import { isDeltaMock, placeOrder } from "./DeltaService";
import { logger } from "../utils/logger";

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

// ─── Position Management ──────────────────────────────────────────────────────

/**
 * Opens a new paper/live BTC perpetual position.
 * Sizes the position as CRYPTO_RISK_PER_TRADE_PCT % of available capital, then
 * computes fixed-percent SL and TP levels from the entry price.
 *
 * @param sessionId - Active BTC session identifier
 * @param side      - "LONG" or "SHORT"
 * @param entryPrice - Current BTC price at entry
 * @param capital    - Available paper/live capital in USD
 * @returns The persisted CryptoPosition document
 */
export async function openCryptoPosition(
  sessionId: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  capital: number
): Promise<CryptoPosition> {
  // Using 5x leverage on available capital.
  // Delta API handles the margin organically based on the contract size you buy.
  // We want the total notional size of the position to be `capital * 5`.
  // We reserve 5% of capital to cover the exchange trading commissions and slippage.
  const leverage = 5;
  const usableCapital = capital * 0.95;
  const notionalTargetUsd = usableCapital * leverage;
  const size = parseFloat((notionalTargetUsd / entryPrice).toFixed(6));

  // SL and TP are percentage-based from entry
  const stopLoss   =
    side === "LONG"
      ? parseFloat((entryPrice * (1 - CRYPTO_STOP_LOSS_PCT)).toFixed(2))
      : parseFloat((entryPrice * (1 + CRYPTO_STOP_LOSS_PCT)).toFixed(2));

  const takeProfit =
    side === "LONG"
      ? parseFloat((entryPrice * (1 + CRYPTO_TAKE_PROFIT_PCT)).toFixed(2))
      : parseFloat((entryPrice * (1 - CRYPTO_TAKE_PROFIT_PCT)).toFixed(2));

  const dataMode = isDeltaMock() ? "MOCK" : "LIVE";
  const positionId = uuidv4();

  // In LIVE mode, place the market order first (no-op in mock)
  if (!isDeltaMock()) {
    const orderSide = side === "LONG" ? "buy" : "sell";
    await placeOrder(orderSide, size, "BTCUSD");
  }

  const position: CryptoPosition = {
    positionId,
    sessionId,
    asset:          "BTCUSD",
    side,
    entryPrice,
    exitPrice:      null,
    size,
    entryTimestamp: new Date().toISOString(),
    exitTimestamp:  null,
    stopLoss,
    takeProfit,
    realizedPnL:    null,
    unrealizedPnL:  null,
    exitReason:     null,
    status:         "OPEN",
    dataMode,
  };

  const saved = await CryptoPositionModel.create(position);

  logger.info("🟢 Crypto position opened", {
    positionId,
    sessionId,
    side,
    entryPrice,
    size,
    stopLoss,
    takeProfit,
    dataMode,
  });

  return saved.toObject() as CryptoPosition;
}

/**
 * Closes an existing BTC position and computes realized PnL.
 * In LIVE mode, places a closing market order via DeltaService.
 *
 * @param positionId - Identifier of the position to close
 * @param exitPrice  - Current BTC price at close
 * @param exitReason - One of: SL_HIT | TP_HIT | MANUAL | SESSION_STOP
 * @returns Updated CryptoPosition with realized PnL
 */
export async function closeCryptoPosition(
  positionId: string,
  exitPrice: number,
  exitReason: CryptoPosition["exitReason"]
): Promise<CryptoPosition> {
  const doc = await CryptoPositionModel.findOne({ positionId });
  if (!doc) throw new Error(`Crypto position not found: ${positionId}`);
  if ((doc as any).status !== "OPEN") throw new Error(`Position already closed: ${positionId}`);

  const position = doc.toObject() as CryptoPosition;
  const realizedPnL = calculateCryptoPnL(position, exitPrice);

  // In LIVE mode, send the closing order (no-op in mock)
  if (!isDeltaMock()) {
    const closeSide = position.side === "LONG" ? "sell" : "buy";
    await placeOrder(closeSide, position.size, "BTCUSD");
  }

  (doc as any).status         = "CLOSED";
  (doc as any).exitPrice      = exitPrice;
  (doc as any).exitTimestamp  = new Date().toISOString();
  (doc as any).exitReason     = exitReason;
  (doc as any).realizedPnL    = realizedPnL;
  (doc as any).unrealizedPnL  = null;

  await doc.save();

  logger.info("🔴 Crypto position closed", {
    positionId,
    exitReason,
    exitPrice,
    realizedPnL,
  });

  return doc.toObject() as CryptoPosition;
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
