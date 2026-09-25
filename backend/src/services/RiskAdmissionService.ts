import { randomUUID } from "node:crypto";
import type { ClientSession, Connection, Document } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { requireAggregateVersion } from "../db/executionConcurrency";
import { calculateEntryRisk, checkedRiskUnits, entryRiskPolicySchema, EntryRiskError, riskAssert,
  verifyEntryReservation, type EntryRiskReason } from "../domain/entryRisk";
import { assertAccountEntryProjection, loadAccountEntryProjection } from "../db/entryRiskProjection";
import { transitionIntent } from "../domain/IntentStateMachine";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { submissionFingerprint } from "../brokers/submissionEvidence";

export type EntryAdmissionResult = { status: "AUTHORIZED"; intentId: string; reservationId: string; orderIds: string[]; requiredRiskMinor: number }
  | { status: "REJECTED"; intentId: string; reason: EntryRiskReason };
const plain = (doc: Document): Record<string, unknown> => doc.toObject();

/** Explicit PAPER admission only. All financial decisions happen in one Mongo
 * transaction. No broker instance, environment config, dispatcher or worker.
 */
export class RiskAdmissionService {
  private readonly scope: ExecutionScope;
  private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope);
    if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  private async save(doc: Document, session: ClientSession) {
    requireAggregateVersion(doc, this.scope, doc.get("version"));
    riskAssert(doc.get("version") < Number.MAX_SAFE_INTEGER, "RISK_ARITHMETIC_OVERFLOW");
    doc.set("updatedAt", this.clock()); await doc.save({ session });
  }
  private transition(intent: Document, to: "RISK_PENDING" | "RISK_RESERVED", reservationId?: string) {
    const result = transitionIntent(intent.get("state"), to, { reservationId });
    riskAssert(result.ok, "STALE_EXECUTION_CHAIN"); intent.set("state", result.value);
  }
  private async capacity(account: Document, session: ClientSession) {
    const projection = await loadAccountEntryProjection(this.connection, session, this.scope);
    assertAccountEntryProjection(plain(account), projection);
    return projection;
  }
  async authorizeEntry(input: string): Promise<EntryAdmissionResult> {
    const intentId = identifierSchema.parse(input);
    await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async (): Promise<EntryAdmissionResult> => {
        const account = await this.models.TradingAccount.findOne(this.scope).session(session);
        riskAssert(account && account.get("broker") === "PAPER" && account.get("admissionStatus") === "PAPER_READY", "ACCOUNT_NOT_READY");
        const intent = await this.models.OrderIntent.findOne({ ...this.scope, intentId }).session(session);
        riskAssert(intent, "INTENT_NOT_FOUND"); riskAssert(intent.get("purpose") === "ENTRY", "ENTRY_ONLY");
        const position = await this.models.Position.findOne({ ...this.scope, entryIntentId: intentId }).session(session);
        const signal = await this.models.StrategySignal.findOne({ ...this.scope, signalId: intent.get("signalId") }).session(session);
        riskAssert(position && signal && position.get("strategyInstanceId") === signal.get("strategyInstanceId")
          && position.get("sessionId") === signal.get("sessionId") && intent.get("closeGeneration") === 0, "STALE_EXECUTION_CHAIN");
        const requirement = calculateEntryRisk(intent.get("targetLegs"), intent.get("entryPlan"));
        const positionLegs = position.get("legs") as { legId: string; contractKey: string; entrySide: string; targetUnits: number }[];
        riskAssert(positionLegs.length === requirement.legs.length && requirement.legs.every(leg => positionLegs.some(p =>
          p.legId === leg.legId && p.contractKey === leg.contractKey && p.entrySide === leg.side && p.targetUnits === leg.quantityUnits)), "STALE_EXECUTION_CHAIN");
        const children = await this.models.BrokerOrder.find({ ...this.scope, intentId }).session(session);
        const existing = await this.models.RiskReservation.findOne({ ...this.scope, intentId }).session(session);
        if (existing) {
          const { admission } = verifyEntryReservation(plain(existing), plain(intent), position.get("positionId"));
          riskAssert(["RISK_RESERVED", "EXECUTING", "COMPLETED", "ABORTING", "ABORTED"].includes(intent.get("state")), "STALE_EXECUTION_CHAIN");
          riskAssert(children.length === requirement.legs.length && requirement.legs.every(leg => children.some(child =>
            child.get("legId") === leg.legId && child.get("positionId") === position.get("positionId") && child.get("contractKey") === leg.contractKey
            && child.get("side") === leg.side && child.get("quantityUnits") === leg.quantityUnits && child.get("limitPriceMinor") === leg.limitPriceMinor
            && child.get("generation") === admission.generation && child.get("sliceId") === "entry"
            && child.get("submissionAuthorization.reservationId") === existing.get("reservationId"))), "STALE_EXECUTION_CHAIN");
          for (const child of children) {
            const request = brokerOrderRequestSchema.parse({ ...this.scope, orderId: child.get("orderId"), claimId: "unclaimed", intentId,
              positionId: position.get("positionId"), legId: child.get("legId"), contractKey: child.get("contractKey"), side: child.get("side"),
              quantityUnits: child.get("quantityUnits"), orderType: "LIMIT", limitPriceMinor: child.get("limitPriceMinor"), product: requirement.product });
            riskAssert(child.get("requestFingerprint") === submissionFingerprint(request) && child.get("brokerNamespace") === "PAPER_SIM_V1"
              && child.get("submissionAuthorization.reservedQuantityUnits") === child.get("quantityUnits")
              && child.get("submissionAuthorization.policyVersion") === admission.policyVersion
              && child.get("submissionAuthorization.executionEpoch") === admission.executionEpoch
              && child.get("submissionAuthorization.product") === requirement.product
              && child.get("submissionAuthorization.expiresAt")?.getTime() === Math.min(requirement.expiresAt.getTime(), intent.get("deadline").getTime()), "STALE_EXECUTION_CHAIN");
          }
          await this.capacity(account, session);
          return { status: "AUTHORIZED", intentId, reservationId: existing.get("reservationId"),
            orderIds: children.map(child => String(child.get("orderId"))).sort(), requiredRiskMinor: requirement.requiredRiskMinor };
        }
        riskAssert(["CREATED", "RISK_PENDING"].includes(intent.get("state")) && !children.length
          && position.get("lifecycle") === "PENDING_ENTRY" && position.get("integrity") === "CONSISTENT"
          && position.get("activeCloseIntentId") === null, "STALE_EXECUTION_CHAIN");
        const now = this.clock(), expiresAt = new Date(Math.min(requirement.expiresAt.getTime(), intent.get("deadline").getTime()));
        riskAssert(expiresAt.getTime() > now.getTime() && signal.get("expiresAt").getTime() > now.getTime()
          && intent.get("policyVersion") === account.get("policyVersion"), "STALE_EXECUTION_CHAIN");
        const policy = entryRiskPolicySchema.safeParse(account.get("entryRiskPolicy"));
        riskAssert(policy.success && policy.data.policyVersion === account.get("policyVersion"), "RISK_POLICY_REQUIRED");
        const held = await this.capacity(account, session);
        riskAssert(requirement.requiredRiskMinor <= policy.data.maxRiskPerEntryMinor, "RISK_PER_TRADE_EXCEEDED");
        riskAssert(held.maxEntryUsage <= BigInt(policy.data.maxRiskPerEntryMinor), "RISK_PER_TRADE_EXCEEDED");
        const pending = held.pending + BigInt(requirement.requiredRiskMinor), total = pending + held.committed;
        const slots = held.reservedSlots + held.committedSlots + 1n;
        riskAssert(total <= BigInt(policy.data.maxReservedRiskMinor), "RISK_CAPACITY_EXCEEDED");
        riskAssert(slots <= BigInt(policy.data.maxPositionSlots), "POSITION_LIMIT_EXCEEDED");
        // This first CAS write serializes competing admissions before any authorization.
        account.set({ reservedExposureMinor: checkedRiskUnits(pending), reservedMarginMinor: checkedRiskUnits(pending), positionSlots: checkedRiskUnits(slots), committedPositionSlots: checkedRiskUnits(held.committedSlots) });
        await this.save(account, session);
        const reservationId = randomUUID(), base = { ...this.scope, schemaVersion: 1, correlationId: intent.get("correlationId"),
          createdAt: now, updatedAt: now, version: 0 };
        const reservation = new this.models.RiskReservation({ ...base, reservationId, intentId, kind: "ENTRY_RISK",
          strategyInstanceId: position.get("strategyInstanceId"), instrumentKeys: requirement.legs.map(leg => leg.contractKey), state: "HELD",
          initialMarginMinor: requirement.requiredRiskMinor, remainingMarginMinor: requirement.requiredRiskMinor,
          initialExposureMinor: requirement.requiredRiskMinor, remainingExposureMinor: requirement.requiredRiskMinor,
          positionSlots: 1, policyVersion: account.get("policyVersion"), entryAdmission: { positionId: position.get("positionId"),
            economicsFingerprint: requirement.fingerprint, generation: 0, executionEpoch: account.get("executionEpoch"), policyVersion: account.get("policyVersion") } });
        await reservation.save({ session });
        if (intent.get("state") === "CREATED") { this.transition(intent, "RISK_PENDING"); await this.save(intent, session); }
        this.transition(intent, "RISK_RESERVED", reservationId); await this.save(intent, session);
        const orderIds: string[] = [];
        for (const leg of requirement.legs) {
          const orderId = randomUUID();
          const request = brokerOrderRequestSchema.parse({ ...this.scope, orderId, intentId, positionId: position.get("positionId"), claimId: "unclaimed",
            legId: leg.legId, contractKey: leg.contractKey, side: leg.side, quantityUnits: leg.quantityUnits, orderType: "LIMIT", limitPriceMinor: leg.limitPriceMinor, product: requirement.product });
          const { claimId: _claim, orderType: _type, product: _product, ...economics } = request;
          await new this.models.BrokerOrder({ ...base, ...economics,
            sliceId: "entry", generation: 0, brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request),
            phase: "READY", knowledge: "KNOWN", cancellation: "NONE", filledUnits: 0, lastObservationVersion: 0,
            submissionAuthorization: { reservationId, evidenceRef: reservationId, product: requirement.product, reservedQuantityUnits: leg.quantityUnits,
              policyVersion: account.get("policyVersion"), executionEpoch: account.get("executionEpoch"), expiresAt } }).save({ session });
          orderIds.push(orderId);
        }
        position.set("potentiallyExecutingOrderCount", orderIds.length); await this.save(position, session);
        const sequencer = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
        const sequence = sequencer.get("nextEventSequence");
        riskAssert(Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number.MAX_SAFE_INTEGER, "RISK_ARITHMETIC_OVERFLOW");
        sequencer.set("nextEventSequence", sequence + 1); await this.save(sequencer, session);
        await new this.models.TradingEvent({ ...this.scope, schemaVersion: 1, correlationId: intent.get("correlationId"), createdAt: now,
          eventId: `${reservationId}:RISK_RESERVED`, eventType: "RISK_RESERVED", accountSequence: sequence, tradingDate: now.toISOString().slice(0, 10),
          aggregateType: "OrderIntent", aggregateId: intentId, aggregateVersion: intent.get("version"), causationId: intentId,
          actor: "RiskAdmissionService", occurredAt: now, recordedAt: now, reason: "BUY_OPTION_PREMIUM_RESERVED",
          evidenceRefs: [reservationId, ...requirement.legs.map(leg => leg.qualificationRef)],
          payload: { kind: "RISK", reservationId, marginMinor: requirement.requiredRiskMinor, exposureMinor: requirement.requiredRiskMinor } }).save({ session });
        return { status: "AUTHORIZED", intentId, reservationId, orderIds: orderIds.sort(), requiredRiskMinor: requirement.requiredRiskMinor };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (error) {
      if (error instanceof EntryRiskError) return { status: "REJECTED", intentId, reason: error.reason };
      throw error; // Persistence failures abort; never disguise them as a successful risk decision.
    } finally { await session.endSession(); }
  }
}
