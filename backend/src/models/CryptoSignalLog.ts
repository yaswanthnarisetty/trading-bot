import { Schema, model, type Document } from "mongoose";

/**
 * Persists every evaluated BTC signal tick so the UI can reload history on refresh.
 * One document per signal evaluation (every CRYPTO_TICK_INTERVAL_MS).
 */
export interface CryptoSignalLogDocument extends Document {
  sessionId: string;
  asset: string;
  side: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  atr: number;
  volumeRatio: number;
  reason: string;
  riskAction: "SUGGEST" | "BLOCK";
  blockReason: string | null;
  dataMode: "LIVE" | "MOCK";
  timestamp: Date;
}

const CryptoSignalLogSchema = new Schema<CryptoSignalLogDocument>(
  {
    sessionId:   { type: String,  required: true, index: true },
    asset:       { type: String,  required: true },
    side:        { type: String,  enum: ["LONG", "SHORT", "HOLD"], required: true },
    confidence:  { type: Number,  required: true },
    rsi:         { type: Number,  required: true },
    ema9:        { type: Number,  required: true },
    ema21:       { type: Number,  required: true },
    ema50:       { type: Number,  required: true },
    atr:         { type: Number,  required: true },
    volumeRatio: { type: Number,  required: true },
    reason:      { type: String,  required: true },
    riskAction:  { type: String,  enum: ["SUGGEST", "BLOCK"], required: true },
    blockReason: { type: String,  default: null },
    dataMode:    { type: String,  enum: ["LIVE", "MOCK"], required: true },
    timestamp:   { type: Date,    default: Date.now, index: -1 },
  },
  { collection: "crypto_signal_logs" }
);

CryptoSignalLogSchema.index({ sessionId: 1, timestamp: -1 });

export const CryptoSignalLogModel = model<CryptoSignalLogDocument>(
  "CryptoSignalLog",
  CryptoSignalLogSchema
);
