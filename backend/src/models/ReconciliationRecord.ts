import { Schema, model } from "mongoose";
import { z } from "zod";
import { executionSchema, idField, identityIndexes } from "./executionSupport";
import { classificationSchema, discrepancySchema } from "../domain/reconciliation";
export const reconciliationReportSchema = z.object({
  normalizationVersion: z.literal(1), reconciliationVersion: z.literal(2), scope: z.literal("REFERENCE_ONLY"), scopeKind: z.literal("PAPER_KITE_SHADOW_V1"),
  // Historical pre-recovery records remain readable, but cannot complete a generation.
  recoveryGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  recoveryStartupId: z.string().min(1).max(200).optional(),
  classification: classificationSchema, discrepancies: z.array(discrepancySchema),
  snapshotStartedAt: z.string().datetime(), snapshotFetchedAt: z.string().datetime(),
  internalFingerprint: z.string().regex(/^[a-f0-9]{64}$/), internalAccountVersion: z.number().int().nonnegative(),
  endpoints: z.array(z.object({ endpoint: z.enum(["/orders", "/trades", "/portfolio/positions", "/user/margins"]),
    fetchedAt: z.string().datetime(), availability: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    errorCode: z.enum(["AUTHENTICATION_FAILED", "RATE_LIMITED", "NETWORK_ERROR", "BROKER_ERROR", "INVALID_RESPONSE"]).optional() }).strict()).length(4),
  counts: z.object({ internalOrders: z.number().int().nonnegative(), internalFills: z.number().int().nonnegative(),
    internalPositions: z.number().int().nonnegative(), brokerOrders: z.number().int().nonnegative(), brokerTrades: z.number().int().nonnegative(),
    brokerNetPositions: z.number().int().nonnegative().nullable() }).strict(),
}).strict();
export const ReconciliationRecordSchema = executionSchema({
  recordId: idField(), broker: { type: String, enum: ["KITE"], required: true, immutable: true }, brokerAccountId: idField(),
  snapshotId: idField(), runKey: idField(), startedAt: { type: Date, required: true, immutable: true },
  completedAt: { type: Date, required: true, immutable: true }, report: { type: Schema.Types.Mixed, required: true, immutable: true },
}, "execution_reconciliations", true);
identityIndexes(ReconciliationRecordSchema, "recordId");
ReconciliationRecordSchema.index({ accountId: 1, executionMode: 1, runKey: 1 }, { unique: true });
ReconciliationRecordSchema.pre("validate", function () {
  if (this.get("executionMode") !== "PAPER" || !reconciliationReportSchema.safeParse(this.get("report")).success)
    this.invalidate("report", "Invalid PAPER reconciliation evidence");
});
export const ReconciliationRecordModel = model("ExecutionReconciliationRecord", ReconciliationRecordSchema);
