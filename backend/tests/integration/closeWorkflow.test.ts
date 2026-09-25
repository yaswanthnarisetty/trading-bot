import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { OrderManager } from "../../src/services/OrderManager";
import { FillProcessor } from "../../src/services/FillProcessor";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import type { BrokerOrderRequest } from "../../src/brokers/BrokerAdapter";
import { submissionFingerprint } from "../../src/brokers/submissionEvidence";
import * as f from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
const models = executionModels(connection);
const clock = () => new Date(f.now), deadline = new Date(f.now.getTime() + 60000);
const service = () => new CloseIntentService(connection, f.scope, clock);
const processor = () => new FillProcessor(connection, f.scope, clock);
let ids = 0;
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
const position = () => models.Position.findOne({ positionId: "position-1" }).orFail();
function paper(plan: PaperScenario = { submission: "ACCEPTED" }) {
  return new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` }, scenario: () => plan });
}
const manager = (broker: PaperBrokerAdapter) => new OrderManager(connection, f.scope, broker, clock);
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [name, model] of Object.entries(models)) result[name] = await model.find().sort({ _id: 1 }).lean();
  return result;
}
async function seed(options: { side?: "BUY" | "SELL"; spread?: boolean; units?: number; orderUnits?: number; filled?: number; policy?: boolean; suffix?: string; zeroMoney?: boolean } = {}) {
  const side = options.side ?? "BUY", units = options.units ?? 10, orderUnits = options.orderUnits ?? units, filled = options.filled ?? orderUnits, suffix = options.suffix ?? "1";
  const positionId = `position-${suffix}`, intentId = `intent-${suffix}`, reservationId = `entry-reservation-${suffix}`;
  const legs = [{ legId: "hedge", contractKey: "NFO:contract-1", side, targetUnits: units },
    ...(options.spread ? [{ legId: "short", contractKey: "NFO:contract-2", side: "SELL" as const, targetUnits: units }] : [])];
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`signal-${suffix}`), decisionKey: `decision-${suffix}` }).save({ session });
    await new models.OrderIntent({ ...f.intent(intentId), signalId: `signal-${suffix}`, state: "RISK_RESERVED", targetLegs: legs, deadline }).save({ session });
    await new models.Position({ ...f.position(positionId), entryIntentId: intentId,
      legs: legs.map(leg => ({ ...f.position().legs[0], legId: leg.legId, contractKey: leg.contractKey, entrySide: leg.side, targetUnits: units })),
      ...(options.policy === false ? {} : { closePolicy: { kind: "POSITION_LIMIT_V1", policyVersion: 1, product: "INTRADAY", expiresAt: deadline,
        legLimits: legs.map(leg => ({ legId: leg.legId, limitPriceMinor: 1000 })) } }) }).save({ session });
    await new models.RiskReservation({ ...f.reservation(reservationId), intentId, instrumentKeys: legs.map(leg => leg.contractKey),
      ...(options.zeroMoney ? { initialMarginMinor: 0, remainingMarginMinor: 0, initialExposureMinor: 0, remainingExposureMinor: 0, positionSlots: 0 } : {}) }).save({ session });
    for (const leg of legs) {
      const request: BrokerOrderRequest = { ...f.scope, orderId: `entry-${suffix}-${leg.legId}`, claimId: "unclaimed", intentId, positionId,
        legId: leg.legId, contractKey: leg.contractKey, side: leg.side, quantityUnits: orderUnits, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY" };
      await new models.BrokerOrder({ ...f.brokerOrder(request.orderId), positionId, intentId, legId: leg.legId, contractKey: leg.contractKey, side: leg.side,
        quantityUnits: orderUnits, phase: "READY", brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request),
        submissionAuthorization: { reservationId, evidenceRef: `entry-auth-${suffix}`, product: "INTRADAY", reservedQuantityUnits: orderUnits,
          policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session });
    }
  });
  const brokers = new Map<string, PaperBrokerAdapter>();
  for (const leg of legs) {
    const broker = paper({ submission: "ACCEPTED", initialFills: filled ? [{ quantityUnits: filled, priceMinor: 1000 }] : [],
      steps: filled < orderUnits ? [{ kind: "FILL", quantityUnits: orderUnits - filled, priceMinor: 1000 }] : [] });
    const orderId = `entry-${suffix}-${leg.legId}`;
    assert.equal((await manager(broker).submit(orderId)).status, "PERSISTED");
    await processor().processRetained(orderId);
    brokers.set(leg.legId, broker);
  }
  return brokers;
}

import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
const workflow = () => new CloseWorkflowService(connection, f.scope, clock);
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { ids = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY" }).save({ session })); });

async function planned(spread = true, units = 10) {
  await seed({ spread, units, orderUnits: 10 });
  const close = await service().requestClose("position-1", "close-command");
  const children = await models.BrokerOrder.find({ intentId: close.intentId });
  const hedge = children.find(order => order.get("legId") === "hedge")!;
  const short = children.find(order => order.get("legId") === "short");
  await workflow().advance("position-1"); // Incorporate complete entry-fill receipts first.
  return { close, hedgeId: String(hedge.get("orderId")), shortId: short ? String(short.get("orderId")) : undefined };
}
async function execute(orderId: string, filled = 10) {
  const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: filled, priceMinor: 1000 }],
    steps: filled < 10 ? [{ kind: "FILL", quantityUnits: 10 - filled, priceMinor: 1000 }] : [] });
  assert.equal((await manager(broker).submit(orderId)).status, "PERSISTED");
  await processor().processRetained(orderId); return broker;
}
async function extraEntry(legId: string, phase = "READY", knowledge = "KNOWN") {
  const leg = (await position()).get("legs").find((l: { legId: string }) => l.legId === legId);
  const orderId = `extra-${legId}`;
  const request: BrokerOrderRequest = { ...f.scope, orderId, claimId: "unclaimed", intentId: "intent-1", positionId: "position-1",
    legId, contractKey: leg.contractKey, side: leg.entrySide, quantityUnits: 4, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY" };
  await tx(session => new models.BrokerOrder({ ...f.brokerOrder(orderId), legId, contractKey: leg.contractKey, side: leg.entrySide,
    sliceId: "extra", phase, knowledge, quantityUnits: 4, brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request),
    submissionAuthorization: { reservationId: "entry-reservation-1", evidenceRef: "extra-authorization", product: "INTRADAY",
      reservedQuantityUnits: 4, policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session }));
  return orderId;
}
async function terminalAssertions(intentId: string) {
  const pos = await position(), intent = await models.OrderIntent.findOne({ intentId }).orFail();
  const reservation = await models.RiskReservation.findOne({ intentId }).orFail();
  assert.equal(pos.get("lifecycle"), "CLOSED"); assert.equal(pos.get("activeCloseIntentId"), null);
  assert.equal(pos.get("potentiallyExecutingOrderCount"), 0); assert.equal(intent.get("state"), "COMPLETED");
  assert.equal(reservation.get("state"), "CONSUMED");
  for (const leg of pos.get("legs")) { assert.equal(leg.netQuantityUnits, 0); assert.equal(leg.closeHeldUnits, 0); assert.equal(leg.closeHoldIntentId, intentId); }
  for (const type of ["POSITION_CLOSED", "INTENT_COMPLETED", "RESERVATION_CONSUMED"])
    assert.equal(await models.TradingEvent.countDocuments({ eventType: type, causationId: intentId }), 1);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(event => event.get("accountSequence")), Array.from({ length: events.length }, (_, i) => i + 1));
}

for (const side of ["BUY", "SELL"] as const) test(`real single-leg ${side} finalizes atomically and replays`, async () => {
  await seed({ side }); const close = await service().requestClose("position-1", "close-command");
  const accountBefore = await models.TradingAccount.findOne(f.scope).orFail();
  const broker = await execute(close.orderIds[0]);
  assert.equal((await position()).get("lifecycle"), "PARTIALLY_CLOSING");
  const done = await workflow().advance("position-1"); assert.equal(done.status, "CLOSED"); await terminalAssertions(close.intentId!);
  const after = await snapshot();
  assert.deepEqual(await workflow().advance("position-1"), done);
  assert.equal((await manager(broker).submit(close.orderIds[0])).status, "CURRENT"); await processor().processRetained(close.orderIds[0]);
  assert.deepEqual(await snapshot(), after);
  const accountAfter = await models.TradingAccount.findOne(f.scope).orFail();
  for (const key of ["reservedMarginMinor", "reservedExposureMinor", "committedExposureMinor", "positionSlots", "realizedPnlMinor"])
    assert.equal(accountAfter.get(key), accountBefore.get(key));
});

test("real complete PAPER spread close preserves sole submit/fill paths and every replay", async () => {
  const { close, hedgeId, shortId } = await planned(); assert.ok(shortId);
  const shortBroker = await execute(shortId);
  assert.equal((await position()).get("legs.1.netQuantityUnits"), 0); assert.equal((await position()).get("legs.0.netQuantityUnits"), 10);
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
  const ready = await workflow().advance("position-1"); assert.deepEqual(ready.promotedOrderIds, [hedgeId]);
  assert.equal(await models.TradingEvent.countDocuments({ aggregateId: hedgeId, eventType: "ORDER_SUBMITTED" }), 0);
  const activated = await snapshot(); await workflow().advance("position-1"); assert.deepEqual(await snapshot(), activated);
  const hedgeBroker = await execute(hedgeId);
  assert.equal((await workflow().advance("position-1")).status, "CLOSED"); await terminalAssertions(close.intentId!);
  const done = await snapshot();
  await service().requestClose("position-1", "close-again");
  for (const [id, broker] of [[shortId, shortBroker], [hedgeId, hedgeBroker]] as const) {
    assert.equal((await manager(broker).submit(id)).status, "CURRENT"); await processor().processRetained(id);
    assert.equal((await broker.getOrders(f.scope)).length, 1);
  }
  await workflow().advance("position-1"); assert.deepEqual(await snapshot(), done);
  assert.equal(await models.BrokerOrder.countDocuments({ intentId: close.intentId }), 2);
  assert.equal(await models.Fill.countDocuments({ intentId: close.intentId }), 2);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ORDER_READY" }), 1);
});

test("real partial short close stays protected across reload then full fill activates", async () => {
  const { shortId, hedgeId } = await planned(); assert.ok(shortId); const broker = await execute(shortId, 4);
  const waiting = await workflow().advance("position-1"); assert.deepEqual(waiting.promotedOrderIds, []);
  assert.equal((await position()).get("legs.1.netQuantityUnits"), -6);
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
  await broker.advance({ ...f.scope, orderId: shortId }); await processor().process((await broker.getTrades(f.scope))[1]);
  assert.deepEqual((await workflow().advance("position-1")).promotedOrderIds, [hedgeId]);
});

test("real two concurrent activators publish one READY event", async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!);
  const results = await Promise.all([workflow().advance("position-1"), workflow().advance("position-1")]);
  assert.equal(results.reduce((n, r) => n + r.promotedOrderIds.length, 0), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ORDER_READY", aggregateId: hedgeId }), 1);
  const broker = paper({ submission: "ACCEPTED" });
  await Promise.all([manager(broker).submit(hedgeId), manager(broker).submit(hedgeId)]);
  assert.equal((await broker.getOrders(f.scope)).length, 1);
});

for (const phase of ["READY", "SUBMITTING", "ACKNOWLEDGED", "UNKNOWN"] as const)
 test(`real unresolved short ENTRY ${phase} blocks hedge removal`, async () => {
  const { shortId, hedgeId } = await planned(true, 14); await execute(shortId!);
  const orderId = await extraEntry("short");
  if (phase === "SUBMITTING") await (manager(paper()) as unknown as { claim(id: string): Promise<unknown> }).claim(orderId);
  if (phase === "ACKNOWLEDGED" || phase === "UNKNOWN") await manager(paper({ submission: phase === "UNKNOWN" ? "AMBIGUOUS" : "ACCEPTED" })).submit(orderId);
  const result = await workflow().advance("position-1"); assert.deepEqual(result.promotedOrderIds, []); assert.ok(result.blockingOrderIds.includes(orderId));
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
 });

test("real conclusively unsent reopening ENTRY allows subsequent hedge activation", async () => {
  const { shortId, hedgeId } = await planned(true, 14); await execute(shortId!); const orderId = await extraEntry("short");
  await workflow().advance("position-1");
  await tx(async session => { const order = await models.BrokerOrder.findOne({ orderId }).session(session).orFail(); order.set("phase", "NOT_SENT"); await order.save({ session }); });
  assert.deepEqual((await workflow().advance("position-1")).promotedOrderIds, [hedgeId]);
});

test("real reopening ENTRY added after promotion blocks OrderManager before broker dispatch", async () => {
  const { shortId, hedgeId } = await planned(true, 14); await execute(shortId!); await workflow().advance("position-1");
  await extraEntry("short"); const broker = paper(); const before = await snapshot();
  let submissions = 0; const submit = broker.submitOrder.bind(broker);
  broker.submitOrder = async request => { submissions++; return submit(request); };
  await assert.rejects(manager(broker).submit(hedgeId), /CLOSE_DEPENDENCY_NOT_AUTHORIZED/);
  assert.equal(submissions, 0);
  assert.equal((await broker.getOrders(f.scope)).length, 0); assert.deepEqual(await snapshot(), before);
});

test("real UNKNOWN full short-close remains unresolved and cannot activate hedge", async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!);
  await tx(async session => { const order = await models.BrokerOrder.findOne({ orderId: shortId }).session(session).orFail(); order.set("knowledge", "UNKNOWN"); await order.save({ session }); });
  const before = await snapshot(); const result = await workflow().advance("position-1");
  assert.deepEqual(result.promotedOrderIds, []); assert.deepEqual(await snapshot(), before);
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
});

for (const unknown of [false, true]) test(`real all flat with unresolved ENTRY unknown=${unknown} retains active reservation`, async () => {
  const { close, hedgeId } = await planned(false, 14); await execute(hedgeId);
  const extra = await extraEntry("hedge");
  if (unknown) await manager(paper({ submission: "AMBIGUOUS" })).submit(extra);
  assert.equal((await workflow().advance("position-1")).status, "BLOCKED");
  assert.equal((await position()).get("lifecycle"), "PARTIALLY_CLOSING"); assert.equal((await position()).get("activeCloseIntentId"), close.intentId);
  assert.equal((await models.OrderIntent.findOne({ intentId: close.intentId }).orFail()).get("state"), "EXECUTING");
  assert.equal((await models.RiskReservation.findOne({ intentId: close.intentId }).orFail()).get("state"), "HELD");
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_CLOSED" }), 0);
});

test("real concurrent finalizers and terminal replay emit one completion set", async () => {
  const { close, hedgeId } = await planned(false); await execute(hedgeId);
  const results = await Promise.all([workflow().advance("position-1"), workflow().advance("position-1")]);
  assert.deepEqual(results[0], results[1]); await terminalAssertions(close.intentId!);
  const before = await snapshot(); await workflow().advance("position-1"); assert.deepEqual(await snapshot(), before);
});

for (const failure of ["BrokerOrder", "ORDER_READY"] as const) test(`real activation ${failure} failure rolls back promotion and event sequence`, async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!); const before = await snapshot();
  const model = failure === "BrokerOrder" ? models.BrokerOrder : models.TradingEvent, original = model.prototype.save;
  model.prototype.save = function (...args: unknown[]) {
    if ((failure === "BrokerOrder" && this.get("orderId") === hedgeId) || (failure === "ORDER_READY" && this.get("eventType") === failure)) return Promise.reject(new Error("injected-activation"));
    return original.apply(this, args);
  };
  try { await assert.rejects(workflow().advance("position-1"), /injected-activation/); } finally { model.prototype.save = original; }
  assert.deepEqual(await snapshot(), before); assert.deepEqual((await workflow().advance("position-1")).promotedOrderIds, [hedgeId]);
});

for (const failure of ["Position", "INTENT_COMPLETED", "RESERVATION_CONSUMED", "POSITION_CLOSED"] as const)
 test(`real finalization ${failure} failure rolls back position, intent, reservation and sequence`, async () => {
  const { close, hedgeId } = await planned(false); await execute(hedgeId); const before = await snapshot();
  const model = failure === "Position" ? models.Position : models.TradingEvent, original = model.prototype.save;
  model.prototype.save = function (...args: unknown[]) {
    if (failure === "Position" || this.get("eventType") === failure) return Promise.reject(new Error("injected-finalization"));
    return original.apply(this, args);
  };
  try { await assert.rejects(workflow().advance("position-1"), /injected-finalization/); } finally { model.prototype.save = original; }
  assert.deepEqual(await snapshot(), before); await workflow().advance("position-1"); await terminalAssertions(close.intentId!);
 });

for (const defect of ["positionId", "intentId", "generation", "leg", "instrument"] as const)
 test(`real activation rejects wrong dependency ${defect}`, async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!);
  const changes = { positionId: { positionId: "wrong-position" }, intentId: { intentId: "wrong-intent" },
    generation: { "closePlan.closeGeneration": 99 }, leg: { "closePlan.dependsOnLegIds": ["hedge"] }, instrument: { contractKey: "wrong-contract" } };
  await connection.db!.collection("execution_orders").updateOne({ orderId: hedgeId }, { $set: changes[defect] });
  const before = await snapshot(); await assert.rejects(workflow().advance("position-1"), /CLOSE_.*(OWNERSHIP|CHILDREN)/);
  assert.deepEqual(await snapshot(), before);
 });

test("real advancement rejects LIVE and cross-account ownership", async () => {
  await planned(); assert.throws(() => new CloseWorkflowService(connection, { accountId: "LIVE:test", executionMode: "LIVE" }), /PAPER_ONLY/);
  await tx(session => new models.TradingAccount(f.account("PAPER:other")).save({ session }));
  await assert.rejects(new CloseWorkflowService(connection, { accountId: "PAPER:other", executionMode: "PAPER" }, clock).advance("position-1"), /REFERENCE_NOT_FOUND/);
});

test("real unresolved RECOVERY child on a dependency leg blocks activation", async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!);
  await tx(async session => {
    await new models.OrderIntent({ ...f.intent("other-recovery"), purpose: "RECOVERY", positionId: "position-1", state: "RISK_RESERVED",
      targetLegs: [{ legId: "short", contractKey: "NFO:contract-2", side: "BUY", targetUnits: 4 }], deadline }).save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder("recovery-order"), intentId: "other-recovery", legId: "short",
      contractKey: "NFO:contract-2", side: "BUY", quantityUnits: 4 }).save({ session });
  });
  const result = await workflow().advance("position-1"); assert.deepEqual(result.promotedOrderIds, []);
  assert.ok(result.blockingOrderIds.includes("recovery-order"));
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
});

test("real inconsistent flat Position retains the unfinished close", async () => {
  const { close, hedgeId } = await planned(false); await execute(hedgeId);
  await tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("integrity", "RECONCILIATION_REQUIRED"); await pos.save({ session }); });
  assert.equal((await workflow().advance("position-1")).status, "BLOCKED");
  assert.equal((await position()).get("activeCloseIntentId"), close.intentId);
  assert.equal((await models.RiskReservation.findOne({ intentId: close.intentId }).orFail()).get("state"), "HELD");
});

for (const barrier of ["HALTED", "expired"] as const) test(`real ${barrier} authorization prevents hedge promotion`, async () => {
  const { shortId, hedgeId } = await planned(); await execute(shortId!);
  if (barrier === "HALTED") await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set("admissionStatus", "HALTED"); await account.save({ session }); });
  const evaluator = barrier === "expired" ? new CloseWorkflowService(connection, f.scope, () => new Date(f.now.getTime() + 120000)) : workflow();
  assert.deepEqual((await evaluator.advance("position-1")).promotedOrderIds, []);
  assert.equal((await models.BrokerOrder.findOne({ orderId: hedgeId }).orFail()).get("phase"), "PLANNED");
});

test("real full known quantity does not bypass incomplete retained evidence", async () => {
  const { close, hedgeId } = await planned(false); await execute(hedgeId);
  // Simulate contradictory externally persisted finality; the successful path must not trust the label.
  await connection.db!.collection("execution_orders").updateOne({ orderId: hedgeId },
    { $set: { knowledge: "KNOWN", "submissionOutcome.evidenceComplete": false } });
  const before = await snapshot(); assert.equal((await workflow().advance("position-1")).status, "BLOCKED");
  assert.deepEqual(await snapshot(), before);
  assert.equal((await models.OrderIntent.findOne({ intentId: close.intentId }).orFail()).get("state"), "EXECUTING");
});

// Public-service reproduction: the physical trade exists, but its receipt transaction failed.
async function dispatchedHedge(knowledge: "KNOWN" | "UNKNOWN" = "KNOWN") {
  const plan = await planned(true, 14); await execute(plan.shortId!);
  assert.deepEqual((await workflow().advance("position-1")).promotedOrderIds, [plan.hedgeId]);
  const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  let submissions = 0; const submit = broker.submitOrder.bind(broker);
  broker.submitOrder = async request => { submissions++; return submit(request); };
  const original = models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save = function (...args: unknown[]) {
    if (this.get("eventType") === "ORDER_SUBMITTED" && this.get("aggregateId") === plan.hedgeId)
      return Promise.reject(new Error("injected-lost-outcome"));
    return original.apply(this, args);
  };
  try {
    const result = await manager(broker).submit(plan.hedgeId);
    assert.equal(result.status, "UNRESOLVED"); assert.equal(result.reason, "OUTCOME_PERSISTENCE_FAILED");
  } finally { models.TradingEvent.prototype.save = original; }
  const order = await models.BrokerOrder.findOne({ orderId: plan.hedgeId }).orFail();
  assert.equal(order.get("phase"), "SUBMITTING"); assert.ok(order.get("submissionClaim.claimId"));
  assert.equal(order.get("brokerOrderId"), undefined); assert.equal(order.get("submissionOutcome"), undefined);
  if (knowledge === "UNKNOWN") await tx(async session => {
    const submitted = await models.BrokerOrder.findOne({ orderId: plan.hedgeId }).session(session).orFail();
    submitted.set("knowledge", "UNKNOWN"); await submitted.save({ session });
  });
  const trades = await broker.getTrades(f.scope); assert.equal(trades.length, 1); assert.equal(trades[0].quantityUnits, 10);
  return { ...plan, broker, trade: trades[0], submissions: () => submissions, knowledge };
}
async function extraRecovery() {
  await tx(async session => {
    await new models.OrderIntent({ ...f.intent("post-submit-recovery"), purpose: "RECOVERY", positionId: "position-1", state: "RISK_RESERVED",
      targetLegs: [{ legId: "short", contractKey: "NFO:contract-2", side: "BUY", targetUnits: 4 }], deadline }).save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder("post-submit-recovery-order"), intentId: "post-submit-recovery", legId: "short",
      contractKey: "NFO:contract-2", side: "BUY", quantityUnits: 4 }).save({ session });
  });
  return "post-submit-recovery-order";
}
async function assertHedgeTruth(state: Awaited<ReturnType<typeof dispatchedHedge>>, unresolvedId: string) {
  const order = await models.BrokerOrder.findOne({ orderId: state.hedgeId }).orFail();
  assert.equal(order.get("filledUnits"), 10); assert.equal(order.get("phase"), "FILLED");
  assert.equal(order.get("knowledge"), state.knowledge); assert.equal(order.get("brokerOrderId"), state.trade.brokerOrderId);
  assert.equal(await models.Fill.countDocuments({ orderId: state.hedgeId }), 1);
  const fill = await models.Fill.findOne({ orderId: state.hedgeId }).orFail();
  assert.equal(fill.get("brokerTradeKey"), state.trade.brokerTradeKey);
  assert.equal((await position()).get("legs.0.netQuantityUnits"), 0);
  assert.equal((await position()).get("legs.0.closeHeldUnits"), 0);
  assert.equal((await position()).get("legs.0.closeHoldIntentId"), state.close.intentId);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "FILL_RECEIVED", aggregateId: fill.get("fillId") }), 1);
  const unresolved = await models.BrokerOrder.findOne({ orderId: unresolvedId }).orFail();
  const before = await snapshot();
  assert.equal((await processor().process(state.trade)).status, "DUPLICATE");
  assert.equal((await manager(state.broker).submit(state.hedgeId)).status, "CURRENT");
  const advancement = await workflow().advance("position-1");
  assert.equal(advancement.status, "BLOCKED"); assert.ok(advancement.blockingOrderIds.includes(unresolvedId));
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await models.BrokerOrder.findOne({ orderId: unresolvedId }).orFail()).toObject(), unresolved.toObject());
  assert.equal((await models.RiskReservation.findOne({ intentId: state.close.intentId }).orFail()).get("state"), "HELD");
  assert.equal((await position()).get("activeCloseIntentId"), state.close.intentId);
  assert.equal(state.submissions(), 1); assert.equal((await state.broker.getOrders(f.scope)).length, 1);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(event => event.get("accountSequence")), Array.from({ length: events.length }, (_, i) => i + 1));
}

for (const work of ["ENTRY", "RECOVERY"] as const) for (const knowledge of ["KNOWN", "UNKNOWN"] as const)
 test(`real post-dispatch lost outcome with ${work} records hedge truth knowledge=${knowledge}`, async () => {
  const state = await dispatchedHedge(knowledge);
  const unresolvedId = work === "ENTRY" ? await extraEntry("short") : await extraRecovery();
  assert.equal((await processor().process(state.trade)).status, "APPLIED");
  await assertHedgeTruth(state, unresolvedId);
 });

test("real post-dispatch hedge evidence still enforces ownership, overfill and conflicting duplicates", async () => {
  const state = await dispatchedHedge(); const unresolvedId = await extraEntry("short");
  const before = await snapshot();
  for (const change of [{ accountId: "PAPER:other" }, { executionMode: "LIVE" }, { positionId: "wrong-position" },
    { intentId: "wrong-intent" }, { orderId: "wrong-order" }, { legId: "short" }, { contractKey: "wrong-contract" },
    { side: "BUY" }, { brokerNamespace: "wrong-namespace" }]) {
    await assert.rejects(processor().process({ ...state.trade, ...change }));
    assert.deepEqual(await snapshot(), before);
  }
  await assert.rejects(processor().process({ ...state.trade, quantityUnits: 11 }), /QUANTITY_INVALID/);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await processor().process(state.trade)).status, "APPLIED");
  const after = await snapshot();
  await assert.rejects(processor().process({ ...state.trade, priceMinor: 1001 }), /DUPLICATE_FILL_CONFLICT/);
  await assert.rejects(processor().process({ ...state.trade, brokerOrderId: "wrong-broker-order" }), /FILL_BROKER_ORDER_MISMATCH/);
  await assert.rejects(processor().process({ ...state.trade, brokerTradeKey: "extra-trade", quantityUnits: 1 }), /ILLEGAL_TRANSITION/);
  assert.deepEqual(await snapshot(), after);
  await assertHedgeTruth(state, unresolvedId);
});

for (const failure of ["Position", "FILL_RECEIVED"] as const)
 test(`real post-dispatch hedge ${failure} failure rolls back all evidence and retries once`, async () => {
  const state = await dispatchedHedge("UNKNOWN"); const unresolvedId = await extraEntry("short");
  const before = await snapshot(), model = failure === "Position" ? models.Position : models.TradingEvent;
  const original = model.prototype.save;
  model.prototype.save = function (...args: unknown[]) {
    if (failure === "Position" || this.get("eventType") === failure) return Promise.reject(new Error("injected-hedge-fill"));
    return original.apply(this, args);
  };
  try { await assert.rejects(processor().process(state.trade), /injected-hedge-fill/); }
  finally { model.prototype.save = original; }
  assert.deepEqual(await snapshot(), before);
  assert.equal((await processor().process(state.trade)).status, "APPLIED");
  await assertHedgeTruth(state, unresolvedId);
 });

test("real post-dispatch hedge truth survives halt, expired policy and inconsistent workflow", async () => {
  const state = await dispatchedHedge("UNKNOWN"); const unresolvedId = await extraEntry("short");
  await tx(async session => {
    const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set({ admissionStatus: "HALTED", policyVersion: 2, executionEpoch: 2 }); await account.save({ session });
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("integrity", "RECONCILIATION_REQUIRED"); await pos.save({ session });
  });
  const lateProcessor = new FillProcessor(connection, f.scope, () => new Date(deadline.getTime() + 60000));
  assert.equal((await lateProcessor.process(state.trade)).status, "APPLIED");
  assert.equal((await position()).get("integrity"), "RECONCILIATION_REQUIRED");
  await assertHedgeTruth(state, unresolvedId);
});
