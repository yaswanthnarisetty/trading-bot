import { Schema, model, type Document } from "mongoose";
import type {
  OptionsPosition as OptionsPositionType,
} from "@trading-bot/shared";

/**
 * Mongoose document interface for an options position record.
 * This augments the shared OptionsPosition type with MongoDB-specific bookkeeping fields.
 */
export interface OptionsPositionDocument
  extends OptionsPositionType,
    Document {
  createdAt: Date;
  timestamp: Date;
}

const TradeLegSubSchema = new Schema(
  {
    action: { type: String, enum: ["BUY", "SELL"], required: true },
    type: { type: String, enum: ["CALL", "PUT"], required: true },
    strike: { type: Number, required: true },
    expiry: { type: String, required: true },
    lotSize: { type: Number, required: true },
    lots: { type: Number, required: true },
    entryPremium: { type: Number, required: true },
    exitPremium: { type: Number, default: null },
    legPnL: { type: Number, default: null },
  },
  { _id: false }
);

const OptionsPositionSchema = new Schema(
  {
    positionId: { type: String, required: true },
    sessionId: { type: String, required: true },
    asset: { type: String, required: true },
    strategy: {
      type: String,
      enum: ["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"],
      required: true,
    },
    legs: { type: [TradeLegSubSchema], required: true },
    entrySpot: { type: Number, required: true },
    entryDTE: { type: Number, required: true },
    entryIVRank: { type: Number, required: true },
    entryTimestamp: { type: String, required: true },
    maxProfit: { type: Number, required: true },
    maxLoss: { type: Number, required: true },
    breakevenPoint: { type: Number, required: true },
    riskRewardRatio: { type: Number, required: true },
    status: {
      type: String,
      enum: [
        "OPEN",
        "CLOSED_SL",
        "CLOSED_TARGET",
        "CLOSED_EXPIRY",
        "CLOSED_MANUAL",
      ],
      required: true,
    },
    exitSpot: { type: Number, default: null },
    exitTimestamp: { type: String, default: null },
    exitReason: {
      type: String,
      enum: ["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"],
      default: null,
    },
    realizedPnL: { type: Number, default: null },
    entryATR: { type: Number, default: null },
    dataMode: { type: String, enum: ["LIVE", "MOCK"], required: true },
    premiumSource: {
      type: String,
      enum: ["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"],
      default: "BLACK_SCHOLES",
    },
    requiredMargin: { type: Number, default: null },
    marginSource: {
      type: String,
      enum: ["KITE_API", "ESTIMATED"],
      default: null,
    },
    createdAt: { type: Date, default: Date.now },
    timestamp: { type: Date, default: Date.now },
  },
  {
    collection: "options_positions",
  }
);

OptionsPositionSchema.index({ sessionId: 1, status: 1 });
OptionsPositionSchema.index({ sessionId: 1, timestamp: -1 });

/**
 * OptionsPosition model for tracking multi-leg options paper trades.
 * This model provides the canonical record of open and closed spread positions.
 */
export const OptionsPositionModel = model<OptionsPositionDocument>(
  "OptionsPosition",
  OptionsPositionSchema
);

