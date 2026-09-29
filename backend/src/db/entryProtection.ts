import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { verifyEntryRiskLedger } from "./entryRiskProjection";
import { closeOrderFinality } from "../domain/closeWorkflowEvidence";
type Row = Record<string, any>;
/** Fixed physical SELL children cannot be resized. Require their entire legal lot
 * quantity, immutable BUY fills, and no ambiguity. Called again at initial claim;
 * post-dispatch truth deliberately does not revisit this admission condition.
 */
export async function assertEntrySellProtection(connection: Connection, session: ClientSession, scope: ExecutionScope,
  order: Row, intent: Row, position: Row, reservation: Row) {
  const verified = await verifyEntryRiskLedger(connection, session, scope, reservation, intent, position);
  if (!verified.requirement.family || verified.requirement.family === "LONG_OPTION" || order.side !== "SELL"
    || position.integrity !== "CONSISTENT" || position.activeCloseIntentId !== null
    || !["PENDING_ENTRY", "PARTIALLY_OPENED", "OPEN"].includes(position.lifecycle)) throw new Error("ENTRY_PROTECTION_REQUIRED");
  const buy = verified.requirement.legs.find(l => l.side === "BUY")!;
  const orders = await connection.db!.collection("execution_orders").find({ ...scope, intentId: intent.intentId }, { session }).toArray();
  const protection = orders.filter(o => o.legId === buy.legId);
  const leg = position.legs.find((l: Row) => l.legId === buy.legId);
  const alreadyDispatched = orders.filter(o => o.side === "SELL" && o.orderId !== order.orderId && o.submissionClaim)
    .reduce((n, o) => n + BigInt(o.quantityUnits), 0n);
  if (protection.length !== 1 || protection[0]!.knowledge === "UNKNOWN"
    || closeOrderFinality(protection[0]!, verified.fills) === "UNRESOLVED"
    || !leg || leg.exitFilledUnits !== 0 || leg.closeHeldUnits !== 0
    || BigInt(leg.entryFilledUnits) - alreadyDispatched < BigInt(order.quantityUnits)) throw new Error("INSUFFICIENT_CONFIRMED_BUY_PROTECTION");
  return verified.fills.filter(f => f.legId === buy.legId).map(f => String(f.fillId));
}
