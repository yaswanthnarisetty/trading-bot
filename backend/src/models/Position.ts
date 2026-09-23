import { positionEconomicsSchema } from "../domain/financialInvariants";
import { model, Schema } from "mongoose";
import { positionIntegritySchema, positionLifecycleSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, moneyField, unitsField } from "./executionSupport";

const PositionLegSchema = new Schema({
  legId: idField(), contractKey: idField(),
  entrySide: { type: String, enum: ["BUY", "SELL"], required: true, immutable: true },
  targetUnits: { ...unitsField(true), immutable: true }, entryFilledUnits: unitsField(), exitFilledUnits: unitsField(),
  closeHeldUnits: unitsField(), realizedPnlMinor: moneyField(true),
  // Retain ownership at zero so an exhausted hold cannot become an unheld legacy close.
  closeHoldIntentId: { ...idField(), required: false, immutable: false },
  // Optional for pre-2B3 ledger compatibility; once attached, the write boundary
  // requires both projections on every save and proves them against actual Fills.
  entryNotionalMinor: { ...moneyField(), required: false },
  netQuantityUnits: { ...unitsField(), min: Number.MIN_SAFE_INTEGER, required: false },
}, { _id: false, strict: "throw" });
const ClosePolicySchema = new Schema({
  kind: { type: String, enum: ["POSITION_LIMIT_V1"], required: true },
  policyVersion: unitsField(), product: { ...idField(), immutable: false },
  expiresAt: { type: Date, required: true },
  legLimits: { type: [new Schema({ legId: { ...idField(), immutable: false }, limitPriceMinor: { ...moneyField(), min: 1 } }, { _id: false, strict: "throw" })],
    required: true, validate: { validator: (legs: { legId: string }[]) => legs.length > 0 && new Set(legs.map(l => l.legId)).size === legs.length,
      message: "Distinct persisted close leg limits required" } },
}, { _id: false, strict: "throw" });
export const PositionSchema = executionSchema({
  positionId: idField(), entryIntentId: idField(), strategyInstanceId: idField(), sessionId: idField(),
  lifecycle: { type: String, enum: positionLifecycleSchema.options, required: true },
  integrity: { type: String, enum: positionIntegritySchema.options, required: true },
  activeCloseIntentId: { type: String, default: null }, closeGeneration: unitsField(),
  legs: { type: [PositionLegSchema], required: true }, realizedPnlMinor: moneyField(true),
  executionEvidenceRefs: { type: [String], default: [] },
  closureEvidenceRefs: { type: [String], default: [] },
  potentiallyExecutingOrderCount: unitsField(),
  // Trusted persisted configuration, never supplied to requestClose. Children snapshot it immutably.
  closePolicy: { type: ClosePolicySchema },
}, "execution_positions");
identityIndexes(PositionSchema, "positionId");
PositionSchema.index({ accountId: 1, entryIntentId: 1 }, { unique: true });
PositionSchema.index({ accountId: 1, activeCloseIntentId: 1 }, {
  unique: true, partialFilterExpression: { activeCloseIntentId: { $type: "string" } },
});
PositionSchema.pre("validate", function () {
  const result = positionEconomicsSchema.safeParse(this.toObject());
  if (!result.success) this.invalidate("lifecycle", result.error.message);
});
export const PositionModel = model("ExecutionPosition", PositionSchema);
