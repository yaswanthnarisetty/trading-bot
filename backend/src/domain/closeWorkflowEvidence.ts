import { executionScopeSchema } from "@trading-bot/shared";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { validateSubmissionEvidence } from "../brokers/submissionEvidence";
import { orderEconomicsSchema, positionEconomicsSchema } from "./financialInvariants";
import { fillAccounting, type AccountingFill } from "./fillAccounting";
import { z } from "zod";

export type LedgerRecord = Record<string, unknown>;
export const recordRows = (record: LedgerRecord, key: string): LedgerRecord[] => z.array(z.record(z.unknown())).parse(record[key]);
export const recordUnits = (record: LedgerRecord, key: string): number => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(record[key]);
const same = (a: unknown, b: unknown) => { if (a !== b) throw new Error("CLOSE_EVIDENCE_OWNERSHIP_MISMATCH"); };
const ids = (items: unknown) => z.array(z.string().min(1)).parse(items).sort();

/** Read-only proof over persisted ledger records; no broker calls or state mutation. */
export function verifyCloseLedger(position: LedgerRecord, orders: LedgerRecord[], fills: LedgerRecord[], intents: LedgerRecord[]) {
  positionEconomicsSchema.parse(position);
  executionScopeSchema.parse({ accountId: position.accountId, executionMode: position.executionMode });
  const legs = recordRows(position, "legs"), entry = intents.find(intent => intent.intentId === position.entryIntentId);
  if (!entry || entry.purpose !== "ENTRY") throw new Error("CLOSE_EVIDENCE_OWNERSHIP_MISMATCH");
  for (const intent of intents) {
    same(intent.accountId, position.accountId); same(intent.executionMode, position.executionMode);
    if (intent.purpose !== "ENTRY") same(intent.positionId, position.positionId);
  }
  for (const order of orders) {
    orderEconomicsSchema.parse(order);
    for (const key of ["accountId", "executionMode", "positionId"]) same(order[key], position[key]);
    const intent = intents.find(item => item.intentId === order.intentId);
    const leg = legs.find(item => item.legId === order.legId);
    const target = intent && recordRows(intent, "targetLegs").find(item => item.legId === order.legId);
    if (!intent || !leg || !target) throw new Error("CLOSE_EVIDENCE_OWNERSHIP_MISMATCH");
    if (intent.purpose === "ENTRY") same(intent.intentId, position.entryIntentId);
    same(order.contractKey, leg.contractKey); same(target.contractKey, leg.contractKey); same(target.side, order.side);
    same(order.side, intent.purpose === "ENTRY" ? leg.entrySide : leg.entrySide === "BUY" ? "SELL" : "BUY");
    if (recordUnits(order, "quantityUnits") > recordUnits(target, "targetUnits")) throw new Error("CLOSE_EVIDENCE_QUANTITY_MISMATCH");
    verifyOrderFills(order, fills);
  }
  for (const fill of fills) if (!orders.some(order => order.orderId === fill.orderId)) throw new Error("CLOSE_EVIDENCE_OWNERSHIP_MISMATCH");
  same(JSON.stringify(ids(position.executionEvidenceRefs)), JSON.stringify(fills.map(fill => String(fill.fillId)).sort()));
  for (const leg of legs) {
    const own = fills.filter(fill => fill.legId === leg.legId);
    const entryUnits = own.filter(fill => fill.intentId === position.entryIntentId).reduce((n, fill) => n + BigInt(recordUnits(fill, "quantityUnits")), 0n);
    const exitUnits = own.filter(fill => fill.intentId !== position.entryIntentId).reduce((n, fill) => n + BigInt(recordUnits(fill, "quantityUnits")), 0n);
    same(entryUnits, BigInt(recordUnits(leg, "entryFilledUnits"))); same(exitUnits, BigInt(recordUnits(leg, "exitFilledUnits")));
    const accounting = fillAccounting(own as unknown as AccountingFill[], String(position.entryIntentId));
    if (leg.netQuantityUnits !== undefined) same(leg.netQuantityUnits, accounting.netQuantityUnits);
    if (leg.entryNotionalMinor !== undefined) same(leg.entryNotionalMinor, accounting.entryNotionalMinor);
  }
}

export function verifyOrderFills(order: LedgerRecord, fills: LedgerRecord[]) {
  const own = fills.filter(fill => fill.orderId === order.orderId);
  for (const fill of own) {
    for (const key of ["accountId", "executionMode", "positionId", "intentId", "legId", "contractKey", "side", "brokerNamespace", "brokerOrderId"])
      same(fill[key], order[key]);
  }
  same(own.reduce((n, fill) => n + BigInt(recordUnits(fill, "quantityUnits")), 0n), BigInt(recordUnits(order, "filledUnits")));
  same(JSON.stringify(ids(order.executionEvidenceRefs)), JSON.stringify(own.map(fill => String(fill.fillId)).sort()));
  return own;
}

export type OrderFinality = "FINAL" | "INCORPORATED_FULL_FILL" | "UNRESOLVED";
export function closeOrderFinality(order: LedgerRecord, fills: LedgerRecord[]): OrderFinality {
  orderEconomicsSchema.parse(order);
  const own = verifyOrderFills(order, fills);
  if (order.knowledge === "UNKNOWN" || order.cancellation === "UNKNOWN") return "UNRESOLVED";
  const full = order.phase === "FILLED" && recordUnits(order, "filledUnits") === recordUnits(order, "quantityUnits");
  if (order.phase === "NOT_SENT" && order.knowledge === "KNOWN" && !order.submissionClaim && !order.submissionOutcome
    && !order.brokerOrderId && recordUnits(order, "filledUnits") === 0) return "FINAL";
  if (!order.submissionClaim || !order.submissionOutcome) return "UNRESOLVED";
  const claim = z.record(z.unknown()).parse(order.submissionClaim);
  const request = brokerOrderRequestSchema.parse(claim.request);
  for (const key of ["accountId", "executionMode", "orderId", "intentId", "positionId", "legId", "contractKey", "side", "quantityUnits", "limitPriceMinor"] as const)
    same(request[key], order[key]);
  const evidence = validateSubmissionEvidence(request, order.submissionOutcome);
  if (!evidence.evidenceComplete) return "UNRESOLVED";
  const observed = evidence.observedOrder;
  if (observed) same(observed.brokerOrderId, order.brokerOrderId);
  const incorporated = evidence.trades.every(trade => own.some(fill => fill.brokerTradeKey === trade.brokerTradeKey
    && fill.quantityUnits === trade.quantityUnits && fill.priceMinor === trade.priceMinor));
  // Consume only the successful accepted-fill handoff. Never resolve ambiguous submission,
  // incomplete receipts, late fills after cancellation/rejection, or UNKNOWN knowledge.
  if (full && evidence.outcome.kind === "ACCEPTED" && observed && observed.state !== "CANCELLED" && incorporated) {
    if (order.knowledge === "KNOWN") return "FINAL";
    if (order.knowledge === "RECONCILIATION_REQUIRED" && evidence.pendingFillProcessing) return "INCORPORATED_FULL_FILL";
  }
  if (order.knowledge !== "KNOWN") return "UNRESOLVED";
  if (order.phase === "REJECTED" && evidence.outcome.kind === "REJECTED" && own.length === 0 && !order.brokerOrderId) return "FINAL";
  if (order.phase === "CANCELLED" && order.cancellation === "CONFIRMED" && observed?.state === "CANCELLED"
    && observed.cancellation === "CONFIRMED" && observed.filledUnits === recordUnits(order, "filledUnits") && incorporated) return "FINAL";
  return "UNRESOLVED";
}

export function dependenciesAreSafe(position: LedgerRecord, dependencies: readonly string[], orders: LedgerRecord[], fills: LedgerRecord[]): boolean {
  if (position.integrity !== "CONSISTENT") return false;
  for (const legId of dependencies) {
    const leg = recordRows(position, "legs").find(item => item.legId === legId);
    if (!leg || leg.entrySide !== "SELL") throw new Error("CLOSE_DEPENDENCY_OWNERSHIP_MISMATCH");
    if (recordUnits(leg, "entryFilledUnits") !== recordUnits(leg, "exitFilledUnits")) return false;
    if (fillAccounting(fills.filter(fill => fill.legId === legId) as unknown as AccountingFill[], String(position.entryIntentId)).netQuantityUnits !== 0) return false;
    if (orders.filter(order => order.legId === legId).some(order => closeOrderFinality(order, fills) !== "FINAL")) return false;
  }
  return true;
}

export function successfulClose(position: LedgerRecord, intent: LedgerRecord, orders: LedgerRecord[], fills: LedgerRecord[]): boolean {
  if (position.integrity !== "CONSISTENT" || intent.purpose !== "CLOSE" || position.activeCloseIntentId !== intent.intentId
    || position.closeGeneration !== intent.closeGeneration) return false;
  if (recordRows(position, "legs").some(leg => recordUnits(leg, "entryFilledUnits") !== recordUnits(leg, "exitFilledUnits") || recordUnits(leg, "closeHeldUnits") !== 0)) return false;
  if (orders.some(order => closeOrderFinality(order, fills) !== "FINAL")) return false;
  const children = orders.filter(order => order.intentId === intent.intentId);
  if (!children.length || children.some(order => order.phase !== "FILLED")) return false;
  return recordRows(intent, "targetLegs").every(target => fills.filter(fill => fill.intentId === intent.intentId && fill.legId === target.legId)
    .reduce((n, fill) => n + BigInt(recordUnits(fill, "quantityUnits")), 0n) === BigInt(recordUnits(target, "targetUnits")));
}
