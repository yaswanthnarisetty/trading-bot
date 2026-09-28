import type { ClientSession, Connection, Document } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { assertAccountReconciliationIndexes, currentMatchedReconciliation } from "../db/reconciliationAdmission";
import { loadReconciliationLedger } from "../db/reconciliationLedger";
import { withRecoveryWrite } from "../db/recoveryWrite";
import { fingerprint, istDay, reconciliationConfigSchema, reconciliationStateSchema } from "../domain/reconciliation";
import { recoveryBeginId, recoveryReadyId, recoveryStateSchema, type RecoveryState } from "../domain/recovery";
import { saveRisk } from "./riskAudit";
import { withExecutionHost } from "../db/executionHost";
import { requireExecutionHost, validateExecutionHost, type ExecutionHostContext } from "../domain/ExecutionHostContext";

export type RecoveryResult = RecoveryState | { status: "OPTED_OUT" };

/** Explicit startup boundary. No broker dependency, financial writes or automatic startup hooks. */
export class RecoveryBarrierService {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date(),
    private readonly host?: ExecutionHostContext) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    validateExecutionHost(host);
    this.models = executionModels(connection);
  }
  private async transaction<T>(accountId: string, work: (account: Document, session: ClientSession) => Promise<T>): Promise<T | { status: "OPTED_OUT" }> {
    if (accountId !== this.scope.accountId) throw new Error("LEDGER_SCOPE_MISMATCH");
    await assertExecutionIndexes(this.connection, "BASE");
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => withExecutionHost(session, this.host, async () => {
        const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
        await assertAccountReconciliationIndexes(this.connection, account.toObject());
        if (account.get("reconciliationConfig") === undefined) {
          if (account.get("reconciliationState") !== undefined || account.get("recoveryState") !== undefined) throw new Error("RECOVERY_CONFIG_REQUIRED");
          return { status: "OPTED_OUT" as const };
        }
        reconciliationConfigSchema.parse(account.get("reconciliationConfig"));
        requireExecutionHost(this.host);
        return work(account, session);
      }), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
  private async persist(account: Document, state: RecoveryState, session: ClientSession) {
    return withRecoveryWrite(session, async () => {
      const now = this.clock(), sequence = account.get("nextEventSequence");
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
      account.set({ recoveryState: state, nextEventSequence: sequence + 1 });
      await saveRisk(account, this.scope, session, now);
      const ready = state.status === "READY", eventId = ready ? state.readyEventId : state.beginEventId;
      await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: eventId, createdAt: now,
        eventId, eventType: ready ? "RECOVERY_READY" : "RECOVERY_REQUIRED", accountSequence: sequence,
        tradingDate: istDay(now.toISOString()), aggregateType: "TradingAccount", aggregateId: this.scope.accountId,
        aggregateVersion: account.get("version"), causationId: ready ? state.recordId : state.commandKey,
        actor: "RecoveryBarrierService", occurredAt: now, recordedAt: now, reason: state.status,
        evidenceRefs: ready ? [state.beginEventId, state.recordId] : [state.commandKey],
        payload: { kind: "RECOVERY", generation: state.generation, startupId: state.startupId, commandKey: state.commandKey,
          recordId: ready ? state.recordId : null } }).save({ session });
      return state;
    });
  }
  async beginRecovery(accountId: string, input: string): Promise<RecoveryResult> {
    const commandKey = identifierSchema.parse(input);
    return this.transaction(accountId, async (account, session) => {
      const { startupId } = requireExecutionHost(this.host), eventId = recoveryBeginId(accountId, commandKey, startupId);
      const raw = account.get("recoveryState"), previous = raw === undefined ? undefined : recoveryStateSchema.parse(raw);
      // Durable receipt survives later generations. An old replay never starts a new one.
      const receipt = await this.models.TradingEvent.findOne({ ...this.scope, eventId, eventType: "RECOVERY_REQUIRED" }).session(session);
      if (receipt) {
        if (!previous || previous.startupId !== startupId) throw new Error("RECOVERY_HOST_MISMATCH");
        return previous;
      }
      // Workers for one startup must share its command key. A different command
      // cannot churn an already-required generation or erase its fresh-evidence floor.
      if (previous?.status === "RECOVERY_REQUIRED") throw new Error("RECOVERY_ALREADY_REQUIRED");
      const generation = (previous?.generation ?? 0) + 1, requiredAt = this.clock().toISOString();
      if (!Number.isSafeInteger(generation)) throw new Error("RECOVERY_GENERATION_EXHAUSTED");
      if (previous && requiredAt < previous.readyAt) throw new Error("RECOVERY_CLOCK_REGRESSION");
      return this.persist(account, { status: "RECOVERY_REQUIRED", startupId, generation, commandKey, beginEventId: eventId, requiredAt }, session);
    });
  }
  async completeRecovery(accountId: string, input: string): Promise<RecoveryResult> {
    const recordId = identifierSchema.parse(input);
    return this.transaction(accountId, async (account, session) => {
      const recovery = recoveryStateSchema.parse(account.get("recoveryState"));
      const { startupId } = requireExecutionHost(this.host);
      if (recovery.startupId !== startupId) throw new Error("RECOVERY_HOST_MISMATCH");
      const state = reconciliationStateSchema.parse(account.get("reconciliationState"));
      const proof = await currentMatchedReconciliation(this.connection, session, this.scope, account.toObject());
      if (!proof || proof.recordId !== recordId || proof.report.recoveryGeneration !== recovery.generation || proof.report.recoveryStartupId !== startupId)
        throw new Error("RECOVERY_PROOF_INVALID");
      const report = proof.report, now = this.clock().toISOString();
      if (report.snapshotStartedAt <= recovery.requiredAt || report.snapshotFetchedAt > now
        || report.endpoints.some((e, i) => e.availability !== "AVAILABLE" || e.fetchedAt < state.endpointTimes[i]))
        throw new Error("RECOVERY_EVIDENCE_STALE");
      const config = reconciliationConfigSchema.parse(account.get("reconciliationConfig"));
      const ledger = await loadReconciliationLedger(this.connection, session, this.scope);
      if (fingerprint({ config, ledger }) !== report.internalFingerprint) throw new Error("RECOVERY_LEDGER_CHANGED");
      const begin = await this.models.TradingEvent.findOne({ ...this.scope, eventId: recovery.beginEventId,
        eventType: "RECOVERY_REQUIRED", "payload.generation": recovery.generation, "payload.startupId": startupId, "payload.commandKey": recovery.commandKey }).session(session);
      if (!begin) throw new Error("RECOVERY_BEGIN_PROOF_REQUIRED");
      if (recovery.status === "READY") {
        const ready = await this.models.TradingEvent.findOne({ ...this.scope, eventId: recovery.readyEventId,
          eventType: "RECOVERY_READY", "payload.generation": recovery.generation, "payload.startupId": startupId, "payload.recordId": recovery.recordId }).session(session);
        if (!ready) throw new Error("RECOVERY_READY_PROOF_REQUIRED");
        return recovery;
      }
      return this.persist(account, { ...recovery, status: "READY", recordId, readyAt: now,
        readyEventId: recoveryReadyId(accountId, recovery.generation) }, session);
    });
  }
}
