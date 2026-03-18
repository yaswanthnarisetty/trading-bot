import { Schema, model, type Document } from "mongoose";

/**
 * Persists BTC trading sessions so they can be restored after a server restart.
 * Mirrors the in-memory CryptoSession shape in crypto.ts.
 */
export interface CryptoSessionDocument extends Document {
  sessionId: string;
  asset: "BTCUSD";
  capital: number;
  startTime: string;
  status: "RUNNING" | "STOPPED";
}

const CryptoSessionSchema = new Schema<CryptoSessionDocument>(
  {
    sessionId:  { type: String, required: true, unique: true },
    asset:      { type: String, required: true, default: "BTCUSD" },
    capital:    { type: Number, required: true },
    startTime:  { type: String, required: true },
    status:     { type: String, enum: ["RUNNING", "STOPPED"], required: true },
  },
  { collection: "crypto_sessions" }
);

CryptoSessionSchema.index({ status: 1 });

export const CryptoSessionModel = model<CryptoSessionDocument>(
  "CryptoSession",
  CryptoSessionSchema
);
