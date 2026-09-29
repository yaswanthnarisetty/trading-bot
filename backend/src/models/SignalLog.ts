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

export const SignalLogSchema = new Schema(
  {
    sessionId: { type: String, required: true, index: true },
    cycleId: { type: String, immutable: true }, accountId: { type: String, immutable: true },
    window: { type: String, immutable: true }, startupId: { type: String, immutable: true },
    configFingerprint: { type: String, immutable: true }, config: { type: Schema.Types.Mixed, immutable: true },
    outcome: String, reason: String, decision: Schema.Types.Mixed, evaluatedAt: String,
    intentId: String, positionId: String,
    executionMode: { type: String, enum: ["LEGACY_PAPER", "PAPER"], default: "LEGACY_PAPER", immutable: true },
    asset: { type: String, required: true },
    ltp: { type: Number },
    signal: { type: Schema.Types.Mixed },
    verifierResult: { type: Schema.Types.Mixed, default: null },
    riskAction: { type: String, enum: ["SUGGEST", "BLOCK"] },
    blockReason: { type: String, default: null },
    indicators: { type: Schema.Types.Mixed },
    greeksSnapshot: { type: Schema.Types.Mixed, default: null },
    expiryContext: { type: Schema.Types.Mixed },
    dataMode: { type: String, enum: ["LIVE", "MOCK", "KITE_REAL"], required: true },
    timestamp: { type: Date, default: Date.now, index: -1 },
  },
  {
    collection: "signal_logs",
  }
);

SignalLogSchema.index({ sessionId: 1, timestamp: -1 });
SignalLogSchema.index({ asset: 1, timestamp: -1 });
SignalLogSchema.index({ cycleId: 1 }, { unique: true, partialFilterExpression: { executionMode: "PAPER" } });

/**
 * SignalLog model for persisting every generated signal and its context.
 * This model is the highest write-volume collection and underpins analytics and audits.
 */
export const SignalLogModel = model<SignalLogDocument>(
  "SignalLog",
  SignalLogSchema
);
