import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { OrderManager } from "../../src/services/OrderManager";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import type { BrokerOrderRequest } from "../../src/brokers/BrokerAdapter";
import { submissionFingerprint } from "../../src/brokers/submissionEvidence";
import * as f from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
const models = executionModels(connection);
const sessions = new Set<ClientSession>();
const startSession = connection.startSession.bind(connection);
connection.startSession = async (...args) => { const session = await startSession(...args); sessions.add(session); return session; };
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); }
  finally { await session.endSession(); }
}
const clock = () => new Date(f.now);
const deadline = new Date(f.now.getTime() + 60_000);
function requestFor(orderId = "order-1", suffix = "1"): BrokerOrderRequest {
  return { ...f.scope, orderId, claimId: "unclaimed", intentId: `intent-${suffix}`, positionId: `position-${suffix}`,
    legId: "hedge", contractKey: "NFO:contract-1", side: "BUY", quantityUnits: 10, orderType: "LIMIT", limitPriceMinor: 1000, product: "INTRADAY" };
}
async function seed(suffix = "1") {
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`signal-${suffix}`), decisionKey: `decision-${suffix}` }).save({ session });
    await new models.OrderIntent({ ...f.intent(`intent-${suffix}`), signalId: `signal-${suffix}`, state: "RISK_RESERVED", deadline }).save({ session });
    await new models.Position({ ...f.position(`position-${suffix}`), entryIntentId: `intent-${suffix}` }).save({ session });
    await new models.RiskReservation({ ...f.reservation(`reservation-${suffix}`), intentId: `intent-${suffix}`, instrumentKeys: ["NFO:contract-1"] }).save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder(`order-${suffix}`), intentId: `intent-${suffix}`, positionId: `position-${suffix}`,
      phase: "READY", brokerNamespace: "PAPER_SIM_V1", requestFingerprint: submissionFingerprint(requestFor(`order-${suffix}`, suffix)),
      submissionAuthorization: { reservationId: `reservation-${suffix}`, evidenceRef: `authorization-${suffix}`, product: "INTRADAY",
        reservedQuantityUnits: 10, policyVersion: 1, executionEpoch: 1, expiresAt: deadline } }).save({ session });
  });
}
class SpyPaper extends PaperBrokerAdapter {
  calls: BrokerOrderRequest[] = [];
  concurrentWorkers = false;
  constructor(plan: PaperScenario = { submission: "ACCEPTED" }) {
    let sequence = 0;
    super(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++sequence}` }, scenario: () => plan });
  }
  override async submitOrder(request: BrokerOrderRequest) {
    this.calls.push(structuredClone(request));
    if (!this.concurrentWorkers) assert.ok([...sessions].every(s => !s.inTransaction()), "broker called with an open transaction");
    const order = await models.BrokerOrder.findOne({ orderId: request.orderId }).orFail();
    assert.equal(order.get("phase"), "SUBMITTING"); assert.equal(order.get("submissionClaim.claimId"), request.claimId);
    assert.equal(await models.TradingEvent.countDocuments({ aggregateId: request.orderId, eventType: "SUBMISSION_CLAIMED" }), 1);
    return super.submitOrder(request);
  }
}
const manager = (broker: SpyPaper) => new OrderManager(connection, f.scope, broker, clock);
const order = () => models.BrokerOrder.findOne({ orderId: "order-1" }).orFail();
async function failEvent(eventType: string, work: () => Promise<void>) {
  const original = models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save = function (...args: unknown[]) {
    if (this.get("eventType") === eventType) return Promise.reject(new Error("injected-event-failure"));
    return original.apply(this, args);
  };
  try { await work(); } finally { models.TradingEvent.prototype.save = original; }
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => {
  sessions.clear(); await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY" }).save({ session }));
  await seed();
});

for (const [name, plan, phase, knowledge, count] of [
  ["accepted unfilled", { submission: "ACCEPTED" }, "ACKNOWLEDGED", "KNOWN", 0],
  ["accepted partial", { submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 990 }] }, "SUBMITTED", "RECONCILIATION_REQUIRED", 1],
  ["accepted full", { submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 990 }] }, "SUBMITTED", "RECONCILIATION_REQUIRED", 1],
  ["rejected", { submission: "REJECTED" }, "REJECTED", "KNOWN", 0],
  ["ambiguous", { submission: "AMBIGUOUS", initialFills: [{ quantityUnits: 4, priceMinor: 990 }] }, "SUBMITTING", "UNKNOWN", 1],
] as const) test(`real OrderManager ${name}: atomic outcome, retained evidence, no financial fill processing or duplicate POST`, async () => {
  const broker = new SpyPaper(plan);
  const beforePosition = (await models.Position.findOne({ positionId: "position-1" }).orFail()).toObject();
  const beforeReservation = (await models.RiskReservation.findOne({ reservationId: "reservation-1" }).orFail()).toObject();
  const result = await manager(broker).submit("order-1"); assert.equal(result.status, "PERSISTED");
  assert.equal(result.order?.phase, phase); assert.equal(result.order?.knowledge, knowledge);
  const saved = await order(); assert.equal(saved.get("filledUnits"), 0); assert.equal(saved.get("lastObservationVersion"), 0);
  assert.equal(saved.get("submissionOutcome.trades").length, count);
  assert.equal(saved.get("submissionOutcome.pendingFillProcessing"), count > 0);
  assert.equal(saved.get("submissionOutcome.outcome.kind"), plan.submission);
  assert.equal(saved.get("submissionClaim.requestFingerprint"), submissionFingerprint(broker.calls[0]));
  assert.deepEqual(saved.get("submissionClaim.request"), broker.calls[0]);
  assert.equal((await models.OrderIntent.findOne({ intentId: "intent-1" }).orFail()).get("state"), "EXECUTING");
  assert.equal(await models.Fill.countDocuments(), 0);
  assert.deepEqual((await models.Position.findOne({ positionId: "position-1" }).orFail()).toObject(), beforePosition);
  assert.deepEqual((await models.RiskReservation.findOne({ reservationId: "reservation-1" }).orFail()).toObject(), beforeReservation);
  assert.equal((await manager(broker).submit("order-1")).status, "CURRENT"); assert.equal(broker.calls.length, 1);
  const events = await models.TradingEvent.find().sort({ accountSequence: 1 });
  assert.deepEqual(events.map(e => e.get("accountSequence")), [1, 2]);
  assert.deepEqual(events.map(e => e.get("eventType")), ["SUBMISSION_CLAIMED", plan.submission === "ACCEPTED" ? "ORDER_SUBMITTED" : plan.submission === "REJECTED" ? "ORDER_REJECTED" : "ORDER_OUTCOME_UNKNOWN"]);
});

test("real concurrent managers race one READY order: one durable claim, one broker call", async () => {
  const broker = new SpyPaper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 990 }] });
  broker.concurrentWorkers = true;
  const results = await Promise.all([manager(broker).submit("order-1"), manager(broker).submit("order-1")]);
  assert.equal(results.filter(r => r.status === "PERSISTED").length, 1);
  assert.equal(broker.calls.length, 1); assert.equal(await models.TradingEvent.countDocuments({ eventType: "SUBMISSION_CLAIMED" }), 1);
  assert.equal((await broker.getOrders(f.scope)).length, 1); assert.equal((await broker.getTrades(f.scope)).length, 1);
  const saved = await order(); const claim = saved.get("submissionClaim").toObject();
  await manager(broker).submit("order-1"); assert.deepEqual((await order()).get("submissionClaim").toObject(), claim);
  await assert.rejects(tx(async session => {
    const changed = await models.BrokerOrder.findOne({ orderId: "order-1" }).session(session).orFail();
    changed.set("submissionClaim.claimId", "replacement-claim"); await changed.save({ session });
  }), /attached once|never replaced/);
});

test("real claim event failure rolls back order, intent and account sequence before broker call", async () => {
  const broker = new SpyPaper(); const account = (await models.TradingAccount.findOne(f.scope).orFail()).toObject();
  await failEvent("SUBMISSION_CLAIMED", async () => { await assert.rejects(manager(broker).submit("order-1"), /injected-event-failure/); });
  assert.equal(broker.calls.length, 0); assert.equal((await order()).get("phase"), "READY"); assert.equal((await order()).get("submissionClaim"), undefined);
  assert.equal((await models.OrderIntent.findOne({ intentId: "intent-1" }).orFail()).get("state"), "RISK_RESERVED");
  assert.equal(await models.TradingEvent.countDocuments(), 0); assert.deepEqual((await models.TradingAccount.findOne(f.scope).orFail()).toObject(), account);
});

for (const submission of ["ACCEPTED", "REJECTED", "AMBIGUOUS"] as const) test(`real ${submission} audit failure after broker interaction leaves durable SUBMITTING and never retries`, async () => {
  const broker = new SpyPaper({ submission });
  const eventType = submission === "ACCEPTED" ? "ORDER_SUBMITTED" : submission === "REJECTED" ? "ORDER_REJECTED" : "ORDER_OUTCOME_UNKNOWN";
  await failEvent(eventType, async () => { assert.equal((await manager(broker).submit("order-1")).status, "UNRESOLVED"); });
  assert.equal((await order()).get("phase"), "SUBMITTING"); assert.equal((await order()).get("submissionOutcome"), undefined);
  assert.equal(await models.TradingEvent.countDocuments(), 1);
  assert.equal((await models.TradingAccount.findOne(f.scope).orFail()).get("nextEventSequence"), 2);
  assert.equal((await manager(broker).submit("order-1")).status, "CURRENT"); assert.equal(broker.calls.length, 1);
});

for (const sent of [false, true]) test(`real crash checkpoint after claim commit, broker sent=${sent}: restart never resubmits`, async () => {
  const broker = new SpyPaper();
  // Stop between the real manager phases, without adding production crash hooks or executing a recovery worker.
  const paused = manager(broker) as unknown as { claim(id: string): Promise<{ request: BrokerOrderRequest }> };
  const claim = await paused.claim("order-1");
  if (sent) await broker.submitOrder(claim.request);
  assert.equal((await order()).get("phase"), "SUBMITTING");
  assert.equal((await manager(broker).submit("order-1")).status, "CURRENT"); assert.equal(broker.calls.length, sent ? 1 : 0);
});

test("real concurrent claims/outcomes for two orders allocate distinct contiguous account sequences", async () => {
  await seed("2"); const broker = new SpyPaper(); broker.concurrentWorkers = true;
  await Promise.all([manager(broker).submit("order-1"), manager(broker).submit("order-2")]);
  assert.equal(broker.calls.length, 2);
  assert.deepEqual((await models.TradingEvent.find().sort({ accountSequence: 1 })).map(e => e.get("accountSequence")), [1, 2, 3, 4]);
  assert.equal((await models.TradingAccount.findOne(f.scope).orFail()).get("nextEventSequence"), 5);
});

test("LIVE and disabled PAPER admission fail closed without broker submission", async () => {
  const broker = new SpyPaper();
  assert.throws(() => new OrderManager(connection, { accountId: "LIVE:test", executionMode: "LIVE" }, broker), /PAPER_ONLY/);
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail(); account.set("admissionStatus", "DISABLED"); await account.save({ session }); });
  await assert.rejects(manager(broker).submit("order-1"), /PAPER_NOT_READY/); assert.equal(broker.calls.length, 0);
});

test("real mandatory chain boundary rejects corrupted authorization ownership before broker interaction", async () => {
  await seed("2"); const broker = new SpyPaper();
  // Administrative corruption fixture bypasses middleware deliberately; the manager must detect it on save.
  await connection.db!.collection("execution_orders").updateOne({ orderId: "order-1" }, { $set: { "submissionAuthorization.reservationId": "reservation-2" } });
  await assert.rejects(manager(broker).submit("order-1"), /LEDGER_RELATIONSHIP_MISMATCH/);
  assert.equal(broker.calls.length, 0); assert.equal((await order()).get("phase"), "READY");
});

test("authorized request tampering, expiry and missing indexes prevent any broker call", async () => {
  const broker = new SpyPaper();
  await connection.db!.collection("execution_orders").updateOne({ orderId: "order-1" }, { $set: { limitPriceMinor: 999 } });
  await assert.rejects(manager(broker).submit("order-1"), /AUTHORIZED_REQUEST_MISMATCH/);
  await connection.db!.collection("execution_orders").updateOne({ orderId: "order-1" }, { $set: { limitPriceMinor: 1000, "submissionAuthorization.expiresAt": f.now } });
  await assert.rejects(manager(broker).submit("order-1"), /AUTHORIZATION_NOT_CURRENT/);
  await connection.db!.collection("execution_orders").updateOne({ orderId: "order-1" }, { $set: { "submissionAuthorization.expiresAt": deadline } });
  await connection.db!.collection("execution_events").dropIndex("accountId_1_accountSequence_1");
  await assert.rejects(manager(broker).submit("order-1"), /EXECUTION_INDEXES_NOT_READY/); assert.equal(broker.calls.length, 0);
});

test("adapter exception after acceptance persists UNKNOWN evidence without resubmission", async () => {
  class LostResponsePaper extends SpyPaper {
    override async submitOrder(request: BrokerOrderRequest): ReturnType<SpyPaper["submitOrder"]> {
      await super.submitOrder(request); throw new Error("lost-response");
    }
  }
  const broker = new LostResponsePaper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 990 }] });
  const result = await manager(broker).submit("order-1");
  assert.equal(result.status, "PERSISTED"); assert.equal(result.order?.knowledge, "UNKNOWN");
  assert.equal(result.order?.phase, "SUBMITTING"); assert.equal((await order()).get("submissionOutcome.trades").length, 1);
  assert.equal(await models.Fill.countDocuments(), 0);
  await manager(broker).submit("order-1"); assert.equal(broker.calls.length, 1);
});

test("failed trade query retains the accepted fill-bearing snapshot for later processing", async () => {
  class UnavailableTradesPaper extends SpyPaper {
    override async getTrades(): ReturnType<SpyPaper["getTrades"]> { throw new Error("query-unavailable"); }
  }
  const broker = new UnavailableTradesPaper({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 990 }] });
  const result = await manager(broker).submit("order-1"); assert.equal(result.status, "PERSISTED");
  const saved = await order(); assert.equal(saved.get("submissionOutcome.outcome.order.filledUnits"), 10);
  assert.equal(saved.get("submissionOutcome.evidenceComplete"), false); assert.equal(saved.get("filledUnits"), 0);
  assert.equal(result.order?.pendingFillProcessing, true); assert.equal(result.order?.knowledge, "RECONCILIATION_REQUIRED");
  assert.equal(await models.Fill.countDocuments(), 0);
});
