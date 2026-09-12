import { model } from "mongoose";
import { executionSchema, idField, identityIndexes } from "./executionSupport";

export const StrategySignalSchema = executionSchema({
  signalId: idField(), decisionKey: idField(), strategyInstanceId: idField(),
  strategyVersion: idField(), decisionSlot: idField(), sessionId: idField(),
  strategy: { type: String, enum: ["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"], required: true, immutable: true },
  decisionEvidenceRefs: { type: [String], required: true, immutable: true,
    validate: { validator: (refs: string[]) => refs.length > 0 && refs.every(r => !!r.trim()), message: "Decision evidence required" } },
  expiresAt: { type: Date, required: true, immutable: true },
}, "execution_signals", true);
identityIndexes(StrategySignalSchema, "signalId");
StrategySignalSchema.index({ accountId: 1, decisionKey: 1 }, { unique: true });
export const StrategySignalModel = model("ExecutionStrategySignal", StrategySignalSchema);
