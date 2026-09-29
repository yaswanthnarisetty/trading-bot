import type { ClientSession, Connection, Document } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope, type TradingEventType } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { loadExecutionChain, requireAggregateVersion } from "../db/executionConcurrency";
import { closeDependencyRefs, closeOrderFinality, dependenciesAreSafe, successfulClose, verifyCloseLedger, recordRows, type LedgerRecord } from "../domain/closeWorkflowEvidence";
import { transitionPosition, type PositionState } from "../domain/PositionStateMachine";
import { transitionIntent } from "../domain/IntentStateMachine";
import type { Result } from "../domain/execution";

export interface CloseAdvanceResult {
  status: "ACTIVE" | "BLOCKED" | "CLOSED";
  positionId: string; intentId: string;
  readyOrderIds: string[]; promotedOrderIds: string[]; blockingOrderIds: string[];
}
const plain = (doc: Document): LedgerRecord => doc.toObject() as LedgerRecord;
const value = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value; };

/** Explicit PAPER-only successful close progression. No broker, timer, retry executor or reconciliation. */
export class CloseWorkflowService {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  private async save(doc: Document, session: ClientSession) {
    requireAggregateVersion(doc, this.scope, doc.get("version"));
    if (doc.get("version") >= Number.MAX_SAFE_INTEGER) throw new Error("CAS_VERSION_EXHAUSTED");
    doc.set("updatedAt", this.clock()); await doc.save({ session });
  }
  private async audit(doc: Document, aggregateType: "BrokerOrder" | "Position" | "OrderIntent" | "RiskReservation",
    key: string, eventType: TradingEventType, intentId: string, from: string, to: string, refs: string[], session: ClientSession) {
    const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
    const sequence = account.get("nextEventSequence");
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
    account.set("nextEventSequence", sequence + 1); await this.save(account, session);
    const now = this.clock();
    await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: doc.get("correlationId"), createdAt: now,
      eventId: `${doc.get(key)}:${eventType}`, accountSequence: sequence, tradingDate: now.toISOString().slice(0, 10), eventType,
      aggregateType, aggregateId: doc.get(key), aggregateVersion: doc.get("version"), causationId: intentId,
      actor: "CloseWorkflowService", occurredAt: now, recordedAt: now, reason: eventType, evidenceRefs: refs,
      payload: { kind: "STATE_CHANGE", from, to } }).save({ session });
  }
  async advance(input: string): Promise<CloseAdvanceResult> {
    const positionId = identifierSchema.parse(input);
    await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const [account, position] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "Position", id: positionId }]);
        if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
        if (position.get("lifecycle") === "CLOSED") {
          const completed = await this.models.OrderIntent.findOne({ ...this.scope, positionId, purpose: "CLOSE",
            closeGeneration: position.get("closeGeneration"), state: "COMPLETED" }).session(session).orFail();
          return { status: "CLOSED", positionId, intentId: completed.get("intentId"), readyOrderIds: [], promotedOrderIds: [], blockingOrderIds: [] };
        }
        const intentId = identifierSchema.parse(position.get("activeCloseIntentId"));
        const [, intent] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "OrderIntent", id: intentId }]);
        if (intent.get("purpose") !== "CLOSE" || intent.get("positionId") !== positionId
          || intent.get("closeGeneration") !== position.get("closeGeneration")
          || !["RISK_RESERVED", "EXECUTING"].includes(intent.get("state"))) throw new Error("CLOSE_WORKFLOW_OWNERSHIP_MISMATCH");
        const orders = await this.models.BrokerOrder.find({ ...this.scope,
          $or: [{ positionId }, { intentId: position.get("entryIntentId") }, { intentId }] }).session(session);
        const fills = (await this.models.Fill.find({ ...this.scope, positionId }).session(session)).map(plain);
        const intents = (await this.models.OrderIntent.find({ ...this.scope,
          intentId: { $in: [...new Set([position.get("entryIntentId"), intentId, ...orders.map(order => order.get("intentId"))])] } }).session(session)).map(plain);
        const pos = plain(position);
        verifyCloseLedger(pos, orders.map(plain), fills, intents);
        const children = orders.filter(order => order.get("intentId") === intentId);
        if (!children.length) throw new Error("CLOSE_CHILDREN_REQUIRED");
        const reservation = await this.models.RiskReservation.findOne({ ...this.scope, intentId }).session(session).orFail();
        if (reservation.get("kind") !== "CLOSE_QUANTITY" || !["HELD", "PARTIALLY_CONSUMED"].includes(reservation.get("state"))) throw new Error("CLOSE_RESERVATION_MISMATCH");
        for (const key of ["initialMarginMinor", "remainingMarginMinor", "initialExposureMinor", "remainingExposureMinor", "positionSlots"])
          if (reservation.get(key) !== 0) throw new Error("CLOSE_RESERVATION_MISMATCH");
        for (const child of children) {
          const leg = recordRows(pos, "legs").find(item => item.legId === child.get("legId"));
          const dependencies: string[] = child.get("closePlan.dependsOnLegIds");
          const expected = leg?.entrySide === "BUY" ? recordRows(pos, "legs").filter(item => item.entrySide === "SELL").map(item => String(item.legId)).sort() : [];
          if (!leg || leg.closeHoldIntentId !== intentId || child.get("closePlan.closeGeneration") !== intent.get("closeGeneration")
            || child.get("closePlan.policy") !== "POSITION_LIMIT_V1" || !Array.isArray(dependencies)
            || JSON.stringify([...dependencies].sort()) !== JSON.stringify(expected)
            || child.get("submissionAuthorization.reservationId") !== reservation.get("reservationId")) throw new Error("CLOSE_DEPENDENCY_OWNERSHIP_MISMATCH");
        }
        // Confirm only an accepted, complete PAPER handoff whose full physical quantity
        // is now in the immutable Fill ledger. UNKNOWN/incomplete/terminal-late evidence stays unresolved.
        for (const order of orders) if (closeOrderFinality(plain(order), fills) === "INCORPORATED_FULL_FILL") {
          order.set("knowledge", "KNOWN"); await this.save(order, session);
          await this.audit(order, "BrokerOrder", "orderId", "ORDER_FINALITY_CONFIRMED", intentId,
            "RECONCILIATION_REQUIRED", "KNOWN", order.get("executionEvidenceRefs"), session);
        }
        const promotedOrderIds: string[] = [];
        for (const child of children) {
          const dependencies: string[] = child.get("closePlan.dependsOnLegIds");
          if (!dependencies.length || child.get("phase") !== "PLANNED" || child.get("knowledge") !== "KNOWN" || child.get("cancellation") !== "NONE") continue;
          const authorization = child.get("submissionAuthorization"), now = this.clock().getTime();
          if (account.get("admissionStatus") !== "PAPER_READY" || authorization.expiresAt.getTime() <= now || intent.get("deadline").getTime() <= now
            || authorization.policyVersion !== account.get("policyVersion") || reservation.get("policyVersion") !== account.get("policyVersion")
            || intent.get("policyVersion") !== account.get("policyVersion") || authorization.executionEpoch !== account.get("executionEpoch")) continue;
          if (!dependenciesAreSafe(pos, dependencies, orders.map(plain), fills)) continue;
          const refs = closeDependencyRefs(pos, dependencies, orders.map(plain), fills);
          // Zero-executed short needs conclusive final entry-order proof instead of a fabricated Fill.
          if (!refs.length) continue;
          child.set({ phase: "READY", dependencyActivation: { positionId, intentId, orderId: child.get("orderId"),
            closeGeneration: intent.get("closeGeneration"), eventId: `${child.get("orderId")}:ORDER_READY`, evidenceRefs: refs } });
          await this.save(child, session);
          await this.audit(child, "BrokerOrder", "orderId", "ORDER_READY", intentId, "PLANNED", "READY", refs, session);
          promotedOrderIds.push(child.get("orderId"));
        }
        if (successfulClose(pos, plain(intent), orders.map(plain), fills)) {
          const refs = fills.map(fill => String(fill.fillId)).sort();
          const next = value(transitionPosition({ ...pos, orders: orders.map(plain), fills: fills.map(fill => ({ ...fill, source: "SIMULATED_FILL" })) } as unknown as PositionState,
            { type: "CONFIRM_CLOSED", noPotentiallyExecutingOrders: true, evidenceRefs: refs }));
          const intentFrom = intent.get("state"), reservationFrom = reservation.get("state"), positionFrom = position.get("lifecycle");
          intent.set("state", value(transitionIntent(intentFrom, "COMPLETED", { targetAchieved: true, noPotentiallyExecutingChildren: true, evidenceRefs: refs })));
          await this.save(intent, session);
          // Retain the exhausted per-leg owner as immutable workflow history. It cannot
          // authorize another close once the active pointer is cleared and intent completed.
          reservation.set("state", "CONSUMED"); await this.save(reservation, session);
          position.set({ lifecycle: next.lifecycle, activeCloseIntentId: null, potentiallyExecutingOrderCount: 0, closureEvidenceRefs: refs });
          await this.save(position, session);
          await this.audit(intent, "OrderIntent", "intentId", "INTENT_COMPLETED", intentId, intentFrom, "COMPLETED", refs, session);
          await this.audit(reservation, "RiskReservation", "reservationId", "RESERVATION_CONSUMED", intentId, reservationFrom, "CONSUMED", refs, session);
          await this.audit(position, "Position", "positionId", "POSITION_CLOSED", intentId, positionFrom, "CLOSED", refs, session);
          return { status: "CLOSED", positionId, intentId, readyOrderIds: [], promotedOrderIds: [], blockingOrderIds: [] };
        }
        const blockingOrderIds = orders.filter(order => closeOrderFinality(plain(order), fills) === "UNRESOLVED").map(order => String(order.get("orderId"))).sort();
        const readyOrderIds = children.filter(child => child.get("phase") === "READY").map(child => String(child.get("orderId"))).sort();
        return { status: readyOrderIds.length ? "ACTIVE" : "BLOCKED", positionId, intentId, readyOrderIds,
          promotedOrderIds: promotedOrderIds.sort(), blockingOrderIds };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
}
