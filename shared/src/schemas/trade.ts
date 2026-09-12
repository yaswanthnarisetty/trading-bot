import { z } from "zod";

/**
 * Zod schema for a single options trade leg within a multi-leg paper position.
 * This describes direction, option type, pricing, and realized leg-level PnL.
 */
export const tradeLegSchema = z.object({
  action: z.enum(["BUY", "SELL"]),
  type: z.enum(["CALL", "PUT"]),
  strike: z.number(),
  expiry: z.string(),
  lotSize: z.number(),
  lots: z.number(),
  entryPremium: z.number(),
  exitPremium: z.number().nullable(),
  legPnL: z.number().nullable(),
});

export type TradeLeg = z.infer<typeof tradeLegSchema>;

/**
 * Zod schema for a full paper options position consisting of one or more legs.
 * This captures lifecycle, risk, and performance metrics for backtesting and monitoring.
 */
export const optionsPositionSchema = z.object({
  executionMode: z.literal("LEGACY_PAPER").optional(),
  positionId: z.string(),
  sessionId: z.string(),
  asset: z.string(),
  strategy: z.enum(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]),
  legs: z.array(tradeLegSchema),
  entrySpot: z.number(),
  entryDTE: z.number(),
  entryIVRank: z.number(),
  entryTimestamp: z.string(),
  maxProfit: z.number(),
  maxLoss: z.number(),
  breakevenPoint: z.number(),
  riskRewardRatio: z.number(),
  status: z.enum([
    "OPEN",
    "CLOSED_SL",
    "CLOSED_TARGET",
    "CLOSED_EXPIRY",
    "CLOSED_MANUAL",
  ]),
  exitSpot: z.number().nullable(),
  exitTimestamp: z.string().nullable(),
  exitReason: z
    .enum(["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"])
    .nullable(),
  realizedPnL: z.number().nullable(),
  /**
   * ATR (14-period, 5-min candles) at the moment the position was opened.
   * Used by PositionMonitorService to compute the directional stop threshold (ATR × 1.5).
   * Null when ATR was unavailable during warmup.
   */
  entryATR: z.number().nullable().optional(),
  dataMode: z.enum(["LIVE", "MOCK"]),
  /**
   * Tracks where the entry premiums came from.
   * KITE_LTP = real live LTP fetched from Kite at open (accurate).
   * BLACK_SCHOLES = theoretical estimate used in mock mode.
   * BLACK_SCHOLES_FALLBACK = Kite fetch failed at open, fell back to estimate.
   */
  premiumSource: z.enum(["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]).optional(),
  /**
   * SPAN + exposure margin required to hold this spread, in rupees.
   * KITE_API = fetched from POST /margins/orders (accurate SPAN netting).
   * ESTIMATED = spreadWidth × lotSize × lots × MARGIN_ESTIMATE_MULTIPLIER (fallback).
   */
  requiredMargin: z.number().optional(),
  marginSource: z.enum(["KITE_API", "ESTIMATED"]).optional(),
});

export type OptionsPosition = z.infer<typeof optionsPositionSchema>;
