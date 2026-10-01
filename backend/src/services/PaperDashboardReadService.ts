import type { Connection } from "mongoose";
import { executionModels } from "../db/executionModels";
import { classifiedEntryPlanSchema, entryRiskPolicySchema } from "../domain/entryRisk";
import { capturePaperConfig } from "../domain/paperOrchestration";
import { DEFAULT_LONG_SELECTION } from "../domain/strategyEvaluation";
import { paperHistoryModels } from "./PaperEntryOrchestrator";

type Row = Record<string, any>;
const text = (value: unknown) => typeof value === "string" ? value : null;
const integer = (value: unknown) => Number.isSafeInteger(value) ? value as number : null;
const iso = (value: unknown) => value instanceof Date && Number.isFinite(+value) ? value.toISOString() : text(value);

/** Presentation only. Entry cost is accumulated from actual immutable Fill rows. */
export function projectDurablePaperPosition(position: Row, entryPlan: unknown, fills: readonly Row[], exit: Row | null, orders: readonly Row[]) {
  const plan = classifiedEntryPlanSchema.safeParse(entryPlan);
  const entryFills = fills.filter(f => f.positionId === position.positionId && f.intentId === position.entryIntentId
    && f.accountId === position.accountId && f.executionMode === "PAPER" && f.broker === "PAPER");
  if (!entryFills.length) return null; // A zero-fill PENDING_ENTRY shell is never an open trade.
  const legs = (Array.isArray(position.legs) ? position.legs : []).filter((leg: Row) => leg.entryFilledUnits > 0).map((leg: Row) => {
    const actual = entryFills.filter(f => f.legId === leg.legId && f.contractKey === leg.contractKey && f.side === leg.entrySide);
    const quantity = actual.reduce((n, f) => n + BigInt(f.quantityUnits), 0n);
    const notional = actual.reduce((n, f) => n + BigInt(f.quantityUnits) * BigInt(f.priceMinor), 0n);
    const backed = quantity === BigInt(leg.entryFilledUnits) && quantity > 0n && notional <= BigInt(Number.MAX_SAFE_INTEGER);
    return { legId: leg.legId, contractKey: leg.contractKey, entrySide: leg.entrySide,
      filledUnits: leg.entryFilledUnits, exitFilledUnits: leg.exitFilledUnits,
      openUnits: Math.max(0, leg.entryFilledUnits - leg.exitFilledUnits),
      entryNotionalMinor: backed ? Number(notional) : null, entryPriceEvidence: backed ? "FILL_BACKED" : "UNAVAILABLE" };
  });
  const openedAt = entryFills.map(f => +new Date(f.executedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const closeFills = fills.filter(f => f.positionId === position.positionId && f.accountId === position.accountId
    && f.executionMode === "PAPER" && f.broker === "PAPER" && f.intentId !== position.entryIntentId);
  const unknown = orders.some(o => o.knowledge === "UNKNOWN");
  const stranded = plan.success && plan.data.family !== "LONG_OPTION"
    && legs.some(l => l.entrySide === "BUY" && l.openUnits > 0)
    && !legs.some(l => l.entrySide === "SELL" && l.filledUnits > 0);
  const closureProven = position.lifecycle === "CLOSED" && Array.isArray(position.closureEvidenceRefs)
    && position.closureEvidenceRefs.length > 0;
  const attention = !plan.success || !legs.length || legs.some(l => l.entryPriceEvidence !== "FILL_BACKED")
    || position.integrity !== "CONSISTENT" || unknown || stranded || ["ATTENTION", "BLOCKED"].includes(exit?.status)
    || position.lifecycle === "CLOSED" && !closureProven;
  return { positionId: position.positionId, sessionId: position.sessionId, accountId: position.accountId,
    family: plan.success ? plan.data.family : null, strategyKind: plan.success ? plan.data.strategyKind : null,
    underlying: plan.success ? plan.data.legs[0]?.identity.underlying ?? null : null,
    legs, lifecycle: closureProven ? "CLOSED" : position.lifecycle === "CLOSED" ? "ATTENTION" : position.lifecycle,
    integrity: position.integrity, openedAt: openedAt === undefined ? null : new Date(openedAt).toISOString(),
    closeState: closureProven ? "PROVEN_CLOSED" : position.lifecycle === "CLOSED" ? "ATTENTION"
      : position.activeCloseIntentId ? "CLOSING" : "NONE",
    closeIntentId: text(position.activeCloseIntentId), exitReason: text(exit?.triggerReason),
    exitMonitorStatus: text(exit?.status) ?? "WAITING", exitAttentionReason: text(exit?.reason),
    unknownOrder: unknown, stranded: Boolean(stranded || exit?.stranded), attention,
    realizedPnlMinor: closeFills.length ? integer(position.realizedPnlMinor) : null,
    estimatedUnrealizedPnlMinor: null };
}

export function projectPaperDecision(cycle: Row) {
  const evidence = cycle.decision && typeof cycle.decision === "object" ? cycle.decision as Row : {};
  const primary = evidence.primary?.status === "COMPLETED" ? evidence.primary.result : null;
  const verifier = evidence.verifier?.status === "COMPLETED" ? evidence.verifier.result : null;
  const family = cycle.config?.strategyConfig?.strategyFamily;
  return { cycleId: cycle.cycleId, evaluatedAt: iso(cycle.evaluatedAt) ?? iso(cycle.timestamp),
    direction: text(evidence.finalProposal?.direction) ?? "UNAVAILABLE",
    confidence: typeof evidence.finalProposal?.confidence === "number" ? evidence.finalProposal.confidence : null,
    outcome: text(cycle.outcome) ?? "UNAVAILABLE", candidate: evidence.strategyResult?.action === "CANDIDATE",
    family: ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"].includes(family) ? family : null,
    strategyKind: text(evidence.strategyResult?.candidate?.strategyKind),
    reason: text(cycle.reason) ?? text(evidence.reason),
    verifier: verifier ? { status: "COMPLETED", verdict: verifier.verdict, reasonCode: verifier.reasonCode }
      : { status: text(evidence.verifier?.status) ?? "NOT_RUN", verdict: null, reasonCode: text(evidence.verifier?.reason) },
    rationale: text(primary?.rationale), blockingReason: ["REJECTED", "ATTENTION", "ERROR", "HOLD"].includes(cycle.outcome)
      ? text(cycle.reason) : null };
}

export async function readPaperDashboard(connection: Connection, sessionId: string, exitMonitorActive: boolean,
  currentStartupId: string) {
  const models = executionModels(connection), history = paperHistoryModels(connection);
  const session = await history.Session.findOne({ sessionId, executionMode: "PAPER" }).lean() as Row | null;
  if (!session || !session.accountId) throw new Error("SESSION_NOT_FOUND");
  const accountId = session.accountId as string, scope = { accountId, executionMode: "PAPER" };
  const config = capturePaperConfig(session.config);
  const [account, positions, cycles, exits] = await Promise.all([
    models.TradingAccount.findOne(scope).lean() as Promise<Row | null>,
    models.Position.find(scope).sort({ createdAt: -1 }).limit(201).lean() as Promise<Row[]>,
    history.Cycle.find({ ...scope, sessionId }).sort({ timestamp: -1 }).limit(30).lean() as Promise<Row[]>,
    connection.db!.collection("paper_exit_states").find(scope, { projection: { leaseId: 0, config: 0 } }).limit(200).toArray() as Promise<Row[]>,
  ]);
  const positionsTruncated = positions.length > 200;
  const visiblePositions = positions.slice(0, 200);
  const ids = visiblePositions.map(p => p.positionId), intentIds = visiblePositions.map(p => p.entryIntentId);
  const [fills, intents, orders] = ids.length ? await Promise.all([
    models.Fill.find({ ...scope, positionId: { $in: ids } }).lean() as Promise<Row[]>,
    models.OrderIntent.find({ ...scope, intentId: { $in: intentIds }, purpose: "ENTRY" }).lean() as Promise<Row[]>,
    models.BrokerOrder.find({ ...scope, positionId: { $in: ids } }).lean() as Promise<Row[]>,
  ]) : [[], [], []] as Row[][];
  const byIntent = new Map(intents.map(i => [i.intentId, i]));
  const byExit = new Map(exits.map(e => [e.positionId, e]));
  const durablePositions = visiblePositions.map(p => projectDurablePaperPosition(p, byIntent.get(p.entryIntentId)?.entryPlan,
    fills, byExit.get(p.positionId) ?? null, orders.filter(o => o.positionId === p.positionId))).filter(p => p !== null);
  const policy = entryRiskPolicySchema.safeParse(account?.entryRiskPolicy);
  const pending = integer(account?.reservedExposureMinor), committed = integer(account?.committedExposureMinor);
  const cap = policy.success ? policy.data.maxReservedRiskMinor : null;
  const available = cap !== null && pending !== null && committed !== null
    ? BigInt(cap) - BigInt(pending) - BigInt(committed) : null;
  const totalSlots = integer(account?.positionSlots), committedSlots = integer(account?.committedPositionSlots);
  return { session: { sessionId, accountId, asset: session.asset, status: session.status,
      executionMode: "PAPER", dataMode: session.dataMode, strategyFamily: session.strategyFamily,
      intervalMs: config.intervalMs, lastCycleAt: iso(session.lastCycleAt), lastCycleOutcome: text(session.lastCycleOutcome),
      blockingReason: text(session.blockingReason), config: {
        configId: config.configId, minConfidence: config.strategyConfig.minConfidence,
        entryWindowStartMinuteIST: 555 + config.strategyConfig.openingBlockMinutes,
        entryCutoffMinuteIST: config.entryCutoffMinuteIST,
        longOptionSelection: config.strategyConfig.longOptionSelection ?? DEFAULT_LONG_SELECTION } },
    positions: durablePositions, positionsTruncated,
    decisions: cycles.map(projectPaperDecision),
    exits: { status: exitMonitorActive && !durablePositions.some(p => p.attention) ? "ACTIVE" : "ATTENTION",
      active: exitMonitorActive, closeInProgress: durablePositions.filter(p => p.closeState === "CLOSING").length,
      attentionCount: durablePositions.filter(p => p.attention).length },
    risk: account ? { pendingRiskMinor: pending, committedRiskMinor: committed, capacityMinor: cap,
      availableCapacityMinor: available !== null && available >= 0n && available <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(available) : null,
      reservedSlots: totalSlots !== null && committedSlots !== null ? totalSlots - committedSlots : null,
      committedSlots, maxPositionSlots: policy.success ? policy.data.maxPositionSlots : null,
      dailyTradingDay: text(account.dailyTradingDay), dailyRealizedPnlMinor: integer(account.dailyRealizedPnlMinor),
      killSwitchEnabled: account.killSwitchEnabled === true,
      recoveryStatus: account.recoveryState?.startupId === currentStartupId ? text(account.recoveryState.status) : "RECOVERY_REQUIRED",
      reconciliationStatus: text(account.reconciliationState?.classification) ?? "UNAVAILABLE" } : null };
}
