import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { successfulClose, verifyCloseLedger } from "../domain/closeWorkflowEvidence";
import { calculateEntryRisk } from "../domain/entryRisk";

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
