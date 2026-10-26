import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { checkedRiskUnits, entryProjectionFromFills, riskAssert, verifyEntryReservation } from "../domain/entryRisk";
import { noSubmissionRiskProof, terminalRiskProof } from "./terminalRiskEvidence";
import { positionEconomicsSchema } from "../domain/financialInvariants";

type Row = Record<string, any>;
export interface AccountEntryProjection {
  pending: bigint; committed: bigint; reservedSlots: bigint; committedSlots: bigint; maxEntryUsage: bigint;
}
export function assertAccountEntryProjection(account: Row, projection: AccountEntryProjection) {
  riskAssert(account.reservedExposureMinor === checkedRiskUnits(projection.pending)
    && account.reservedMarginMinor === checkedRiskUnits(projection.pending)
    && account.committedExposureMinor === checkedRiskUnits(projection.committed)
    && account.positionSlots === checkedRiskUnits(projection.reservedSlots + projection.committedSlots)
    && (account.committedPositionSlots === undefined ? 0 : account.committedPositionSlots) === checkedRiskUnits(projection.committedSlots), "RISK_PROJECTION_MISMATCH");
}

/** Read-only evidence proof; never admits, repairs, releases or applies policy limits.
 * May validate the incoming reservation after its Fill/order/Position writes in the
 * same transaction, before the account counter update. All writes share account CAS.
 */
export async function verifyEntryRiskLedger(connection: Connection, session: ClientSession, scope: ExecutionScope,
  reservation: Row, intent: Row, position: Row,
  snapshot?: { orders: Row[]; fills: Row[]; intents: Row[] }) {
  riskAssert(reservation.accountId === scope.accountId && reservation.executionMode === scope.executionMode
    && intent.accountId === scope.accountId && intent.executionMode === scope.executionMode
    && position.accountId === scope.accountId && position.executionMode === scope.executionMode
    && position.entryIntentId === intent.intentId && position.strategyInstanceId === reservation.strategyInstanceId, "STALE_EXECUTION_CHAIN");
  const verified = verifyEntryReservation(reservation, intent, position.positionId);
  const db = connection.db!;
  const fills = snapshot ? snapshot.fills.filter(row => row.intentId === intent.intentId)
    : await db.collection("execution_fills").find({ ...scope, intentId: intent.intentId }, { session }).toArray();
  const orders = snapshot ? snapshot.orders.filter(row => row.intentId === intent.intentId)
    : await db.collection("execution_orders").find({ ...scope, intentId: intent.intentId }, { session }).toArray();
  for (const fill of fills) {
    const order = orders.find(order => order.orderId === fill.orderId);
    const leg = verified.requirement.legs.find(leg => leg.legId === fill.legId);
    riskAssert(order && leg && fill.positionId === position.positionId && fill.broker === "PAPER"
      && order.positionId === position.positionId && order.legId === leg.legId && order.contractKey === leg.contractKey
      && order.side === leg.side && order.quantityUnits === leg.quantityUnits && order.limitPriceMinor === leg.limitPriceMinor
      && order.generation === verified.admission.generation && order.sliceId === "entry"
      && order.submissionClaim && order.submissionAuthorization?.reservationId === reservation.reservationId
      && fill.brokerNamespace === order.brokerNamespace && fill.brokerOrderId === order.brokerOrderId, "STALE_EXECUTION_CHAIN");
  }
  const actual = entryProjectionFromFills(verified.requirement, intent.intentId, fills);
  riskAssert(JSON.stringify(actual) === JSON.stringify(verified.projection), "RISK_PROJECTION_MISMATCH");
  const validPosition = positionEconomicsSchema.safeParse(position);
  riskAssert(validPosition.success, "RISK_PROJECTION_MISMATCH");
  for (const leg of actual.progress) {
    const posLeg = position.legs.find((p: Row) => p.legId === leg.legId);
    riskAssert(posLeg && posLeg.entryFilledUnits === leg.transferredUnits
      && (posLeg.entryNotionalMinor === undefined ? leg.transferredUnits === 0 : posLeg.entryNotionalMinor === leg.committedMinor), "RISK_PROJECTION_MISMATCH");
  }
  if (reservation.state === "RELEASED") {
    if (reservation.entrySettlement.abortIntentId) {
      const proof = await noSubmissionRiskProof(connection, session, scope, position, intent,
        new Date(reservation.entrySettlement.settledAt), snapshot);
      riskAssert(reservation.entrySettlement.abortIntentId === proof.abortIntentId, "RISK_PROJECTION_MISMATCH");
    } else {
      const proof = await terminalRiskProof(connection, session, scope, position);
      riskAssert(reservation.entrySettlement.closeIntentId === proof.closeIntentId, "RISK_PROJECTION_MISMATCH");
    }
  }
  return { ...verified, fills };
}

/** Supported ledger only. Unknown legacy overlap and unexplained drift fail closed. */
export async function loadAccountEntryProjection(connection: Connection, session: ClientSession, scope: ExecutionScope,
  pendingSettlementEventId?: string): Promise<AccountEntryProjection> {
  const db = connection.db!;
  const reservations = await db.collection("execution_reservations").find(scope, { session }).toArray();
  const positions = await db.collection("execution_positions").find(scope, { session }).toArray();
  const relevant = reservations.filter(row => row.kind === "ENTRY_RISK");
  const ownedPositions = positions.filter(position => relevant.some(row => row.intentId === position.entryIntentId));
  const positionIds = ownedPositions.map(position => position.positionId);
  const intentIds = relevant.map(row => row.intentId);
  // One snapshot-scoped read per collection avoids replaying the same remote
  // ledger round trips for every settled historical PAPER candidate.
  const intents = intentIds.length ? await db.collection("execution_intents").find({ ...scope,
    $or: [{ intentId: { $in: intentIds } }, { positionId: { $in: positionIds } }] }, { session }).toArray() : [];
  const ownedRows = [{ positionId: { $in: positionIds } }, { intentId: { $in: intentIds } }];
  const orders = intentIds.length ? await db.collection("execution_orders").find({ ...scope,
    $or: ownedRows }, { session }).toArray() : [];
  const fills = intentIds.length ? await db.collection("execution_fills").find({ ...scope,
    $or: ownedRows }, { session }).toArray() : [];
  const snapshot = { intents, orders, fills };
  const settlements = relevant.some(row => row.state === "RELEASED")
    ? await db.collection("execution_events").find({ ...scope, eventType: "ENTRY_RISK_SETTLED",
      eventId: { $in: relevant.filter(row => row.state === "RELEASED").map(row => row.entrySettlement?.eventId) } }, { session }).toArray() : [];
  const held = new Set<string>();
  const result: AccountEntryProjection = { pending: 0n, committed: 0n, reservedSlots: 0n, committedSlots: 0n, maxEntryUsage: 0n };
  for (const reservation of reservations) {
    if (reservation.kind === "CLOSE_QUANTITY") continue;
    riskAssert(reservation.kind === "ENTRY_RISK", "UNSUPPORTED_ACCOUNT_EXPOSURE");
    const intent = intents.find(row => row.intentId === reservation.intentId);
    const position = positions.find(p => p.entryIntentId === reservation.intentId);
    riskAssert(intent && position, "RISK_PROJECTION_MISMATCH");
    const { projection } = await verifyEntryRiskLedger(connection, session, scope, reservation, intent, position, snapshot);
    held.add(intent.intentId);
    if (reservation.state === "RELEASED") {
      const eventId = reservation.entrySettlement.eventId;
      // The settlement audit validates its final transaction state just before its
      // own insert. Every subsequent capacity reader requires the published event.
      if (eventId !== pendingSettlementEventId) riskAssert(settlements.some(event => event.eventId === eventId
        && event.aggregateId === reservation.reservationId), "RISK_PROJECTION_MISMATCH");
      continue;
    }
    result.pending += BigInt(projection.pendingMinor); result.committed += BigInt(projection.committedMinor);
    result.reservedSlots += BigInt(projection.reservedSlots); result.committedSlots += BigInt(projection.committedSlots);
    const usage = BigInt(projection.pendingMinor) + BigInt(projection.committedMinor);
    if (usage > result.maxEntryUsage) result.maxEntryUsage = usage;
    held.add(intent.intentId);
  }
  const unreserved: Row[] = [];
  for (const position of positions) {
    riskAssert(positionEconomicsSchema.safeParse(position).success, "RISK_PROJECTION_MISMATCH");
    if (held.has(position.entryIntentId)) continue;
    riskAssert(position.lifecycle === "PENDING_ENTRY", "UNSUPPORTED_ACCOUNT_EXPOSURE");
    unreserved.push(position);
  }
  if (unreserved.length) {
    // Historical zero-fill rejected candidates must not add two remote reads per
    // position to every later admission. One snapshot-scoped lookup preserves
    // the same fail-closed proof for the whole unreserved set.
    const positionId = { $in: unreserved.map(position => position.positionId) };
    const fills = await db.collection("execution_fills").findOne({ ...scope, positionId }, { session });
    const orders = await db.collection("execution_orders").findOne({ ...scope, positionId,
      $or: [{ phase: { $nin: ["PLANNED", "NOT_SENT"] } }, { submissionClaim: { $exists: true } }, { knowledge: { $ne: "KNOWN" } }] }, { session });
    riskAssert(!fills && !orders, "UNSUPPORTED_ACCOUNT_EXPOSURE");
  }
  return result;
}
