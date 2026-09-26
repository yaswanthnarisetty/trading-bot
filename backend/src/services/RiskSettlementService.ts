import type { Connection } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { loadExecutionChain } from "../db/executionConcurrency";
import { assertAccountEntryProjection, loadAccountEntryProjection, verifyEntryRiskLedger } from "../db/entryRiskProjection";
import { terminalRiskProof } from "../db/terminalRiskEvidence";
import { assertRealizedProjection, loadRealizedProjection } from "../db/realizedRiskProjection";
import { releaseRisk } from "../domain/realizedRisk";
import { riskAudit, saveRisk } from "./riskAudit";

/** Explicit successful-CLOSED settlement. Empty/aborted entries remain conservatively held. */
export class RiskSettlementService {
  private readonly scope: ExecutionScope; private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope); if (scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
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
