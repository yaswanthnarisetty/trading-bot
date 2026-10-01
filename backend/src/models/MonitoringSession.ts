import { Schema, model, type Document } from "mongoose";
import type {
  MonitoringSession as MonitoringSessionType,
} from "@trading-bot/shared";

/**
 * Mongoose document interface for a monitoring session record.
 * This extends the shared MonitoringSession type with MongoDB-specific fields.
 */
export interface MonitoringSessionDocument
  extends MonitoringSessionType,
    Document {
  createdAt: Date;
}

export const MonitoringSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    executionMode: { type: String, enum: ["LEGACY_PAPER", "PAPER"], default: "LEGACY_PAPER", immutable: true },
    asset: { type: String, required: true },
    accountId: { type: String, immutable: true },
    startupId: { type: String, immutable: true },
    config: { type: Schema.Types.Mixed, immutable: true },
    configFingerprint: { type: String, immutable: true },
    strategyFamily: { type: String, enum: ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"] },
    cycleFence: { type: Number, default: 0 },
    lastCycleAt: Date, lastCycleOutcome: String, blockingReason: String,
    lastCycleId: String,
    // Operational attempt receipt, never financial authorization or broker evidence.
    entryPreparation: { type: Schema.Types.Mixed },
    startTime: { type: String, required: true },
    stopTime: { type: String, default: null },
    status: { type: String, enum: ["RUNNING", "STOPPED", "CRASHED"], required: true },
    totalSignals: { type: Number, required: true, default: 0 },
    totalTrades: { type: Number, required: true, default: 0 },
    winRate: { type: Number, required: true, default: 0 },
    paperPnL: { type: Number, required: true, default: 0 },
    paperCapital: { type: Number, required: true },
    ticksSkipped: { type: Number, required: true, default: 0 },
    dataMode: { type: String, enum: ["LIVE", "MOCK", "KITE_REAL"], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: "monitoring_sessions",
  }
);

MonitoringSessionSchema.index({ status: 1 });
MonitoringSessionSchema.index({ accountId: 1 }, { unique: true, partialFilterExpression: { executionMode: "PAPER", status: "RUNNING" } });
MonitoringSessionSchema.index({ sessionId: 1 }, { unique: true, partialFilterExpression: { executionMode: "PAPER" } });

/**
 * MonitoringSession model for tracking the lifecycle and performance of trading sessions.
 * This model backs dashboards and guards that need aggregated session statistics.
 */
export const MonitoringSessionModel = model<MonitoringSessionDocument>(
  "MonitoringSession",
  MonitoringSessionSchema
);
