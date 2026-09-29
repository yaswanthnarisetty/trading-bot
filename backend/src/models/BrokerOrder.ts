import { submissionEvidenceSchema } from "../brokers/submissionEvidence";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { orderEconomicsSchema } from "../domain/financialInvariants";
import { model, Schema } from "mongoose";
import { cancellationStateSchema, knowledgeStateSchema, orderPhaseSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, moneyField, unitsField, writeOnceFields, monotonicFields } from "./executionSupport";

const AuthorizationSchema = new Schema({
  reservationId: idField(), evidenceRef: idField(), product: idField(),
  reservedQuantityUnits: unitsField(true), policyVersion: unitsField(), executionEpoch: unitsField(),
  expiresAt: { type: Date, required: true },
}, { _id: false, strict: "throw" });
const ClaimSchema = new Schema({
  // Parent writeOnceFields enforces immutability after attachment. Child immutable setters
  // would also reject the FIRST claim attached to an existing READY document.
  claimId: { ...idField(), immutable: false }, reservationId: { ...idField(), immutable: false }, evidenceRef: { ...idField(), immutable: false },
  policyVersion: unitsField(), executionEpoch: unitsField(),
  claimedAt: { type: Date, required: true }, expiresAt: { type: Date, required: true },
  request: { type: Schema.Types.Mixed }, requestFingerprint: { type: String },
}, { _id: false, strict: "throw" });
export const BrokerOrderSchema = executionSchema({
  orderId: idField(), positionId: idField(), intentId: idField(), legId: idField(), sliceId: idField(),
  generation: { ...unitsField(), immutable: true },
  contractKey: idField(), side: { type: String, enum: ["BUY", "SELL"], required: true, immutable: true },
  quantityUnits: { ...unitsField(true), immutable: true }, limitPriceMinor: { ...moneyField(), immutable: true },
  requestFingerprint: idField(),
  brokerOrderId: { type: String, trim: true, minlength: 1 }, brokerNamespace: idField(),
  phase: { type: String, enum: orderPhaseSchema.options, required: true },
  knowledge: { type: String, enum: knowledgeStateSchema.options, required: true },
  cancellation: { type: String, enum: cancellationStateSchema.options, required: true },
  filledUnits: unitsField(), lastObservationVersion: unitsField(),
  entryClassification: { type: new Schema({
    family: { type: String, enum: ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"], required: true },
    strategyKind: { type: String, enum: ["LONG_CALL", "LONG_PUT", "BULL_CALL_DEBIT_SPREAD", "BEAR_PUT_DEBIT_SPREAD", "BULL_PUT_CREDIT_SPREAD", "BEAR_CALL_CREDIT_SPREAD"], required: true },
    role: { type: String, enum: ["LONG", "HEDGE", "SHORT"], required: true },
  }, { _id: false, strict: "throw" }), immutable: true },
  submissionAuthorization: { type: AuthorizationSchema, immutable: true },
  submissionClaim: { type: ClaimSchema },
  submissionOutcome: { type: Schema.Types.Mixed },
  closePlan: { type: new Schema({
    policy: { type: String, enum: ["POSITION_LIMIT_V1"], required: true },
    closeGeneration: unitsField(),
    dependsOnLegIds: { type: [String], required: true },
  }, { _id: false, strict: "throw" }), immutable: true },
  dependencyActivation: { type: new Schema({
    positionId: { ...idField(), immutable: false }, intentId: { ...idField(), immutable: false }, orderId: { ...idField(), immutable: false }, closeGeneration: unitsField(),
    eventId: { ...idField(), immutable: false }, evidenceRefs: { type: [String], required: true, validate: (refs: string[]) => refs.length > 0 },
  }, { _id: false, strict: "throw" }) },
  executionEvidenceRefs: { type: [String], default: [] },
}, "execution_orders");
identityIndexes(BrokerOrderSchema, "orderId");
writeOnceFields(BrokerOrderSchema, ["entryClassification", "brokerOrderId", "submissionClaim", "submissionOutcome", "closePlan", "dependencyActivation"]);
monotonicFields(BrokerOrderSchema, ["filledUnits", "lastObservationVersion"]);
BrokerOrderSchema.index({ intentId: 1, legId: 1, sliceId: 1, generation: 1 }, { unique: true });
// Not verified from broker contract: namespace must encode verified ID scope before live ingestion.
BrokerOrderSchema.index({ accountId: 1, brokerNamespace: 1, brokerOrderId: 1 }, {
  unique: true, partialFilterExpression: { brokerOrderId: { $type: "string" } },
});
BrokerOrderSchema.index({ "submissionClaim.claimId": 1 }, {
  unique: true, partialFilterExpression: { "submissionClaim.claimId": { $type: "string" } },
});
BrokerOrderSchema.pre("validate", function () {
  const result = orderEconomicsSchema.safeParse(this.toObject());
  if (!result.success) this.invalidate("phase", result.error.message);
  const receipt = this.get("submissionOutcome");
  if (receipt !== undefined && !submissionEvidenceSchema.safeParse(receipt).success) this.invalidate("submissionOutcome", "Invalid normalized submission evidence");
  const request = this.get("submissionClaim.request");
  if (request !== undefined && !brokerOrderRequestSchema.safeParse(request).success) this.invalidate("submissionClaim", "Invalid durable request");
  const phase = this.get("phase");
  if (this.get("closePlan") && !(Number(this.get("limitPriceMinor")) > 0))
    this.invalidate("limitPriceMinor", "Close LIMIT price must be positive");
  // An explicit advancement operation must attach durable proof before dependency activation.
  const dependencies = this.get("closePlan.dependsOnLegIds");
  if (Array.isArray(dependencies) && dependencies.length && (typeof phase !== "string" || !["PLANNED", "NOT_SENT"].includes(phase)) && !this.get("dependencyActivation"))
    this.invalidate("phase", "CLOSE_DEPENDENCY_NOT_AUTHORIZED: hedge removal remains PLANNED");
  if (typeof phase === "string" && ["SUBMITTING", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED"].includes(phase) && !this.get("submissionClaim")) {
    this.invalidate("submissionClaim", "Sent order requires durable authorization metadata");
  }
});
export const BrokerOrderModel = model("ExecutionBrokerOrder", BrokerOrderSchema);
