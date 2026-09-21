import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { FillProcessor } from "../../src/services/FillProcessor";
import { OrderManager } from "../../src/services/OrderManager";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import type { BrokerOrderRequest, BrokerTradeObservation } from "../../src/brokers/BrokerAdapter";
import { submissionFingerprint } from "../../src/brokers/submissionEvidence";
import { transitionOrder, type OrderState } from "../../src/domain/OrderStateMachine";
import type { FillEvidence } from "../../src/domain/execution";
import * as f from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
const models = executionModels(connection);
const clock = () => new Date(f.now);
const processor = () => new FillProcessor(connection, f.scope, clock);
let ids = 0;
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); }
  finally { await session.endSession(); }
}
const order = () => models.BrokerOrder.findOne({ orderId: "order-1" }).orFail();
const position = () => models.Position.findOne({ positionId: "position-1" }).orFail();
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [name, model] of Object.entries(models)) result[name] = await model.find().sort({ _id: 1 }).lean();
  return result;
}
function broker(plan: PaperScenario) {
  return new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` }, scenario: () => plan });
}
async function seed(quantity = 10, spread = false, side: "BUY" | "SELL" = "BUY", limit = 1000) {
  const targetLegs = [{ legId: "hedge", contractKey: "NFO:contract-1", side, targetUnits: quantity },
    ...(spread ? [{ legId: "short", contractKey: "NFO:contract-2", side: "SELL" as const, targetUnits: quantity }] : [])];
  const deadline = new Date(f.now.getTime() + 60000);
  await tx(async session => {
    await new models.StrategySignal(f.signal()).save({ session });
    await new models.OrderIntent({ ...f.intent(), state: "RISK_RESERVED", targetLegs, deadline }).save({ session });
    await new models.Position({ ...f.position(), legs: targetLegs.map(l => ({ ...f.position().legs[0], legId: l.legId,
      contractKey: l.contractKey, entrySide: l.side, targetUnits: l.targetUnits })) }).save({ session });
    await new models.RiskReservation({ ...f.reservation(), instrumentKeys: targetLegs.map(l => l.contractKey) }).save({ session });
    for (const [index, leg] of targetLegs.entries()) {
      const orderId = `order-${index + 1}`;
      const request: BrokerOrderRequest = { ...f.scope, orderId, claimId: "unclaimed", intentId: "intent-1", positionId: "position-1",
        legId: leg.legId, contractKey: leg.contractKey, side: leg.side, quantityUnits: quantity, orderType: "LIMIT", limitPriceMinor: limit, product: "INTRADAY" };
      await new models.BrokerOrder({ ...f.brokerOrder(orderId), legId: leg.legId, contractKey: leg.contractKey, side: leg.side,
        quantityUnits: quantity, limitPriceMinor: limit, phase: "READY", brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request),
        submissionAuthorization: { reservationId: "reservation-1", evidenceRef: "authorization-1", product: "INTRADAY",
          reservedQuantityUnits: quantity, policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session });
    }
  });
}
async function submit(plan: PaperScenario, orderId = "order-1") {
  const paper = broker(plan);
  assert.equal((await new OrderManager(connection, f.scope, paper, clock).submit(orderId)).status, "PERSISTED");
  return { paper, trades: await paper.getTrades(f.scope) };
}
async function setup(fills = [{ quantityUnits: 4, priceMinor: 990 }], quantity = 10) {
  await seed(quantity); return submit({ submission: "ACCEPTED", initialFills: fills });
}
async function failSave(entity: "Position" | "TradingEvent", matches: (doc: mongoose.Document) => boolean, work: () => Promise<void>) {
  const original = models[entity].prototype.save;
  models[entity].prototype.save = function (...args: unknown[]) {
    if (matches(this)) return Promise.reject(new Error("injected-save-failure"));
    return original.apply(this, args);
  };
  try { await work(); } finally { models[entity].prototype.save = original; }
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => {
  ids = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY" }).save({ session }));
});

for (const quantity of [4, 10]) test(`real immediate ${quantity === 4 ? "partial" : "full"} fill handoff and replay`, async () => {
  const { trades } = await setup([{ quantityUnits: quantity, priceMinor: 991 }]);
  const retainedBefore = (await order()).get("submissionOutcome");
  const reservation = (await models.RiskReservation.findOne().orFail()).toObject();
  const orderVersion = (await order()).get("version"), positionVersion = (await position()).get("version");
  assert.equal((await order()).get("filledUnits"), 0); assert.equal((await position()).get("legs.0.entryFilledUnits"), 0);
  assert.equal((await processor().retainedStatus("order-1")).status, "UNPROCESSED");
  const result = await processor().processRetained("order-1");
  assert.equal(result.status, "PROCESSED"); assert.deepEqual(result.failedTradeKeys, []);
  assert.equal(await models.Fill.countDocuments(), 1);
  const saved = await order(), pos = await position();
  assert.equal(saved.get("filledUnits"), quantity); assert.equal(saved.get("phase"), quantity === 10 ? "FILLED" : "PARTIALLY_FILLED");
  assert.equal(saved.get("version"), orderVersion + 1); assert.equal(pos.get("version"), positionVersion + 1);
  assert.equal(saved.get("lastObservationVersion"), 0); assert.equal(saved.get("knowledge"), "RECONCILIATION_REQUIRED");
  assert.equal(pos.get("lifecycle"), quantity === 10 ? "OPEN" : "PARTIALLY_OPENED");
  assert.equal(pos.get("legs.0.entryFilledUnits"), quantity); assert.equal(pos.get("legs.0.netQuantityUnits"), quantity);
  assert.equal(pos.get("legs.0.entryNotionalMinor"), quantity * 991); assert.equal(pos.get("realizedPnlMinor"), 0);
  assert.deepEqual((await models.RiskReservation.findOne().orFail()).toObject(), reservation);
  assert.deepEqual(saved.get("submissionOutcome"), retainedBefore);
  assert.deepEqual((await models.TradingEvent.find().sort({ accountSequence: 1 })).map(e => e.get("eventType")),
    ["SUBMISSION_CLAIMED", "ORDER_SUBMITTED", "FILL_RECEIVED", quantity === 10 ? "POSITION_OPENED" : "POSITION_PARTIALLY_OPENED"]);
  const beforeReplay = await snapshot();
  assert.equal((await processor().process(trades[0])).status, "DUPLICATE");
  assert.equal((await processor().processRetained("order-1")).status, "PROCESSED");
  assert.deepEqual(await snapshot(), beforeReplay);
});

test("real first/partial/full fills produce lifecycle events exactly once and exact cost basis", async () => {
  const { trades } = await setup([{ quantityUnits: 3, priceMinor: 991 }, { quantityUnits: 2, priceMinor: 992 }, { quantityUnits: 5, priceMinor: 993 }]);
  for (const trade of trades) await processor().process(trade);
  assert.equal((await position()).get("legs.0.entryNotionalMinor"), 9922);
  assert.equal((await position()).get("lifecycle"), "OPEN");
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_PARTIALLY_OPENED" }), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_OPENED" }), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "FILL_RECEIVED" }), 3);
});

for (const [field, changed] of Object.entries({ quantityUnits: 3, priceMinor: 999, side: "SELL", contractKey: "NFO:wrong", orderId: "wrong-order" }))
  test(`real duplicate conflict: ${field} cannot overwrite financial evidence`, async () => {
    const { trades } = await setup(); await processor().process(trades[0]); const before = await snapshot();
    await assert.rejects(processor().process({ ...trades[0], [field]: changed }));
    assert.deepEqual(await snapshot(), before);
  });

for (const [field, changed] of Object.entries({ accountId: "PAPER:other", executionMode: "LIVE", positionId: "other-position", intentId: "other-intent",
  orderId: "other-order", legId: "short", contractKey: "NFO:other", side: "SELL", brokerOrderId: "other-broker-order", brokerNamespace: "other-namespace" }))
  test(`real ownership isolation rejects wrong ${field}`, async () => {
    const { trades } = await setup(); const before = await snapshot();
    await assert.rejects(processor().process({ ...trades[0], [field]: changed }));
    assert.deepEqual(await snapshot(), before);
  });

test("real requested100 existing80 incoming30 overfill rolls back every write", async () => {
  const { trades } = await setup([{ quantityUnits: 80, priceMinor: 990 }, { quantityUnits: 20, priceMinor: 991 }], 100);
  await processor().process(trades[0]); const before = await snapshot();
  await assert.rejects(processor().process({ ...trades[1], quantityUnits: 30 }), /QUANTITY_INVALID/);
  assert.deepEqual(await snapshot(), before); assert.equal(await models.Fill.countDocuments(), 1);
});

test("real SUBMITTING UNKNOWN order accepts proven fills without resolving uncertainty", async () => {
  await seed(); const { trades } = await submit({ submission: "AMBIGUOUS", initialFills: [{ quantityUnits: 4, priceMinor: 990 }] });
  assert.equal((await order()).get("phase"), "SUBMITTING");
  await processor().process(trades[0]); assert.equal((await order()).get("phase"), "PARTIALLY_FILLED");
  assert.equal((await order()).get("knowledge"), "UNKNOWN"); assert.equal((await position()).get("legs.0.entryFilledUnits"), 4);
});

test("real trade before persisted receipt attaches broker identity atomically", async () => {
  await seed(); const paper = broker({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 990 }] });
  const manager = new OrderManager(connection, f.scope, paper, clock) as unknown as { claim(id: string): Promise<{ request: BrokerOrderRequest }> };
  const { request } = await manager.claim("order-1"); await paper.submitOrder(request);
  const [trade] = await paper.getTrades(f.scope); assert.equal((await order()).get("brokerOrderId"), undefined);
  await processor().process(trade); assert.equal((await order()).get("brokerOrderId"), trade.brokerOrderId);
  assert.equal((await order()).get("phase"), "PARTIALLY_FILLED"); assert.equal(await models.Fill.countDocuments(), 1);
});

for (const reverse of [false, true]) test(`real out-of-order delivery reverse=${reverse} has identical economics and no duplicate effects`, async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 990 }, { quantityUnits: 6, priceMinor: 995 }]);
  const sequence = reverse ? [trades[1], trades[0], trades[0]] : [trades[0], trades[1], trades[0]];
  for (const trade of sequence) await processor().process(trade);
  assert.equal(await models.Fill.countDocuments(), 2); assert.equal((await order()).get("filledUnits"), 10);
  assert.equal((await position()).get("legs.0.entryNotionalMinor"), 9930); assert.equal((await position()).get("legs.0.netQuantityUnits"), 10);
  assert.equal((await position()).get("lifecycle"), "OPEN"); assert.equal(await models.TradingEvent.countDocuments({ eventType: "FILL_RECEIVED" }), 2);
});

for (const same of [true, false]) test(`real concurrency ${same ? "same" : "different"} trades: unique fills, CAS versions, no lost quantity/events`, async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 990 }, { quantityUnits: 6, priceMinor: 995 }]);
  const initialOrderVersion = (await order()).get("version"), initialPositionVersion = (await position()).get("version");
  const results = await Promise.all([processor().process(trades[0]), processor().process(trades[same ? 0 : 1])]);
  const count = same ? 1 : 2;
  assert.equal(results.filter(r => r.status === "APPLIED").length, count);
  assert.equal(await models.Fill.countDocuments(), count); assert.equal((await order()).get("filledUnits"), same ? 4 : 10);
  assert.equal((await position()).get("legs.0.entryNotionalMinor"), same ? 3960 : 9930);
  assert.equal((await order()).get("version"), initialOrderVersion + count); assert.equal((await position()).get("version"), initialPositionVersion + count);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(e => e.get("accountSequence")), Array.from({ length: events.length }, (_, i) => i + 1));
  assert.equal(events.filter(e => e.get("eventType") === "FILL_RECEIVED").length, count);
});

for (const failure of ["Position", "FILL_RECEIVED", "POSITION_PARTIALLY_OPENED", "POSITION_OPENED"] as const)
  test(`real ${failure} save failure rolls back Fill, order, position, cost basis and account sequence`, async () => {
    const { trades } = await setup([{ quantityUnits: failure === "POSITION_OPENED" ? 10 : 4, priceMinor: 990 }]);
    const before = await snapshot();
    await failSave(failure === "Position" ? "Position" : "TradingEvent", doc => failure === "Position" || doc.get("eventType") === failure,
      async () => { await assert.rejects(processor().process(trades[0]), /injected-save-failure/); });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await processor().retainedStatus("order-1")).status, "UNPROCESSED");
    await processor().process(trades[0]); assert.equal(await models.Fill.countDocuments(), 1);
  });

test("real retained multi-trade failure reports PARTIAL and restart resumes only unapplied evidence", async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 990 }, { quantityUnits: 6, priceMinor: 995 }]);
  await failSave("TradingEvent", doc => doc.get("eventType") === "POSITION_OPENED", async () => {
    const result = await processor().processRetained("order-1");
    assert.equal(result.status, "PARTIAL"); assert.deepEqual(result.processedTradeKeys, [trades[0].brokerTradeKey]);
    assert.deepEqual(result.failedTradeKeys, [trades[1].brokerTradeKey]); assert.deepEqual(result.unprocessedTradeKeys, [trades[1].brokerTradeKey]);
  });
  assert.equal(await models.Fill.countDocuments(), 1); assert.equal((await order()).get("filledUnits"), 4);
  assert.equal((await processor().processRetained("order-1")).status, "PROCESSED");
  assert.equal(await models.Fill.countDocuments(), 2); assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_OPENED" }), 1);
});

test("real incomplete retained snapshot cannot create quantity or report PROCESSED", async () => {
  await seed();
  class UnavailableTrades extends PaperBrokerAdapter { override async getTrades(): Promise<readonly BrokerTradeObservation[]> { throw new Error("unavailable"); } }
  const paper = new UnavailableTrades(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` },
    scenario: () => ({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 990 }] }) });
  await new OrderManager(connection, f.scope, paper, clock).submit("order-1");
  const before = await snapshot(); assert.equal((await processor().processRetained("order-1")).status, "INCOMPLETE");
  assert.deepEqual(await snapshot(), before); assert.equal((await order()).get("filledUnits"), 0);
});

test("real hedge130 with65 fills exposes only65 protection; SELL entry carries negative units", async () => {
  await seed(130, true);
  const hedge = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 65, priceMinor: 990 }] });
  await processor().process(hedge.trades[0]);
  let pos = await position(); assert.equal(pos.get("legs.0.netQuantityUnits"), 65); assert.equal(pos.get("legs.1.netQuantityUnits"), 0);
  assert.equal(pos.get("lifecycle"), "PARTIALLY_OPENED");
  const short = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 65, priceMinor: 1005 }] }, "order-2");
  await processor().process(short.trades[0]); pos = await position();
  assert.equal(pos.get("legs.1.netQuantityUnits"), -65); assert.equal(pos.get("legs.1.entryNotionalMinor"), 65325);
  assert.equal(pos.get("lifecycle"), "PARTIALLY_OPENED");
});

test("real fill truth survives disabled admission, expired authorization and price risk breach, preserving holds", async () => {
  const { trades } = await setup();
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set({ admissionStatus: "HALTED", policyVersion: 2, executionEpoch: 2 }); await account.save({ session }); });
  const reservation = (await models.RiskReservation.findOne().orFail()).toObject();
  const late = new FillProcessor(connection, f.scope, () => new Date(f.now.getTime() + 120000));
  await late.process({ ...trades[0], priceMinor: 1100 });
  assert.equal((await position()).get("legs.0.entryNotionalMinor"), 4400);
  assert.deepEqual((await models.RiskReservation.findOne().orFail()).toObject(), reservation);
  const account = await models.TradingAccount.findOne(f.scope).orFail();
  for (const field of ["reservedMarginMinor", "reservedExposureMinor", "committedExposureMinor", "realizedPnlMinor"]) assert.equal(account.get(field), 0);
});

test("real cost basis overflow rejects entire fill transaction", async () => {
  await seed(10, false, "BUY", Number.MAX_SAFE_INTEGER);
  const { trades } = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 2, priceMinor: Number.MAX_SAFE_INTEGER }] });
  const before = await snapshot(); await assert.rejects(processor().process(trades[0]), /FILL_ACCOUNTING_OVERFLOW/);
  assert.deepEqual(await snapshot(), before);
});

test("real mandatory persistence rejects fabricated or removed cost basis and signed units", async () => {
  const { trades } = await setup(); await processor().process(trades[0]); const before = await snapshot();
  for (const [field, bad] of [["entryNotionalMinor", 1], ["netQuantityUnits", -4], ["entryNotionalMinor", undefined]] as const) {
    await assert.rejects(tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
      pos.set(`legs.0.${field}`, bad); await pos.save({ session }); }), /LEDGER_RELATIONSHIP_MISMATCH/);
  }
  assert.deepEqual(await snapshot(), before);
});

test("real missing indexes and LIVE constructor fail closed", async () => {
  const { trades } = await setup();
  assert.throws(() => new FillProcessor(connection, { accountId: "LIVE:other", executionMode: "LIVE" }), /PAPER_ONLY/);
  await connection.db!.collection("execution_fills").dropIndex("accountId_1_broker_1_brokerNamespace_1_brokerTradeKey_1");
  await assert.rejects(processor().process(trades[0]), /EXECUTION_INDEXES_NOT_READY/);
  assert.equal(await models.Fill.countDocuments(), 0);
});

test("real ACKNOWLEDGED order processes later trade; stale snapshots cannot regress fill-derived state", async () => {
  await seed(); const { paper } = await submit({ submission: "ACCEPTED", steps: [{ kind: "FILL", quantityUnits: 4, priceMinor: 990 }] });
  assert.equal((await order()).get("phase"), "ACKNOWLEDGED");
  const old = await paper.getOrder({ ...f.scope, orderId: "order-1" }); assert.ok(old);
  await paper.advance({ ...f.scope, orderId: "order-1" }); const [trade] = await paper.getTrades(f.scope);
  await processor().process(trade);
  const saved = await order(); const fills = (await models.Fill.find()).map(doc => ({ ...doc.toObject<FillEvidence>(), source: "SIMULATED_FILL" as const }));
  const state: OrderState = { ...saved.toObject<OrderState>(), fills };
  const stale = transitionOrder(state, { type: "BROKER_OBSERVED", phase: "ACKNOWLEDGED", cumulativeFilledUnits: old.filledUnits,
    observationVersion: old.observationVersion, evidenceRef: old.evidence.reference });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "OBSERVATION_REGRESSION");
  assert.equal(saved.get("lastObservationVersion"), 0); assert.equal(saved.get("filledUnits"), 4);
  const before = await snapshot();
  await assert.rejects(tx(async session => {
    const changed = await models.BrokerOrder.findOne({ orderId: "order-1" }).session(session).orFail();
    changed.set({ phase: "ACKNOWLEDGED", filledUnits: 0, executionEvidenceRefs: [] }); await changed.save({ session });
  }));
  assert.deepEqual(await snapshot(), before);
});

test("real existing foreign position/intent cannot receive another chain's trade", async () => {
  const { trades } = await setup();
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal("signal-2"), decisionKey: "decision-2" }).save({ session });
    await new models.OrderIntent({ ...f.intent("intent-2"), signalId: "signal-2" }).save({ session });
    await new models.Position({ ...f.position("position-2"), entryIntentId: "intent-2" }).save({ session });
  });
  const before = await snapshot();
  await assert.rejects(processor().process({ ...trades[0], positionId: "position-2", intentId: "intent-2" }), /OWNERSHIP_MISMATCH/);
  assert.deepEqual(await snapshot(), before);
});

test("real competing overfills cannot both commit", async () => {
  const { trades } = await setup([{ quantityUnits: 80, priceMinor: 990 }, { quantityUnits: 20, priceMinor: 991 }], 100);
  const results = await Promise.allSettled([processor().process(trades[0]), processor().process({ ...trades[1], quantityUnits: 80 })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await models.Fill.countDocuments(), 1); assert.equal((await order()).get("filledUnits"), 80);
  assert.equal((await position()).get("legs.0.entryFilledUnits"), 80);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "FILL_RECEIVED" }), 1);
});

test("real multi-leg position becomes OPEN only when all authorized legs actually fill", async () => {
  await seed(130, true);
  const hedge = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 130, priceMinor: 990 }] });
  await processor().process(hedge.trades[0]); assert.equal((await position()).get("lifecycle"), "PARTIALLY_OPENED");
  const short = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 130, priceMinor: 1005 }] }, "order-2");
  assert.equal((await position()).get("legs.1.entryFilledUnits"), 0);
  await processor().process(short.trades[0]); assert.equal((await position()).get("lifecycle"), "OPEN");
  assert.equal((await position()).get("legs.1.netQuantityUnits"), -130);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_OPENED" }), 1);
});

test("real existing close-fill reduction preserves entry cost and never confirms CLOSED", async () => {
  const { trades } = await setup([{ quantityUnits: 10, priceMinor: 990 }]); await processor().process(trades[0]);
  const deadline = new Date(f.now.getTime() + 60000);
  const request: BrokerOrderRequest = { ...f.scope, orderId: "close-order", intentId: "close-intent", positionId: "position-1", legId: "hedge",
    contractKey: "NFO:contract-1", side: "SELL", quantityUnits: 10, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY", claimId: "unclaimed" };
  // Prepared close authorization fixture only. FillProcessor does not request/create a close.
  await tx(async session => {
    await new models.OrderIntent({ ...f.intent("close-intent"), purpose: "CLOSE", signalId: undefined, positionId: "position-1", closeGeneration: 1,
      state: "RISK_RESERVED", targetLegs: [{ legId: "hedge", contractKey: "NFO:contract-1", side: "SELL", targetUnits: 10 }], deadline }).save({ session });
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ activeCloseIntentId: "close-intent", lifecycle: "CLOSING", closeGeneration: 1 }); await pos.save({ session });
    await new models.RiskReservation({ ...f.reservation("close-reservation"), intentId: "close-intent", instrumentKeys: ["NFO:contract-1"] }).save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder("close-order"), intentId: "close-intent", side: "SELL", phase: "READY", brokerNamespace: "PAPER_SIM_V1",
      requestFingerprint: submissionFingerprint(request), submissionAuthorization: { reservationId: "close-reservation", evidenceRef: "close-authorization",
        product: "INTRADAY", reservedQuantityUnits: 10, policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session });
  });
  const close = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1100 }] }, "close-order");
  await processor().process(close.trades[0]); const pos = await position();
  assert.equal(pos.get("legs.0.netQuantityUnits"), 0); assert.equal(pos.get("legs.0.entryNotionalMinor"), 9900);
  assert.equal(pos.get("legs.0.exitFilledUnits"), 10); assert.equal(pos.get("lifecycle"), "PARTIALLY_CLOSING");
  assert.equal(pos.get("realizedPnlMinor"), 0); assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_CLOSED" }), 0);
});

// Correction regressions: prepare existing authorized close workflows, never orchestrate them.
async function prepareHeldClose(options: { side?: "BUY" | "SELL"; held?: number; entryUnits?: number; spread?: boolean;
  owner?: string; intentId?: string; generation?: number; activate?: boolean; purpose?: "CLOSE" | "RECOVERY" } = {}) {
  const side = options.side ?? "BUY", entryUnits = options.entryUnits ?? 10, held = options.held ?? entryUnits;
  const intentId = options.intentId ?? "held-close", generation = options.generation ?? 1;
  const orderId = `${intentId}-order`, reservationId = `${intentId}-reservation`;
  const deadline = new Date(f.now.getTime() + 60000), closingSide = side === "BUY" ? "SELL" : "BUY";
  const request: BrokerOrderRequest = { ...f.scope, orderId, claimId: "unclaimed", intentId, positionId: "position-1", legId: "hedge",
    contractKey: "NFO:contract-1", side: closingSide, quantityUnits: entryUnits, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY" };
  await tx(async session => {
    await new models.OrderIntent({ ...f.intent(intentId), purpose: options.purpose ?? "CLOSE", signalId: undefined, positionId: "position-1", closeGeneration: generation,
      state: "RISK_RESERVED", targetLegs: [{ legId: "hedge", contractKey: "NFO:contract-1", side: closingSide, targetUnits: entryUnits }], deadline }).save({ session });
    if (options.activate !== false) {
      const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
      pos.set({ activeCloseIntentId: intentId, lifecycle: "CLOSING", closeGeneration: generation });
      pos.set("legs.0.closeHeldUnits", held);
      if (options.owner) pos.set("legs.0.closeHoldIntentId", options.owner);
      await pos.save({ session });
    }
    await new models.RiskReservation({ ...f.reservation(reservationId), intentId, instrumentKeys: ["NFO:contract-1"] }).save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder(orderId), intentId, side: closingSide, quantityUnits: entryUnits, phase: "READY",
      brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(request), submissionAuthorization: {
        reservationId, evidenceRef: `${intentId}-authorization`, product: "INTRADAY", reservedQuantityUnits: entryUnits,
        policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session });
  });
  return orderId;
}
async function heldClose(fills: { quantityUnits: number; priceMinor: number }[], options: Parameters<typeof prepareHeldClose>[0] = {}) {
  const side = options.side ?? "BUY", entryUnits = options.entryUnits ?? 10;
  await seed(10, options.spread, side);
  const opening = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: entryUnits, priceMinor: 1000 }] });
  await processor().process(opening.trades[0]);
  const orderId = await prepareHeldClose(options);
  return { ...await submit({ submission: "ACCEPTED", initialFills: fills }, orderId), orderId };
}

for (const [name, side, quantity, expectedNet] of [
  ["partial long", "BUY", 4, 6], ["full long", "BUY", 10, 0], ["partial short", "SELL", 4, -6],
] as const) test(`real close hold ${name}: owned reducing fill and duplicate replay`, async () => {
  const { trades, orderId } = await heldClose([{ quantityUnits: quantity, priceMinor: 1000 }], { side });
  const reservations = await models.RiskReservation.find().sort({ reservationId: 1 }).lean();
  await processor().process(trades[0]); const pos = await position();
  assert.equal(pos.get("legs.0.netQuantityUnits"), expectedNet); assert.equal(pos.get("legs.0.exitFilledUnits"), quantity);
  assert.equal(pos.get("legs.0.closeHeldUnits"), 10 - quantity); assert.equal(pos.get("legs.0.closeHoldIntentId"), "held-close");
  assert.equal(pos.get("legs.0.entryNotionalMinor"), 10000); assert.equal(pos.get("lifecycle"), "PARTIALLY_CLOSING");
  assert.equal((await models.BrokerOrder.findOne({ orderId }).orFail()).get("filledUnits"), quantity);
  assert.equal(await models.Fill.countDocuments({ orderId }), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_PARTIALLY_CLOSED" }), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_CLOSED" }), 0);
  assert.deepEqual(await models.RiskReservation.find().sort({ reservationId: 1 }).lean(), reservations);
  const before = await snapshot(); assert.equal((await processor().process(trades[0])).status, "DUPLICATE");
  assert.deepEqual(await snapshot(), before);
});

test("real conflicting duplicate close fill cannot consume more hold", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }]); await processor().process(trades[0]);
  const before = await snapshot(); await assert.rejects(processor().process({ ...trades[0], quantityUnits: 5 }), /DUPLICATE_FILL_CONFLICT/);
  assert.deepEqual(await snapshot(), before);
});

test("real increasing entry fill preserves an existing close hold", async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 990 }, { quantityUnits: 6, priceMinor: 995 }]);
  await processor().process(trades[0]); await prepareHeldClose({ held: 4, entryUnits: 4, owner: "held-close" });
  await processor().process(trades[1]); const pos = await position();
  assert.equal(pos.get("legs.0.netQuantityUnits"), 10); assert.equal(pos.get("legs.0.closeHeldUnits"), 4);
  assert.equal(pos.get("legs.0.closeHoldIntentId"), "held-close"); assert.equal(pos.get("legs.0.exitFilledUnits"), 0);
});

for (const [field, wrong] of Object.entries({ positionId: "other-position", legId: "short", intentId: "other-close", orderId: "other-close-order" }))
  test(`real close hold wrong ${field} fails without consuming quantity or holds`, async () => {
    const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }]); const before = await snapshot();
    await assert.rejects(processor().process({ ...trades[0], [field]: wrong })); assert.deepEqual(await snapshot(), before);
  });

test("real valid trade for an inactive close intent/order cannot consume the active hold", async () => {
  await heldClose([{ quantityUnits: 4, priceMinor: 1000 }]);
  const orderId = await prepareHeldClose({ intentId: "inactive-close", generation: 2, activate: false });
  const { trades } = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 1000 }] }, orderId);
  const before = await snapshot(); await assert.rejects(processor().process(trades[0]), /EVIDENCE_REQUIRED/);
  assert.deepEqual(await snapshot(), before);
});

test("real close hold tagged to another intent fails closed", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }], { owner: "different-owner" });
  const before = await snapshot(); await assert.rejects(processor().process(trades[0]), /CLOSE_HOLD_OWNERSHIP_MISMATCH/);
  assert.deepEqual(await snapshot(), before);
});

test("real reducing fill greater than its remaining close hold fails atomically", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }], { held: 3 }); const before = await snapshot();
  await assert.rejects(processor().process(trades[0]), /CLOSE_HOLD_EXCEEDED/); assert.deepEqual(await snapshot(), before);
});

test("real exhausted close hold cannot revert to legacy zero-hold behavior", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }, { quantityUnits: 6, priceMinor: 1000 }], { held: 4 });
  await processor().process(trades[0]); const pos = await position();
  assert.equal(pos.get("legs.0.closeHeldUnits"), 0); assert.equal(pos.get("legs.0.closeHoldIntentId"), "held-close");
  const before = await snapshot(); await assert.rejects(processor().process(trades[1]), /CLOSE_HOLD_EXCEEDED/);
  assert.deepEqual(await snapshot(), before);
});

for (const same of [true, false]) test(`real concurrent ${same ? "same" : "different"} close fills consume owned holds exactly once`, async () => {
  const { trades, orderId } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }, { quantityUnits: 6, priceMinor: 1000 }]);
  const beforeVersion = (await position()).get("version");
  const results = await Promise.all([processor().process(trades[0]), processor().process(trades[same ? 0 : 1])]);
  const count = same ? 1 : 2, pos = await position();
  assert.equal(results.filter(r => r.status === "APPLIED").length, count);
  assert.equal(pos.get("legs.0.netQuantityUnits"), same ? 6 : 0); assert.equal(pos.get("legs.0.closeHeldUnits"), same ? 6 : 0);
  assert.equal(pos.get("version"), beforeVersion + count); assert.equal(await models.Fill.countDocuments({ orderId }), count);
  assert.equal((await models.BrokerOrder.findOne({ orderId }).orFail()).get("filledUnits"), same ? 4 : 10);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "FILL_RECEIVED", "payload.orderId": orderId }), count);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "POSITION_PARTIALLY_CLOSED" }), 1);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(e => e.get("accountSequence")), Array.from({ length: events.length }, (_, i) => i + 1));
});

for (const failure of ["Position", "FILL_RECEIVED", "POSITION_PARTIALLY_CLOSED"] as const)
  test(`real close hold ${failure} failure rolls back all quantities, holds and account sequences`, async () => {
    const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }]); const before = await snapshot();
    await failSave(failure === "Position" ? "Position" : "TradingEvent", doc => failure === "Position" || doc.get("eventType") === failure,
      async () => { await assert.rejects(processor().process(trades[0]), /injected-save-failure/); });
    assert.deepEqual(await snapshot(), before);
    await processor().process(trades[0]); assert.equal((await position()).get("legs.0.closeHeldUnits"), 6);
  });

test("real owned recovery close fill persists despite halt, stale policy and expired authorization", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }], { purpose: "RECOVERY" });
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set({ admissionStatus: "HALTED", policyVersion: 2, executionEpoch: 2 }); await account.save({ session }); });
  const reservations = await models.RiskReservation.find().sort({ reservationId: 1 }).lean();
  await new FillProcessor(connection, f.scope, () => new Date(f.now.getTime() + 120000)).process({ ...trades[0], priceMinor: 900 });
  assert.equal((await position()).get("legs.0.netQuantityUnits"), 6); assert.equal((await position()).get("legs.0.closeHeldUnits"), 6);
  assert.deepEqual(await models.RiskReservation.find().sort({ reservationId: 1 }).lean(), reservations);
});

test("real other leg entry and close fill leave its sibling hold untouched", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }], { spread: true });
  const short = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 1000 }] }, "order-2");
  await processor().process(short.trades[0]); assert.equal((await position()).get("legs.0.closeHeldUnits"), 10);
  await tx(async session => { const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set("legs.1.closeHeldUnits", 7); await pos.save({ session }); });
  await processor().process(trades[0]); const pos = await position();
  assert.equal(pos.get("legs.0.closeHeldUnits"), 6); assert.equal(pos.get("legs.1.closeHeldUnits"), 7);
  assert.equal(pos.get("legs.1.netQuantityUnits"), -10);
});

test("real persistence cannot erase or replace the active close hold owner after exhaustion", async () => {
  const { trades } = await heldClose([{ quantityUnits: 4, priceMinor: 1000 }, { quantityUnits: 6, priceMinor: 1000 }], { held: 4 });
  await processor().process(trades[0]); const before = await snapshot();
  for (const owner of [undefined, "different-owner"]) {
    await assert.rejects(tx(async session => {
      const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
      pos.set("legs.0.closeHoldIntentId", owner); await pos.save({ session });
    }), /active close hold owner cannot be cleared or replaced/);
  }
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(processor().process(trades[1]), /CLOSE_HOLD_EXCEEDED/);
});
