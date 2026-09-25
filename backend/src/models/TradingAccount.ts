import { model, Schema } from "mongoose";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { executionSchema, idField, moneyField, unitsField } from "./executionSupport";

export const TradingAccountSchema = executionSchema({
  broker: { type: String, enum: ["PAPER", "KITE", "LEGACY"], required: true, immutable: true },
  brokerAccountRef: idField(),
  currency: { type: String, enum: ["INR"], required: true, immutable: true },
  admissionStatus: { type: String, enum: ["DISABLED", "RECOVERING", "HALTED", "PAPER_READY"], required: true, default: "DISABLED" },
  // Explicit opt-in for isolated PAPER submission only; no LIVE readiness or credentials.
  policyVersion: unitsField(), executionEpoch: unitsField(),
  // Explicit durable opt-in; absent policy never inherits legacy env/session limits.
  entryRiskPolicy: { type: Schema.Types.Mixed },
  reservedMarginMinor: moneyField(), reservedExposureMinor: moneyField(),
  committedExposureMinor: moneyField(), realizedPnlMinor: moneyField(true),
  positionSlots: unitsField(), nextEventSequence: unitsField(true),
}, "execution_accounts");
TradingAccountSchema.index({ accountId: 1 }, { unique: true });
TradingAccountSchema.index({ broker: 1, brokerAccountRef: 1, executionMode: 1 }, { unique: true });
TradingAccountSchema.pre("validate", function () {
  if (this.get("entryRiskPolicy") !== undefined && !entryRiskPolicySchema.safeParse(this.get("entryRiskPolicy")).success)
    this.invalidate("entryRiskPolicy", "Invalid persisted entry risk policy");
  if (this.get("admissionStatus") === "PAPER_READY" && this.get("executionMode") !== "PAPER")
    this.invalidate("admissionStatus", "PAPER_READY cannot enable another execution mode");
  const expected = this.get("executionMode") === "LIVE" ? "KITE" : this.get("executionMode") === "PAPER" ? "PAPER" : "LEGACY";
  if (this.get("broker") !== expected) this.invalidate("broker", "Broker does not belong to this execution mode");
});
export const TradingAccountModel = model("ExecutionTradingAccount", TradingAccountSchema);
