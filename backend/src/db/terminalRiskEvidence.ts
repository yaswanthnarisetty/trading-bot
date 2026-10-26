import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { successfulClose, verifyCloseLedger } from "../domain/closeWorkflowEvidence";
import { calculateEntryRisk } from "../domain/entryRisk";

/** A never-claimed PAPER entry has no broker submission path once its immutable
 * market/authorization deadline has passed. Prove that from the whole owned
 * chain and Fill ledger before releasing its reserved capacity. */
export async function noSubmissionRiskProof(connection: Connection, session: ClientSession, scope: ExecutionScope,
  position: Record<string, any>, intent: Record<string, any>, now: Date,
  snapshot?: { orders: Record<string, any>[]; fills: Record<string, any>[]; intents: Record<string, any>[] }) {
  if (position.accountId !== scope.accountId || position.executionMode !== scope.executionMode
    || position.lifecycle !== "ABORTED" || position.integrity !== "CONSISTENT"
    || position.activeCloseIntentId !== null || position.potentiallyExecutingOrderCount !== 0
    || intent.accountId !== scope.accountId || intent.executionMode !== scope.executionMode
    || intent.intentId !== position.entryIntentId || intent.purpose !== "ENTRY" || intent.state !== "ABORTED"
    || !(intent.entryPlan?.marketEvidenceExpiresAt instanceof Date)
    || Math.min(+intent.entryPlan.marketEvidenceExpiresAt, +intent.deadline) >= +now)
    throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
  const db = connection.db!;
  const orders = snapshot ? snapshot.orders.filter(row => row.positionId === position.positionId)
    : await db.collection("execution_orders").find({ ...scope, positionId: position.positionId }, { session }).toArray();
  const fills = snapshot ? snapshot.fills.filter(row => row.positionId === position.positionId)
    : await db.collection("execution_fills").find({ ...scope, positionId: position.positionId }, { session }).toArray();
  const otherIntents = snapshot ? snapshot.intents.filter(row => row.positionId === position.positionId)
    : await db.collection("execution_intents").find({ ...scope, positionId: position.positionId }, { session }).toArray();
  const required = calculateEntryRisk(intent.targetLegs, intent.entryPlan);
  if (fills.length || otherIntents.length || !orders.length || orders.length !== required.legs.length
    || !required.legs.every(leg => orders.some(order => order.intentId === intent.intentId
      && order.legId === leg.legId && order.contractKey === leg.contractKey && order.side === leg.side
      && order.quantityUnits === leg.quantityUnits && order.sliceId === "entry" && order.generation === 0))
    || orders.some(order => order.phase !== "NOT_SENT" || order.knowledge !== "KNOWN" || order.cancellation !== "NONE"
      || order.filledUnits !== 0 || order.submissionClaim || order.submissionOutcome || order.brokerOrderId)
    || position.legs.some((leg: Record<string, any>) => leg.entryFilledUnits !== 0 || leg.exitFilledUnits !== 0)
    || JSON.stringify([...position.closureEvidenceRefs].sort()) !== JSON.stringify(orders.map(order => String(order.orderId)).sort()))
    throw new Error("NO_SUBMISSION_RISK_PROOF_REQUIRED");
  return { abortIntentId: String(intent.intentId), evidenceRefs: orders.map(order => String(order.orderId)).sort() };
}

/** Reuses 2B5's complete ownership/finality proof, without resolving knowledge. */
export async function terminalRiskProof(connection: Connection, session: ClientSession, scope: ExecutionScope, position: Record<string, any>) {
  const db = connection.db!;
  if (position.accountId !== scope.accountId || position.executionMode !== scope.executionMode || position.lifecycle !== "CLOSED"
    || position.activeCloseIntentId !== null || position.potentiallyExecutingOrderCount !== 0) throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  const intents = await db.collection("execution_intents").find({ ...scope,
    $or: [{ intentId: position.entryIntentId }, { positionId: position.positionId }] }, { session }).toArray();
  const close = intents.find(i => i.purpose === "CLOSE" && i.closeGeneration === position.closeGeneration && i.state === "COMPLETED");
  const entry = intents.find(i => i.intentId === position.entryIntentId);
  if (!entry || !close || intents.some(i => i.purpose === "RECOVERY" && !["COMPLETED", "ABORTED", "BLOCKED"].includes(i.state)))
    throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  const orders = await db.collection("execution_orders").find({ ...scope,
    $or: [{ positionId: position.positionId }, { intentId: { $in: intents.map(i => i.intentId) } }] }, { session }).toArray();
  const fills = await db.collection("execution_fills").find({ ...scope,
    $or: [{ positionId: position.positionId }, { orderId: { $in: orders.map(o => o.orderId) } }] }, { session }).toArray();
  verifyCloseLedger(position, orders, fills, intents);
  if (JSON.stringify([...position.closureEvidenceRefs].sort()) !== JSON.stringify(fills.map(f => String(f.fillId)).sort()))
    throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  const required = calculateEntryRisk(entry.targetLegs, entry.entryPlan);
  if (!required.legs.every(leg => orders.filter(o => o.intentId === entry.intentId && o.legId === leg.legId
    && o.quantityUnits === leg.quantityUnits && o.sliceId === "entry" && o.generation === 0).length === 1)
    || orders.some(o => o.knowledge !== "KNOWN")
    || !successfulClose({ ...position, activeCloseIntentId: close.intentId }, close, orders, fills)) throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  const hold = await db.collection("execution_reservations").findOne({ ...scope, intentId: close.intentId, kind: "CLOSE_QUANTITY", state: "CONSUMED" }, { session });
  if (!hold || ["remainingMarginMinor", "remainingExposureMinor", "positionSlots"].some(key => hold[key] !== 0)) throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  for (const [id, type, aggregateId] of [[`${position.positionId}:POSITION_CLOSED`, "POSITION_CLOSED", position.positionId],
    [`${close.intentId}:INTENT_COMPLETED`, "INTENT_COMPLETED", close.intentId], [`${hold.reservationId}:RESERVATION_CONSUMED`, "RESERVATION_CONSUMED", hold.reservationId]]) {
    if (!await db.collection("execution_events").findOne({ ...scope, eventId: id, eventType: type, aggregateId }, { session })) throw new Error("TERMINAL_RISK_PROOF_REQUIRED");
  }
  return { closeIntentId: String(close.intentId), evidenceRefs: fills.map(f => String(f.fillId)).sort() };
}
