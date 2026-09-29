import { createHash } from "node:crypto";
import type { Connection } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { assertIssuedTradeCandidate, candidateMarketEvidenceExpiry, type TradeCandidate } from "../domain/strategyEvaluation";
import { assertQualifiedInstrument } from "./KiteInstrumentMasterService";
import { calculateEntryRisk, classifiedEntryPlanSchema } from "../domain/entryRisk";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { withCandidateWrite } from "../db/candidateWrite";
import { riskAudit } from "./riskAudit";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Explicit authority boundary. Issued analytics candidates remain advisory; this
 * PAPER-only adapter persists unreserved economics, never admits or submits them.
 */
export function candidateEntryPlan(input: unknown, validUntil: Date, now: Date, entryCutoffAt?: Date) {
  assertIssuedTradeCandidate(input, now.getTime());
  const c: TradeCandidate = input;
  if (c.executionAuthority !== "NONE" || c.version !== "TRADE_CANDIDATE_V2" || c.evaluatorVersion !== "PHASE6A01_V1"
    || !Number.isFinite(now.getTime()) || now.getTime() < Date.parse(c.evaluatedAt) || validUntil.getTime() <= now.getTime()
    || validUntil.getTime() > Date.parse(c.evaluatedAt) + 60_000) throw new Error("STALE_CANDIDATE");
  const candidateRef = hash([c.candidateKey, c.evaluatedAt, c.analyticsEvidenceId, c.selectionConfig]);
  const legs = c.legs.map(l => {
    assertQualifiedInstrument(l.instrument); const i = l.instrument;
    if (l.canonicalId !== i.canonicalId || c.underlying !== i.underlying || c.expiry !== i.expiry
      || l.lotSizeUnits !== i.lotSizeUnits || l.quantityUnits !== c.quantityUnits
      || i.provenance.sourceFingerprint !== c.optionMasterFingerprint) throw new Error("CANDIDATE_IDENTITY_MISMATCH");
    return { legId: l.role.toLowerCase(), contractKey: i.contractKey, instrumentKind: "NSE_OPTION" as const,
      optionType: i.instrumentType === "CE" ? "CALL" as const : "PUT" as const, expiry: new Date(`${i.expiry}T10:00:00.000Z`),
      qualificationRef: i.canonicalId, lotSizeUnits: i.lotSizeUnits, tickSizeMinor: i.tickSizeMinor, limitPriceMinor: l.priceMinor,
      role: l.role, identity: { canonicalId: i.canonicalId, broker: i.broker, exchange: i.exchange, segment: i.segment,
        contractKey: i.contractKey, instrumentToken: i.instrumentToken, exchangeToken: i.exchangeToken, underlying: i.underlying,
        expiry: i.expiry, strikeMinor: i.strikeMinor, instrumentType: i.instrumentType, lotSizeUnits: i.lotSizeUnits,
        tickSizeMinor: i.tickSizeMinor, masterFingerprint: i.provenance.sourceFingerprint } };
  });
  const expiry = candidateMarketEvidenceExpiry(c);
  const plan = classifiedEntryPlanSchema.parse({ kind: "NSE_STRATEGY_LIMIT_V1", product: "INTRADAY", validUntil,
    marketEvidenceExpiresAt: expiry === null ? null : new Date(expiry), ...(entryCutoffAt ? { entryCutoffAt } : {}),
    family: c.strategyFamily, strategyKind: c.strategyKind, dataMode: c.dataMode, source: c.source, candidateRef,
    analyticsEvidenceId: c.analyticsEvidenceId, evaluatedAt: c.evaluatedAt, candidateVersion: c.version, evaluatorVersion: c.evaluatorVersion, legs });
  const targets = c.legs.map(l => ({ legId: l.role.toLowerCase(), contractKey: l.instrument.contractKey, side: l.side, targetUnits: l.quantityUnits }));
  return { plan, targets, requirement: calculateEntryRisk(targets, plan) };
}
export class CandidateIntentAdapter {
  private readonly scope: ExecutionScope;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope); if (this.scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
  }
  async adapt(candidate: unknown, context: { strategyInstanceId: string; sessionId: string; validUntil: Date; entryCutoffAt?: Date; orchestration?: { cycleId: string; sessionId: string; startupId: string } }) {
    const strategyInstanceId = identifierSchema.parse(context.strategyInstanceId), sessionId = identifierSchema.parse(context.sessionId);
    const now = this.clock(), { plan, targets, requirement } = candidateEntryPlan(candidate, context.validUntil, now, context.entryCutoffAt);
    // A changed quote/config within the same strategy decision must conflict, not
    // mint a second economic intent. Evidence remains in the immutable fingerprint.
    const key = hash([this.scope, strategyInstanceId, sessionId, plan.evaluatedAt]);
    const signalId = `signal:${key}`, intentId = `entry:${key}`, positionId = `position:${key}`;
    const models = executionModels(this.connection); await assertExecutionIndexes(this.connection);
    const session = await this.connection.startSession();
    try { return await session.withTransaction(async () => {
      const account = await models.TradingAccount.findOne(this.scope).session(session).orFail();
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      const existing = await models.OrderIntent.findOne({ ...this.scope, intentId }).session(session);
      if (existing) {
        if (calculateEntryRisk(existing.get("targetLegs"), existing.get("entryPlan")).fingerprint !== requirement.fingerprint)
          throw new Error("CANDIDATE_ADAPTATION_CONFLICT");
        await models.Position.findOne({ ...this.scope, positionId, entryIntentId: intentId }).session(session).orFail();
        return { signalId, intentId, positionId, replay: true };
      }
      const base = { ...this.scope, schemaVersion: 1, correlationId: key, createdAt: now }, mutable = { ...base, updatedAt: now, version: 0 };
      await new models.StrategySignal({ ...base, signalId, decisionKey: key, strategyInstanceId, sessionId,
        strategyVersion: plan.evaluatorVersion, decisionSlot: plan.evaluatedAt, strategy: plan.strategyKind,
        ...(context.orchestration ? { orchestration: context.orchestration } : {}),
        decisionEvidenceRefs: [plan.candidateRef, plan.analyticsEvidenceId, ...(context.orchestration ? [context.orchestration.cycleId] : [])], expiresAt: requirement.expiresAt }).save({ session });
      await withCandidateWrite(session, requirement.fingerprint, () => new models.OrderIntent({ ...mutable, intentId, commandKey: key,
        purpose: "ENTRY", signalId, state: "CREATED", targetLegs: targets, closeGeneration: 0, policyVersion: account.get("policyVersion"),
        deadline: requirement.expiresAt, entryPlan: plan }).save({ session }));
      await new models.Position({ ...mutable, positionId, entryIntentId: intentId, strategyInstanceId, sessionId,
        lifecycle: "PENDING_ENTRY", integrity: "CONSISTENT", activeCloseIntentId: null, closeGeneration: 0,
        legs: targets.map(l => ({ legId: l.legId, contractKey: l.contractKey, entrySide: l.side, targetUnits: l.targetUnits,
          entryFilledUnits: 0, exitFilledUnits: 0, closeHeldUnits: 0, realizedPnlMinor: 0 })),
        realizedPnlMinor: 0, potentiallyExecutingOrderCount: 0 }).save({ session });
      await riskAudit(models, this.scope, session, now, { eventId: `${intentId}:ADAPTED`, eventType: "INTENT_CREATED",
        causationId: signalId, reason: "ISSUED_CANDIDATE_ADAPTED", tradingDate: now.toISOString().slice(0, 10),
        evidenceRefs: [plan.candidateRef, plan.analyticsEvidenceId], payload: { kind: "REFERENCE", entityId: intentId } });
      return { signalId, intentId, positionId, replay: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
}
