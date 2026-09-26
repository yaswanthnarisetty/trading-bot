import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
import { FillProcessor } from "../../src/services/FillProcessor";
import { OrderManager } from "../../src/services/OrderManager";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import * as f from "../fixtures";
const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection), clock = () => new Date(f.now);
const deadline = new Date(f.now.getTime() + 60000);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 1000000, maxReservedRiskMinor: 1000000, maxPositionSlots: 10, maxDailyLossMinor: 1000000 };
const admission = () => new RiskAdmissionService(connection, f.scope, clock);
const processor = () => new FillProcessor(connection, f.scope, clock);
let ids = 0;
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
async function configure(changes: Record<string, unknown>) {
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set(changes); await account.save({ session }); });
}
async function seed(id = "1", price = 10000, multi = false) {
  const legs = ["a", ...(multi ? ["b"] : [])].map(legId => ({ legId, contractKey: `NFO:${legId}`, side: "BUY", targetUnits: 10 }));
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`s-${id}`), decisionKey: `d-${id}`, expiresAt: deadline }).save({ session });
    await new models.OrderIntent({ ...f.intent(`i-${id}`), signalId: `s-${id}`, deadline, targetLegs: legs,
      entryPlan: { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: deadline,
        legs: legs.map(({ legId, contractKey }) => ({ legId, contractKey, instrumentKind: "NSE_OPTION", optionType: "CALL",
          expiry: deadline, qualificationRef: `qualified-${legId}`, lotSizeUnits: 1, tickSizeMinor: 1, limitPriceMinor: price })) } }).save({ session });
    await new models.Position({ ...f.position(`p-${id}`), entryIntentId: `i-${id}`,
      legs: legs.map(l => ({ ...f.position().legs[0], legId: l.legId, contractKey: l.contractKey })),
      closePolicy: { kind: "POSITION_LIMIT_V1", product: "INTRADAY", policyVersion: 1, expiresAt: deadline,
        legLimits: legs.map(l => ({ legId: l.legId, limitPriceMinor: price })) } }).save({ session });
  });
}
async function authorize(id = "1") {
  const result = await admission().authorizeEntry(`i-${id}`); assert.equal(result.status, "AUTHORIZED"); return result;
}
function broker(plan: PaperScenario) {
  return new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` }, scenario: () => plan });
}
async function submit(plan: PaperScenario, id = "1", legId = "a") {
  const child = await models.BrokerOrder.findOne({ intentId: `i-${id}`, legId }).orFail(), paper = broker(plan);
  assert.equal((await new OrderManager(connection, f.scope, paper, clock).submit(child.get("orderId"))).status, "PERSISTED");
  return { paper, orderId: String(child.get("orderId")), trades: await paper.getTrades(f.scope) };
}
async function setup(fills = [{ quantityUnits: 4, priceMinor: 9000 }]) {
  await seed(); await authorize(); return submit({ submission: "ACCEPTED", initialFills: fills });
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [name, model] of Object.entries(models)) result[name] = await model.find().sort({ _id: 1 }).lean();
  return result;
}
async function expectAccount(pending: number, committed: number, slots = 1, committedSlots = 1) {
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(account.get("reservedMarginMinor"), pending); assert.equal(account.get("reservedExposureMinor"), pending);
  assert.equal(account.get("committedExposureMinor"), committed); assert.equal(account.get("positionSlots"), slots);
  assert.equal(account.get("committedPositionSlots"), committedSlots);
  return account;
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { ids = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session })); });

test("real first partial ENTRY Fill atomically transfers exact premium and the first slot", async () => {
  const { trades } = await setup(); await expectAccount(100000, 0, 1, 0);
  assert.equal((await processor().process(trades[0])).status, "APPLIED"); await expectAccount(60000, 36000);
  const hold = await models.RiskReservation.findOne().orFail();
  assert.equal(hold.get("initialExposureMinor"), 100000); assert.equal(hold.get("remainingExposureMinor"), 60000);
  assert.deepEqual(hold.get("entryProgress"), [{ legId: "a", transferredUnits: 4, committedMinor: 36000 }]);
  const event = await models.TradingEvent.findOne({ eventType: "ENTRY_RISK_COMMITTED" }).orFail();
  assert.equal(event.get("payload.releasedPendingMinor"), 40000); assert.equal(event.get("payload.committedPremiumMinor"), 36000);
  assert.equal(event.get("payload.slotTransferred"), true);
});
test("real later partial Fill transfers no second slot", async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 9000 }, { quantityUnits: 3, priceMinor: 9500 }]);
  for (const trade of trades) await processor().process(trade);
  await expectAccount(30000, 64500);
  const events = await models.TradingEvent.find({ eventType: "ENTRY_RISK_COMMITTED" }).sort({ accountSequence: 1 });
  assert.deepEqual(events.map(e => e.get("payload.slotTransferred")), [true, false]);
  assert.equal((await models.Position.findOne().orFail()).get("legs.0.entryFilledUnits"), 7);
});
test("real full ENTRY Fill leaves zero pending and retains committed premium and slot", async () => {
  const { trades } = await setup([{ quantityUnits: 10, priceMinor: 9000 }]); await processor().process(trades[0]);
  await expectAccount(0, 90000); assert.equal((await models.RiskReservation.findOne().orFail()).get("state"), "HELD");
  const before = await snapshot(); await authorize(); assert.deepEqual(await snapshot(), before);
});
test("real exact and conflicting Fill replay cannot transfer risk twice", async () => {
  const { trades } = await setup(); await processor().process(trades[0]); const before = await snapshot();
  assert.equal((await processor().process(trades[0])).status, "DUPLICATE");
  await assert.rejects(processor().process({ ...trades[0], priceMinor: 9999 }), /DUPLICATE_FILL_CONFLICT/);
  assert.deepEqual(await snapshot(), before);
});
for (const reverse of [false, true]) test(`real out-of-order risk transfer reverse=${reverse} has identical economics`, async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 9000 }, { quantityUnits: 3, priceMinor: 9500 }]);
  for (const trade of reverse ? [...trades].reverse() : trades) await processor().process(trade);
  await expectAccount(30000, 64500); assert.equal(await models.Fill.countDocuments(), 2);
});
test("real two different Fill writers preserve both risk transfers and one slot", async () => {
  const { trades } = await setup([{ quantityUnits: 4, priceMinor: 9000 }, { quantityUnits: 3, priceMinor: 9500 }]);
  const results = await Promise.all(trades.map(trade => processor().process(trade)));
  assert.ok(results.every(r => r.status === "APPLIED")); await expectAccount(30000, 64500);
  assert.equal(await models.Fill.countDocuments(), 2); assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_COMMITTED" }), 2);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_COMMITTED", "payload.slotTransferred": true }), 1);
});
test("real duplicate Fill writers commit one economic transfer", async () => {
  const { trades } = await setup(); const results = await Promise.all([processor().process(trades[0]), processor().process(trades[0])]);
  assert.deepEqual(results.map(r => r.status).sort(), ["APPLIED", "DUPLICATE"]); await expectAccount(60000, 36000);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_COMMITTED" }), 1);
});
test("real multiple BUY legs retain their own pending quantities and permit the next admitted child", async () => {
  await seed("1", 10000, true); await authorize();
  const a = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 9000 }] });
  await processor().process(a.trades[0]); await expectAccount(160000, 36000); await authorize();
  const b = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 3, priceMinor: 9500 }] }, "1", "b");
  await processor().process(b.trades[0]); await expectAccount(130000, 64500);
  assert.deepEqual((await models.RiskReservation.findOne().orFail()).get("entryProgress"), [
    { legId: "a", transferredUnits: 4, committedMinor: 36000 }, { legId: "b", transferredUnits: 3, committedMinor: 28500 }]);
});
test("real UNKNOWN remainder retains pending risk after proved partial fills", async () => {
  await seed(); await authorize(); const result = await submit({ submission: "AMBIGUOUS", initialFills: [{ quantityUnits: 4, priceMinor: 9000 }] });
  await processor().process(result.trades[0]); await expectAccount(60000, 36000);
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("knowledge"), "UNKNOWN");
  const before = await snapshot(); await authorize(); assert.deepEqual(await snapshot(), before);
});
test("real admission counts 70000 committed plus 20000 pending against 100000 maximum", async () => {
  await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 100000 } });
  await seed("1", 7000); await authorize(); const first = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 7000 }] });
  await processor().process(first.trades[0]); await seed("2", 2000); await authorize("2"); await seed("3", 2000);
  const before = await snapshot(); assert.deepEqual(await admission().authorizeEntry("i-3"), { status: "REJECTED", intentId: "i-3", reason: "RISK_CAPACITY_EXCEEDED" });
  assert.deepEqual(await snapshot(), before); await expectAccount(20000, 70000, 2, 1);
});
test("real slot ceiling includes one committed and one reserved position", async () => {
  await configure({ entryRiskPolicy: { ...policy, maxPositionSlots: 2 } });
  const { trades } = await setup(); await processor().process(trades[0]); await seed("2"); await authorize("2"); await seed("3");
  assert.deepEqual(await admission().authorizeEntry("i-3"), { status: "REJECTED", intentId: "i-3", reason: "POSITION_LIMIT_EXCEEDED" });
  await expectAccount(160000, 36000, 2, 1);
});
test("real concurrent Fill and new admission cannot oversubscribe total risk", async () => {
  await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 100000 } });
  await seed("1", 7000); await authorize(); await seed("2", 4000);
  const { trades } = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 6000 }] });
  const [filled, admitted] = await Promise.all([processor().process(trades[0]), admission().authorizeEntry("i-2")]);
  assert.equal(filled.status, "APPLIED"); assert.equal(admitted.status, "REJECTED");
  assert.equal(admitted.reason, "RISK_CAPACITY_EXCEEDED"); await expectAccount(42000, 24000);
});
test("real admission cannot observe pending removed before committed was added", async () => {
  await configure({ entryRiskPolicy: { ...policy, maxReservedRiskMinor: 100000 } });
  await seed("1", 7000); await authorize(); await seed("2", 4000);
  const { trades } = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 6500 }] });
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), paused = new Promise<void>(resolve => { reached = resolve; });
  const original = models.RiskReservation.prototype.save;
  models.RiskReservation.prototype.save = async function (...args: unknown[]) { const saved = await original.apply(this, args); reached(); await gate; return saved; };
  const filling = processor().process(trades[0]);
  try {
    await Promise.race([paused, filling.then(() => { throw new Error("transfer did not pause"); })]);
    assert.deepEqual(await admission().authorizeEntry("i-2"), { status: "REJECTED", intentId: "i-2", reason: "RISK_CAPACITY_EXCEEDED" });
    await expectAccount(70000, 0, 1, 0); // Separate reader sees the coherent pre-transfer state.
  } finally { release(); models.RiskReservation.prototype.save = original; }
  await filling; await expectAccount(0, 65000);
});
for (const ceiling of ["maxReservedRiskMinor", "maxRiskPerEntryMinor"] as const)
test(`real above-limit Fill persists truth above ${ceiling} and blocks new admission`, async () => {
  await configure({ entryRiskPolicy: { ...policy, [ceiling]: 100000 } });
  const { trades } = await setup([{ quantityUnits: 10, priceMinor: 10000 }]);
  // PaperBroker enforces BUY limits. Inject owned abnormal broker truth at the evidence boundary.
  await processor().process({ ...trades[0], priceMinor: 10500 });
  await expectAccount(0, 105000); assert.equal(await models.Fill.countDocuments(), 1);
  await seed("2", 100); assert.deepEqual(await admission().authorizeEntry("i-2"), { status: "REJECTED", intentId: "i-2",
    reason: ceiling === "maxReservedRiskMinor" ? "RISK_CAPACITY_EXCEEDED" : "RISK_PER_TRADE_EXCEEDED" });
});
test("real zero-premium full Fill transfers the slot without inventing premium", async () => {
  const { trades } = await setup([{ quantityUnits: 10, priceMinor: 0 }]); await processor().process(trades[0]); await expectAccount(0, 0);
});
for (const entity of ["RiskReservation", "TradingAccount", "Position", "TradingEvent"] as const)
 test(`real ${entity} save failure rolls back Fill transfer, quantities, slots and event sequence`, async () => {
  const { trades } = await setup(), before = await snapshot(), original = models[entity].prototype.save;
  models[entity].prototype.save = function (...args: unknown[]) {
    if (entity !== "TradingEvent" || this.get("eventType") === "ENTRY_RISK_COMMITTED") return Promise.reject(new Error("injected-risk-transfer"));
    return original.apply(this, args);
  };
  try { await assert.rejects(processor().process(trades[0]), /injected-risk-transfer/); }
  finally { models[entity].prototype.save = original; }
  assert.deepEqual(await snapshot(), before);
  assert.equal((await processor().process(trades[0])).status, "APPLIED"); await expectAccount(60000, 36000);
  const after = await snapshot(); assert.equal((await processor().process(trades[0])).status, "DUPLICATE"); assert.deepEqual(await snapshot(), after);
});
test("real CLOSE partial/full fills and CLOSED retain committed ENTRY premium and slots", async () => {
  const { trades } = await setup([{ quantityUnits: 10, priceMinor: 9000 }]); await processor().process(trades[0]);
  await seed("2", 1000); await authorize("2"); // Unrelated pending reservation must also remain untouched.
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("p-1", "close");
  const paper = broker({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 10000 }], steps: [{ kind: "FILL", quantityUnits: 6, priceMinor: 10000 }] });
  await new OrderManager(connection, f.scope, paper, clock).submit(close.orderIds[0]); await processor().processRetained(close.orderIds[0]);
  await expectAccount(10000, 90000, 2, 1);
  await paper.advance({ ...f.scope, orderId: close.orderIds[0] });
  for (const trade of await paper.getTrades(f.scope)) await processor().process(trade);
  assert.equal((await new CloseWorkflowService(connection, f.scope, clock).advance("p-1")).status, "CLOSED");
  await expectAccount(10000, 90000, 2, 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_COMMITTED" }), 1);
});
for (const corrupt of ["regress", "invent-premium", "over-transfer", "negative"]) test(`real reservation progress rejects ${corrupt}`, async () => {
  const { trades } = await setup(); await processor().process(trades[0]); const before = await snapshot();
  await assert.rejects(tx(async session => {
    const hold = await models.RiskReservation.findOne().session(session).orFail();
    const progress = { legId: "a", transferredUnits: 4, committedMinor: 36000 };
    if (corrupt === "regress") { progress.transferredUnits = 0; progress.committedMinor = 0; hold.set({ remainingMarginMinor: 100000, remainingExposureMinor: 100000 }); }
    if (corrupt === "invent-premium") progress.committedMinor = 1;
    if (corrupt === "over-transfer") progress.transferredUnits = 11;
    if (corrupt === "negative") progress.transferredUnits = -1;
    hold.set("entryProgress", [progress]); await hold.save({ session });
  })); assert.deepEqual(await snapshot(), before);
});
for (const drift of ["committedExposureMinor", "committedPositionSlots"]) test(`real unexplained ${drift} drift blocks new admission`, async () => {
  const { trades } = await setup(); await processor().process(trades[0]); await seed("2"); await configure({ [drift]: 0 });
  const before = await snapshot(); assert.deepEqual(await admission().authorizeEntry("i-2"), { status: "REJECTED", intentId: "i-2", reason: "RISK_PROJECTION_MISMATCH" });
  assert.deepEqual(await snapshot(), before);
});
test("real foreign leg evidence cannot consume another reservation leg", async () => {
  const { trades } = await setup(); const before = await snapshot();
  await assert.rejects(processor().process({ ...trades[0], legId: "other" }), /FILL_OWNERSHIP_MISMATCH/); assert.deepEqual(await snapshot(), before);
});
