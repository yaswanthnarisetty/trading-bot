import { model, Schema } from "mongoose";
import { aggregateTypeSchema, tradingEventSchema, tradingEventTypeSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, unitsField } from "./executionSupport";

export const TradingEventSchema = executionSchema({
  eventId: idField(), accountSequence: { ...unitsField(true), immutable: true },
  tradingDate: idField(), eventType: { type: String, enum: tradingEventTypeSchema.options, required: true, immutable: true },
  aggregateType: { type: String, enum: aggregateTypeSchema.options, required: true, immutable: true },
  aggregateId: idField(), aggregateVersion: { ...unitsField(), immutable: true },
  causationId: idField(), actor: idField(), reason: idField(),
  occurredAt: { type: Date, required: true, immutable: true },
  recordedAt: { type: Date, required: true, immutable: true },
  evidenceRefs: { type: [String], required: true, immutable: true },
  // Runtime validated as the shared discriminated union below; no arbitrary JSON payloads.
  payload: { type: Schema.Types.Mixed, required: true, immutable: true },
}, "execution_events", true);
identityIndexes(TradingEventSchema, "eventId");
TradingEventSchema.index({ accountId: 1, accountSequence: 1 }, { unique: true });
TradingEventSchema.pre("validate", function () {
  const raw = this.toObject();
  const { _id, createdAt, ...event } = raw;
  const result = tradingEventSchema.safeParse({ ...event,
    occurredAt: raw.occurredAt instanceof Date ? raw.occurredAt.toISOString() : raw.occurredAt,
    recordedAt: raw.recordedAt instanceof Date ? raw.recordedAt.toISOString() : raw.recordedAt,
  });
  if (!result.success) this.invalidate("payload", result.error.message);
});
export const TradingEventModel = model("ExecutionTradingEvent", TradingEventSchema);
