import type { ClientSession, Connection } from "mongoose";
interface WriteDocument {
  db: Connection; collection: { collectionName: string }; isNew: boolean;
  $session(): ClientSession | null; validate(): Promise<void>; toObject(): Record<string, unknown>;
}
import { z } from "zod";
import { executionScopeSchema } from "@trading-bot/shared";
import { requireExecutionTransaction } from "./executionReadiness";
import { assertExecutionIndexes } from "./executionIndexes";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { submissionFingerprint, validateSubmissionEvidence } from "../brokers/submissionEvidence";

type RecordData = Record<string, unknown>;
const text = (r: RecordData, key: string): string => z.string().trim().min(1).parse(r[key]);
const units = (r: RecordData, key: string): number => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(r[key]);
const rows = (r: RecordData, key: string): RecordData[] => z.array(z.record(z.unknown())).parse(r[key]);
const equal = (a: unknown, b: unknown, label: string) => { if (a !== b) throw new Error(`LEDGER_RELATIONSHIP_MISMATCH: ${label}`); };

/** Every supported ledger save passes here, including create() and save({validateBeforeSave:false}).
 * No broker callbacks, account credentials, risk decisions, or execution dispatch live here.
 * Native driver writes are an administrative escape hatch, not a supported financial API.
 */
export async function validateExecutionWrite(doc: WriteDocument): Promise<void> {
  const connection = doc.db;
  const session = doc.$session();
  requireExecutionTransaction(connection, session ?? undefined);
  if (!session) throw new Error("PERSISTENCE_NOT_READY");
  await assertExecutionIndexes(connection);
  await doc.validate();
  const data: RecordData = doc.toObject();
  const scope = executionScopeSchema.parse({ accountId: data.accountId, executionMode: data.executionMode });
  const db = connection.db;
  if (!db) throw new Error("PERSISTENCE_NOT_READY");
  const find = async (collection: string, key: string, id: unknown): Promise<RecordData> => {
    const record = await db.collection(collection).findOne({ ...scope, [key]: z.string().min(1).parse(id) }, { session });
    if (!record) throw new Error(`LEDGER_REFERENCE_NOT_FOUND: ${collection}.${key}`);
    return record;
  };
  const name = doc.collection.collectionName;
  if (name === "execution_accounts") return;
  const account = await find("execution_accounts", "accountId", scope.accountId);
  if (units(account, "version") === Number.MAX_SAFE_INTEGER) throw new Error("CAS_VERSION_EXHAUSTED");
  // All chain writes contend on the account version. Snapshot reads alone permit
  // write skew (e.g. a new fill racing closure); this CAS makes one transaction retry.
  const fenced = await db.collection("execution_accounts").updateOne({ ...scope, version: account.version },
    { $inc: { version: 1 } }, { session });
  if (fenced.matchedCount !== 1) throw new Error("CAS_CONFLICT: account write fence");
  const intentFor = (id: unknown) => find("execution_intents", "intentId", id);
  const positionFor = (id: unknown) => find("execution_positions", "positionId", id);
  const checkIntentPosition = (intent: RecordData, position: RecordData) => {
    if (intent.purpose === "ENTRY") equal(intent.intentId, position.entryIntentId, "entry intent → position");
    else equal(intent.positionId, position.positionId, "close intent → position");
  };
  const checkOrder = async (order: RecordData) => {
    const intent = await intentFor(order.intentId);
    const position = await positionFor(order.positionId);
    checkIntentPosition(intent, position);
    const leg = rows(intent, "targetLegs").find(l => l.legId === order.legId);
    if (!leg) throw new Error("LEDGER_RELATIONSHIP_MISMATCH: order leg");
    equal(leg.contractKey, order.contractKey, "order contract"); equal(leg.side, order.side, "order side");
    if (units(order, "quantityUnits") > units(leg, "targetUnits")) throw new Error("Order exceeds intent target");
    return { intent, position };
  };
  if (name === "execution_intents") {
    if (data.purpose === "ENTRY") {
      await find("execution_signals", "signalId", data.signalId);
    } else {
      const position = await positionFor(data.positionId);
      for (const leg of rows(data, "targetLegs")) {
        const original = rows(position, "legs").find(l => l.legId === leg.legId);
        if (!original) throw new Error("LEDGER_RELATIONSHIP_MISMATCH: close leg");
        equal(original.contractKey, leg.contractKey, "close contract");
        equal(leg.side, original.entrySide === "BUY" ? "SELL" : "BUY", "close side");
      }
    }
  } else if (name === "execution_reservations") {
    await intentFor(data.intentId);
  } else if (name === "execution_orders") {
    const { position } = await checkOrder(data);
    if (data.submissionAuthorization) {
      const authorization = z.record(z.unknown()).parse(data.submissionAuthorization);
      const reservation = await find("execution_reservations", "reservationId", authorization.reservationId);
      equal(reservation.intentId, data.intentId, "authorization reservation → intent");
    }
    if (["CLOSED", "ABORTED"].includes(text(position, "lifecycle")) &&
      (doc.isNew || !["FILLED", "CANCELLED", "REJECTED", "NOT_SENT"].includes(text(data, "phase")))) {
      throw new Error("TERMINAL_POSITION: cannot add or reactivate an order");
    }
    if (data.submissionClaim) {
      const claim = z.record(z.unknown()).parse(data.submissionClaim);
      const reservation = await find("execution_reservations", "reservationId", claim.reservationId);
      equal(reservation.intentId, data.intentId, "reservation → order intent");
      if (claim.request) {
        const request = brokerOrderRequestSchema.parse(claim.request);
        for (const key of ["accountId", "executionMode", "orderId", "intentId", "positionId", "legId", "contractKey", "side", "quantityUnits", "limitPriceMinor"] as const)
          equal(request[key], data[key], `durable request → order ${key}`);
        const authorization = z.record(z.unknown()).parse(data.submissionAuthorization);
        equal(request.product, authorization.product, "durable product");
        equal(request.claimId, claim.claimId, "durable claim identity");
        equal(claim.reservationId, authorization.reservationId, "authorized reservation");
        equal(request.orderType, "LIMIT", "Phase 2B2 order type");
        equal(submissionFingerprint(request), data.requestFingerprint, "authorized fingerprint");
        equal(claim.requestFingerprint, data.requestFingerprint, "claimed fingerprint");
        if (data.submissionOutcome) validateSubmissionEvidence(request, data.submissionOutcome);
      }
    }
    const fills = await db.collection("execution_fills").find({ ...scope, orderId: data.orderId }, { session }).toArray();
    checkFillTotals(data, fills, "filledUnits");
    const previous = await db.collection(name).findOne({ ...scope, orderId: data.orderId }, { session });
    if (previous && (units(data, "filledUnits") < units(previous, "filledUnits") || units(data, "lastObservationVersion") < units(previous, "lastObservationVersion"))) throw new Error("OBSERVATION_REGRESSION");
    if (previous && !["PLANNED", "READY"].includes(text(previous, "phase")) && ["PLANNED", "READY"].includes(text(data, "phase"))) throw new Error("BLIND_RETRY_FORBIDDEN");
    if (previous?.knowledge === "UNKNOWN" && data.knowledge === "KNOWN") throw new Error("RECONCILIATION_REQUIRED");
  } else if (name === "execution_fills") {
    const order = await find("execution_orders", "orderId", data.orderId);
    const { intent, position } = await checkOrder(order);
    for (const key of ["intentId", "positionId", "legId", "contractKey", "side", "brokerNamespace", "brokerOrderId"]) equal(data[key], order[key], `fill → order ${key}`);
    equal(data.positionId, position.positionId, "fill → position");
    if (intent.purpose !== "ENTRY") equal(position.activeCloseIntentId, intent.intentId, "fill → active close");
    if (["PLANNED", "READY", "NOT_SENT"].includes(text(order, "phase"))) throw new Error("Fill cannot evidence an unsent order");
    if (["CLOSED", "ABORTED"].includes(text(position, "lifecycle"))) throw new Error("Terminal position requires quarantine, not new fills");
    const existing = await db.collection("execution_fills").find({ ...scope, positionId: data.positionId }, { session }).toArray();
    if (sum(existing.filter(f => f.orderId === data.orderId)) + units(data, "quantityUnits") > units(order, "quantityUnits")) throw new Error("Fill exceeds order quantity");
    const leg = rows(position, "legs").find(l => l.legId === data.legId);
    if (!leg) throw new Error("LEDGER_RELATIONSHIP_MISMATCH: fill leg");
    const entry = existing.filter(f => f.legId === data.legId && f.intentId === position.entryIntentId);
    const exits = existing.filter(f => f.legId === data.legId && f.intentId !== position.entryIntentId);
    if (intent.purpose === "ENTRY" ? sum(entry) + units(data, "quantityUnits") > units(leg, "targetUnits")
      : sum(exits) + units(data, "quantityUnits") > sum(entry)) throw new Error("Fill exceeds position entry/close quantity");
  } else if (name === "execution_positions") {
    const previous = await db.collection(name).findOne({ ...scope, positionId: data.positionId }, { session });
    if (previous && ["CLOSED", "ABORTED"].includes(text(previous, "lifecycle")) && data.lifecycle !== previous.lifecycle) {
      throw new Error("TERMINAL_POSITION: lifecycle cannot regress");
    }
    const intent = await intentFor(data.entryIntentId);
    equal(intent.purpose, "ENTRY", "position entry purpose");
    for (const leg of rows(data, "legs")) {
      const target = rows(intent, "targetLegs").find(l => l.legId === leg.legId);
      if (!target) throw new Error("LEDGER_RELATIONSHIP_MISMATCH: position leg");
      equal(leg.contractKey, target.contractKey, "position contract"); equal(leg.entrySide, target.side, "position side"); equal(leg.targetUnits, target.targetUnits, "position target");
    }
    equal(rows(data, "legs").length, rows(intent, "targetLegs").length, "position leg count");
    if (data.activeCloseIntentId) {
      const close = await intentFor(data.activeCloseIntentId);
      if (close.purpose === "ENTRY") throw new Error("LEDGER_RELATIONSHIP_MISMATCH: active close purpose");
      checkIntentPosition(close, data);
    }
    const fills = await db.collection("execution_fills").find({ ...scope, positionId: data.positionId }, { session }).toArray();
    checkEvidenceIds(data, fills);
    for (const leg of rows(data, "legs")) {
      const entry = fills.filter(f => f.legId === leg.legId && f.intentId === data.entryIntentId);
      const exit = fills.filter(f => f.legId === leg.legId && f.intentId !== data.entryIntentId);
      equal(units(leg, "entryFilledUnits"), sum(entry), "position entry fills"); equal(units(leg, "exitFilledUnits"), sum(exit), "position exit fills");
    }
    if (["CLOSED", "ABORTED"].includes(text(data, "lifecycle"))) {
      const unresolved = await db.collection("execution_orders").countDocuments({ ...scope, positionId: data.positionId,
        $or: [{ phase: { $nin: ["FILLED", "CANCELLED", "REJECTED", "NOT_SENT"] } }, { knowledge: { $ne: "KNOWN" } }] }, { session });
      if (unresolved) throw new Error("CLOSURE_REQUIRES_ORDER_FINALITY");
      if (data.lifecycle === "CLOSED" && previous?.lifecycle !== "CLOSED") equal(data.integrity, "CONSISTENT", "closure integrity");
    }
  } else if (name === "execution_events") {
    const aggregateCollections: Record<string, [string, string]> = {
      TradingAccount: ["execution_accounts", "accountId"], StrategySignal: ["execution_signals", "signalId"],
      OrderIntent: ["execution_intents", "intentId"], RiskReservation: ["execution_reservations", "reservationId"],
      BrokerOrder: ["execution_orders", "orderId"], Fill: ["execution_fills", "fillId"], Position: ["execution_positions", "positionId"],
    };
    const [collection, key] = aggregateCollections[text(data, "aggregateType")];
    const aggregate = await find(collection, key, data.aggregateId);
    equal(data.aggregateVersion, aggregate.version ?? 0, "audit aggregate version");
  }
}
function sum(fills: RecordData[]): number {
  return fills.reduce((total, f) => z.number().int().max(Number.MAX_SAFE_INTEGER).parse(total + units(f, "quantityUnits")), 0);
}
function checkEvidenceIds(data: RecordData, fills: RecordData[]) {
  const ids = z.array(z.string()).parse(data.executionEvidenceRefs).sort();
  equal(JSON.stringify(ids), JSON.stringify(fills.map(f => text(f, "fillId")).sort()), "aggregate fill identity set");
}
function checkFillTotals(data: RecordData, fills: RecordData[], field: string) {
  checkEvidenceIds(data, fills); equal(units(data, field), sum(fills), "aggregate fill quantity");
}
