import { assertExecutionIndexes } from "./executionIndexes";
import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { reconciliationConfigSchema, reconciliationStateSchema } from "../domain/reconciliation";
export async function assertAccountReconciliationIndexes(connection: Connection, account: Record<string, unknown>) {
  if (account.reconciliationConfig !== undefined || account.reconciliationState !== undefined)
    await assertExecutionIndexes(connection, "RECONCILIATION");
}
/** Absence of opt-in preserves approved Phase 2 PAPER behavior. Once configured,
 * absent/invalid state or missing durable audit proof fails closed. */
export async function reconciliationAdmissionHealthy(connection: Connection, session: ClientSession, scope: ExecutionScope, account: Record<string, unknown>) {
  await assertAccountReconciliationIndexes(connection, account);
  if (account.reconciliationConfig === undefined) return account.reconciliationState === undefined;
  const config = reconciliationConfigSchema.safeParse(account.reconciliationConfig), state = reconciliationStateSchema.safeParse(account.reconciliationState);
  if (!config.success || !state.success || state.data.classification !== "MATCHED" || !connection.db) return false;
  const record = await connection.db.collection("execution_reconciliations").findOne({ ...scope, recordId: state.data.recordId,
    broker: "KITE", brokerAccountId: config.data.brokerAccountId, "report.classification": "MATCHED", "report.scope": "REFERENCE_ONLY", "report.reconciliationVersion": 2,
    "report.internalFingerprint": state.data.internalFingerprint, "report.snapshotFetchedAt": state.data.snapshotFetchedAt }, { session });
  if (!record) return false;
  const event = await connection.db.collection("execution_events").findOne({ ...scope, eventId: state.data.recordId,
    eventType: "RECONCILIATION_RESOLVED", aggregateType: "TradingAccount", aggregateId: scope.accountId,
    "payload.kind": "REFERENCE", "payload.entityId": state.data.recordId, evidenceRefs: state.data.recordId }, { session });
  return !!event;
}
