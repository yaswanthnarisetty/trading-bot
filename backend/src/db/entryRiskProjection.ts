import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { checkedRiskUnits, entryProjectionFromFills, riskAssert, verifyEntryReservation } from "../domain/entryRisk";
import { terminalRiskProof } from "./terminalRiskEvidence";
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
  reservation: Row, intent: Row, position: Row) {
  riskAssert(reservation.accountId === scope.accountId && reservation.executionMode === scope.executionMode
    && intent.accountId === scope.accountId && intent.executionMode === scope.executionMode
    && position.accountId === scope.accountId && position.executionMode === scope.executionMode
    && position.entryIntentId === intent.intentId && position.strategyInstanceId === reservation.strategyInstanceId, "STALE_EXECUTION_CHAIN");
  const verified = verifyEntryReservation(reservation, intent, position.positionId);
  const db = connection.db!;
  const fills = await db.collection("execution_fills").find({ ...scope, intentId: intent.intentId }, { session }).toArray();
  const orders = await db.collection("execution_orders").find({ ...scope, intentId: intent.intentId }, { session }).toArray();
  for (const fill of fills) {
    const order = orders.find(order => order.orderId === fill.orderId);
    const leg = verified.requirement.legs.find(leg => leg.legId === fill.legId);
    riskAssert(order && leg && fill.positionId === position.positionId && fill.broker === "PAPER"
      && order.positionId === position.positionId && order.legId === leg.legId && order.contractKey === leg.contractKey
      && order.side === "BUY" && order.quantityUnits === leg.quantityUnits && order.limitPriceMinor === leg.limitPriceMinor
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
    const proof = await terminalRiskProof(connection, session, scope, position);
    riskAssert(reservation.entrySettlement.closeIntentId === proof.closeIntentId, "RISK_PROJECTION_MISMATCH");
  }
  return { ...verified, fills };
}

/** Supported ledger only. Unknown legacy overlap and unexplained drift fail closed. */
export async function loadAccountEntryProjection(connection: Connection, session: ClientSession, scope: ExecutionScope,
  pendingSettlementEventId?: string): Promise<AccountEntryProjection> {
  const db = connection.db!;
  const reservations = await db.collection("execution_reservations").find(scope, { session }).toArray();
  const positions = await db.collection("execution_positions").find(scope, { session }).toArray();
  const held = new Set<string>();
  const result: AccountEntryProjection = { pending: 0n, committed: 0n, reservedSlots: 0n, committedSlots: 0n, maxEntryUsage: 0n };
  for (const reservation of reservations) {
    if (reservation.kind === "CLOSE_QUANTITY") continue;
    riskAssert(reservation.kind === "ENTRY_RISK", "UNSUPPORTED_ACCOUNT_EXPOSURE");
    const intent = await db.collection("execution_intents").findOne({ ...scope, intentId: reservation.intentId }, { session });
    const position = positions.find(p => p.entryIntentId === reservation.intentId);
    riskAssert(intent && position, "RISK_PROJECTION_MISMATCH");
    const { projection } = await verifyEntryRiskLedger(connection, session, scope, reservation, intent, position);
    held.add(intent.intentId);
    if (reservation.state === "RELEASED") {
      const eventId = reservation.entrySettlement.eventId;
      // The settlement audit validates its final transaction state just before its
      // own insert. Every subsequent capacity reader requires the published event.
      if (eventId !== pendingSettlementEventId) riskAssert(await db.collection("execution_events").findOne({ ...scope,
        eventId, eventType: "ENTRY_RISK_SETTLED", aggregateId: reservation.reservationId }, { session }), "RISK_PROJECTION_MISMATCH");
      continue;
    }
    result.pending += BigInt(projection.pendingMinor); result.committed += BigInt(projection.committedMinor);
    result.reservedSlots += BigInt(projection.reservedSlots); result.committedSlots += BigInt(projection.committedSlots);
    const usage = BigInt(projection.pendingMinor) + BigInt(projection.committedMinor);
    if (usage > result.maxEntryUsage) result.maxEntryUsage = usage;
    held.add(intent.intentId);
  }
  for (const position of positions) {
    riskAssert(positionEconomicsSchema.safeParse(position).success, "RISK_PROJECTION_MISMATCH");
    if (held.has(position.entryIntentId)) continue;
    const fills = await db.collection("execution_fills").countDocuments({ ...scope, positionId: position.positionId }, { session });
    const orders = await db.collection("execution_orders").countDocuments({ ...scope, positionId: position.positionId,
      $or: [{ phase: { $nin: ["PLANNED", "NOT_SENT"] } }, { submissionClaim: { $exists: true } }, { knowledge: { $ne: "KNOWN" } }] }, { session });
    riskAssert(!fills && !orders && position.lifecycle === "PENDING_ENTRY", "UNSUPPORTED_ACCOUNT_EXPOSURE");
  }
  return result;
}
