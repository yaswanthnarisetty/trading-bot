import type { ClientSession, Connection } from "mongoose";
interface WriteDocument {
  db: Connection; collection: { collectionName: string }; isNew: boolean;
  $session(): ClientSession | null; validate(): Promise<void>; toObject(): Record<string, unknown>;
}
import { z } from "zod";
import { executionScopeSchema, type ExecutionScope } from "@trading-bot/shared";
import { requireExecutionTransaction } from "./executionReadiness";
import { assertExecutionIndexes } from "./executionIndexes";
import { brokerOrderRequestSchema } from "../brokers/BrokerAdapter";
import { submissionFingerprint, validateSubmissionEvidence } from "../brokers/submissionEvidence";
import { fillAccounting, type AccountingFill } from "../domain/fillAccounting";
import { dependenciesAreSafe, verifyCloseLedger } from "../domain/closeWorkflowEvidence";
import { entryRiskPolicySchema, riskAssert, verifyEntryReservation } from "../domain/entryRisk";

type RecordData = Record<string, unknown>;
const text = (r: RecordData, key: string): string => z.string().trim().min(1).parse(r[key]);
const units = (r: RecordData, key: string): number => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(r[key]);
const rows = (r: RecordData, key: string): RecordData[] => z.array(z.record(z.unknown())).parse(r[key]);
const equal = (a: unknown, b: unknown, label: string) => { if (a !== b) throw new Error(`LEDGER_RELATIONSHIP_MISMATCH: ${label}`); };

/** Pre-dispatch admission only: may this dependent close action still be sent?
 * Called for promotion and the initial claim, before any claim exists in storage.
 * Evidence for an already claimed physical order must never pass through this gate.
 */
async function validateCloseSubmissionAuthorization(db: NonNullable<Connection["db"]>, session: ClientSession,
  scope: ExecutionScope, order: RecordData, position: RecordData, dependencies: string[], activation: RecordData) {
  const chainOrders = await db.collection("execution_orders").find({ ...scope, positionId: order.positionId }, { session }).toArray();
  const chainFills = await db.collection("execution_fills").find({ ...scope, positionId: order.positionId }, { session }).toArray();
  const chainIntents = await db.collection("execution_intents").find({ ...scope,
    intentId: { $in: [...new Set([position.entryIntentId, ...chainOrders.map(child => child.intentId)])] } }, { session }).toArray();
  verifyCloseLedger(position, chainOrders, chainFills, chainIntents);
  const proofRefs = z.array(z.string().min(1)).min(1).parse(activation.evidenceRefs);
  if (proofRefs.some(ref => !chainFills.some(fill => fill.fillId === ref && dependencies.includes(String(fill.legId)))))
    throw new Error("CLOSE_DEPENDENCY_NOT_AUTHORIZED");
  if (!dependenciesAreSafe(position, dependencies, chainOrders, chainFills)) throw new Error("CLOSE_DEPENDENCY_NOT_AUTHORIZED");
}

/** Every supported ledger save passes here, including create() and save({validateBeforeSave:false}).
 * No broker callbacks, account credentials, risk decisions, or execution dispatch live here.
 * Native driver writes are an administrative escape hatch, not a supported financial API.
 * Chain ownership, immutable economics, fill evidence, quantity bounds and CAS apply
 * both before and after dispatch. Only submission admission depends on current safety.
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
    const intent = await intentFor(data.intentId);
    if (data.kind === "ENTRY_RISK") {
      const admission = z.record(z.unknown()).parse(data.entryAdmission);
      const position = await positionFor(admission.positionId);
      checkIntentPosition(intent, position);
      equal(data.strategyInstanceId, position.strategyInstanceId, "entry reservation strategy");
      equal(scope.executionMode, "PAPER", "entry reservation mode");
      const { requirement, admission: snapshot } = verifyEntryReservation(data, intent, text(position, "positionId"));
      if (doc.isNew) {
        const policy = entryRiskPolicySchema.safeParse(account.entryRiskPolicy);
        riskAssert(policy.success && policy.data.policyVersion === account.policyVersion, "RISK_POLICY_REQUIRED");
        riskAssert(account.admissionStatus === "PAPER_READY" && account.broker === "PAPER", "ACCOUNT_NOT_READY");
        equal(snapshot.policyVersion, account.policyVersion, "entry admission policy");
        equal(snapshot.executionEpoch, account.executionEpoch, "entry admission epoch");
        equal(intent.policyVersion, account.policyVersion, "entry intent policy");
        riskAssert(account.committedExposureMinor === 0, "UNSUPPORTED_ACCOUNT_EXPOSURE");
        const retained = await db.collection(name).find({ ...scope, kind: { $ne: "CLOSE_QUANTITY" } }, { session }).toArray();
        riskAssert(retained.every(hold => hold.kind === "ENTRY_RISK" && hold.state === "HELD"), "UNSUPPORTED_ACCOUNT_EXPOSURE");
        const totalRisk = retained.reduce((total, hold) => total + BigInt(units(hold, "remainingExposureMinor")), BigInt(requirement.requiredRiskMinor));
        const totalMargin = retained.reduce((total, hold) => total + BigInt(units(hold, "remainingMarginMinor")), BigInt(requirement.requiredRiskMinor));
        const totalSlots = retained.reduce((total, hold) => total + BigInt(units(hold, "positionSlots")), 1n);
        riskAssert(BigInt(units(account, "reservedExposureMinor")) === totalRisk && BigInt(units(account, "reservedMarginMinor")) === totalMargin
          && BigInt(units(account, "positionSlots")) === totalSlots, "RISK_PROJECTION_MISMATCH");
        riskAssert(requirement.requiredRiskMinor <= policy.data.maxRiskPerEntryMinor, "RISK_PER_TRADE_EXCEEDED");
        riskAssert(totalRisk <= BigInt(policy.data.maxReservedRiskMinor), "RISK_CAPACITY_EXCEEDED");
        riskAssert(totalSlots <= BigInt(policy.data.maxPositionSlots), "POSITION_LIMIT_EXCEEDED");
      }
    }
    if (data.kind === "CLOSE_QUANTITY") {
      equal(intent.purpose, "CLOSE", "quantity reservation purpose");
      const position = await positionFor(intent.positionId);
      equal(position.activeCloseIntentId, intent.intentId, "quantity reservation active close");
      equal(position.closeGeneration, intent.closeGeneration, "quantity reservation generation");
      for (const field of ["initialMarginMinor", "remainingMarginMinor", "initialExposureMinor", "remainingExposureMinor", "positionSlots"])
        equal(data[field], 0, "close authorization has no monetary hold or position slot");
      for (const target of rows(intent, "targetLegs")) {
        const leg = rows(position, "legs").find(l => l.legId === target.legId);
        if (!leg) throw new Error("CLOSE_HOLD_OWNERSHIP_MISMATCH");
        equal(leg.closeHoldIntentId, intent.intentId, "quantity reservation leg owner");
        if (doc.isNew) equal(leg.closeHeldUnits, target.targetUnits, "new close quantity reservation");
      }
    }
  } else if (name === "execution_orders") {
    const { position, intent } = await checkOrder(data);
    const previous = await db.collection(name).findOne({ ...scope, orderId: data.orderId }, { session });
    // The persisted physical claim separates new dispatch from already-sent truth.
    // Missing optional economics must never select a weaker admission path.
    const initialEntryClaim = scope.executionMode === "PAPER" && intent.purpose === "ENTRY"
      && Boolean(data.submissionClaim) && !previous?.submissionClaim;
    if (initialEntryClaim) {
      equal(previous?.phase, "READY", "ENTRY admission requires an existing READY child");
      if (!data.submissionAuthorization) throw new Error("ENTRY_ADMISSION_REQUIRED");
    }
    if (data.submissionAuthorization) {
      const authorization = z.record(z.unknown()).parse(data.submissionAuthorization);
      const reservation = await find("execution_reservations", "reservationId", authorization.reservationId);
      equal(reservation.intentId, data.intentId, "authorization reservation → intent");
      if (initialEntryClaim) equal(reservation.kind, "ENTRY_RISK", "ENTRY admission reservation kind");
      if (reservation.kind === "ENTRY_RISK") {
        const { requirement, admission } = verifyEntryReservation(reservation, intent, text(position, "positionId"));
        const leg = requirement.legs.find(leg => leg.legId === data.legId);
        if (!leg) throw new Error("LEDGER_RELATIONSHIP_MISMATCH: entry admission leg");
        equal(data.generation, admission.generation, "entry generation"); equal(data.sliceId, "entry", "entry physical child");
        equal(data.quantityUnits, leg.quantityUnits, "entry authorized quantity"); equal(data.limitPriceMinor, leg.limitPriceMinor, "entry authorized limit");
        equal(authorization.reservedQuantityUnits, leg.quantityUnits, "entry reserved quantity");
        equal(authorization.policyVersion, admission.policyVersion, "entry policy snapshot");
        equal(authorization.executionEpoch, admission.executionEpoch, "entry epoch snapshot");
        equal(authorization.product, requirement.product, "entry product");
        equal((authorization.expiresAt as Date).getTime(), Math.min(requirement.expiresAt.getTime(), (intent.deadline as Date).getTime()), "entry authorization expiry");
        // An initial claim must be backed by the atomically published admission.
        // Once claimed, evidence ingestion never repeats pre-dispatch admission.
        if (initialEntryClaim) {
          const retained = await db.collection("execution_reservations").find({ ...scope, kind: { $ne: "CLOSE_QUANTITY" } }, { session }).toArray();
          riskAssert(retained.every(hold => hold.kind === "ENTRY_RISK" && hold.state === "HELD"), "RISK_PROJECTION_MISMATCH");
          for (const [counter, field] of [["reservedExposureMinor", "remainingExposureMinor"], ["reservedMarginMinor", "remainingMarginMinor"], ["positionSlots", "positionSlots"]]) {
            const total = retained.reduce((sum, hold) => sum + BigInt(units(hold, field)), 0n);
            riskAssert(BigInt(units(account, counter)) === total, "RISK_PROJECTION_MISMATCH");
          }
          const event = await find("execution_events", "eventId", `${reservation.reservationId}:RISK_RESERVED`);
          equal(event.eventType, "RISK_RESERVED", "entry admission event"); equal(event.aggregateId, intent.intentId, "entry admission intent");
          equal(event.aggregateType, "OrderIntent", "entry admission aggregate");
          const payload = z.record(z.unknown()).parse(event.payload);
          equal(payload.kind, "RISK", "entry admission payload");
          equal(payload.reservationId, reservation.reservationId, "entry admission reservation");
          equal(payload.exposureMinor, requirement.requiredRiskMinor, "entry admission risk");
          equal(payload.marginMinor, requirement.requiredRiskMinor, "entry admission margin");
        }
      }
      if (reservation.kind === "CLOSE_QUANTITY") {
        equal(intent.purpose, "CLOSE", "quantity-authorized child purpose");
        equal(position.activeCloseIntentId, intent.intentId, "quantity-authorized child active close");
        equal(position.closeGeneration, intent.closeGeneration, "quantity-authorized child generation");
        const plan = z.object({ policy: z.literal("POSITION_LIMIT_V1"), closeGeneration: z.number().int().nonnegative(),
          dependsOnLegIds: z.array(z.string().min(1)) }).strict().parse(data.closePlan);
        equal(plan.closeGeneration, intent.closeGeneration, "close child generation");
        const leg = rows(position, "legs").find(l => l.legId === data.legId);
        if (!leg) throw new Error("CLOSE_HOLD_OWNERSHIP_MISMATCH");
        equal(leg.closeHoldIntentId, intent.intentId, "close child hold owner");
        const dependencies = leg.entrySide === "BUY" ? rows(position, "legs").filter(l => l.entrySide === "SELL").map(l => text(l, "legId")).sort() : [];
        equal(JSON.stringify([...plan.dependsOnLegIds].sort()), JSON.stringify(dependencies), "short-first dependency set");
        if (dependencies.length && !["PLANNED", "NOT_SENT"].includes(text(data, "phase"))) {
          if (!data.dependencyActivation) throw new Error("CLOSE_DEPENDENCY_NOT_AUTHORIZED");
          const activation = z.record(z.unknown()).parse(data.dependencyActivation);
          for (const key of ["positionId", "intentId", "orderId"]) equal(activation[key], data[key], "dependency activation identity");
          equal(activation.closeGeneration, intent.closeGeneration, "dependency activation generation");
          equal(activation.eventId, `${data.orderId}:ORDER_READY`, "dependency activation event");
          // The persisted claim, not the incoming phase or a caller-supplied purpose,
          // determines whether this physical order has crossed the submission boundary.
          // A new claim in `data` still requires admission. Subsequent evidence saves
          // (including broker-ID attachment while SUBMITTING) retain all checks below,
          // but must not ask whether we would choose to dispatch this action again now.
          if (!previous?.submissionClaim)
            await validateCloseSubmissionAuthorization(db, session, scope, data, position, dependencies, activation);
        }
        const siblings = await db.collection(name).find({ ...scope, intentId: data.intentId, legId: data.legId,
          orderId: { $ne: data.orderId } }, { session }).toArray();
        const outstanding = [...siblings, data].reduce((total, child) => total + BigInt(units(child, "quantityUnits")) - BigInt(units(child, "filledUnits")), 0n);
        if (outstanding > BigInt(units(leg, "closeHeldUnits"))) throw new Error("CLOSE_HOLD_EXCEEDED: outstanding children exceed owned hold");
      }
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
      const previousLeg = previous && rows(previous, "legs").find(l => l.legId === leg.legId);
      if (previousLeg?.closeHoldIntentId !== undefined && previous?.activeCloseIntentId === data.activeCloseIntentId) {
        equal(leg.closeHoldIntentId, previousLeg.closeHoldIntentId, "active close hold owner cannot be cleared or replaced");
      }
      if (leg.entryNotionalMinor !== undefined || leg.netQuantityUnits !== undefined || previousLeg?.entryNotionalMinor !== undefined) {
        const accounting = fillAccounting([...entry, ...exit] as unknown as AccountingFill[], text(data, "entryIntentId"));
        equal(leg.entryNotionalMinor, accounting.entryNotionalMinor, "position entry notional");
        equal(leg.netQuantityUnits, accounting.netQuantityUnits, "position signed quantity");
      }
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
