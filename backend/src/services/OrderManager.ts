import { randomUUID } from "node:crypto";
import type { ClientSession, Connection, Document } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { PaperBrokerAdapter } from "../brokers/PaperBrokerAdapter";
import { brokerOrderRequestSchema, type BrokerOrderRequest } from "../brokers/BrokerAdapter";
import { paperSubmissionOutcomeSchema, paperOrderObservationSchema, submissionEvidenceSchema, submissionFingerprint, validateSubmissionEvidence, type SubmissionEvidence } from "../brokers/submissionEvidence";
import { executionModels } from "../db/executionModels";
import { loadExecutionChain, requireAggregateVersion } from "../db/executionConcurrency";
import { checkTransactionCapability } from "../db/executionReadiness";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { transitionIntent } from "../domain/IntentStateMachine";

export interface SubmissionState {
  orderId: string; phase: string; knowledge: string; filledUnits: number; version: number;
  claimId?: string; brokerOrderId?: string; pendingFillProcessing: boolean;
}
export interface SubmissionResult {
  status: "PERSISTED" | "CURRENT" | "UNRESOLVED";
  order: SubmissionState | null;
  reason?: "CLAIM_COMMIT_UNRESOLVED" | "OUTCOME_PERSISTENCE_FAILED";
}
function stateOf(order: Document): SubmissionState {
  return { orderId: order.get("orderId"), phase: order.get("phase"), knowledge: order.get("knowledge"),
    filledUnits: order.get("filledUnits"), version: order.get("version"), claimId: order.get("submissionClaim.claimId"),
    brokerOrderId: order.get("brokerOrderId"), pendingFillProcessing: order.get("submissionOutcome.pendingFillProcessing") === true };
}

/** Explicitly constructed, account-bound PAPER orchestrator. No bootstrap, scheduler or recovery retry. */
export class OrderManager {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope,
    private readonly broker: PaperBrokerAdapter, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER" || !(broker instanceof PaperBrokerAdapter)) throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
  }
  private async save(order: Document, session: ClientSession): Promise<void> {
    requireAggregateVersion(order, this.scope, order.get("version"));
    order.set("updatedAt", this.clock()); await order.save({ session });
  }
  private async audit(order: Document, eventType: "SUBMISSION_CLAIMED" | "ORDER_SUBMITTED" | "ORDER_REJECTED" | "ORDER_OUTCOME_UNKNOWN",
    from: string, evidenceRef: string, session: ClientSession): Promise<void> {
    // Re-read after the mandatory write boundary's account fences. Never save a stale account snapshot.
    const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
    const sequence: number = account.get("nextEventSequence");
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
    account.set("nextEventSequence", sequence + 1); await this.save(account, session);
    const now = this.clock();
    await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: order.get("correlationId"), createdAt: now,
      eventId: `${order.get("submissionClaim.claimId")}:${eventType}`, accountSequence: sequence,
      tradingDate: now.toISOString().slice(0, 10), eventType, aggregateType: "BrokerOrder", aggregateId: order.get("orderId"),
      aggregateVersion: order.get("version"), causationId: order.get("submissionClaim.claimId"), actor: "OrderManager",
      occurredAt: now, recordedAt: now, reason: eventType, evidenceRefs: [evidenceRef],
      payload: { kind: "STATE_CHANGE", from, to: order.get("phase") } }).save({ session });
  }
  private async claim(orderId: string): Promise<{ claimed: boolean; state: SubmissionState; request?: BrokerOrderRequest }> {
    if (!(await checkTransactionCapability(this.connection)).supported) throw new Error("PERSISTENCE_NOT_READY");
    await assertExecutionIndexes(this.connection);
    const claimId = randomUUID();
    return this.transaction(async session => {
      const [account, order] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "BrokerOrder", id: orderId }]);
      if (order.get("submissionClaim") || order.get("phase") !== "READY") return { claimed: false, state: stateOf(order) };
      if (account.get("broker") !== "PAPER" || account.get("admissionStatus") !== "PAPER_READY") throw new Error("PAPER_NOT_READY");
      if (order.get("knowledge") !== "KNOWN" || order.get("cancellation") !== "NONE" || order.get("filledUnits") !== 0) throw new Error("ORDER_NOT_ELIGIBLE");
      const authorization = order.get("submissionAuthorization");
      if (!authorization) throw new Error("AUTHORIZATION_REQUIRED");
      const [, intent, reservation] = await loadExecutionChain(this.connection, session, this.scope,
        [{ entity: "OrderIntent", id: order.get("intentId") }, { entity: "RiskReservation", id: authorization.reservationId }]);
      const now = this.clock();
      if (!["RISK_RESERVED", "EXECUTING"].includes(intent.get("state")) || !["HELD", "PARTIALLY_CONSUMED"].includes(reservation.get("state"))
        || authorization.expiresAt.getTime() <= now.getTime() || intent.get("deadline").getTime() <= now.getTime()
        || authorization.policyVersion !== account.get("policyVersion") || authorization.executionEpoch !== account.get("executionEpoch")
        || intent.get("policyVersion") !== account.get("policyVersion") || reservation.get("policyVersion") !== account.get("policyVersion")
        || authorization.reservedQuantityUnits < order.get("quantityUnits") || !reservation.get("instrumentKeys").includes(order.get("contractKey"))
        || (reservation.get("remainingMarginMinor") === 0 && reservation.get("remainingExposureMinor") === 0)) throw new Error("AUTHORIZATION_NOT_CURRENT");
      const request = brokerOrderRequestSchema.parse({ ...this.scope, orderId, claimId, intentId: order.get("intentId"),
        positionId: order.get("positionId"), legId: order.get("legId"), contractKey: order.get("contractKey"), side: order.get("side"),
        quantityUnits: order.get("quantityUnits"), orderType: "LIMIT", limitPriceMinor: order.get("limitPriceMinor"), product: authorization.product });
      if (order.get("brokerNamespace") !== "PAPER_SIM_V1" || submissionFingerprint(request) !== order.get("requestFingerprint")) throw new Error("AUTHORIZED_REQUEST_MISMATCH");
      order.set({ phase: "SUBMITTING", submissionClaim: { claimId, reservationId: authorization.reservationId,
        evidenceRef: authorization.evidenceRef, policyVersion: authorization.policyVersion, executionEpoch: authorization.executionEpoch,
        claimedAt: now, expiresAt: authorization.expiresAt, request, requestFingerprint: order.get("requestFingerprint") } });
      // This save invokes the mandatory chain/position/reservation/financial write boundary and account CAS fence.
      await this.save(order, session);
      if (intent.get("state") === "RISK_RESERVED") {
        const next = transitionIntent("RISK_RESERVED", "EXECUTING", { submissionClaimId: claimId });
        if (!next.ok) throw new Error(next.error.code);
        intent.set("state", next.value); await this.save(intent, session);
      }
      await this.audit(order, "SUBMISSION_CLAIMED", "READY", authorization.evidenceRef, session);
      return { claimed: true, state: stateOf(order), request };
    });
  }
  private async collect(request: BrokerOrderRequest): Promise<SubmissionEvidence> {
    // Called only after claim transaction commit AND session end. Never invoked by a retried transaction callback.
    let outcome: SubmissionEvidence["outcome"];
    try { outcome = paperSubmissionOutcomeSchema.parse(await this.broker.submitOrder(request)); }
    catch {
      outcome = { kind: "AMBIGUOUS", boundary: "MAY_HAVE_BEEN_ACCEPTED", evidence: {
        source: "PAPER_SIMULATOR", reference: `${request.claimId}:adapter-unresolved`, receivedAt: this.clock().toISOString() } };
    }
    let observedOrder = outcome.kind === "ACCEPTED" ? outcome.order : undefined;
    let trades: SubmissionEvidence["trades"] = [], evidenceComplete = true;
    try {
      if (outcome.kind === "AMBIGUOUS") {
        const found = await this.broker.getOrder({ ...this.scope, orderId: request.orderId });
        observedOrder = found ? paperOrderObservationSchema.parse(found) : undefined;
      }
      if (observedOrder) trades = submissionEvidenceSchema.shape.trades.parse(await this.broker.getTrades(this.scope, observedOrder));
      if (outcome.kind === "AMBIGUOUS" && !observedOrder) evidenceComplete = false;
    } catch { evidenceComplete = false; }
    if (observedOrder && trades.reduce((total, trade) => total + trade.quantityUnits, 0) !== observedOrder.filledUnits) evidenceComplete = false;
    const pendingFillProcessing = (observedOrder?.filledUnits ?? 0) > 0 || trades.length > 0;
    return validateSubmissionEvidence(request, { outcome, observedOrder, trades, evidenceComplete, pendingFillProcessing });
  }
  private async persist(orderId: string, request: BrokerOrderRequest, evidence: SubmissionEvidence): Promise<SubmissionState> {
    return this.transaction(async session => {
      const [, order] = await loadExecutionChain(this.connection, session, this.scope, [{ entity: "BrokerOrder", id: orderId }]);
      if (order.get("submissionClaim.claimId") !== request.claimId) throw new Error("CLAIM_MISMATCH");
      if (order.get("submissionOutcome")) return stateOf(order);
      if (order.get("phase") !== "SUBMITTING" || order.get("knowledge") !== "KNOWN") throw new Error("OUTCOME_REQUIRES_RECONCILIATION");
      const outcome = evidence.outcome;
      let eventType: "ORDER_SUBMITTED" | "ORDER_REJECTED" | "ORDER_OUTCOME_UNKNOWN";
      if (outcome.kind === "ACCEPTED") {
        order.set({ brokerOrderId: outcome.order.brokerOrderId,
          phase: !evidence.pendingFillProcessing && outcome.order.state === "OPEN" ? "ACKNOWLEDGED" : "SUBMITTED",
          knowledge: evidence.pendingFillProcessing || !evidence.evidenceComplete ? "RECONCILIATION_REQUIRED" : "KNOWN" });
        eventType = "ORDER_SUBMITTED";
      } else if (outcome.kind === "REJECTED") {
        order.set("phase", "REJECTED"); eventType = "ORDER_REJECTED";
      } else {
        order.set("knowledge", "UNKNOWN"); eventType = "ORDER_OUTCOME_UNKNOWN";
        if (evidence.observedOrder) order.set("brokerOrderId", evidence.observedOrder.brokerOrderId);
      }
      // All observations (including zero-fill ones) await later consumption; no fill ledger/version advancement here.
      order.set("submissionOutcome", evidence); await this.save(order, session);
      await this.audit(order, eventType, "SUBMITTING", outcome.evidence.reference, session);
      return stateOf(order);
    });
  }
  async submit(input: string): Promise<SubmissionResult> {
    const orderId = identifierSchema.parse(input);
    let claim: Awaited<ReturnType<OrderManager["claim"]>>;
    try { claim = await this.claim(orderId); }
    catch (error) {
      // An uncertain commit is never permission to send. No physical retry occurs here.
      if (error instanceof Error && "hasErrorLabel" in error && typeof error.hasErrorLabel === "function"
        && error.hasErrorLabel("UnknownTransactionCommitResult")) return { status: "UNRESOLVED", order: null, reason: "CLAIM_COMMIT_UNRESOLVED" };
      throw error;
    }
    if (!claim.claimed || !claim.request) return { status: "CURRENT", order: claim.state };
    try {
      const evidence = await this.collect(claim.request);
      return { status: "PERSISTED", order: await this.persist(orderId, claim.request, evidence) };
    } catch {
      // Claim remains durable even if response/event persistence fails. NEVER resubmit or synthesize a rejection.
      return { status: "UNRESOLVED", order: claim.state, reason: "OUTCOME_PERSISTENCE_FAILED" };
    }
  }
}
