import { model } from "mongoose";
import { executionSchema, idField, identityIndexes, moneyField, unitsField } from "./executionSupport";

export const FillSchema = executionSchema({
  fillId: idField(), orderId: idField(), intentId: idField(), positionId: idField(), legId: idField(),
  broker: { type: String, enum: ["PAPER", "KITE"], required: true, immutable: true },
  brokerNamespace: idField(), brokerTradeKey: idField(), brokerOrderId: idField(),
  contractKey: idField(), side: { type: String, enum: ["BUY", "SELL"], required: true, immutable: true },
  quantityUnits: { ...unitsField(true), immutable: true }, priceMinor: { ...moneyField(), immutable: true },
  evidenceRef: idField(), executedAt: { type: Date, required: true, immutable: true },
}, "execution_fills", true);
identityIndexes(FillSchema, "fillId");
// Not verified from broker contract: brokerTradeKey must be canonicalized within a
// verified namespace (including order/day if necessary). No Kite ingestion exists yet.
FillSchema.index({ accountId: 1, broker: 1, brokerNamespace: 1, brokerTradeKey: 1 }, { unique: true });
FillSchema.pre("validate", function () {
  const mode = this.get("executionMode");
  if (mode === "LEGACY_PAPER" || this.get("broker") !== (mode === "LIVE" ? "KITE" : "PAPER")) {
    this.invalidate("executionMode", "Legacy fills and cross-mode execution evidence are forbidden");
  }
});
export const FillModel = model("ExecutionFill", FillSchema);
