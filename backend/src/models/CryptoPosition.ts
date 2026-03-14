import { Schema, model, type Document } from "mongoose";
import type { CryptoPosition } from "@trading-bot/shared";

/**
 * Mongoose document interface for a BTC perpetual position.
 * Augments the shared CryptoPosition type with MongoDB bookkeeping fields.
 */
export interface CryptoPositionDocument extends CryptoPosition, Document {
  createdAt: Date;
}

const CryptoPositionSchema = new Schema(
  {
    positionId:     { type: String, required: true, unique: true },
    sessionId:      { type: String, required: true },
    asset:          { type: String, enum: ["BTCUSD"], required: true },
    side:           { type: String, enum: ["LONG", "SHORT"], required: true },
    entryPrice:     { type: Number, required: true },
    exitPrice:      { type: Number, default: null },
    size:           { type: Number, required: true },
    entryTimestamp: { type: String, required: true },
    exitTimestamp:  { type: String, default: null },
    stopLoss:       { type: Number, required: true },
    takeProfit:     { type: Number, required: true },
    realizedPnL:    { type: Number, default: null },
    unrealizedPnL:  { type: Number, default: null },
    exitReason: {
      type: String,
      enum: ["SL_HIT", "TP_HIT", "MANUAL", "SESSION_STOP"],
      default: null,
    },
    status:   { type: String, enum: ["OPEN", "CLOSED"], required: true },
    dataMode: { type: String, enum: ["LIVE", "MOCK"], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: "crypto_positions",
  }
);

CryptoPositionSchema.index({ sessionId: 1, status: 1 });
CryptoPositionSchema.index({ sessionId: 1, entryTimestamp: -1 });

/**
 * CryptoPosition model for tracking BTC perpetual paper / live trades.
 */
export const CryptoPositionModel = model<CryptoPositionDocument>(
  "CryptoPosition",
  CryptoPositionSchema
);
