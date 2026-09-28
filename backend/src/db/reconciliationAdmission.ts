import { assertExecutionIndexes } from "./executionIndexes";
import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { reconciliationConfigSchema, reconciliationStateSchema } from "../domain/reconciliation";
import { recoveryStateSchema } from "../domain/recovery";
import { EntryRiskError } from "../domain/entryRisk";
import { reconciliationReportSchema } from "../models/ReconciliationRecord";
import { requireExecutionHost, type ExecutionHostContext } from "../domain/ExecutionHostContext";
import { executionHostFor } from "./executionHost";

export function assertCurrentRecoveryHost(account: Record<string, unknown>, host: ExecutionHostContext | undefined) {
  if (account.reconciliationConfig === undefined) return;
  const current = requireExecutionHost(host), recovery = recoveryStateSchema.safeParse(account.recoveryState);
  if (!recovery.success || recovery.data.startupId !== current.startupId) throw new EntryRiskError("RECOVERY_REQUIRED");
}
export async function assertAccountReconciliationIndexes(connection: Connection, account: Record<string, unknown>) {
  if (account.reconciliationConfig !== undefined || account.reconciliationState !== undefined || account.recoveryState !== undefined)
    await assertExecutionIndexes(connection, "RECONCILIATION");
}
/** Absence of opt-in preserves approved Phase 2 PAPER behavior. Once configured,
 * absent/invalid state or missing durable audit proof fails closed. */
export async function currentMatchedReconciliation(connection: Connection, session: ClientSession, scope: ExecutionScope, account: Record<string, unknown>) {
  const config = reconciliationConfigSchema.safeParse(account.reconciliationConfig), state = reconciliationStateSchema.safeParse(account.reconciliationState);
  if (!config.success || !state.success || state.data.classification !== "MATCHED" || !connection.db) return null;
  const record = await connection.db.collection("execution_reconciliations").findOne({ ...scope, recordId: state.data.recordId,
    broker: "KITE", brokerAccountId: config.data.brokerAccountId, "report.classification": "MATCHED", "report.scope": "REFERENCE_ONLY", "report.reconciliationVersion": 2,
    "report.internalFingerprint": state.data.internalFingerprint, "report.snapshotFetchedAt": state.data.snapshotFetchedAt }, { session });
  if (!record) return null;
  const parsed = reconciliationReportSchema.safeParse(record.report);
  if (!parsed.success || parsed.data.scopeKind !== config.data.kind) return null;
  const event = await connection.db.collection("execution_events").findOne({ ...scope, eventId: state.data.recordId,
    eventType: "RECONCILIATION_RESOLVED", aggregateType: "TradingAccount", aggregateId: scope.accountId,
    "payload.kind": "REFERENCE", "payload.entityId": state.data.recordId, evidenceRefs: state.data.recordId }, { session });
  return event ? { recordId: String(record.recordId), report: parsed.data } : null;
}

export async function reconciliationAdmissionHealthy(connection: Connection, session: ClientSession, scope: ExecutionScope, account: Record<string, unknown>) {
  await assertAccountReconciliationIndexes(connection, account);
  if (account.reconciliationConfig === undefined) return account.reconciliationState === undefined && account.recoveryState === undefined;
  assertCurrentRecoveryHost(account, executionHostFor(session));
  const recovery = recoveryStateSchema.safeParse(account.recoveryState);
  if (!recovery.success || recovery.data.status !== "READY" || !connection.db) throw new EntryRiskError("RECOVERY_REQUIRED");
  const ready = await connection.db.collection("execution_events").findOne({ ...scope,
    eventId: recovery.data.readyEventId, eventType: "RECOVERY_READY", aggregateType: "TradingAccount", aggregateId: scope.accountId,
    "payload.kind": "RECOVERY", "payload.generation": recovery.data.generation, "payload.commandKey": recovery.data.commandKey,
    "payload.startupId": recovery.data.startupId,
    "payload.recordId": recovery.data.recordId, evidenceRefs: recovery.data.recordId }, { session });
  if (!ready) throw new EntryRiskError("RECOVERY_REQUIRED");
  const proof = await currentMatchedReconciliation(connection, session, scope, account);
  return !!proof && proof.report.recoveryGeneration === recovery.data.generation && proof.report.recoveryStartupId === recovery.data.startupId;
}
