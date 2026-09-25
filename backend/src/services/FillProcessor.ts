import { randomUUID } from "node:crypto";
import type { ClientSession, Connection, Document } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope, type TradingEventType, type TradingEvent } from "@trading-bot/shared";
import { paperTradeObservationSchema, submissionEvidenceSchema } from "../brokers/submissionEvidence";
import { executionModels } from "../db/executionModels";
import { loadExecutionChain, requireAggregateVersion } from "../db/executionConcurrency";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { transitionOrder, type OrderState } from "../domain/OrderStateMachine";
import { transitionPosition, type PositionState } from "../domain/PositionStateMachine";
import { fillAccounting } from "../domain/fillAccounting";
import { checkedRiskUnits, entryProjectionFromFills, verifyEntryReservation } from "../domain/entryRisk";
import { assertAccountEntryProjection, loadAccountEntryProjection } from "../db/entryRiskProjection";
import type { FillEvidence, Result } from "../domain/execution";
import type { z } from "zod";

type PaperTrade = z.infer<typeof paperTradeObservationSchema>;
export interface FillResult { status: "APPLIED" | "DUPLICATE"; fillId: string }
export interface RetainedFillStatus {
  status: "UNPROCESSED" | "PARTIAL" | "INCOMPLETE" | "PROCESSED";
  evidenceComplete: boolean;
  processedTradeKeys: string[];
  unprocessedTradeKeys: string[];
}
const identity = (trade: PaperTrade) => ({ accountId: trade.accountId, broker: "PAPER",
  brokerNamespace: trade.brokerNamespace, brokerTradeKey: trade.brokerTradeKey });
function sameTrade(fill: Document, trade: PaperTrade): boolean {
  return (["accountId", "executionMode", "brokerNamespace", "brokerTradeKey", "brokerOrderId", "orderId", "intentId",
    "positionId", "legId", "contractKey", "side", "quantityUnits", "priceMinor"] as const).every(key => fill.get(key) === trade[key])
    && fill.get("executedAt").getTime() === new Date(trade.executedAt).getTime();
}
function evidence(fill: Document): FillEvidence {
  return { ...fill.toObject(), source: "SIMULATED_FILL" } as FillEvidence;
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Explicit PAPER evidence consumer. No broker dependency, dispatch, admission check,
 * background worker or reconciliation. Each trade has exactly one financial path.
 */
export class FillProcessor {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope,
    private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
  private async save(document: Document, session: ClientSession): Promise<void> {
    const version = document.get("version");
    requireAggregateVersion(document, this.scope, version);
    if (version >= Number.MAX_SAFE_INTEGER) throw new Error("CAS_VERSION_EXHAUSTED");
    document.set("updatedAt", this.clock());
    await document.save({ session });
  }
  private async audit(fill: Document, aggregate: Document, eventType: TradingEventType,
    from: string | undefined, session: ClientSession, riskPayload?: Extract<TradingEvent["payload"], { kind: "ENTRY_RISK_TRANSFER" }>): Promise<void> {
    // Mandatory model saves fence the account. Reload before allocating a sequence.
    const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
    const sequence: number = account.get("nextEventSequence");
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
    account.set("nextEventSequence", sequence + 1); await this.save(account, session);
    const now = this.clock(), isFill = eventType === "FILL_RECEIVED", isRisk = eventType === "ENTRY_RISK_COMMITTED", fillId: string = fill.get("fillId");
    await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: fill.get("correlationId"), createdAt: now,
      eventId: `${fillId}:${eventType}`, accountSequence: sequence, tradingDate: fill.get("executedAt").toISOString().slice(0, 10),
      eventType, aggregateType: isFill ? "Fill" : isRisk ? "RiskReservation" : "Position", aggregateId: aggregate.get(isFill ? "fillId" : isRisk ? "reservationId" : "positionId"),
      aggregateVersion: isFill ? 0 : aggregate.get("version"), causationId: fillId, actor: "FillProcessor",
      occurredAt: fill.get("executedAt"), recordedAt: now, reason: eventType, evidenceRefs: [fill.get("evidenceRef")],
      payload: isRisk ? riskPayload : isFill ? { kind: "FILL", fillId, orderId: fill.get("orderId"), quantityUnits: fill.get("quantityUnits"), priceMinor: fill.get("priceMinor") }
        : { kind: "STATE_CHANGE", from, to: aggregate.get("lifecycle") } }).save({ session });
  }
  async process(input: unknown): Promise<FillResult> {
    const trade = paperTradeObservationSchema.parse(input);
    if (trade.accountId !== this.scope.accountId || trade.executionMode !== this.scope.executionMode) throw new Error("FILL_SCOPE_MISMATCH");
    const fillId = randomUUID();
    return this.transaction(async session => {
      const [account, order, intent, position] = await loadExecutionChain(this.connection, session, this.scope, [
        { entity: "BrokerOrder", id: trade.orderId }, { entity: "OrderIntent", id: trade.intentId }, { entity: "Position", id: trade.positionId },
      ]);
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      for (const key of ["intentId", "positionId", "legId", "contractKey", "side", "brokerNamespace"] as const)
        if (order.get(key) !== trade[key]) throw new Error(`FILL_OWNERSHIP_MISMATCH: ${key}`);
      if (order.get("brokerOrderId") !== undefined && order.get("brokerOrderId") !== trade.brokerOrderId) throw new Error("FILL_BROKER_ORDER_MISMATCH");
      const existing = await this.models.Fill.findOne(identity(trade)).session(session);
      if (existing) {
        if (!sameTrade(existing, trade)) throw new Error("DUPLICATE_FILL_CONFLICT");
        return { status: "DUPLICATE", fillId: existing.get("fillId") };
      }
      const entryReservation = intent.get("purpose") === "ENTRY"
        ? await this.models.RiskReservation.findOne({ ...this.scope, intentId: trade.intentId }).session(session) : null;
      const supported = entryReservation?.get("kind") === "ENTRY_RISK";
      // Verify the BEFORE projection. Never repair drift or run current policy limits
      // while recording owned broker truth. Historical untyped fills retain their old path.
      const priorAccount = supported ? await loadAccountEntryProjection(this.connection, session, this.scope) : undefined;
      if (priorAccount) assertAccountEntryProjection(account.toObject(), priorAccount);
      const priorRisk = supported ? verifyEntryReservation(entryReservation!.toObject(), intent.toObject(), trade.positionId) : undefined;
      const oldFills = (await this.models.Fill.find({ ...this.scope, positionId: trade.positionId }).session(session)).map(evidence);
      const orders = await this.models.BrokerOrder.find({ ...this.scope, positionId: trade.positionId }).session(session);
      const now = this.clock();
      const fill = new this.models.Fill({ ...this.scope, schemaVersion: 1, correlationId: order.get("correlationId"), createdAt: now,
        fillId, broker: "PAPER", brokerNamespace: trade.brokerNamespace, brokerOrderId: trade.brokerOrderId, brokerTradeKey: trade.brokerTradeKey,
        orderId: trade.orderId, intentId: trade.intentId, positionId: trade.positionId, legId: trade.legId, contractKey: trade.contractKey,
        side: trade.side, quantityUnits: trade.quantityUnits, priceMinor: trade.priceMinor, evidenceRef: trade.evidence.reference,
        executedAt: new Date(trade.executedAt) });
      const nextOrder = value(transitionOrder({ ...order.toObject(), fills: oldFills.filter(f => f.orderId === trade.orderId) } as OrderState,
        { type: "APPLY_FILL", fill: evidence(fill) }));
      const nextPosition = value(transitionPosition({ ...position.toObject(), fills: oldFills, orders: orders.map(o => o.toObject()) } as PositionState,
        { type: intent.get("purpose") === "ENTRY" ? "ENTRY_FILL" : "EXIT_FILL", fill: evidence(fill) }));
      const legs = nextPosition.legs.map(leg => {
        const accounting = fillAccounting(nextPosition.fills.filter(f => f.legId === leg.legId), nextPosition.entryIntentId);
        if (intent.get("purpose") === "ENTRY" || leg.legId !== trade.legId) return { ...leg, ...accounting };
        const previous = position.get("legs").find((item: { legId: string }) => item.legId === leg.legId);
        const held: number = previous.closeHeldUnits;
        const owner: string | undefined = previous.closeHoldIntentId;
        // Pre-2B3 unheld closes remain supported. Once a hold is consumed, persist
        // its owner even at zero; later fills must not bypass an exhausted hold.
        if (held === 0 && owner === undefined) return { ...leg, ...accounting };
        if (position.get("activeCloseIntentId") !== trade.intentId || intent.get("positionId") !== trade.positionId
          || intent.get("closeGeneration") !== position.get("closeGeneration")
          || (owner !== undefined && owner !== trade.intentId)
          || !["CLOSING", "PARTIALLY_CLOSING"].includes(position.get("lifecycle"))) throw new Error("CLOSE_HOLD_OWNERSHIP_MISMATCH");
        const before = fillAccounting(oldFills.filter(f => f.legId === leg.legId), nextPosition.entryIntentId).netQuantityUnits;
        const reduction = Math.abs(before) - Math.abs(accounting.netQuantityUnits);
        if ((before > 0 ? trade.side !== "SELL" : before < 0 ? trade.side !== "BUY" : true)
          || reduction !== trade.quantityUnits || (accounting.netQuantityUnits !== 0 && Math.sign(before) !== Math.sign(accounting.netQuantityUnits)))
          throw new Error("CLOSE_FILL_NOT_REDUCING");
        if (!Number.isSafeInteger(held) || held < reduction) throw new Error("CLOSE_HOLD_EXCEEDED");
        // Only this owned reducing leg consumes a hold. The rest remains reserved;
        // no cancellation release, new risk admission or CLOSED confirmation occurs.
        return { ...leg, ...accounting, closeHeldUnits: held - reduction, closeHoldIntentId: trade.intentId };
      });
      // A trade may beat its receipt. Bind the broker ID once within this same transaction,
      // keeping UNKNOWN/recovery knowledge unchanged; this is not reconciliation.
      if (order.get("brokerOrderId") === undefined) {
        order.set("brokerOrderId", trade.brokerOrderId); await this.save(order, session);
      }
      await fill.save({ session }); // Mandatory ownership and quantity boundary, plus account CAS fence.
      order.set({ filledUnits: nextOrder.filledUnits, phase: nextOrder.phase, knowledge: nextOrder.knowledge,
        executionEvidenceRefs: nextOrder.fills.map(f => f.fillId) });
      await this.save(order, session); // Does not consume a broker snapshot or advance its observation version.
      const from: string = position.get("lifecycle");
      position.set({ legs, lifecycle: nextPosition.lifecycle, integrity: nextPosition.integrity,
        executionEvidenceRefs: nextPosition.fills.map(f => f.fillId) });
      await this.save(position, session);
      let riskPayload: Extract<TradingEvent["payload"], { kind: "ENTRY_RISK_TRANSFER" }> | undefined;
      if (priorAccount && priorRisk && entryReservation) {
        const next = entryProjectionFromFills(priorRisk.requirement, trade.intentId,
          [...oldFills.filter(f => f.intentId === trade.intentId), evidence(fill)]);
        entryReservation.set({ entryProgress: next.progress, remainingMarginMinor: next.pendingMinor, remainingExposureMinor: next.pendingMinor });
        await this.save(entryReservation, session); // Mandatory proof against the just-inserted owned Fill ledger.
        const current = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
        const pending = priorAccount.pending - BigInt(priorRisk.projection.pendingMinor) + BigInt(next.pendingMinor);
        const committed = priorAccount.committed - BigInt(priorRisk.projection.committedMinor) + BigInt(next.committedMinor);
        const committedSlots = priorAccount.committedSlots + BigInt(next.committedSlots - priorRisk.projection.committedSlots);
        current.set({ reservedMarginMinor: checkedRiskUnits(pending), reservedExposureMinor: checkedRiskUnits(pending),
          committedExposureMinor: checkedRiskUnits(committed), committedPositionSlots: checkedRiskUnits(committedSlots) });
        await this.save(current, session);
        assertAccountEntryProjection(current.toObject(), await loadAccountEntryProjection(this.connection, session, this.scope));
        const leg = priorRisk.requirement.legs.find(leg => leg.legId === trade.legId)!;
        riskPayload = { kind: "ENTRY_RISK_TRANSFER", reservationId: entryReservation.get("reservationId"), fillId, legId: trade.legId,
          quantityUnits: trade.quantityUnits, releasedPendingMinor: checkedRiskUnits(BigInt(trade.quantityUnits) * BigInt(leg.limitPriceMinor)),
          committedPremiumMinor: checkedRiskUnits(BigInt(trade.quantityUnits) * BigInt(trade.priceMinor)), remainingPendingMinor: next.pendingMinor,
          committedExposureMinor: next.committedMinor, slotTransferred: next.committedSlots > priorRisk.projection.committedSlots };
      }
      await this.audit(fill, fill, "FILL_RECEIVED", undefined, session);
      if (from !== nextPosition.lifecycle) {
        const events: Partial<Record<PositionState["lifecycle"], TradingEventType>> = {
          PARTIALLY_OPENED: "POSITION_PARTIALLY_OPENED", OPEN: "POSITION_OPENED", PARTIALLY_CLOSING: "POSITION_PARTIALLY_CLOSED",
        };
        const eventType = events[nextPosition.lifecycle];
        if (!eventType) throw new Error("UNSUPPORTED_FILL_LIFECYCLE_TRANSITION");
        await this.audit(fill, position, eventType, from, session);
      }
      if (riskPayload && entryReservation) await this.audit(fill, entryReservation, "ENTRY_RISK_COMMITTED", undefined, session, riskPayload);
      return { status: "APPLIED", fillId };
    });
  }
  /** Status describes only this immutable retained evidence set, not order finality.
   * It is derived from committed Fill identities/economics, so restart needs no claim flag.
   */
  async retainedStatus(input: string): Promise<RetainedFillStatus> {
    const orderId = identifierSchema.parse(input);
    return this.transaction(async session => {
      const [, order] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "BrokerOrder", id: orderId }]);
      if (!order.get("submissionOutcome")) return { status: "INCOMPLETE", evidenceComplete: false, processedTradeKeys: [], unprocessedTradeKeys: [] };
      const retained = submissionEvidenceSchema.parse(order.get("submissionOutcome"));
      const processedTradeKeys: string[] = [], unprocessedTradeKeys: string[] = [];
      for (const trade of retained.trades) {
        const fill = await this.models.Fill.findOne(identity(trade)).session(session);
        (fill && sameTrade(fill, trade) ? processedTradeKeys : unprocessedTradeKeys).push(trade.brokerTradeKey);
      }
      const status = unprocessedTradeKeys.length ? (processedTradeKeys.length ? "PARTIAL" : "UNPROCESSED")
        : retained.evidenceComplete ? "PROCESSED" : "INCOMPLETE";
      return { status, evidenceComplete: retained.evidenceComplete, processedTradeKeys, unprocessedTradeKeys };
    });
  }
  async processRetained(input: string): Promise<RetainedFillStatus & { failedTradeKeys: string[] }> {
    const orderId = identifierSchema.parse(input);
    const retained = await this.transaction(async session => {
      const [, order] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "BrokerOrder", id: orderId }]);
      return order.get("submissionOutcome") ? submissionEvidenceSchema.parse(order.get("submissionOutcome")) : undefined;
    });
    const failedTradeKeys: string[] = [];
    for (const trade of retained?.trades ?? []) {
      try { await this.process(trade); }
      catch { failedTradeKeys.push(trade.brokerTradeKey); break; }
    }
    return { ...await this.retainedStatus(orderId), failedTradeKeys };
  }
}
