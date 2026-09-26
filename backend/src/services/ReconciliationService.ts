import type { z } from "zod";
import { reconciliationReportSchema } from "../models/ReconciliationRecord";
import type { Connection } from "mongoose";
import { executionScopeSchema, type ExecutionScope } from "@trading-bot/shared";
import { assertKiteAccountSnapshot, type BrokerAccountSnapshot } from "../brokers/KiteReadOnlyAdapter";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { withReconciliationWrite } from "../db/reconciliationWrite";
import { compareReconciliation, fingerprint, istDay, reconciliationConfigSchema, reconciliationStateSchema, type ReconciliationLink } from "../domain/reconciliation";
import { saveRisk } from "./riskAudit";

export interface ReconciliationResult { recordId: string; snapshotId: string; runKey: string; report: z.infer<typeof reconciliationReportSchema> }

/** Explicit call only. Takes immutable normalized evidence; no broker, repair, or worker. */
export class ReconciliationService {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  async reconcileAccount(accountId: string, snapshot: BrokerAccountSnapshot): Promise<ReconciliationResult> {
    if (accountId !== this.scope.accountId) throw new Error("LEDGER_SCOPE_MISMATCH");
    assertKiteAccountSnapshot(snapshot);
    const snapshotId = fingerprint(snapshot), startedAt = this.clock();
    await assertExecutionIndexes(this.connection, "ALL");
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
        const config = reconciliationConfigSchema.parse(account.get("reconciliationConfig"));
        if (config.brokerAccountId !== snapshot.brokerAccountId) throw new Error("BROKER_ACCOUNT_MISMATCH");
        const orders = await this.models.BrokerOrder.find(this.scope).sort({ orderId: 1 }).session(session).lean();
        const fills = await this.models.Fill.find(this.scope).sort({ fillId: 1 }).session(session).lean();
        const positions = await this.models.Position.find(this.scope).sort({ positionId: 1 }).session(session).lean();
        const links = await this.models.ReconciliationLink.find(this.scope).sort({ linkId: 1 }).session(session).lean();
        const ledger = { orders, fills, positions, links: links as unknown as ReconciliationLink[] };
        // Account CAS/event counters are deliberately excluded: reconciliation itself
        // must not change the identity of the state it has just compared.
        const internalFingerprint = fingerprint({ config, ledger });
        const runKey = fingerprint([this.scope, snapshotId, internalFingerprint, 2]);
        const existing = await this.models.ReconciliationRecord.findOne({ ...this.scope, runKey }).session(session);
        if (existing) return existing.toObject() as unknown as ReconciliationResult; // Historical replay never clears newer blocking state.
        const prior = account.get("reconciliationState");
        const comparison = compareReconciliation(accountId, config.brokerAccountId, snapshot, ledger, this.clock(),
          prior === undefined ? undefined : reconciliationStateSchema.parse(prior));
        const recordId = `reconciliation:${runKey}`, completedAt = this.clock();
        const endpoints = [snapshot.orders, snapshot.trades, snapshot.positions, snapshot.funds].map(e => ({
          endpoint: e.endpoint, fetchedAt: e.fetchedAt, availability: e.availability,
          ...(e.availability === "UNAVAILABLE" ? { errorCode: e.error.code } : {}) }));
        const report = { ...comparison, normalizationVersion: 1, reconciliationVersion: 2, scope: config.scope, scopeKind: config.kind,
          snapshotStartedAt: snapshot.startedAt, snapshotFetchedAt: snapshot.fetchedAt, internalFingerprint,
          internalAccountVersion: account.get("version"), endpoints };
        const sequence = account.get("nextEventSequence");
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
        const base = { ...this.scope, schemaVersion: 1, correlationId: recordId, createdAt: completedAt };
        return await withReconciliationWrite(session, async () => {
          // First write is the shared account CAS fence: admission / FillProcessor
          // cannot commit a stale competing snapshot after this transaction wins.
          account.set({ reconciliationState: { recordId, classification: report.classification,
            snapshotFetchedAt: snapshot.fetchedAt, endpointTimes: endpoints.map((e, i) => {
              // A stale/future run remains auditable but cannot lower or poison the
              // evidence watermark used by a subsequent attempt to clear a block.
              const previous = prior === undefined ? undefined : reconciliationStateSchema.parse(prior).endpointTimes[i];
              const usable = e.fetchedAt <= completedAt.toISOString() ? e.fetchedAt : startedAt.toISOString();
              return previous && previous > usable ? previous : usable;
            }), internalFingerprint }, nextEventSequence: sequence + 1 });
          await saveRisk(account, this.scope, session, completedAt);
          const record = new this.models.ReconciliationRecord({ ...base, recordId, broker: "KITE", brokerAccountId: config.brokerAccountId,
            snapshotId, runKey, startedAt, completedAt, report });
          await record.save({ session });
          const sequencer = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
          await new this.models.TradingEvent({ ...base, eventId: recordId, accountSequence: sequence,
            eventType: report.classification === "MATCHED" ? "RECONCILIATION_RESOLVED" : "RECONCILIATION_MISMATCH",
            tradingDate: istDay(completedAt.toISOString()), aggregateType: "TradingAccount", aggregateId: accountId,
            aggregateVersion: sequencer.get("version"), causationId: recordId, actor: "ReconciliationService",
            occurredAt: completedAt, recordedAt: completedAt, reason: report.classification, evidenceRefs: [recordId],
            payload: { kind: "REFERENCE", entityId: recordId } }).save({ session });
          return record.toObject() as unknown as ReconciliationResult;
        });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
}
