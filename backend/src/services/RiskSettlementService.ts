import type { Connection } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { loadExecutionChain } from "../db/executionConcurrency";
import { assertAccountEntryProjection, loadAccountEntryProjection, verifyEntryRiskLedger } from "../db/entryRiskProjection";
import { noSubmissionRiskProof, terminalRiskProof } from "../db/terminalRiskEvidence";
import { assertRealizedProjection, loadRealizedProjection } from "../db/realizedRiskProjection";
import { releaseRisk } from "../domain/realizedRisk";
import { riskAudit, saveRisk } from "./riskAudit";
import { transitionIntent } from "../domain/IntentStateMachine";

/** Audited settlement of a proven terminal close or an expired never-submitted entry. */
export class RiskSettlementService {
  private readonly scope: ExecutionScope; private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope); if (scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  async abortExpiredUnclaimedEntry(input: string) {
    const intentId = identifierSchema.parse(input); await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try { return await session.withTransaction(async () => {
      const [account, intent] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "OrderIntent", id: intentId }]);
      if (account.get("broker") !== "PAPER" || intent.get("purpose") !== "ENTRY") throw new Error("PAPER_ONLY");
      const position = await this.models.Position.findOne({ ...this.scope, entryIntentId: intentId }).session(session).orFail();
      const hold = await this.models.RiskReservation.findOne({ ...this.scope, intentId, kind: "ENTRY_RISK" }).session(session).orFail();
      const eventId = `${hold.get("reservationId")}:ENTRY_RISK_SETTLED`;
      if (hold.get("state") === "RELEASED") {
        if (hold.get("entrySettlement.abortIntentId") !== intentId) throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
        await this.models.TradingEvent.findOne({ ...this.scope, eventId, eventType: "ENTRY_RISK_SETTLED" }).session(session).orFail();
        return { status: "SETTLED" as const, intentId, replay: true };
      }
      const now = this.clock(), evidenceExpiry = intent.get("entryPlan.marketEvidenceExpiresAt");
      if (intent.get("state") !== "RISK_RESERVED" || position.get("lifecycle") !== "PENDING_ENTRY"
        || position.get("integrity") !== "CONSISTENT" || position.get("activeCloseIntentId") !== null
        || !(evidenceExpiry instanceof Date) || Math.min(+evidenceExpiry, +intent.get("deadline")) >= +now)
        throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
      const orders = await this.models.BrokerOrder.find({ ...this.scope, intentId }).session(session);
      if (!orders.length || orders.some(order => !["READY", "PLANNED"].includes(order.get("phase"))
        || order.get("knowledge") !== "KNOWN" || order.get("cancellation") !== "NONE" || order.get("filledUnits") !== 0
        || order.get("submissionClaim") || order.get("submissionOutcome") || order.get("brokerOrderId")))
        throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
      const evidenceRefs = orders.map(order => String(order.get("orderId"))).sort();
      assertAccountEntryProjection(account.toObject(), await loadAccountEntryProjection(this.connection, session, this.scope));
      assertRealizedProjection(account.toObject(), await loadRealizedProjection(this.connection, session, this.scope, account.get("riskTradingCalendar")));
      const { projection } = await verifyEntryRiskLedger(this.connection, session, this.scope, hold.toObject(), intent.toObject(), position.toObject());
      if (projection.committedMinor !== 0 || projection.committedSlots !== 0) throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
      for (const order of orders) { order.set("phase", "NOT_SENT"); await saveRisk(order, this.scope, session, now); }
      const nextIntent = transitionIntent("RISK_RESERVED", "ABORTED", { noPotentiallyExecutingChildren: true, evidenceRefs });
      if (!nextIntent.ok) throw new Error(nextIntent.error.code);
      intent.set("state", nextIntent.value); await saveRisk(intent, this.scope, session, now);
      position.set({ lifecycle: "ABORTED", potentiallyExecutingOrderCount: 0, closureEvidenceRefs: evidenceRefs });
      await saveRisk(position, this.scope, session, now);
      const proof = await noSubmissionRiskProof(this.connection, session, this.scope, position.toObject(), intent.toObject(), now);
      const next = releaseRisk({ pending: account.get("reservedExposureMinor"), committed: account.get("committedExposureMinor"),
        slots: account.get("positionSlots"), committedSlots: account.get("committedPositionSlots") },
        { pending: projection.pendingMinor, committed: 0, reservedSlots: projection.reservedSlots, committedSlots: 0 });
      const entrySettlement = { positionId: position.get("positionId"), abortIntentId: intentId, eventId, settledAt: now,
        pendingReleasedMinor: projection.pendingMinor, committedReleasedMinor: 0,
        reservedSlotsReleased: projection.reservedSlots, committedSlotsReleased: 0 };
      hold.set({ state: "RELEASED", remainingMarginMinor: 0, remainingExposureMinor: 0, positionSlots: 0, entrySettlement });
      await saveRisk(hold, this.scope, session, now);
      const current = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
      current.set({ reservedMarginMinor: next.pending, reservedExposureMinor: next.pending, committedExposureMinor: next.committed,
        positionSlots: next.slots, committedPositionSlots: next.committedSlots });
      await saveRisk(current, this.scope, session, now);
      const { settledAt: _at, abortIntentId: _abort, eventId: _event, ...released } = entrySettlement;
      await riskAudit(this.models, this.scope, session, now, { eventId, eventType: "ENTRY_RISK_SETTLED", reservation: hold,
        causationId: intentId, reason: "PROVEN_NEVER_SUBMITTED_ENTRY", tradingDate: current.get("dailyTradingDay") ?? now.toISOString().slice(0, 10),
        evidenceRefs: proof.evidenceRefs, payload: { kind: "RISK_SETTLEMENT", reservationId: hold.get("reservationId"), ...released } });
      return { status: "SETTLED" as const, intentId, replay: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
  async settleClosedPosition(input: string) {
    const positionId = identifierSchema.parse(input); await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try { return await session.withTransaction(async () => {
      const [account, position] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "Position", id: positionId }]);
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      const proof = await terminalRiskProof(this.connection, session, this.scope, position.toObject());
      assertAccountEntryProjection(account.toObject(), await loadAccountEntryProjection(this.connection, session, this.scope));
      assertRealizedProjection(account.toObject(), await loadRealizedProjection(this.connection, session, this.scope, account.get("riskTradingCalendar")));
      const intent = await this.models.OrderIntent.findOne({ ...this.scope, intentId: position.get("entryIntentId") }).session(session).orFail();
      const hold = await this.models.RiskReservation.findOne({ ...this.scope, intentId: intent.get("intentId"), kind: "ENTRY_RISK" }).session(session).orFail();
      const { projection } = await verifyEntryRiskLedger(this.connection, session, this.scope, hold.toObject(), intent.toObject(), position.toObject());
      const eventId = `${hold.get("reservationId")}:ENTRY_RISK_SETTLED`;
      if (hold.get("state") === "RELEASED") {
        await this.models.TradingEvent.findOne({ ...this.scope, eventId, eventType: "ENTRY_RISK_SETTLED" }).session(session).orFail();
        return { status: "SETTLED" as const, positionId, replay: true };
      }
      const next = releaseRisk({ pending: account.get("reservedExposureMinor"), committed: account.get("committedExposureMinor"),
        slots: account.get("positionSlots"), committedSlots: account.get("committedPositionSlots") },
        { pending: projection.pendingMinor, committed: projection.committedMinor, reservedSlots: projection.reservedSlots, committedSlots: projection.committedSlots });
      const now = this.clock(), entrySettlement = { positionId, closeIntentId: proof.closeIntentId, eventId, settledAt: now,
        pendingReleasedMinor: projection.pendingMinor, committedReleasedMinor: projection.committedMinor,
        reservedSlotsReleased: projection.reservedSlots, committedSlotsReleased: projection.committedSlots };
      hold.set({ state: "RELEASED", remainingMarginMinor: 0, remainingExposureMinor: 0, positionSlots: 0, entrySettlement });
      await saveRisk(hold, this.scope, session, now);
      const current = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
      current.set({ reservedMarginMinor: next.pending, reservedExposureMinor: next.pending, committedExposureMinor: next.committed,
        positionSlots: next.slots, committedPositionSlots: next.committedSlots });
      await saveRisk(current, this.scope, session, now);
      const { settledAt: _at, closeIntentId: _close, eventId: _event, ...released } = entrySettlement;
      await riskAudit(this.models, this.scope, session, now, { eventId, eventType: "ENTRY_RISK_SETTLED", reservation: hold,
        causationId: proof.closeIntentId, reason: "PROVEN_TERMINAL_CLOSE", tradingDate: current.get("dailyTradingDay") ?? now.toISOString().slice(0, 10),
        evidenceRefs: proof.evidenceRefs, payload: { kind: "RISK_SETTLEMENT", reservationId: hold.get("reservationId"), ...released } });
      return { status: "SETTLED" as const, positionId, replay: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
}
