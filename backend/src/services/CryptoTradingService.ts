import { v4 as uuidv4 } from "uuid";
import type { CryptoPosition } from "@trading-bot/shared";
import { CryptoPositionModel } from "../models/CryptoPosition";
import {
  CRYPTO_RISK_PER_TRADE_PCT,
  CRYPTO_SL_ATR_MULT,
  CRYPTO_TP_ATR_MULT,
  CRYPTO_SL_FALLBACK_PCT,
  CRYPTO_TP_FALLBACK_PCT,
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
 *
 * Position sizing: risk-based (not fixed-leverage).
 *   riskAmount  = capital × CRYPTO_RISK_PER_TRADE_PCT%       (e.g. $2 on $100 capital)
 *   slDistance  = atr × CRYPTO_SL_ATR_MULT                   (e.g. 1.5 × $111 = $166)
 *   size (BTC)  = riskAmount / slDistance                     (e.g. $2 / $166 = 0.012 BTC)
 *
 * SL/TP levels: ATR-based (adapts to current volatility).
 *   SL = entry ∓ (atr × CRYPTO_SL_ATR_MULT)                  (1.5 ATR from entry)
 *   TP = entry ± (atr × CRYPTO_TP_ATR_MULT)                  (3.0 ATR → 2:1 R:R)
 *
 * Fallback (ATR = 0 during indicator warmup):
 *   Uses CRYPTO_SL_FALLBACK_PCT / CRYPTO_TP_FALLBACK_PCT of entry price.
 *
 * @param sessionId  - Active BTC session identifier
 * @param side       - "LONG" or "SHORT"
 * @param entryPrice - Current BTC price at entry
 * @param capital    - Paper/live capital in USD
 * @param atr        - ATR(14) from signal evaluation; 0 during warmup
 * @returns The persisted CryptoPosition document
 */
export async function openCryptoPosition(
  sessionId: string,
  side: "LONG" | "SHORT",
  entryPrice: number,
  capital: number,
  atr: number
): Promise<CryptoPosition> {
  // ── SL / TP distances ────────────────────────────────────────────────────
  const slDistance = atr > 0
    ? parseFloat((atr * CRYPTO_SL_ATR_MULT).toFixed(2))
    : parseFloat((entryPrice * CRYPTO_SL_FALLBACK_PCT).toFixed(2));

  const tpDistance = atr > 0
    ? parseFloat((atr * CRYPTO_TP_ATR_MULT).toFixed(2))
    : parseFloat((entryPrice * CRYPTO_TP_FALLBACK_PCT).toFixed(2));

  // ── Risk-based position size ─────────────────────────────────────────────
  // Dollar amount we're willing to lose = capital × risk%
  // Size in BTC = riskAmount / slDistance  (so loss at SL = exactly riskAmount)
  const riskAmount = capital * (CRYPTO_RISK_PER_TRADE_PCT / 100);
  const size = parseFloat((riskAmount / slDistance).toFixed(6));

  // ── SL / TP price levels ──────────────────────────────────────────────────
  const stopLoss =
    side === "LONG"
      ? parseFloat((entryPrice - slDistance).toFixed(2))
      : parseFloat((entryPrice + slDistance).toFixed(2));

  const takeProfit =
    side === "LONG"
      ? parseFloat((entryPrice + tpDistance).toFixed(2))
      : parseFloat((entryPrice - tpDistance).toFixed(2));

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
    slDistance,
    tpDistance,
    stopLoss,
    takeProfit,
    riskAmount,
    atr,
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

  // In LIVE mode, send the closing order with reduce_only=true so it can never
  // accidentally open a new opposite-direction position on Delta.
  // If the exchange order fails (network error, already closed on exchange, etc.)
  // we log a warning but still mark the DB record as CLOSED — the DB must stay
  // consistent with the session state regardless of exchange-side outcome.
  if (!isDeltaMock()) {
    const closeSide = position.side === "LONG" ? "sell" : "buy";
    try {
      await placeOrder(closeSide, position.size, "BTCUSD", true);
    } catch (exchangeErr) {
      logger.warn("Exchange close order failed — marking DB as CLOSED anyway", {
        positionId,
        exitReason,
        message: exchangeErr instanceof Error ? exchangeErr.message : String(exchangeErr),
      });
    }
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
