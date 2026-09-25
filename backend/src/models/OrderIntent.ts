import { model, Schema } from "mongoose";
import { intentPurposeSchema, intentStateSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, unitsField, writeOnceFields } from "./executionSupport";
import { entryPlanSchema } from "../domain/entryRisk";

const TargetLegSchema = new Schema({
  legId: idField(), contractKey: idField(), side: { type: String, enum: ["BUY", "SELL"], required: true },
  targetUnits: unitsField(true),
}, { _id: false, strict: "throw" });
export const OrderIntentSchema = executionSchema({
  intentId: idField(), commandKey: idField(), purpose: { type: String, enum: intentPurposeSchema.options, required: true, immutable: true },
  signalId: { type: String, trim: true, immutable: true },
  positionId: { type: String, trim: true, immutable: true },
  state: { type: String, enum: intentStateSchema.options, required: true },
  targetLegs: { type: [TargetLegSchema], required: true, immutable: true,
    validate: { validator: (legs: { legId: string }[]) => legs.length > 0 && new Set(legs.map(l => l.legId)).size === legs.length, message: "Distinct target legs required" } },
  closeGeneration: { ...unitsField(), immutable: true }, policyVersion: unitsField(),
  deadline: { type: Date, required: true, immutable: true },
  entryPlan: { type: Schema.Types.Mixed, immutable: true },
}, "execution_intents");
writeOnceFields(OrderIntentSchema, ["entryPlan", "targetLegs"]);
identityIndexes(OrderIntentSchema, "intentId");
OrderIntentSchema.index({ accountId: 1, commandKey: 1 }, { unique: true });
OrderIntentSchema.index({ accountId: 1, signalId: 1 }, { unique: true, partialFilterExpression: { purpose: "ENTRY" } });
OrderIntentSchema.index({ accountId: 1, positionId: 1, closeGeneration: 1 }, {
  unique: true, partialFilterExpression: { purpose: "CLOSE" },
});
OrderIntentSchema.pre("validate", function () {
  if (this.get("entryPlan") !== undefined && (this.get("purpose") !== "ENTRY" || !entryPlanSchema.safeParse(this.get("entryPlan")).success))
    this.invalidate("entryPlan", "ENTRY requires valid immutable qualified terms");
  const field = this.get("purpose") === "ENTRY" ? "signalId" : "positionId";
  const reference = this.get(field);
  if (typeof reference !== "string" || !reference.trim()) this.invalidate(field, `${field} is required for this intent purpose`);
});
export const OrderIntentModel = model("ExecutionOrderIntent", OrderIntentSchema);
