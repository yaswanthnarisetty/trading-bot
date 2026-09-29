import type { Connection } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { assertEntrySellProtection } from "../db/entryProtection";
import { riskAudit, saveRisk } from "./riskAudit";
/** Explicit eligibility advancement only. No dispatch, retry, child resizing or worker. */
export class EntryProtectionService {
  private readonly scope: ExecutionScope;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope); if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
  }
  async advance(input: string) {
    const orderId = identifierSchema.parse(input), models = executionModels(this.connection);
    await assertExecutionIndexes(this.connection); const session = await this.connection.startSession();
    try { return await session.withTransaction(async () => {
      const order = await models.BrokerOrder.findOne({ ...this.scope, orderId }).session(session).orFail();
      if (order.get("submissionClaim") || order.get("phase") !== "PLANNED") return { status: "CURRENT" as const };
      const intent = await models.OrderIntent.findOne({ ...this.scope, intentId: order.get("intentId"), purpose: "ENTRY" }).session(session).orFail();
      const position = await models.Position.findOne({ ...this.scope, positionId: order.get("positionId") }).session(session).orFail();
      const reservation = await models.RiskReservation.findOne({ ...this.scope, intentId: intent.get("intentId"), kind: "ENTRY_RISK", state: "HELD" }).session(session).orFail();
      let refs: string[];
      try { refs = await assertEntrySellProtection(this.connection, session, this.scope, order.toObject(), intent.toObject(), position.toObject(), reservation.toObject()); }
      catch (error) {
        if (!(error instanceof Error) || !["ENTRY_PROTECTION_REQUIRED", "INSUFFICIENT_CONFIRMED_BUY_PROTECTION"].includes(error.message)) throw error;
        // Same state/progress produces one stable blocked audit, not an unbounded retry log.
        const eventId = `${orderId}:PROTECTION_BLOCKED:${reservation.get("version")}`;
        if (!await models.TradingEvent.exists({ ...this.scope, eventId }).session(session))
          await riskAudit(models, this.scope, session, this.clock(), { eventId, eventType: "RISK_BLOCKED", causationId: orderId,
            reason: "SELL_BLOCKED_INSUFFICIENT_CONFIRMED_PROTECTION", tradingDate: this.clock().toISOString().slice(0, 10),
            evidenceRefs: [reservation.get("reservationId")], payload: { kind: "REFERENCE", entityId: orderId } });
        return { status: "BLOCKED" as const };
      }
      order.set("phase", "READY"); await saveRisk(order, this.scope, session, this.clock());
      await riskAudit(models, this.scope, session, this.clock(), { eventId: `${orderId}:PROTECTION_READY`, eventType: "ORDER_READY",
        causationId: orderId, reason: "CONFIRMED_BUY_FILL_SELL_QUANTITY_ELIGIBLE", tradingDate: this.clock().toISOString().slice(0, 10),
        evidenceRefs: refs, payload: { kind: "REFERENCE", entityId: orderId } });
      return { status: "READY" as const };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
}
