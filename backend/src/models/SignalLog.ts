import { Schema, model, type Document } from "mongoose";
import type {
  PrimarySignal,
  VerifierResult,
  IndicatorSnapshot,
  GreeksSnapshot,
  ExpiryContext,
} from "@trading-bot/shared";

/**
 * Mongoose document interface for a single signal log entry.
 * This captures each tick's analytical context and decisions for later audit and backtesting.
 */
export interface SignalLogDocument extends Document {
  executionMode: "LEGACY_PAPER";
  sessionId: string;
  asset: string;
  ltp?: number;
  signal: PrimarySignal;
  verifierResult: VerifierResult | null;
  riskAction: "SUGGEST" | "BLOCK";
  blockReason: string | null;
  indicators: IndicatorSnapshot;
  greeksSnapshot: GreeksSnapshot | null;
  expiryContext: ExpiryContext;
  dataMode: "LIVE" | "MOCK";
  timestamp: Date;
}

const SignalLogSchema = new Schema<SignalLogDocument>(
  {
    sessionId: { type: String, required: true, index: true },
    executionMode: { type: String, enum: ["LEGACY_PAPER"], default: "LEGACY_PAPER", immutable: true },
    asset: { type: String, required: true },
    ltp: { type: Number },
    signal: { type: Schema.Types.Mixed, required: true },
    verifierResult: { type: Schema.Types.Mixed, default: null },
    riskAction: { type: String, enum: ["SUGGEST", "BLOCK"], required: true },
    blockReason: { type: String, default: null },
    indicators: { type: Schema.Types.Mixed, required: true },
    greeksSnapshot: { type: Schema.Types.Mixed, default: null },
    expiryContext: { type: Schema.Types.Mixed, required: true },
    dataMode: { type: String, enum: ["LIVE", "MOCK"], required: true },
    timestamp: { type: Date, default: Date.now, index: -1 },
  },
  {
    collection: "signal_logs",
  }
);

SignalLogSchema.index({ sessionId: 1, timestamp: -1 });
SignalLogSchema.index({ asset: 1, timestamp: -1 });

/**
 * SignalLog model for persisting every generated signal and its context.
 * This model is the highest write-volume collection and underpins analytics and audits.
 */
export const SignalLogModel = model<SignalLogDocument>(
  "SignalLog",
  SignalLogSchema
);
