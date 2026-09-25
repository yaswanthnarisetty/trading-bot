import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { CloseIntentService, UnresolvedEntryExposureError } from "../../src/services/CloseIntentService";
import { OrderManager } from "../../src/services/OrderManager";
import { FillProcessor } from "../../src/services/FillProcessor";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import type { BrokerOrderRequest } from "../../src/brokers/BrokerAdapter";
import { submissionFingerprint } from "../../src/brokers/submissionEvidence";
import * as f from "../fixtures";
import { restoreHistoricalEntryClaim, recordHistoricalEntryOutcome } from "../historicalEntryFixture";

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
    // Zero-money authorization still exercises the real pre-dispatch rejection.
    const opening = options.zeroMoney ? await manager(broker).submit(orderId)
      : await recordHistoricalEntryOutcome(connection, f.scope, broker, clock, orderId);
    assert.equal(opening.status, "PERSISTED");
    await processor().processRetained(orderId);
    brokers.set(leg.legId, broker);
  }
  return brokers;
}
async function failSave(entity: "Position" | "TradingEvent" | "BrokerOrder" | "RiskReservation", work: () => Promise<void>) {
  const original = models[entity].prototype.save;
  models[entity].prototype.save = function () { return Promise.reject(new Error(`injected-${entity}-failure`)); };
  try { await work(); } finally { models[entity].prototype.save = original; }
}
async function assertBlocked(orderId: string, quantity: number) {
  const before = await snapshot();
  await assert.rejects(service().requestClose("position-1", "blocked-close"), (error: unknown) => {
    assert.ok(error instanceof UnresolvedEntryExposureError); assert.equal(error.code, "UNRESOLVED_ENTRY_EXPOSURE");
    assert.equal(error.positionId, "position-1");
    assert.ok(error.blockingOrders.some(order => order.intentId === "intent-1" && order.orderId === orderId && order.unresolvedQuantityUnits === quantity));
    return true;
  });
  assert.deepEqual(await snapshot(), before);
  assert.equal(await models.OrderIntent.countDocuments({ purpose: "CLOSE" }), 0);
  assert.equal(await models.RiskReservation.countDocuments({ kind: "CLOSE_QUANTITY" }), 0);
  assert.equal(await models.TradingEvent.countDocuments({ causationId: "blocked-close" }), 0);
  assert.equal((await position()).get("activeCloseIntentId"), null);
  assert.ok((await position()).get("legs").every((leg: { closeHeldUnits: number }) => leg.closeHeldUnits === 0));
}
async function remainder(phase = "READY", legId = "hedge") {
  const pos = await position(), leg = pos.get("legs").find((l: { legId: string }) => l.legId === legId);
  const orderId = `remainder-${legId}`;
  const request: BrokerOrderRequest = { ...f.scope, orderId, claimId: "unclaimed", intentId: "intent-1", positionId: "position-1",
    legId, contractKey: leg.contractKey, side: leg.entrySide, quantityUnits: 6, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY" };
  await tx(session => new models.BrokerOrder({ ...f.brokerOrder(orderId), legId, contractKey: leg.contractKey, side: leg.entrySide,
    quantityUnits: 6, sliceId: "remainder", phase, brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request),
    submissionAuthorization: { reservationId: "entry-reservation-1", evidenceRef: "remaining-entry-authorization", product: "INTRADAY",
      reservedQuantityUnits: 6, policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session }));
  return orderId;
}
async function cancelledRemainder(complete = true) {
  const orderId = await remainder();
  const broker = paper({ submission: "ACCEPTED", steps: [{ kind: "CONFIRM_CANCEL" }] });
  // Existing finality fixture, using actual simulator evidence. No cancellation service is introduced.
  const claimed = await restoreHistoricalEntryClaim(connection, f.scope, broker, clock, orderId);
  const outcome = await broker.submitOrder(claimed.request); assert.equal(outcome.kind, "ACCEPTED");
  const observed = await broker.getOrder({ ...f.scope, orderId }); assert.ok(observed);
  await broker.cancelOrder(observed); const final = await broker.advance({ ...f.scope, orderId });
  await tx(async session => {
    const child = await models.BrokerOrder.findOne({ orderId }).session(session).orFail();
    child.set({ phase: "CANCELLED", knowledge: "KNOWN", cancellation: "CONFIRMED", brokerOrderId: final.brokerOrderId,
      submissionOutcome: { outcome, observedOrder: final, trades: [], evidenceComplete: complete, pendingFillProcessing: false } });
    await child.save({ session });
  });
  return orderId;
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { ids = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY" }).save({ session })); });

for (const side of ["BUY", "SELL"] as const) test(`real ${side === "BUY" ? "long" : "short"} close reserves actual units and creates immutable authorized child`, async () => {
  await seed({ side }); const accountBefore = await models.TradingAccount.findOne(f.scope).orFail();
  const result = await service().requestClose("position-1", "close-command"); assert.equal(result.status, "CREATED");
  const pos = await position(), child = await models.BrokerOrder.findOne({ orderId: result.orderIds[0] }).orFail();
  assert.equal(pos.get("legs.0.closeHeldUnits"), 10); assert.equal(pos.get("legs.0.closeHoldIntentId"), result.intentId);
  assert.equal(pos.get("activeCloseIntentId"), result.intentId); assert.equal(pos.get("closeGeneration"), 1); assert.equal(pos.get("lifecycle"), "CLOSING");
  assert.equal(child.get("quantityUnits"), 10); assert.equal(child.get("side"), side === "BUY" ? "SELL" : "BUY");
  assert.equal(child.get("phase"), "READY"); assert.equal(child.get("limitPriceMinor"), 1000); assert.equal(child.get("filledUnits"), 0);
  assert.equal(child.get("submissionClaim"), undefined);
  const reservation = await models.RiskReservation.findOne({ reservationId: result.reservationId }).orFail();
  assert.equal(reservation.get("kind"), "CLOSE_QUANTITY");
  for (const key of ["initialMarginMinor", "remainingMarginMinor", "initialExposureMinor", "remainingExposureMinor", "positionSlots"]) assert.equal(reservation.get(key), 0);
  const accountAfter = await models.TradingAccount.findOne(f.scope).orFail();
  for (const key of ["reservedMarginMinor", "reservedExposureMinor", "committedExposureMinor", "realizedPnlMinor", "positionSlots"]) assert.equal(accountAfter.get(key), accountBefore.get(key));
  assert.deepEqual((await models.TradingEvent.find({ causationId: "close-command" }).sort({ accountSequence: 1 })).map(event => event.get("eventType")),
    ["INTENT_CREATED", "RISK_RESERVED", "POSITION_CLOSE_REQUESTED"]);
});

for (const command of ["same-command", "different-command"]) test(`real close replay ${command} and process restart reuse one active workflow`, async () => {
  await seed(); const first = await service().requestClose("position-1", "same-command"); const before = await snapshot();
  const replay = await service().requestClose("position-1", command);
  assert.equal(replay.status, "EXISTING"); assert.equal(replay.intentId, first.intentId); assert.deepEqual(replay.orderIds, first.orderIds);
  assert.deepEqual(await snapshot(), before);
});

for (const same of [true, false]) test(`real concurrent close commands same=${same} create one intent, hold, reservation and order set`, async () => {
  await seed(); const results = await Promise.all([service().requestClose("position-1", "command-A"), service().requestClose("position-1", same ? "command-A" : "command-B")]);
  assert.equal(results.filter(result => result.status === "CREATED").length, 1); assert.equal(results[0].intentId, results[1].intentId);
  assert.equal(await models.OrderIntent.countDocuments({ purpose: "CLOSE" }), 1); assert.equal(await models.RiskReservation.countDocuments({ kind: "CLOSE_QUANTITY" }), 1);
  assert.equal(await models.BrokerOrder.countDocuments({ intentId: results[0].intentId }), 1); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_CLOSE_REQUESTED" }), 1);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(event => event.get("accountSequence")), Array.from({ length: events.length }, (_, i) => i + 1));
});

for (const [side, filled] of [["BUY", 4], ["BUY", 10], ["SELL", 4], ["SELL", 10]] as const)
  test(`real close request → OrderManager → PaperBroker → FillProcessor ${side}/${filled}`, async () => {
    await seed({ side }); const close = await service().requestClose("position-1", "close-command");
    const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: filled, priceMinor: 1000 }] });
    assert.equal((await manager(broker).submit(close.orderIds[0])).status, "PERSISTED");
    assert.equal((await position()).get("legs.0.exitFilledUnits"), 0); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
    assert.equal((await processor().processRetained(close.orderIds[0])).status, "PROCESSED"); const pos = await position();
    assert.equal(pos.get("legs.0.netQuantityUnits"), filled === 10 ? 0 : (side === "BUY" ? 1 : -1) * (10 - filled));
    assert.equal(pos.get("legs.0.closeHeldUnits"), 10 - filled); assert.equal(pos.get("legs.0.closeHoldIntentId"), close.intentId);
    assert.equal(pos.get("lifecycle"), "PARTIALLY_CLOSING"); assert.equal(pos.get("activeCloseIntentId"), close.intentId);
    assert.equal(await models.Fill.countDocuments({ intentId: close.intentId }), 1);
    assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_PARTIALLY_CLOSED" }), 1);
    assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_CLOSED" }), 0);
    const before = await snapshot(); const repeat = await service().requestClose("position-1", "second-click");
    assert.equal(repeat.intentId, close.intentId); assert.equal(repeat.status, filled === 10 ? "TERMINAL" : "EXISTING");
    await processor().processRetained(close.orderIds[0]); assert.deepEqual(await snapshot(), before);
  });

test("real partial entry remainder blocks close planning without mutation", async () => {
  await seed({ units: 100, filled: 40 }); await assertBlocked("entry-1-hedge", 60);
});

for (const phase of ["SUBMITTING", "UNKNOWN"] as const) test(`real ${phase} close workflow retains holds and never creates replacement children`, async () => {
  await seed(); const close = await service().requestClose("position-1", "close-command"); const broker = paper({ submission: "AMBIGUOUS" });
  if (phase === "SUBMITTING") {
    const paused = manager(broker) as unknown as { claim(id: string): Promise<unknown> }; await paused.claim(close.orderIds[0]);
  } else { await manager(broker).submit(close.orderIds[0]); assert.equal((await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail()).get("knowledge"), "UNKNOWN"); }
  const before = await snapshot(); const replay = await service().requestClose("position-1", "new-command");
  assert.equal(replay.intentId, close.intentId); assert.deepEqual(replay.orderIds, close.orderIds); assert.deepEqual(await snapshot(), before);
});

test("real orphan close hold fails closed without stealing or doubling its reserved quantity", async () => {
  await seed(); await tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("legs.0.closeHeldUnits", 4); await pos.save({ session }); });
  const before = await snapshot(); await assert.rejects(service().requestClose("position-1", "close-command"), /CLOSE_HOLD_WITHOUT_ACTIVE_WORKFLOW/);
  assert.deepEqual(await snapshot(), before);
});

test("real account/mode isolation and command-key ownership", async () => {
  await seed(); assert.throws(() => new CloseIntentService(connection, { accountId: "LIVE:other", executionMode: "LIVE" }), /PAPER_ONLY/);
  await tx(session => new models.TradingAccount(f.account("PAPER:other")).save({ session }));
  const before = await snapshot();
  await assert.rejects(new CloseIntentService(connection, { accountId: "PAPER:other", executionMode: "PAPER" }, clock).requestClose("position-1", "command"), /REFERENCE_NOT_FOUND/);
  assert.deepEqual(await snapshot(), before);
  await seed({ suffix: "2" }); await service().requestClose("position-1", "bound-command"); const bound = await snapshot();
  await assert.rejects(service().requestClose("position-2", "bound-command"), /COMMAND_KEY_CONFLICT/); assert.deepEqual(await snapshot(), bound);
});

test("real flat position with working entry fails closed instead of returning terminal", async () => {
  await seed({ filled: 0 }); await assertBlocked("entry-1-hedge", 10);
});

for (const failure of ["Position", "TradingEvent", "BrokerOrder", "RiskReservation"] as const)
  test(`real close ${failure} failure rolls back intent, hold, authorization, children and audit sequence`, async () => {
    await seed(); const before = await snapshot(); await failSave(failure, async () => {
      await assert.rejects(service().requestClose("position-1", "close-command"), /injected-/);
    }); assert.deepEqual(await snapshot(), before);
    assert.equal((await service().requestClose("position-1", "close-command")).status, "CREATED");
  });

test("real close refuses fabricated position exposure", async () => {
  await seed(); await connection.db!.collection("execution_positions").updateOne({ positionId: "position-1" }, { $set: { "legs.0.entryFilledUnits": 9, lifecycle: "PARTIALLY_OPENED" } });
  const before = await snapshot(); await assert.rejects(service().requestClose("position-1", "close-command"), /POSITION_FILL_EVIDENCE_MISMATCH/);
  assert.deepEqual(await snapshot(), before);
});

test("real late opening fill increases exposure without consuming close holds or duplicating the active close", async () => {
  await seed({ orderUnits: 4 }); const close = await service().requestClose("position-1", "close-command");
  // New external entry work AFTER planning represents a later inconsistency, not permission to resize.
  const orderId = await remainder(); const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 6, priceMinor: 1000 }] });
  await recordHistoricalEntryOutcome(connection, f.scope, broker, clock, orderId); await processor().processRetained(orderId);
  assert.equal((await position()).get("legs.0.netQuantityUnits"), 10); assert.equal((await position()).get("legs.0.closeHeldUnits"), 4);
  assert.equal((await position()).get("integrity"), "RECONCILIATION_REQUIRED");
  const before = await snapshot();
  assert.equal((await service().requestClose("position-1", "close-again")).intentId, close.intentId);
  assert.equal(await models.BrokerOrder.countDocuments({ intentId: close.intentId }), 1);
  assert.deepEqual(await snapshot(), before);
});

test("real spread plans short covering READY and hedge removal PLANNED with durable dependencies", async () => {
  await seed({ spread: true, units: 130 }); const close = await service().requestClose("position-1", "close-spread");
  const children = await models.BrokerOrder.find({ intentId: close.intentId });
  const short = children.find(child => child.get("legId") === "short")!, hedge = children.find(child => child.get("legId") === "hedge")!;
  assert.equal(short.get("side"), "BUY"); assert.equal(short.get("phase"), "READY"); assert.equal(short.get("quantityUnits"), 130);
  assert.equal(hedge.get("side"), "SELL"); assert.equal(hedge.get("phase"), "PLANNED"); assert.deepEqual([...hedge.get("closePlan.dependsOnLegIds")], ["short"]);
  const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 65, priceMinor: 1000 }] });
  assert.equal((await manager(broker).submit(hedge.get("orderId"))).status, "CURRENT"); assert.equal((await broker.getOrders(f.scope)).length, 0);
  await manager(broker).submit(short.get("orderId")); await processor().processRetained(short.get("orderId"));
  assert.equal((await position()).get("legs.1.netQuantityUnits"), -65); assert.equal((await position()).get("legs.0.closeHeldUnits"), 130);
  await assert.rejects(tx(async session => { const changed = await models.BrokerOrder.findOne({ orderId: hedge.get("orderId") }).session(session).orFail();
    changed.set("phase", "READY"); await changed.save({ session }); }), /CLOSE_DEPENDENCY_NOT_AUTHORIZED/);
  assert.equal((await manager(broker).submit(hedge.get("orderId"))).status, "CURRENT");
  const before = await snapshot(); assert.equal((await service().requestClose("position-1", "close-spread-again")).intentId, close.intentId);
  assert.deepEqual(await snapshot(), before);
});

test("real persisted dependency cannot be removed to enable hedge dispatch", async () => {
  await seed({ spread: true }); const close = await service().requestClose("position-1", "close-spread");
  const hedge = await models.BrokerOrder.findOne({ intentId: close.intentId, legId: "hedge" }).orFail();
  const before = await snapshot(); await assert.rejects(tx(async session => {
    const changed = await models.BrokerOrder.findOne({ orderId: hedge.get("orderId") }).session(session).orFail();
    changed.set("closePlan.dependsOnLegIds", []); changed.set("phase", "READY"); await changed.save({ session });
  })); assert.deepEqual(await snapshot(), before);
});

test("real missing or stale explicit close pricing policy prevents unsafe default pricing", async () => {
  await seed({ policy: false }); const before = await snapshot();
  await assert.rejects(service().requestClose("position-1", "close-command"), /CLOSE_POLICY_REQUIRED/); assert.deepEqual(await snapshot(), before);
});

test("real halted account plans holds but cannot dispatch a close through OrderManager", async () => {
  await seed(); await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set("admissionStatus", "HALTED"); await account.save({ session }); });
  const close = await service().requestClose("position-1", "close-command");
  assert.equal((await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail()).get("phase"), "PLANNED");
  const broker = paper(); assert.equal((await manager(broker).submit(close.orderIds[0])).status, "CURRENT");
  assert.equal((await broker.getOrders(f.scope)).length, 0); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
});

for (const defect of ["expired", "policy-version", "missing-leg-price"] as const)
  test(`real ${defect} persisted close policy rejects without financial mutation`, async () => {
    await seed(); await tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
      if (defect === "expired") pos.set("closePolicy.expiresAt", f.now);
      else if (defect === "policy-version") pos.set("closePolicy.policyVersion", 2);
      else pos.set("closePolicy.legLimits", [{ legId: "not-this-leg", limitPriceMinor: 1000 }]);
      await pos.save({ session }); });
    const before = await snapshot(); await assert.rejects(service().requestClose("position-1", "bad-policy"), /CLOSE_POLICY_NOT_CURRENT/);
    assert.deepEqual(await snapshot(), before);
  });

test("real last close-request event failure rolls back earlier events and all reservations", async () => {
  await seed(); const before = await snapshot(); const original = models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save = function (...args: unknown[]) {
    return this.get("eventType") === "POSITION_CLOSE_REQUESTED" ? Promise.reject(new Error("last-event-failure")) : original.apply(this, args);
  };
  try { await assert.rejects(service().requestClose("position-1", "close-command"), /last-event-failure/); }
  finally { models.TradingEvent.prototype.save = original; }
  assert.deepEqual(await snapshot(), before);
});

test("real dependent hedge stays PLANNED even after short fills; activation is explicitly deferred", async () => {
  await seed({ spread: true }); const close = await service().requestClose("position-1", "close-spread");
  const short = await models.BrokerOrder.findOne({ intentId: close.intentId, legId: "short" }).orFail();
  const hedge = await models.BrokerOrder.findOne({ intentId: close.intentId, legId: "hedge" }).orFail();
  const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  await manager(broker).submit(short.get("orderId")); await processor().processRetained(short.get("orderId"));
  assert.equal((await position()).get("legs.1.netQuantityUnits"), 0);
  assert.equal((await manager(broker).submit(hedge.get("orderId"))).status, "CURRENT");
  assert.equal((await broker.getOrders(f.scope)).length, 1); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
});

test("real planned close children cannot exceed their shared owned leg hold", async () => {
  await seed(); const close = await service().requestClose("position-1", "close-command");
  const child = await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail(); const before = await snapshot();
  await assert.rejects(tx(async session => {
    const { _id, ...copy } = child.toObject();
    await new models.BrokerOrder({ ...copy, orderId: "duplicate-close-child", sliceId: "extra-slice", quantityUnits: 6 }).save({ session });
  }), /CLOSE_HOLD_EXCEEDED/); assert.deepEqual(await snapshot(), before);
});

test("real concurrent opening fill and close planning cannot commit a stale smaller hold", async () => {
  const brokers = await seed({ filled: 4 }); const broker = brokers.get("hedge")!;
  await broker.advance({ ...f.scope, orderId: "entry-1-hedge" }); const trades = await broker.getTrades(f.scope);
  const [close, fill] = await Promise.allSettled([service().requestClose("position-1", "racing-close"), processor().process(trades[1])]);
  assert.equal(fill.status, "fulfilled"); const pos = await position(); assert.equal(pos.get("legs.0.netQuantityUnits"), 10);
  if (close.status === "rejected") {
    assert.ok(close.reason instanceof UnresolvedEntryExposureError); assert.equal(pos.get("legs.0.closeHeldUnits"), 0);
    assert.equal(await models.OrderIntent.countDocuments({ purpose: "CLOSE" }), 0);
    assert.equal(await models.TradingEvent.countDocuments({ causationId: "racing-close" }), 0);
  } else {
    assert.equal(pos.get("legs.0.closeHeldUnits"), 10);
    assert.equal((await models.BrokerOrder.findOne({ orderId: close.value.orderIds[0] }).orFail()).get("quantityUnits"), 10);
  }
  const final = await service().requestClose("position-1", "after-fill");
  assert.equal((await models.BrokerOrder.findOne({ orderId: final.orderIds[0] }).orFail()).get("quantityUnits"), 10);
  assert.equal(await models.OrderIntent.countDocuments({ purpose: "CLOSE" }), 1);
});

test("real CLOSED position returns terminal without reopening its completed execution chain", async () => {
  await seed(); const close = await service().requestClose("position-1", "close-command");
  const broker = paper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] });
  await manager(broker).submit(close.orderIds[0]); await processor().processRetained(close.orderIds[0]);
  // Seed existing conclusive finality, outside the close service. No new confirmation operation is introduced.
  await tx(async session => {
    for (const child of await models.BrokerOrder.find({ positionId: "position-1" }).session(session)) {
      child.set("knowledge", "KNOWN"); await child.save({ session });
    }
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ lifecycle: "CLOSED", activeCloseIntentId: null, potentiallyExecutingOrderCount: 0, closureEvidenceRefs: ["existing-finality-proof"] });
    await pos.save({ session });
  });
  const before = await snapshot(); const result = await service().requestClose("position-1", "new-click");
  assert.equal(result.status, "TERMINAL"); assert.equal(result.reason, "CLOSED"); assert.deepEqual(await snapshot(), before);
});

test("real close child economics remain fixed after persisted policy changes", async () => {
  await seed(); const close = await service().requestClose("position-1", "close-command");
  await tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("closePolicy.legLimits.0.limitPriceMinor", 2000); pos.set("closePolicy.product", "DELIVERY"); await pos.save({ session }); });
  const replay = await service().requestClose("position-1", "new-click"); assert.equal(replay.intentId, close.intentId);
  const child = await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail();
  child.set("quantityUnits", 100); child.set("limitPriceMinor", 1); child.set("side", "BUY");
  assert.equal(child.get("quantityUnits"), 10); assert.equal(child.get("limitPriceMinor"), 1000); assert.equal(child.get("side"), "SELL");
  const broker = paper(); await manager(broker).submit(close.orderIds[0]);
  assert.equal((await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail()).get("submissionClaim.request.product"), "INTRADAY");
});

for (const phase of ["PLANNED", "READY", "SUBMITTING", "SUBMITTED", "ACKNOWLEDGED"] as const)
  test(`real ${phase} ENTRY remainder blocks new close with no committed side effects`, async () => {
    await seed({ orderUnits: 4 }); const orderId = await remainder(phase === "PLANNED" ? phase : "READY");
    if (phase === "SUBMITTING") await restoreHistoricalEntryClaim(connection, f.scope, paper(), clock, orderId);
    if (["SUBMITTED", "ACKNOWLEDGED"].includes(phase)) await recordHistoricalEntryOutcome(connection, f.scope, paper({ submission: "ACCEPTED", delayedAcknowledgement: phase === "SUBMITTED" }), clock, orderId);
    assert.equal((await models.BrokerOrder.findOne({ orderId }).orFail()).get("phase"), phase);
    await assertBlocked(orderId, 6);
  });

for (const knowledge of ["KNOWN", "UNKNOWN", "RECONCILIATION_REQUIRED"] as const)
  test(`real PARTIALLY_FILLED ENTRY ${knowledge} blocks remaining six units`, async () => {
    await seed({ side: "SELL", filled: 4 });
    await tx(async session => { const entry = await models.BrokerOrder.findOne({ orderId: "entry-1-hedge" }).session(session).orFail();
      entry.set("knowledge", knowledge); await entry.save({ session }); });
    await assertBlocked("entry-1-hedge", 6);
  });

for (const phase of ["REJECTED", "CANCELLED", "NOT_SENT"] as const)
  test(`real conclusively ${phase} ENTRY remainder allows fill-backed close`, async () => {
    await seed({ orderUnits: 4 });
    if (phase === "CANCELLED") await cancelledRemainder();
    else { const orderId = await remainder(phase === "NOT_SENT" ? phase : "READY");
      if (phase === "REJECTED") await recordHistoricalEntryOutcome(connection, f.scope, paper({ submission: "REJECTED" }), clock, orderId); }
    const close = await service().requestClose("position-1", "terminal-entry-close");
    assert.equal(close.status, "CREATED"); assert.equal((await position()).get("legs.0.closeHeldUnits"), 4);
    assert.equal((await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail()).get("quantityUnits"), 4);
  });

for (const knowledge of ["UNKNOWN", "RECONCILIATION_REQUIRED"] as const)
  test(`real terminal cancellation with ${knowledge} does not prove non-fillability`, async () => {
    await seed({ orderUnits: 4 }); const orderId = await cancelledRemainder();
    await tx(async session => { const child = await models.BrokerOrder.findOne({ orderId }).session(session).orFail();
      child.set("knowledge", knowledge); await child.save({ session }); });
    await assertBlocked(orderId, 6);
  });

test("real cancellation with incomplete evidence fails closed", async () => {
  await seed({ orderUnits: 4 }); await assertBlocked(await cancelledRemainder(false), 6);
});

test("real terminal phase alone without retained cancellation evidence fails closed", async () => {
  await seed({ orderUnits: 4 }); const orderId = await remainder();
  await tx(async session => { const child = await models.BrokerOrder.findOne({ orderId }).session(session).orFail();
    child.set({ phase: "CANCELLED", cancellation: "CONFIRMED" }); await child.save({ session }); });
  await assertBlocked(orderId, 6);
});

test("real unrelated position working ENTRY does not block this position", async () => {
  await seed(); await seed({ suffix: "2", filled: 0 });
  const close = await service().requestClose("position-1", "only-position-1");
  assert.equal(close.status, "CREATED"); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
});

for (const legId of ["hedge", "short"]) test(`real unresolved ${legId} ENTRY leg blocks the entire spread close`, async () => {
  await seed({ spread: true, orderUnits: 4 }); await assertBlocked(await remainder("READY", legId), 6);
});

test("real new UNKNOWN entry after close creation reuses the existing workflow unchanged", async () => {
  await seed({ orderUnits: 4 }); const close = await service().requestClose("position-1", "first-close");
  const orderId = await remainder(); await recordHistoricalEntryOutcome(connection, f.scope, paper({ submission: "AMBIGUOUS" }), clock, orderId);
  const before = await snapshot(), again = await service().requestClose("position-1", "again");
  assert.equal(again.intentId, close.intentId); assert.deepEqual(again.orderIds, close.orderIds); assert.deepEqual(await snapshot(), before);
});

test("real zero-money ordinary ENTRY cannot submit", async () => {
  await assert.rejects(seed({ zeroMoney: true }), /AUTHORIZATION_NOT_CURRENT/);
  const order = await models.BrokerOrder.findOne({ orderId: "entry-1-hedge" }).orFail();
  assert.equal(order.get("phase"), "READY"); assert.equal(order.get("submissionClaim"), undefined);
  assert.equal(await models.Fill.countDocuments(), 0); assert.equal(await models.TradingEvent.countDocuments(), 0);
});

test("real ENTRY cannot acquire CLOSE_QUANTITY authorization", async () => {
  await seed(); const before = await snapshot();
  await assert.rejects(tx(session => new models.RiskReservation({ ...f.reservation("invalid-close-reservation"), kind: "CLOSE_QUANTITY",
    initialMarginMinor: 0, remainingMarginMinor: 0, initialExposureMinor: 0, remainingExposureMinor: 0, positionSlots: 0 }).save({ session })), /quantity reservation purpose/);
  assert.deepEqual(await snapshot(), before);
});

for (const defect of ["position", "leg", "generation", "reservation"] as const)
  test(`real CLOSE authorization rejects wrong ${defect}`, async () => {
    await seed(); const close = await service().requestClose("position-1", "close");
    await seed({ suffix: "2" }); const other = await service().requestClose("position-2", "other-close");
    assert.ok(other.reservationId);
    const child = await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail();
    const { _id, ...copy } = child.toObject<{ _id: unknown; positionId: string; legId: string;
      closePlan: { closeGeneration: number }; submissionAuthorization: { reservationId: string }; [key: string]: unknown }>();
    if (defect === "position") copy.positionId = "position-2";
    if (defect === "leg") copy.legId = "not-this-leg";
    if (defect === "generation") copy.closePlan.closeGeneration += 1;
    if (defect === "reservation") copy.submissionAuthorization.reservationId = other.reservationId;
    const before = await snapshot();
    await assert.rejects(tx(session => new models.BrokerOrder({ ...copy, orderId: "invalid-child", sliceId: "invalid" }).save({ session })), /LEDGER_RELATIONSHIP_MISMATCH/);
    assert.deepEqual(await snapshot(), before);
  });

test("real zero close LIMIT price cannot persist or authorize", async () => {
  await seed(); const before = await snapshot();
  await assert.rejects(tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("closePolicy.legLimits.0.limitPriceMinor", 0); await pos.save({ session }); }), /limitPriceMinor/);
  assert.deepEqual(await snapshot(), before);
  // Legacy/native corruption must also fail at the planner, without any close records.
  await connection.db!.collection("execution_positions").updateOne({ positionId: "position-1" }, { $set: { "closePolicy.legLimits.0.limitPriceMinor": 0 } });
  const corrupted = await snapshot(); await assert.rejects(service().requestClose("position-1", "zero-price"), /limitPriceMinor/);
  assert.deepEqual(await snapshot(), corrupted); assert.equal(await models.OrderIntent.countDocuments({ purpose: "CLOSE" }), 0);
});

test("real flat UNKNOWN entry cannot be reported terminal", async () => {
  await seed({ filled: 0 });
  await tx(async session => { const entry = await models.BrokerOrder.findOne({ orderId: "entry-1-hedge" }).session(session).orFail();
    entry.set("knowledge", "UNKNOWN"); await entry.save({ session }); });
  await assertBlocked("entry-1-hedge", 10);
});

test("real fully incorporated FILLED entry remains nonblocking with UNKNOWN snapshot knowledge", async () => {
  await seed(); await tx(async session => { const entry = await models.BrokerOrder.findOne({ orderId: "entry-1-hedge" }).session(session).orFail();
    entry.set("knowledge", "UNKNOWN"); await entry.save({ session }); });
  const close = await service().requestClose("position-1", "full-entry");
  assert.equal(close.status, "CREATED"); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
});

for (const defect of ["accountId", "executionMode", "positionId", "intentId", "legId", "contractKey"] as const)
  test(`real ENTRY gate rejects corrupt ${defect} ownership`, async () => {
    await seed(); await seed({ suffix: "2" });
    const wrong = { accountId: "PAPER:other", executionMode: "LIVE", positionId: "position-2", intentId: "intent-2", legId: "another-leg", contractKey: "another-contract" };
    // Administrative corruption fixture; supported write APIs already reject these relationships.
    await connection.db!.collection("execution_orders").updateOne({ orderId: "entry-1-hedge" },
      { $set: { [defect]: wrong[defect], ...(defect === "intentId" ? { sliceId: "corrupt-intent-slice" } : {}) } });
    const before = await snapshot(); await assert.rejects(service().requestClose("position-1", "bad-owner"), /ENTRY_(FILL_)?OWNERSHIP_MISMATCH/);
    assert.deepEqual(await snapshot(), before);
  });

test("real REJECTED phase without conclusive rejection evidence blocks", async () => {
  await seed({ orderUnits: 4 }); await assertBlocked(await remainder("REJECTED"), 6);
});

test("real UNKNOWN rejection cannot authorize close", async () => {
  await seed({ orderUnits: 4 }); const orderId = await remainder(); await recordHistoricalEntryOutcome(connection, f.scope, paper({ submission: "REJECTED" }), clock, orderId);
  await tx(async session => { const child = await models.BrokerOrder.findOne({ orderId }).session(session).orFail();
    child.set("knowledge", "UNKNOWN"); await child.save({ session }); });
  await assertBlocked(orderId, 6);
});
