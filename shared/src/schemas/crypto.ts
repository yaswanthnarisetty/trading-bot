import { z } from "zod";

/**
 * Zod schema for a single BTC perpetual position.
 * Stored in the crypto_positions collection.
 */
export const cryptoPositionSchema = z.object({
  positionId:      z.string(),
  sessionId:       z.string(),
  asset:           z.literal("BTCUSD"),
  side:            z.enum(["LONG", "SHORT"]),
  entryPrice:      z.number(),
  exitPrice:       z.number().nullable(),
  /** BTC contract size (e.g. 0.001 BTC) */
  size:            z.number(),
  entryTimestamp:  z.string(),
  exitTimestamp:   z.string().nullable(),
  stopLoss:        z.number(),
  takeProfit:      z.number(),
  realizedPnL:     z.number().nullable(),
  unrealizedPnL:   z.number().nullable(),
  exitReason:      z.enum(["SL_HIT", "TP_HIT", "MANUAL", "SESSION_STOP"]).nullable(),
  status:          z.enum(["OPEN", "CLOSED"]),
  /** LIVE when DELTA_API_KEY is set, else MOCK (paper) */
  dataMode:        z.enum(["LIVE", "MOCK"]),
});

export type CryptoPosition = z.infer<typeof cryptoPositionSchema>;

/**
 * Signal evaluation result from CryptoSignalService.
 */
export const cryptoSignalSchema = z.object({
  asset:      z.literal("BTCUSD"),
  side:       z.enum(["LONG", "SHORT", "HOLD"]),
  confidence: z.number().min(0).max(1),
  rsi:        z.number(),
  ema9:       z.number(),
  ema21:      z.number(),
  ema50:      z.number(),
  atr:        z.number(),
  volumeRatio: z.number(),
  timestamp:  z.string(),
  reason:     z.string(),
});

export type CryptoSignal = z.infer<typeof cryptoSignalSchema>;
