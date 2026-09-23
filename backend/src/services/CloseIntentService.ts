import { randomUUID } from "node:crypto";
import type { ClientSession, Connection, Document } from "mongoose";
import { z } from "zod";
import { executionScopeSchema, identifierSchema, quantityUnitsSchema, nonnegativeMoneyMinorSchema,
  type ExecutionScope, type TradingEventType, type OrderPhase, type KnowledgeState } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { loadExecutionChain, requireAggregateVersion } from "../db/executionConcurrency";
import { transitionPosition, type PositionState, type PositionLegState } from "../domain/PositionStateMachine";
import { transitionIntent } from "../domain/IntentStateMachine";
import { fillAccounting } from "../domain/fillAccounting";
import type { FillEvidence, Result } from "../domain/execution";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { submissionFingerprint, validateSubmissionEvidence } from "../brokers/submissionEvidence";

const closePolicySchema = z.object({ kind: z.literal("POSITION_LIMIT_V1"), policyVersion: quantityUnitsSchema,
  product: identifierSchema, expiresAt: z.date(), legLimits: z.array(z.object({ legId: identifierSchema, limitPriceMinor: nonnegativeMoneyMinorSchema.refine(n => n > 0, "Close LIMIT price must be positive") }).strict()).min(1),
}).strict();
type CloseLeg = PositionLegState & { contractKey: string; closeHeldUnits: number; closeHoldIntentId?: string };
type EntryFill = FillEvidence & { contractKey: string; brokerOrderId: string; brokerNamespace: string; brokerTradeKey: string };
export interface BlockingEntryOrder {
  intentId: string; orderId: string; legId: string; phase: OrderPhase; knowledge: KnowledgeState;
  unresolvedQuantityUnits: number;
}
export class UnresolvedEntryExposureError extends Error {
  readonly code = "UNRESOLVED_ENTRY_EXPOSURE";
  constructor(readonly positionId: string, readonly blockingOrders: readonly BlockingEntryOrder[]) {
    super("UNRESOLVED_ENTRY_EXPOSURE"); this.name = "UnresolvedEntryExposureError";
  }
}
export interface CloseRequestResult {
  status: "CREATED" | "EXISTING" | "TERMINAL";
  positionId: string;
  intentId?: string;
  reservationId?: string;
  orderIds: string[];
  reason?: "FLAT" | "CLOSED";
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** PAPER-only durable close planning. No broker dependency, dispatch, activation,
 * cancellation, hold release, reconciliation, or automatic CLOSED confirmation.
 */
export class CloseIntentService {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  private async save(document: Document, session: ClientSession) {
    const version = document.get("version");
    requireAggregateVersion(document, this.scope, version);
    if (version >= Number.MAX_SAFE_INTEGER) throw new Error("CAS_VERSION_EXHAUSTED");
    document.set("updatedAt", this.clock()); await document.save({ session });
  }
  private async audit(document: Document, eventType: TradingEventType, intentId: string, commandKey: string,
    payload: object, session: ClientSession) {
    const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
    const sequence: number = account.get("nextEventSequence");
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
    account.set("nextEventSequence", sequence + 1); await this.save(account, session);
    const now = this.clock();
    const [aggregateType, key] = eventType === "POSITION_CLOSE_REQUESTED" ? ["Position", "positionId"]
      : eventType === "INTENT_CREATED" ? ["OrderIntent", "intentId"] : ["RiskReservation", "reservationId"];
    await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: document.get("correlationId"), createdAt: now,
      eventId: `${intentId}:${eventType}`, accountSequence: sequence, tradingDate: now.toISOString().slice(0, 10), eventType,
      aggregateType, aggregateId: document.get(key), aggregateVersion: document.get("version"), causationId: commandKey,
      actor: "CloseIntentService", occurredAt: now, recordedAt: now,
      reason: eventType === "RISK_RESERVED" ? "CLOSE_QUANTITY_RESERVED" : eventType, evidenceRefs: [intentId], payload }).save({ session });
  }
  private async current(position: Document, intentId: string, session: ClientSession): Promise<CloseRequestResult> {
    const [, intent] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "OrderIntent", id: intentId }]);
    if (!["CLOSE", "RECOVERY"].includes(intent.get("purpose")) || intent.get("positionId") !== position.get("positionId")
      || intent.get("closeGeneration") !== position.get("closeGeneration")) throw new Error("CLOSE_WORKFLOW_OWNERSHIP_MISMATCH");
    const reservation = await this.models.RiskReservation.findOne({ ...this.scope, intentId }).session(session).orFail();
    const children = await this.models.BrokerOrder.find({ ...this.scope, intentId }).sort({ legId: 1, orderId: 1 }).session(session);
    if (children.some(child => child.get("positionId") !== position.get("positionId"))) throw new Error("CLOSE_WORKFLOW_OWNERSHIP_MISMATCH");
    const flat = (position.get("legs") as CloseLeg[]).every(leg => leg.entryFilledUnits === leg.exitFilledUnits);
    return { status: flat ? "TERMINAL" : "EXISTING", positionId: position.get("positionId"), intentId,
      reservationId: reservation.get("reservationId"), orderIds: children.map(child => child.get("orderId") as string).sort(), ...(flat ? { reason: "FLAT" as const } : {}) };
  }
  private async assertEntryFinality(position: Document, orders: Document[], fills: EntryFill[], session: ClientSession) {
    const entryIntentId: string = position.get("entryIntentId"), positionId: string = position.get("positionId");
    const [, entry] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "OrderIntent", id: entryIntentId }]);
    if (entry.get("purpose") !== "ENTRY") throw new Error("ENTRY_OWNERSHIP_MISMATCH");
    const legs = position.toObject().legs as CloseLeg[];
    const targets = entry.toObject().targetLegs as { legId: string; contractKey: string; side: string; targetUnits: number }[];
    const blockers: BlockingEntryOrder[] = [];
    for (const order of orders) {
      if (order.get("intentId") !== entryIntentId) {
        const [, other] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "OrderIntent", id: order.get("intentId") }]);
        if (other.get("purpose") === "ENTRY") throw new Error("ENTRY_OWNERSHIP_MISMATCH");
        continue;
      }
      const leg = legs.find(l => l.legId === order.get("legId")), target = targets.find(l => l.legId === order.get("legId"));
      if (order.get("accountId") !== this.scope.accountId || order.get("executionMode") !== this.scope.executionMode
        || order.get("positionId") !== positionId || !leg || !target || leg.contractKey !== order.get("contractKey")
        || target.contractKey !== leg.contractKey || target.side !== leg.entrySide || target.targetUnits !== leg.targetUnits
        || order.get("side") !== leg.entrySide || order.get("quantityUnits") > target.targetUnits) throw new Error("ENTRY_OWNERSHIP_MISMATCH");
      await order.validate();
      const ownFills = fills.filter(fill => fill.orderId === order.get("orderId"));
      if (ownFills.some(fill => fill.accountId !== this.scope.accountId || fill.executionMode !== this.scope.executionMode
        || fill.positionId !== positionId || fill.intentId !== entryIntentId || fill.legId !== leg.legId
        || fill.contractKey !== leg.contractKey || fill.side !== leg.entrySide
        || fill.brokerOrderId !== order.get("brokerOrderId") || fill.brokerNamespace !== order.get("brokerNamespace"))) throw new Error("ENTRY_FILL_OWNERSHIP_MISMATCH");
      const processed = ownFills.reduce((n, fill) => n + BigInt(fill.quantityUnits), 0n);
      const refs = [...order.get("executionEvidenceRefs")].sort();
      if (processed !== BigInt(order.get("filledUnits"))
        || JSON.stringify(refs) !== JSON.stringify(ownFills.map(fill => fill.fillId).sort())) throw new Error("ENTRY_FILL_EVIDENCE_MISMATCH");
      const remaining = Number(BigInt(order.get("quantityUnits")) - processed);
      // Full physical quantity is already incorporated, even if snapshot reconciliation is pending.
      if (remaining === 0 && order.get("phase") === "FILLED") continue;
      let nonfillable = false;
      if (order.get("knowledge") === "KNOWN") {
        // An unclaimed NOT_SENT child cannot have crossed OrderManager's durable claim boundary.
        nonfillable = order.get("phase") === "NOT_SENT" && processed === 0n && !order.get("submissionClaim")
          && !order.get("brokerOrderId") && !order.get("submissionOutcome");
        if (["REJECTED", "CANCELLED"].includes(order.get("phase")) && order.get("submissionClaim.request") && order.get("submissionOutcome")) {
          const request = brokerOrderRequestSchema.parse(order.get("submissionClaim.request"));
          for (const key of ["accountId", "executionMode", "orderId", "intentId", "positionId", "legId", "contractKey", "side", "quantityUnits"] as const)
            if (request[key] !== order.get(key)) throw new Error("ENTRY_OWNERSHIP_MISMATCH");
          const evidence = validateSubmissionEvidence(request, order.get("submissionOutcome"));
          const observed = evidence.observedOrder;
          nonfillable = evidence.evidenceComplete && (order.get("phase") === "REJECTED"
            ? evidence.outcome.kind === "REJECTED" && processed === 0n && !order.get("brokerOrderId") && order.get("cancellation") === "NONE"
            : observed?.state === "CANCELLED" && observed.cancellation === "CONFIRMED" && order.get("cancellation") === "CONFIRMED"
              && observed.brokerOrderId === order.get("brokerOrderId") && BigInt(observed.filledUnits) === processed
              && evidence.trades.every(trade => ownFills.some(fill => fill.brokerTradeKey === trade.brokerTradeKey
                && fill.quantityUnits === trade.quantityUnits && fill.priceMinor === trade.priceMinor)));
        }
      }
      if (!nonfillable) blockers.push({ intentId: entryIntentId, orderId: order.get("orderId"), legId: leg.legId,
        phase: order.get("phase"), knowledge: order.get("knowledge"), unresolvedQuantityUnits: remaining });
    }
    if (fills.some(fill => fill.intentId === entryIntentId && !orders.some(order => order.get("orderId") === fill.orderId))) throw new Error("ENTRY_FILL_OWNERSHIP_MISMATCH");
    if (blockers.length) throw new UnresolvedEntryExposureError(positionId, blockers.sort((a, b) => a.orderId.localeCompare(b.orderId)));
  }
  async requestClose(positionInput: string, commandInput: string): Promise<CloseRequestResult> {
    const positionId = identifierSchema.parse(positionInput), commandKey = identifierSchema.parse(commandInput);
    await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    const intentId = randomUUID(), reservationId = randomUUID();
    try {
      return await session.withTransaction(async () => {
        const [account, position] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "Position", id: positionId }]);
        if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
        const command = await this.models.OrderIntent.findOne({ ...this.scope, commandKey }).session(session);
        if (command && (command.get("purpose") !== "CLOSE" || command.get("positionId") !== positionId)) throw new Error("COMMAND_KEY_CONFLICT");
        if (position.get("lifecycle") === "CLOSED") return { status: "TERMINAL", reason: "CLOSED", positionId, orderIds: [] };
        if (position.get("activeCloseIntentId")) return this.current(position, position.get("activeCloseIntentId"), session);
        if (command) throw new Error("CLOSE_WORKFLOW_NOT_ACTIVE");
        await position.validate();
        const legs = position.toObject().legs as CloseLeg[];
        const fills = (await this.models.Fill.find({ ...this.scope, positionId }).session(session))
          .map(fill => ({ ...fill.toObject(), source: "SIMULATED_FILL" } as unknown as EntryFill));
        const orders = await this.models.BrokerOrder.find({ ...this.scope,
          $or: [{ positionId }, { intentId: position.get("entryIntentId") }] }).session(session);
        // Read-only until finality is proved; subsequent writes use the same account CAS fence as FillProcessor.
        await this.assertEntryFinality(position, orders, fills, session);
        const actual = legs.map(leg => {
          const ownFills = fills.filter(fill => fill.legId === leg.legId);
          const accounting = fillAccounting(ownFills, position.get("entryIntentId"));
          const entry = ownFills.filter(fill => fill.intentId === position.get("entryIntentId")).reduce((n, fill) => n + BigInt(fill.quantityUnits), 0n);
          const exit = ownFills.filter(fill => fill.intentId !== position.get("entryIntentId")).reduce((n, fill) => n + BigInt(fill.quantityUnits), 0n);
          if (entry !== BigInt(leg.entryFilledUnits) || exit !== BigInt(leg.exitFilledUnits)) throw new Error("POSITION_FILL_EVIDENCE_MISMATCH");
          const available = Math.abs(accounting.netQuantityUnits) - leg.closeHeldUnits;
          if (!Number.isSafeInteger(available) || available < 0) throw new Error("CLOSE_QUANTITY_INVALID");
          // Existing holds belong to their original workflow. Never adopt an orphan hold
          // or reserve competing quantity when its active workflow cannot be resolved.
          if (leg.closeHeldUnits > 0) throw new Error("CLOSE_HOLD_WITHOUT_ACTIVE_WORKFLOW");
          return { leg, available, net: accounting.netQuantityUnits };
        });
        if (actual.every(item => item.net === 0)) return { status: "TERMINAL", reason: "FLAT", positionId, orderIds: [] };
        const next = value(transitionPosition({ ...position.toObject(), orders: orders.map(order => order.toObject()), fills } as PositionState,
          { type: "REQUEST_CLOSE", closeIntentId: intentId }));
        const rawPolicy = position.get("closePolicy");
        if (!rawPolicy) throw new Error("CLOSE_POLICY_REQUIRED");
        const policy = closePolicySchema.parse(rawPolicy.toObject());
        const now = this.clock();
        if (policy.expiresAt.getTime() <= now.getTime() || policy.policyVersion !== account.get("policyVersion")
          || new Set(policy.legLimits.map(limit => limit.legId)).size !== policy.legLimits.length
          || policy.legLimits.some(limit => !legs.some(leg => leg.legId === limit.legId))) throw new Error("CLOSE_POLICY_NOT_CURRENT");
        const generation = position.get("closeGeneration") + 1;
        if (!Number.isSafeInteger(generation)) throw new Error("CLOSE_GENERATION_EXHAUSTED");
        const plans = actual.filter(item => item.available > 0).map(({ leg, available, net }) => {
          const price = policy.legLimits.find(limit => limit.legId === leg.legId);
          if (!price) throw new Error("CLOSE_LEG_PRICE_REQUIRED");
          return { leg, quantityUnits: available, side: net > 0 ? "SELL" as const : "BUY" as const, limitPriceMinor: price.limitPriceMinor,
            orderId: randomUUID(), dependencies: net > 0 ? legs.filter(other => other.entrySide === "SELL").map(other => other.legId).sort() : [] };
        });
        const base = { ...this.scope, schemaVersion: 1, correlationId: position.get("correlationId"), createdAt: now, updatedAt: now, version: 0 };
        const intent = new this.models.OrderIntent({ ...base, intentId, commandKey, purpose: "CLOSE", positionId, state: "CREATED",
          targetLegs: plans.map(plan => ({ legId: plan.leg.legId, contractKey: plan.leg.contractKey, side: plan.side, targetUnits: plan.quantityUnits })),
          closeGeneration: generation, policyVersion: policy.policyVersion, deadline: policy.expiresAt });
        await intent.save({ session });
        const from = position.get("lifecycle");
        position.set({ activeCloseIntentId: intentId, closeGeneration: generation, lifecycle: next.lifecycle,
          potentiallyExecutingOrderCount: orders.filter(order => !["FILLED", "CANCELLED", "REJECTED", "NOT_SENT"].includes(order.get("phase"))
            || order.get("knowledge") !== "KNOWN").length + plans.length,
          legs: legs.map(leg => { const plan = plans.find(candidate => candidate.leg.legId === leg.legId);
            return plan ? { ...leg, closeHeldUnits: leg.closeHeldUnits + plan.quantityUnits, closeHoldIntentId: intentId } : leg; }) });
        await this.save(position, session);
        const reservation = new this.models.RiskReservation({ ...base, reservationId, intentId, kind: "CLOSE_QUANTITY",
          strategyInstanceId: position.get("strategyInstanceId"), instrumentKeys: [...new Set(plans.map(plan => plan.leg.contractKey))], state: "HELD",
          initialMarginMinor: 0, initialExposureMinor: 0, remainingMarginMinor: 0, remainingExposureMinor: 0, positionSlots: 0, policyVersion: policy.policyVersion });
        await reservation.save({ session });
        const pending = value(transitionIntent("CREATED", "RISK_PENDING"));
        intent.set("state", value(transitionIntent(pending, "RISK_RESERVED", { reservationId }))); await this.save(intent, session);
        for (const plan of plans) {
          const request = brokerOrderRequestSchema.parse({ ...this.scope, orderId: plan.orderId, claimId: "unclaimed", intentId, positionId,
            legId: plan.leg.legId, contractKey: plan.leg.contractKey, side: plan.side, quantityUnits: plan.quantityUnits,
            orderType: "LIMIT", limitPriceMinor: plan.limitPriceMinor, product: policy.product });
          await new this.models.BrokerOrder({ ...base, orderId: plan.orderId, positionId, intentId, legId: plan.leg.legId, sliceId: "close-0", generation: 0,
            contractKey: plan.leg.contractKey, side: plan.side, quantityUnits: plan.quantityUnits, limitPriceMinor: plan.limitPriceMinor,
            requestFingerprint: submissionFingerprint(request), brokerNamespace: "PAPER_SIM_V1", filledUnits: 0, lastObservationVersion: 0,
            phase: plan.dependencies.length === 0 && account.get("admissionStatus") === "PAPER_READY" ? "READY" : "PLANNED", knowledge: "KNOWN", cancellation: "NONE",
            submissionAuthorization: { reservationId, evidenceRef: intentId, product: policy.product, reservedQuantityUnits: plan.quantityUnits,
              policyVersion: policy.policyVersion, executionEpoch: account.get("executionEpoch"), expiresAt: policy.expiresAt },
            closePlan: { policy: policy.kind, closeGeneration: generation, dependsOnLegIds: plan.dependencies } }).save({ session });
        }
        await this.audit(intent, "INTENT_CREATED", intentId, commandKey, { kind: "REFERENCE", entityId: intentId }, session);
        await this.audit(reservation, "RISK_RESERVED", intentId, commandKey,
          { kind: "RISK", reservationId, marginMinor: 0, exposureMinor: 0 }, session);
        await this.audit(position, "POSITION_CLOSE_REQUESTED", intentId, commandKey, { kind: "STATE_CHANGE", from, to: position.get("lifecycle") }, session);
        return { status: "CREATED", positionId, intentId, reservationId, orderIds: plans.map(plan => plan.orderId).sort() };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
}
