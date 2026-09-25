import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { RiskAdmissionService, type EntryAdmissionResult } from "../../src/services/RiskAdmissionService";
import { OrderManager } from "../../src/services/OrderManager";
import { FillProcessor } from "../../src/services/FillProcessor";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import * as f from "../fixtures";
import { submissionFingerprint } from "../../src/brokers/submissionEvidence";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
const models = executionModels(connection), clock = () => new Date(f.now), deadline = new Date(f.now.getTime() + 60000);
const service = () => new RiskAdmissionService(connection, f.scope, clock);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 100000, maxReservedRiskMinor: 200000, maxPositionSlots: 3 };
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
async function configure(changes: Record<string, unknown>) {
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set(changes); await account.save({ session }); });
}
async function seed(suffix = "1", price = 1000, side: "BUY" | "SELL" = "BUY", multi = false) {
  const targets = [{ legId: "hedge", contractKey: "NFO:contract-1", side, targetUnits: 10 },
    ...(multi ? [{ legId: "second", contractKey: "NFO:contract-2", side, targetUnits: 10 }] : [])];
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`signal-${suffix}`), decisionKey: `decision-${suffix}`, expiresAt: deadline }).save({ session });
    await new models.OrderIntent({ ...f.intent(`intent-${suffix}`), signalId: `signal-${suffix}`, deadline,
      targetLegs: targets,
      entryPlan: { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: deadline,
        legs: targets.map(leg => ({ legId: leg.legId, contractKey: leg.contractKey, instrumentKind: "NSE_OPTION", optionType: "CALL", expiry: new Date("2026-09-18T10:00:00Z"),
          qualificationRef: `qualified-${leg.legId}`, lotSizeUnits: 5, tickSizeMinor: 5, limitPriceMinor: price })) } }).save({ session });
    await new models.Position({ ...f.position(`position-${suffix}`), entryIntentId: `intent-${suffix}`,
      legs: targets.map(leg => ({ ...f.position().legs[0], legId: leg.legId, contractKey: leg.contractKey, entrySide: side })), closePolicy: { kind: "POSITION_LIMIT_V1", product: "INTRADAY", policyVersion: 1,
        expiresAt: deadline, legLimits: [{ legId: "hedge", limitPriceMinor: 1000 }] } }).save({ session });
  });
}
function authorized(result: EntryAdmissionResult) {
  assert.equal(result.status, "AUTHORIZED", JSON.stringify(result));
  if (result.status !== "AUTHORIZED") throw new Error("not authorized"); return result;
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [key, model] of Object.entries(models)) result[key] = await model.find().sort({ _id: 1 }).lean();
  return result;
}
async function rejected(reason: string, intentId = "intent-1", evaluator = service()) {
  const before = await snapshot();
  assert.deepEqual(await evaluator.authorizeEntry(intentId), { status: "REJECTED", intentId, reason });
  assert.deepEqual(await snapshot(), before);
}
let brokerIds = 0;
function paper(scenario: PaperScenario = { submission: "ACCEPTED" }) {
  const broker = new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++brokerIds}` }, scenario: () => scenario });
  let calls = 0; const original = broker.submitOrder.bind(broker);
  broker.submitOrder = async request => { calls++; return original(request); };
  return { broker, calls: () => calls, manager: new OrderManager(connection, f.scope, broker, clock) };
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => {
  brokerIds = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session }));
});

test("real admission reserves exact debit and one slot with no fabricated quantity or submission", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1"));
  assert.equal(result.requiredRiskMinor, 10000); assert.equal(result.orderIds.length, 1);
  const account = await models.TradingAccount.findOne(f.scope).orFail(), reservation = await models.RiskReservation.findOne().orFail();
  assert.equal(account.get("reservedExposureMinor"), 10000); assert.equal(account.get("reservedMarginMinor"), 10000);
  assert.equal(account.get("positionSlots"), 1); assert.equal(account.get("committedExposureMinor"), 0);
  assert.equal(reservation.get("kind"), "ENTRY_RISK"); assert.equal(reservation.get("remainingExposureMinor"), 10000);
  assert.equal((await models.OrderIntent.findOne().orFail()).get("state"), "RISK_RESERVED");
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("phase"), "READY");
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("submissionClaim"), undefined);
  assert.equal(await models.Fill.countDocuments(), 0); assert.equal(await models.Position.countDocuments(), 1);
  const pos = await models.Position.findOne().orFail(); assert.equal(pos.get("lifecycle"), "PENDING_ENTRY");
  assert.equal(pos.get("legs.0.entryFilledUnits"), 0); assert.equal(pos.get("legs.0.exitFilledUnits"), 0);
  const event = await models.TradingEvent.findOne().orFail(); assert.equal(event.get("eventType"), "RISK_RESERVED");
  assert.equal(event.get("payload.exposureMinor"), 10000); assert.equal(account.get("nextEventSequence"), 2);
});
test("real admission replay after restart is identical and has no writes", async () => {
  await seed(); const result = await service().authorizeEntry("intent-1"), before = await snapshot();
  assert.deepEqual(await service().authorizeEntry("intent-1"), result); assert.deepEqual(await snapshot(), before);
});
test("real concurrent same-intent admissions converge on one reservation and event", async () => {
  await seed(); const results = await Promise.all([service().authorizeEntry("intent-1"), service().authorizeEntry("intent-1")]);
  assert.deepEqual(results[0], results[1]); authorized(results[0]);
  assert.equal(await models.RiskReservation.countDocuments(), 1); assert.equal(await models.BrokerOrder.countDocuments(), 1);
  assert.equal(await models.TradingEvent.countDocuments(), 1); assert.equal((await models.TradingAccount.findOne().orFail()).get("positionSlots"), 1);
});
test("real per-trade risk rejection leaves every ledger record unchanged", async () => {
  await seed(); await configure({ entryRiskPolicy: { ...policy, maxRiskPerEntryMinor: 9999 } }); await rejected("RISK_PER_TRADE_EXCEEDED");
});
test("real aggregate risk rejection includes the existing durable hold", async () => {
  await seed(); await seed("2"); await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 15000 } });
  authorized(await service().authorizeEntry("intent-1")); await rejected("RISK_CAPACITY_EXCEEDED", "intent-2");
});
test("real competing 700-rupee intents cannot oversubscribe 1000-rupee capacity", async () => {
  await seed("1", 7000); await seed("2", 7000); await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 100000 } });
  const results = await Promise.all([service().authorizeEntry("intent-1"), service().authorizeEntry("intent-2")]);
  assert.equal(results.filter(r => r.status === "AUTHORIZED").length, 1);
  assert.equal(results.filter(r => r.status === "REJECTED" && r.reason === "RISK_CAPACITY_EXCEEDED").length, 1);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("reservedExposureMinor"), 70000);
  assert.equal(await models.RiskReservation.countDocuments(), 1); assert.equal(await models.TradingEvent.countDocuments(), 1);
});
test("real position-slot ceiling rejects without charging another debit", async () => {
  await seed(); await seed("2"); await configure({ entryRiskPolicy: { ...policy, maxPositionSlots: 1 } });
  authorized(await service().authorizeEntry("intent-1")); await rejected("POSITION_LIMIT_EXCEEDED", "intent-2");
});
test("real two workers compete for the third and final slot", async () => {
  for (const id of ["1", "2", "3", "4"]) await seed(id);
  authorized(await service().authorizeEntry("intent-1")); authorized(await service().authorizeEntry("intent-2"));
  const results = await Promise.all([service().authorizeEntry("intent-3"), service().authorizeEntry("intent-4")]);
  assert.equal(results.filter(r => r.status === "AUTHORIZED").length, 1);
  assert.equal(results.filter(r => r.status === "REJECTED" && r.reason === "POSITION_LIMIT_EXCEEDED").length, 1);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("positionSlots"), 3);
  assert.equal(await models.RiskReservation.countDocuments(), 3); assert.equal(await models.TradingEvent.countDocuments(), 3);
});
test("real account and mode isolation fail closed", async () => {
  await seed(); await tx(session => new models.TradingAccount({ ...f.account("PAPER:other"), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session }));
  await rejected("INTENT_NOT_FOUND", "intent-1", new RiskAdmissionService(connection, { accountId: "PAPER:other", executionMode: "PAPER" }, clock));
  for (const mode of ["LIVE", "LEGACY_PAPER"] as const)
    assert.throws(() => new RiskAdmissionService(connection, { accountId: `${mode}:other`, executionMode: mode }), /PAPER_ONLY/);
});
for (const purpose of ["CLOSE", "RECOVERY"] as const) test(`real ${purpose} intent cannot enter ENTRY risk admission`, async () => {
  await seed(); await tx(session => new models.OrderIntent({ ...f.intent("other"), purpose, positionId: "position-1", deadline,
    targetLegs: [{ ...f.intent().targetLegs[0], side: "SELL" }] }).save({ session }));
  await rejected("ENTRY_ONLY", "other");
});
test("real naked short fails closed", async () => { await seed("1", 1000, "SELL"); await rejected("UNSUPPORTED_RISK_SHAPE"); });
for (const defect of ["price", "contract", "expiry", "policy"] as const) test(`real invalid or stale ${defect} fails closed`, async () => {
  await seed();
  const change = { price: { "entryPlan.legs.0.limitPriceMinor": 0 }, contract: { "entryPlan.legs.0.contractKey": "wrong" },
    expiry: { "entryPlan.validUntil": f.now }, policy: { policyVersion: 2 } };
  await connection.db!.collection("execution_intents").updateOne({ intentId: "intent-1" }, { $set: change[defect] });
  await rejected(defect === "price" || defect === "contract" ? "INVALID_RISK_ECONOMICS" : "STALE_EXECUTION_CHAIN");
});
for (const modelName of ["RiskReservation", "BrokerOrder", "Position", "TradingEvent"] as const)
 test(`real admission ${modelName} failure rolls back reservation, account, children and event sequence`, async () => {
  await seed(); const before = await snapshot(), model = models[modelName], original = model.prototype.save;
  model.prototype.save = function () { return Promise.reject(new Error("injected-admission")); };
  try { await assert.rejects(service().authorizeEntry("intent-1"), /injected-admission/); }
  finally { model.prototype.save = original; }
  assert.deepEqual(await snapshot(), before); authorized(await service().authorizeEntry("intent-1"));
  assert.equal((await models.TradingAccount.findOne().orFail()).get("nextEventSequence"), 2);
});
test("real admitted UNKNOWN submission retains all risk and restart cannot duplicate it", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1")); const p = paper({ submission: "AMBIGUOUS" });
  await p.manager.submit(result.orderIds[0]); const before = await snapshot();
  assert.deepEqual(await service().authorizeEntry("intent-1"), result); assert.deepEqual(await snapshot(), before);
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("knowledge"), "UNKNOWN");
  assert.equal((await models.RiskReservation.findOne().orFail()).get("remainingExposureMinor"), 10000);
  assert.equal((await p.manager.submit(result.orderIds[0])).status, "CURRENT"); assert.equal(p.calls(), 1);
});
test("real ENTRY reservation cannot authorize an unrelated intent's child", async () => {
  await seed(); await seed("2"); const a = authorized(await service().authorizeEntry("intent-1"));
  const before = await snapshot();
  await assert.rejects(tx(async session => {
    const original = await models.BrokerOrder.findOne({ orderId: a.orderIds[0] }).session(session).orFail();
    const { _id, ...copy } = original.toObject();
    await new models.BrokerOrder({ ...copy, orderId: "foreign", intentId: "intent-2", positionId: "position-2" }).save({ session });
  }), /reservation/);
  assert.deepEqual(await snapshot(), before);
});
test("real CLOSE and ENTRY reservation kinds cannot be substituted", async () => {
  await seed(); const a = authorized(await service().authorizeEntry("intent-1"));
  await assert.rejects(tx(session => new models.RiskReservation({ ...f.reservation("bad-close"), kind: "CLOSE_QUANTITY" }).save({ session })), /quantity reservation purpose/);
  await tx(session => new models.OrderIntent({ ...f.intent("close"), purpose: "CLOSE", positionId: "position-1", deadline,
    targetLegs: [{ ...f.intent().targetLegs[0], side: "SELL" }] }).save({ session }));
  const before = await snapshot();
  await assert.rejects(tx(async session => {
    const original = await models.BrokerOrder.findOne({ orderId: a.orderIds[0] }).session(session).orFail();
    const { _id, ...copy } = original.toObject();
    await new models.BrokerOrder({ ...copy, orderId: "close-order", intentId: "close", side: "SELL" }).save({ session });
  }), /reservation/); assert.deepEqual(await snapshot(), before);
});
test("real admitted ENTRY uses unchanged OrderManager/FillProcessor and full close workflow", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1")), p = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  assert.equal((await p.manager.submit(result.orderIds[0])).status, "PERSISTED");
  const processor = new FillProcessor(connection, f.scope, clock); await processor.processRetained(result.orderIds[0]);
  assert.equal((await models.Position.findOne().orFail()).get("legs.0.netQuantityUnits"), 10);
  await seed("2"); await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 15000 } });
  await rejected("RISK_CAPACITY_EXCEEDED", "intent-2"); // Filled risk remains counted once as committed exposure.
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("position-1", "close");
  const exit = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  await exit.manager.submit(close.orderIds[0]); await processor.processRetained(close.orderIds[0]);
  assert.equal((await new CloseWorkflowService(connection, f.scope, clock).advance("position-1")).status, "CLOSED");
  assert.equal((await models.RiskReservation.findOne({ reservationId: result.reservationId }).orFail()).get("state"), "HELD");
  assert.equal((await models.RiskReservation.findOne({ intentId: close.intentId }).orFail()).get("state"), "CONSUMED");
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(account.get("reservedExposureMinor"), 0);
  assert.equal(account.get("committedExposureMinor"), 10000);
  assert.equal(account.get("committedPositionSlots"), 1);
});
test("real failed admission cannot dispatch and consumes no broker calls", async () => {
  await seed(); await configure({ admissionStatus: "HALTED" }); const p = paper();
  await rejected("ACCOUNT_NOT_READY"); await assert.rejects(p.manager.submit("nonexistent-order"), /REFERENCE_NOT_FOUND/);
  assert.equal(p.calls(), 0); assert.equal(await models.BrokerOrder.countDocuments(), 0);
});
test("real missing policy and inconsistent projection fail closed", async () => {
  await seed(); await configure({ entryRiskPolicy: undefined }); await rejected("RISK_POLICY_REQUIRED");
  await configure({ entryRiskPolicy: policy, reservedExposureMinor: 1 }); await rejected("RISK_PROJECTION_MISMATCH");
});
test("real unsupported committed exposure cannot disappear from capacity", async () => {
  await seed(); await configure({ committedExposureMinor: 1 }); await rejected("RISK_PROJECTION_MISMATCH");
});
test("real original ENTRY hold cannot release after possible send", async () => {
  await seed(); authorized(await service().authorizeEntry("intent-1")); const before = await snapshot();
  await assert.rejects(tx(async session => { const reservation = await models.RiskReservation.findOne().session(session).orFail();
    reservation.set({ state: "RELEASED", remainingExposureMinor: 0, remainingMarginMinor: 0, positionSlots: 0 }); await reservation.save({ session }); }), /fully held/);
  assert.deepEqual(await snapshot(), before);
});

test("real multi-leg admission rolls back an earlier child when the second child fails", async () => {
  await seed("1", 1000, "BUY", true); const before = await snapshot(), original = models.BrokerOrder.prototype.save;
  models.BrokerOrder.prototype.save = function (...args: unknown[]) {
    if (this.get("legId") === "second") return Promise.reject(new Error("second-child-failure"));
    return original.apply(this, args);
  };
  try { await assert.rejects(service().authorizeEntry("intent-1"), /second-child-failure/); }
  finally { models.BrokerOrder.prototype.save = original; }
  assert.deepEqual(await snapshot(), before);
  const result = authorized(await service().authorizeEntry("intent-1"));
  assert.equal(result.requiredRiskMinor, 20000); assert.equal(result.orderIds.length, 2);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("positionSlots"), 1);
  const p = paper(); for (const id of result.orderIds) assert.equal((await p.manager.submit(id)).status, "PERSISTED");
  assert.equal(p.calls(), 2);
});
test("real mandatory boundary rejects an uncharged ENTRY_RISK reservation", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1")); await seed("2");
  const original = await models.RiskReservation.findOne({ reservationId: result.reservationId }).orFail();
  const { _id, ...copy } = original.toObject(), before = await snapshot();
  await assert.rejects(tx(session => new models.RiskReservation({ ...copy, reservationId: "uncharged", intentId: "intent-2",
    entryAdmission: { ...original.get("entryAdmission"), positionId: "position-2" } }).save({ session })), /RISK_PROJECTION_MISMATCH/);
  assert.deepEqual(await snapshot(), before);
});
test("real initial claim requires the committed admission event", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1")); const p = paper();
  // Administrative corruption fixture; supported application events are append-only.
  await connection.db!.collection("execution_events").deleteOne({ eventId: `${result.reservationId}:RISK_RESERVED` });
  const before = await snapshot(); await assert.rejects(p.manager.submit(result.orderIds[0]), /LEDGER_REFERENCE_NOT_FOUND/);
  assert.equal(p.calls(), 0); assert.deepEqual(await snapshot(), before);
});
test("real already-filled debit cannot disappear through a corrupted reservation state", async () => {
  await seed(); const result = authorized(await service().authorizeEntry("intent-1"));
  const p = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  await p.manager.submit(result.orderIds[0]); await new FillProcessor(connection, f.scope, clock).processRetained(result.orderIds[0]);
  await seed("2");
  await connection.db!.collection("execution_reservations").updateOne({ reservationId: result.reservationId },
    { $set: { state: "CONSUMED", remainingMarginMinor: 0, remainingExposureMinor: 0, positionSlots: 0 } });
  await connection.db!.collection("execution_accounts").updateOne(f.scope,
    { $set: { reservedMarginMinor: 0, reservedExposureMinor: 0, positionSlots: 0 } });
  await rejected("RISK_PROJECTION_MISMATCH", "intent-2");
});
test("real replay rejects corrupted economics instead of creating another authorization", async () => {
  await seed(); authorized(await service().authorizeEntry("intent-1"));
  await connection.db!.collection("execution_intents").updateOne({ intentId: "intent-1" }, { $set: { "entryPlan.legs.0.limitPriceMinor": 1500 } });
  await rejected("RISK_PROJECTION_MISMATCH");
});

// The bypass regression intentionally uses ONLY normal transactional model APIs.
// Older READY rows may remain readable, but cannot acquire a new physical claim.
async function legacyReady(withPlan = false) {
  await configure({ entryRiskPolicy: undefined });
  if (withPlan) await seed();
  else await tx(async session => {
    await new models.StrategySignal({ ...f.signal(), expiresAt: deadline }).save({ session });
    await new models.OrderIntent({ ...f.intent(), deadline }).save({ session });
    await new models.Position(f.position()).save({ session });
  });
  await tx(async session => {
    const intent = await models.OrderIntent.findOne().session(session).orFail();
    intent.set("state", "RISK_RESERVED"); await intent.save({ session });
    await new models.RiskReservation({ ...f.reservation(), instrumentKeys: ["NFO:contract-1"] }).save({ session });
    const request = { ...f.scope, orderId: "legacy-ready", claimId: "unclaimed", intentId: "intent-1", positionId: "position-1",
      legId: "hedge", contractKey: "NFO:contract-1", side: "BUY" as const, quantityUnits: 10,
      orderType: "LIMIT" as const, limitPriceMinor: 1000, product: "INTRADAY" as const };
    await new models.BrokerOrder({ ...f.brokerOrder(request.orderId), phase: "READY", brokerNamespace: "PAPER_SIM_V1",
      requestFingerprint: submissionFingerprint(request), submissionAuthorization: { reservationId: "reservation-1",
        evidenceRef: "old-authorization", product: "INTRADAY", reservedQuantityUnits: 10, policyVersion: 1,
        executionEpoch: 1, expiresAt: deadline } }).save({ session });
  });
  return "legacy-ready";
}
for (const withPlan of [false, true]) test(`real existing untyped READY ENTRY cannot dispatch entryPlan=${withPlan}`, async () => {
  const orderId = await legacyReady(withPlan), p = paper();
  if (!withPlan) await rejected("INVALID_RISK_ECONOMICS"); // No valid ENTRY_RISK is possible without qualified economics.
  const before = await snapshot();
  await assert.rejects(p.manager.submit(orderId), /ENTRY admission reservation kind/);
  assert.equal(p.calls(), 0); assert.deepEqual(await snapshot(), before);
  const order = await models.BrokerOrder.findOne({ orderId }).orFail();
  assert.equal(order.get("phase"), "READY"); assert.equal(order.get("submissionClaim"), undefined);
  const account = await models.TradingAccount.findOne().orFail();
  for (const field of ["reservedMarginMinor", "reservedExposureMinor", "positionSlots"]) assert.equal(account.get(field), 0);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
});

test("real ENTRY cannot claim using an existing CLOSE_QUANTITY reservation", async () => {
  await seed(); const entry = authorized(await service().authorizeEntry("intent-1")), p = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  await p.manager.submit(entry.orderIds[0]); await new FillProcessor(connection, f.scope, clock).processRetained(entry.orderIds[0]);
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("position-1", "close");
  await seed("2"); const second = authorized(await service().authorizeEntry("intent-2"));
  const reservation = await models.RiskReservation.findOne({ intentId: close.intentId }).orFail();
  // A normal model save already rejects this ownership substitution; corrupt only
  // the stored pointer to prove the initial claim ALSO fails before broker dispatch.
  await connection.db!.collection("execution_orders").updateOne({ orderId: second.orderIds[0] },
    { $set: { "submissionAuthorization.reservationId": reservation.get("reservationId") } });
  const before = await snapshot(), blocked = paper();
  await assert.rejects(blocked.manager.submit(second.orderIds[0]), /reservation/);
  assert.equal(blocked.calls(), 0); assert.deepEqual(await snapshot(), before);
});

test("real admitted ENTRY with missing qualified economics cannot acquire an initial claim", async () => {
  await seed(); const entry = authorized(await service().authorizeEntry("intent-1")), p = paper();
  // No legitimate ENTRY_RISK can be admitted without entryPlan; simulate damaged metadata.
  await connection.db!.collection("execution_intents").updateOne({ intentId: "intent-1" }, { $unset: { entryPlan: "" } });
  const before = await snapshot(); await assert.rejects(p.manager.submit(entry.orderIds[0]), /INVALID_RISK_ECONOMICS/);
  assert.equal(p.calls(), 0); assert.deepEqual(await snapshot(), before);
});

test("real initial claim rejects capacity counters that lost the durable ENTRY charges", async () => {
  await seed(); const entry = authorized(await service().authorizeEntry("intent-1")), p = paper();
  await configure({ reservedMarginMinor: 0, reservedExposureMinor: 0, positionSlots: 0 });
  const before = await snapshot(); await assert.rejects(p.manager.submit(entry.orderIds[0]), /RISK_PROJECTION_MISMATCH/);
  assert.equal(p.calls(), 0); assert.deepEqual(await snapshot(), before);
});

for (const submission of ["ACCEPTED", "AMBIGUOUS"] as const)
 test(`real post-dispatch ENTRY ${submission} persists fills after admission becomes unsafe`, async () => {
  await seed(); const entry = authorized(await service().authorizeEntry("intent-1"));
  const p = paper({ submission, initialFills: [{ quantityUnits: 4, priceMinor: 990 }] });
  const original = p.broker.submitOrder.bind(p.broker);
  p.broker.submitOrder = async request => {
    const receipt = await original(request);
    // Policy changes AFTER committed claim/send and BEFORE outcome persistence.
    await configure({ admissionStatus: "HALTED", policyVersion: 2, executionEpoch: 2,
      entryRiskPolicy: { policyVersion: 2, maxRiskPerEntryMinor: 1, maxReservedRiskMinor: 1, maxPositionSlots: 1 } });
    return receipt;
  };
  assert.equal((await p.manager.submit(entry.orderIds[0])).status, "PERSISTED");
  await rejected("ACCOUNT_NOT_READY");
  const processor = new FillProcessor(connection, f.scope, clock);
  assert.equal((await processor.processRetained(entry.orderIds[0])).status, "PROCESSED");
  assert.equal((await models.Position.findOne().orFail()).get("legs.0.entryFilledUnits"), 4);
  assert.equal((await models.RiskReservation.findOne().orFail()).get("remainingExposureMinor"), 6000);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("committedExposureMinor"), 3960);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("positionSlots"), 1);
  if (submission === "AMBIGUOUS") assert.equal((await models.BrokerOrder.findOne().orFail()).get("knowledge"), "UNKNOWN");
  assert.equal((await p.manager.submit(entry.orderIds[0])).status, "CURRENT"); assert.equal(p.calls(), 1);
});

for (const field of ["maxRiskPerEntryMinor", "maxReservedRiskMinor", "maxPositionSlots"])
 test(`real malformed persisted policy ${field} fails closed`, async () => {
  await seed();
  await connection.db!.collection("execution_accounts").updateOne(f.scope, { $set: { [`entryRiskPolicy.${field}`]: 0.5 } });
  await rejected("RISK_POLICY_REQUIRED");
});
