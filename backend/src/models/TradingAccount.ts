import { model } from "mongoose";
import { executionSchema, idField, moneyField, unitsField } from "./executionSupport";

export const TradingAccountSchema = executionSchema({
  broker: { type: String, enum: ["PAPER", "KITE", "LEGACY"], required: true, immutable: true },
  brokerAccountRef: idField(),
  currency: { type: String, enum: ["INR"], required: true, immutable: true },
  admissionStatus: { type: String, enum: ["DISABLED", "RECOVERING", "HALTED"], required: true, default: "DISABLED" },
  // There is deliberately no READY state or credential field in Phase 2A.
  policyVersion: unitsField(), executionEpoch: unitsField(),
  reservedMarginMinor: moneyField(), reservedExposureMinor: moneyField(),
  committedExposureMinor: moneyField(), realizedPnlMinor: moneyField(true),
  positionSlots: unitsField(), nextEventSequence: unitsField(true),
}, "execution_accounts");
TradingAccountSchema.index({ accountId: 1 }, { unique: true });
TradingAccountSchema.index({ broker: 1, brokerAccountRef: 1, executionMode: 1 }, { unique: true });
TradingAccountSchema.pre("validate", function () {
  const expected = this.get("executionMode") === "LIVE" ? "KITE" : this.get("executionMode") === "PAPER" ? "PAPER" : "LEGACY";
  if (this.get("broker") !== expected) this.invalidate("broker", "Broker does not belong to this execution mode");
});
export const TradingAccountModel = model("ExecutionTradingAccount", TradingAccountSchema);
