import { model, Schema } from "mongoose";
import { executionSchema, idField, identityIndexes } from "./executionSupport";
import { reconciliationLinkSchema } from "../domain/reconciliation";
/** Trusted explicit shadow association, not adoption or a financial record. Never created
 * by reconciliation. One-to-one links cannot be silently reassigned. */
export const ReconciliationLinkSchema = executionSchema({
  linkId: idField(), brokerAccountId: idField(), evidenceRef: idField(),
  link: { type: Schema.Types.Mixed, required: true, immutable: true },
}, "execution_reconciliation_links", true);
identityIndexes(ReconciliationLinkSchema, "linkId");
ReconciliationLinkSchema.index({ accountId: 1, executionMode: 1, "link.kind": 1, "link.internalId": 1 }, { unique: true });
ReconciliationLinkSchema.index({ accountId: 1, executionMode: 1, brokerAccountId: 1, "link.kind": 1, "link.brokerKey": 1 }, { unique: true });
ReconciliationLinkSchema.pre("validate", function () {
  if (this.get("executionMode") !== "PAPER" || !reconciliationLinkSchema.safeParse(this.get("link")).success)
    this.invalidate("link", "Exact PAPER shadow linkage required");
});
export const ReconciliationLinkModel = model("ExecutionReconciliationLink", ReconciliationLinkSchema);
