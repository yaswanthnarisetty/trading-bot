import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";
import { verifyExecutionIndexes } from "../../src/db/executionIndexes";
import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { RecoveryBarrierService } from "../../src/services/RecoveryBarrierService";
import { ReconciliationService } from "../../src/services/ReconciliationService";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
import { FillProcessor } from "../../src/services/FillProcessor";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { OrderManager } from "../../src/services/OrderManager";
import { PaperBrokerAdapter } from "../../src/brokers/PaperBrokerAdapter";
import { brokerSnapshot, orderLink, fillLink, config, reconciliationTime } from "../reconciliationFixtures";
import * as f from "../fixtures";
const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
const host = createExecutionHostContext("test-host");
let now = new Date(reconciliationTime), ids = 0;
const clock = () => new Date(now), paperClock = () => new Date(f.now), deadline = new Date(f.now.getTime() + 60000);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 1000000, maxReservedRiskMinor: 1000000, maxPositionSlots: 10, maxDailyLossMinor: 1000000 };
const service = () => new ReconciliationService(connection, f.scope, clock, host);
const admission = () => new RiskAdmissionService(connection, f.scope, clock, host);
const processor = () => new FillProcessor(connection, f.scope, paperClock);
const reconcile = async (options: Parameters<typeof brokerSnapshot>[0] = {}) => {
  const result = await service().reconcileAccount(f.scope.accountId, await brokerSnapshot({ time: now, ...options }));
  if (result.report.classification === "MATCHED" && (await models.TradingAccount.findOne(f.scope).orFail()).get("recoveryState.status") === "RECOVERY_REQUIRED")
    await new RecoveryBarrierService(connection, f.scope, clock, host).completeRecovery(f.scope.accountId, result.recordId);
  return result;
};
const has = (result: any, code: string) => assert.ok(result.report.discrepancies.some((d: any) => d.code === code), JSON.stringify(result.report));
async function tx<T>(work: (session: ClientSession) => Promise<T>) { const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); } }
async function configure() { await tx(async session => { const a = await models.TradingAccount.findOne(f.scope).session(session).orFail();
  a.set("reconciliationConfig", config); await a.save({ session }); });
  await new RecoveryBarrierService(connection, f.scope, clock, host).beginRecovery(f.scope.accountId, "test-startup");
  now = new Date(now.getTime() + 1);
}
async function seed(id = "1") {
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`s-${id}`), decisionKey: `d-${id}`, expiresAt: deadline }).save({ session });
    await new models.OrderIntent({ ...f.intent(`i-${id}`), signalId: `s-${id}`, deadline,
      entryPlan: { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: deadline,
        legs: [{ legId: "hedge", contractKey: "NFO:contract-1", instrumentKind: "NSE_OPTION", optionType: "CALL", expiry: deadline,
          qualificationRef: "qualified", lotSizeUnits: 1, tickSizeMinor: 1, limitPriceMinor: 1000 }] } }).save({ session });
    await new models.Position({ ...f.position(`p-${id}`), entryIntentId: `i-${id}`,
      closePolicy: { kind: "POSITION_LIMIT_V1", product: "INTRADAY", policyVersion: 1, expiresAt: deadline,
        legLimits: [{ legId: "hedge", limitPriceMinor: 1000 }] } }).save({ session });
  });
}
async function setup(units = 4, ingest = true, linked = true, ownsNetPosition = true) {
  await seed(); const admissionResult = await admission().authorizeEntry("i-1"); assert.equal(admissionResult.status, "AUTHORIZED");
  if (admissionResult.status !== "AUTHORIZED") throw new Error("setup admission failed");
  const orderId = admissionResult.orderIds[0];
  const paper = new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` },
    scenario: () => ({ submission: "ACCEPTED", steps: units ? [{ kind: "FILL", quantityUnits: units, priceMinor: 900 }] : [] }) });
  await new OrderManager(connection, f.scope, paper, paperClock, host).submit(orderId);
  if (units) await paper.advance({ ...f.scope, orderId });
  const trades = await paper.getTrades(f.scope);
  if (ingest && units) await processor().process(trades[0]);
  await configure();
  if (linked) await tx(async session => {
    const reference=orderLink(orderId);
    if (!ownsNetPosition && reference.link.kind === "ORDER") delete reference.link.positionScope;
    await new models.ReconciliationLink({ ...f.base(), ...reference }).save({ session });
    if (ingest && units) { const fill = await models.Fill.findOne({ orderId }).session(session).orFail();
      await new models.ReconciliationLink({ ...f.base(), ...fillLink(String(fill.get("fillId"))) }).save({ session }); }
  });
  return { orderId, trades };
}
async function financial() {
  const a = (await models.TradingAccount.findOne().lean())! as Record<string, unknown>;
  const { version, nextEventSequence, updatedAt, reconciliationState, recoveryState, ...account } = a;
  const result: Record<string, unknown> = { account };
  for (const name of ["BrokerOrder", "Fill", "Position", "RiskReservation", "OrderIntent"] as const) result[name] = await models[name].find().sort({ _id: 1 }).lean();
  return result;
}
async function all() { const out: Record<string, unknown> = {}; for (const [key, model] of Object.entries(models)) out[key] = await model.find().sort({ _id: 1 }).lean(); return out; }
async function entryBlocked() { await seed("2"); const r = await admission().authorizeEntry("i-2");
  const ready = (await models.TradingAccount.findOne(f.scope).orFail()).get("recoveryState.status") === "READY";
  assert.deepEqual(r, { status: "REJECTED", intentId: "i-2", reason: ready ? "RECONCILIATION_REQUIRED" : "RECOVERY_REQUIRED" }); }
function nextSnapshot() { now = new Date(now.getTime() + 1000); }
const flat = { orders: false, trades: false, positions: false };
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { ids = 0; now = new Date(reconciliationTime); await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session })); });

test("real reconciliation fully matched account commits record/state/event without financial mutation", async () => {
  await setup(10); const before = await financial(), r = await reconcile({ units: 10 }); assert.equal(r.report.classification, "MATCHED");
  assert.deepEqual(await financial(), before); assert.equal(await models.ReconciliationRecord.countDocuments(), 1);
  const a = await models.TradingAccount.findOne().orFail(); assert.equal(a.get("reconciliationState.recordId"), r.recordId);
  assert.equal(await models.TradingEvent.countDocuments({ eventId: r.recordId, eventType: "RECONCILIATION_RESOLVED" }), 1);
});
test("real reconciliation partial order and processed Fill match", async () => { await setup(); assert.equal((await reconcile()).report.classification, "MATCHED"); });
test("real reconciliation internal UNKNOWN remains unresolved despite exact broker evidence", async () => {
  const { orderId } = await setup(); await tx(async session => { const o = await models.BrokerOrder.findOne({ orderId }).session(session).orFail(); o.set("knowledge", "UNKNOWN"); await o.save({ session }); });
  const r = await reconcile(); assert.equal(r.report.classification, "RECONCILIATION_REQUIRED"); has(r, "INTERNAL_EXECUTION_UNRESOLVED");
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("knowledge"), "UNKNOWN");
});
test("real reconciliation unlinked broker order is outside reference scope without adopting", async () => { await configure(); const r = await reconcile({ units: 0 }); assert.equal(r.report.classification, "MATCHED"); assert.equal(await models.BrokerOrder.countDocuments(), 0); });
test("real reconciliation internal active order absent is not NOT_SENT", async () => { await setup(0); const r = await reconcile({ ...flat, units: 0 }); has(r, "INTERNAL_ORDER_NOT_CONFIRMED"); assert.equal((await models.BrokerOrder.findOne().orFail()).get("phase"), "ACKNOWLEDGED"); });
test("real reconciliation broker trade without Fill is retained as discrepancy", async () => { await setup(4, false); const r = await reconcile(); has(r, "BROKER_TRADE_MISSING_INTERNAL_FILL"); assert.equal(await models.Fill.countDocuments(), 0); });
test("real reconciliation same-day internal Fill absent from complete trade evidence", async () => { await setup(); has(await reconcile({ trades: false }), "INTERNAL_FILL_NOT_CONFIRMED"); });
test("real reconciliation conflicting native trade economics never overwrites Fill", async () => { await setup(); const before = await financial(); has(await reconcile({ trade: { average_price: 9.005 } }), "TRADE_ECONOMICS_CONFLICT"); assert.deepEqual(await financial(), before); });
test("real reconciliation larger broker position is discrepancy", async () => { await setup(); has(await reconcile({ position: { quantity: 8 } }), "POSITION_QUANTITY_MISMATCH"); });
test("real reconciliation larger internal position is discrepancy", async () => { await setup(); has(await reconcile({ position: { quantity: 1 } }), "POSITION_QUANTITY_MISMATCH"); });
test("real reconciliation external broker exposure blocks ENTRY", async () => { await setup(0); has(await reconcile({ trades: false, order: { filled_quantity: 0, pending_quantity: 10 } }), "EXTERNAL_BROKER_EXPOSURE"); await entryBlocked(); });
test("real reconciliation unavailable trades blocks ENTRY", async () => { await configure(); const r = await reconcile({ ...flat, fail: "/trades" }); assert.equal(r.report.classification, "INCOMPLETE"); await entryBlocked(); });
test("real reconciliation failed positions is not flat", async () => { await setup(); const r = await reconcile({ fail: "/portfolio/positions" }); assert.equal(r.report.classification, "INCOMPLETE"); assert.ok(!r.report.discrepancies.some((d: any) => d.code === "POSITION_QUANTITY_MISMATCH")); });
test("real reconciliation successful empty positions is flat", async () => { await configure(); assert.equal((await reconcile(flat)).report.classification, "MATCHED"); });
test("real reconciliation MATCHED permits ENTRY through all Phase 2C gates", async () => { await seed(); await configure(); await reconcile(flat); assert.equal((await admission().authorizeEntry("i-1")).status, "AUTHORIZED"); });
test("real reconciliation discrepancy blocks ENTRY", async () => { await setup(); await reconcile({ position: { quantity: 7 } }); await entryBlocked(); });
test("real reconciliation configured without proof fails closed", async () => { await configure(); await entryBlocked(); });
test("real reconciliation discrepancy permits CLOSE with existing finality proof", async () => { await setup(10); await reconcile({ units: 10, position: { quantity: 12 } });
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("p-1", "close-under-discrepancy"); assert.equal(close.status, "CREATED"); });
test("real reconciliation discrepancy permits post-dispatch Fill ingestion", async () => { const { trades } = await setup(4, false); await reconcile(); assert.equal((await processor().process(trades[0])).status, "APPLIED"); assert.equal(await models.Fill.countDocuments(), 1); });
test("real reconciliation same snapshot replay adds no records, events or mutations", async () => { await setup(); const snapshot = await brokerSnapshot({ time: now }); const first = await service().reconcileAccount(f.scope.accountId, snapshot), before = await all();
  assert.deepEqual(await service().reconcileAccount(f.scope.accountId, snapshot), first); assert.deepEqual(await all(), before); });
test("real reconciliation concurrent same snapshot has one result and unique event sequence", async () => { await setup(); const snapshot = await brokerSnapshot({ time: now });
  const [a, b] = await Promise.all([service().reconcileAccount(f.scope.accountId, snapshot), service().reconcileAccount(f.scope.accountId, snapshot)]);
  assert.deepEqual(a, b); assert.equal(await models.ReconciliationRecord.countDocuments(), 1);
  const events = await models.TradingEvent.find().lean(); assert.equal(new Set(events.map(e => (e as Record<string, unknown>).accountSequence)).size, events.length);
});
test("real reconciliation newer matching snapshot clears block and preserves discrepancy history", async () => { await setup(); const first = await reconcile({ position: { quantity: 8 } }); nextSnapshot(); const second = await reconcile();
  assert.equal(first.report.classification, "DISCREPANCY"); assert.equal(second.report.classification, "MATCHED"); assert.equal(await models.ReconciliationRecord.countDocuments(), 2);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("reconciliationState.recordId"), second.recordId); });
test("real reconciliation replay of old MATCHED never clears newer discrepancy", async () => { await setup(); const old = await brokerSnapshot({ time: now }); await service().reconcileAccount(f.scope.accountId, old); nextSnapshot(); const current = await reconcile({ position: { quantity: 8 } });
  await service().reconcileAccount(f.scope.accountId, old); assert.equal((await models.TradingAccount.findOne().orFail()).get("reconciliationState.recordId"), current.recordId); });
// These barriers pause actual saves; every transaction, conflict, retry and commit uses real Mongo.
function pauseAccountSave(predicate: (doc: any) => boolean) {
  const original = models.TradingAccount.prototype.save; let release!: () => void, entered!: () => void, paused = false;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  models.TradingAccount.prototype.save = async function (options: any) { if (!paused && predicate(this)) { paused = true; entered(); await gate; } return original.call(this, options); };
  return { waiting, release, restore: () => { release(); models.TradingAccount.prototype.save = original; } };
}
test("real reconciliation winning CAS prevents stale competing ENTRY admission", async () => {
  await seed(); await configure(); await reconcile(flat);
  const barrier = pauseAccountSave(doc => doc.get("reservedExposureMinor") > 0);
  const pending = admission().authorizeEntry("i-1");
  try { await barrier.waiting; nextSnapshot(); const r = await reconcile({ ...flat, fail: "/trades" }); assert.equal(r.report.classification, "INCOMPLETE"); barrier.release();
    assert.deepEqual(await pending, { status: "REJECTED", intentId: "i-1", reason: "RECONCILIATION_REQUIRED" }); assert.equal(await models.RiskReservation.countDocuments(), 0);
  } finally { barrier.restore(); }
});
test("real reconciliation retries after FillProcessor wins and cannot persist stale MATCHED", async () => {
  const { trades } = await setup(4, false), barrier = pauseAccountSave(doc => !!doc.get("reconciliationState"));
  const pending = reconcile({ units: 0 });
  try { await barrier.waiting; await processor().process(trades[0]); barrier.release(); const r = await pending;
    assert.notEqual(r.report.classification, "MATCHED"); assert.equal(r.report.counts.internalFills, 1); assert.equal(await models.ReconciliationRecord.countDocuments(), 1);
  } finally { barrier.restore(); }
});
for (const entity of ["TradingEvent", "TradingAccount", "ReconciliationRecord"] as const) test(`real reconciliation ${entity} save failure rolls back record, account and event sequence`, async () => {
  await setup(); const before = await all(), original = models[entity].prototype.save;
  models[entity].prototype.save = async function () { throw new Error("injected-reconciliation-save-failure"); };
  try { await assert.rejects(reconcile(), /injected-reconciliation-save-failure/); } finally { models[entity].prototype.save = original; }
  assert.deepEqual(await all(), before);
});
test("real reconciliation malformed endpoint evidence remains non-destructive and blocking", async () => { await setup(); const before = await financial(); const r = await reconcile({ trade: { quantity: -1 } }); assert.equal(r.report.classification, "INCOMPLETE"); assert.deepEqual(await financial(), before); });
test("real reconciliation arbitrary caller snapshots rejected before persistence", async () => { await configure(); const before = await all(), snapshot = await brokerSnapshot({ time: now });
  await assert.rejects(service().reconcileAccount(f.scope.accountId, JSON.parse(JSON.stringify(snapshot))), /NORMALIZED_KITE_SNAPSHOT_REQUIRED/); assert.deepEqual(await all(), before); });
test("real reconciliation wrong broker account rejected without mutation", async () => { await configure(); const before = await all(); await assert.rejects(reconcile({ account: "OTHER" }), /BROKER_ACCOUNT_MISMATCH/); assert.deepEqual(await all(), before); });
test("real reconciliation cross-account link references rejected", async () => { await configure(); await assert.rejects(tx(session => new models.ReconciliationLink({ ...f.base(), ...orderLink("foreign-order") }).save({ session })), /LEDGER_REFERENCE_NOT_FOUND/); });
test("real reconciliation LIVE service and LIVE shadow links remain forbidden", async () => { assert.throws(() => new ReconciliationService(connection, { accountId: "LIVE:other", executionMode: "LIVE" }), /PAPER_ONLY/);
  await assert.rejects(new models.ReconciliationLink({ ...f.base(), ...orderLink(), accountId: "LIVE:other", executionMode: "LIVE" }).validate(), /PAPER/); });
test("real reconciliation healthy state cannot be fabricated through account save", async () => { await setup(); await reconcile();
  await assert.rejects(tx(async session => { const a = await models.TradingAccount.findOne().session(session).orFail(); a.set("reconciliationState.recordId", "invented"); await a.save({ session }); }), /AUDITED_RECONCILIATION_SERVICE_REQUIRED/); });
test("real reconciliation record and links are append-only with unique mapping indexes", async () => { await setup(); await reconcile();
  await assert.rejects(tx(async session => { const r = await models.ReconciliationRecord.findOne().session(session).orFail(); await r.save({ session }); }), /APPEND_ONLY/);
  await assert.rejects(tx(async session => { const l = await models.ReconciliationLink.findOne().session(session).orFail(); const { _id, ...data } = l.toObject();
    await new models.ReconciliationLink({ ...data, linkId: "duplicate-link" }).save({ session }); }), /E11000/);
});
test("real reconciliation missing audit proof cannot authorize entry", async () => { await configure(); const r = await reconcile(flat);
  await connection.db!.collection("execution_events").deleteOne({ eventId: r.recordId }); await entryBlocked(); });
test("real reconciliation older run cannot lower endpoint watermark and unlock admission", async () => {
  await setup(); const baseTime = new Date(now); nextSnapshot(); nextSnapshot(); const latest = await reconcile({ position: { quantity: 8 } });
  const old = await reconcile({ time: baseTime }); assert.equal(old.report.classification, "INCOMPLETE");
  assert.deepEqual((await models.TradingAccount.findOne().orFail()).get("reconciliationState.endpointTimes"), latest.report.endpoints.map(e => e.fetchedAt));
  const middle = await reconcile({ time: new Date(baseTime.getTime() + 1000) }); assert.equal(middle.report.classification, "INCOMPLETE"); await entryBlocked();
});
test("real reconciliation discrepancy fences initial dispatch of already admitted ENTRY", async () => {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); assert.equal(admitted.status, "AUTHORIZED");
  if (admitted.status !== "AUTHORIZED") throw new Error("setup admission"); await configure(); await reconcile({ ...flat, fail: "/trades" });
  const paper = new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` }, scenario: () => ({ submission: "ACCEPTED" }) });
  await assert.rejects(new OrderManager(connection, f.scope, paper, paperClock, host).submit(admitted.orderIds[0]), /RECONCILIATION_REQUIRED|RECOVERY_REQUIRED/);
  assert.equal((await paper.getOrders(f.scope)).length, 0); assert.equal((await models.BrokerOrder.findOne().orFail()).get("submissionClaim"), undefined);
});

test("real reference-only PAPER Fill plus flat Kite remains MATCHED and permits new ENTRY", async () => {
  await setup(4, true, false); const before = await financial(); const r = await reconcile(flat);
  assert.equal(r.report.classification, "MATCHED"); assert.deepEqual(r.report.discrepancies, []); assert.deepEqual(await financial(), before);
  await seed("2"); assert.equal((await admission().authorizeEntry("i-2")).status, "AUTHORIZED");
});
test("real reference-only unlinked acknowledged PAPER order needs no broker counterpart", async () => {
  await setup(0, true, false); const r = await reconcile(flat); assert.equal(r.report.classification,"MATCHED");
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("phase"),"ACKNOWLEDGED");
});
test("real reference-only unrelated manual CNC position does not block PAPER ENTRY", async () => {
  await seed(); await configure(); const r = await reconcile({orders:false,trades:false,
    position:{exchange:"NSE",tradingsymbol:"MANUAL_STOCK",instrument_token:999,product:"CNC",quantity:50}});
  assert.equal(r.report.classification,"MATCHED"); assert.deepEqual(r.report.discrepancies,[]);
  assert.equal((await admission().authorizeEntry("i-1")).status,"AUTHORIZED"); assert.equal(await models.Fill.countDocuments(),0);
});
test("real reference-only unrelated Kite order and trade do not block PAPER ENTRY", async () => {
  await seed(); await configure(); const r = await reconcile({positions:false});
  assert.equal(r.report.classification,"MATCHED"); assert.deepEqual(r.report.discrepancies,[]);
  assert.equal((await admission().authorizeEntry("i-1")).status,"AUTHORIZED"); assert.equal(await models.Fill.countDocuments(),0);
});
test("real opt-out with BASE indexes only retains Phase 2C admission without reconciliation collections", async () => {
  await connection.dropDatabase(); await createExecutionIndexes(connection,"BASE");
  await tx(session=>new models.TradingAccount({...f.account(),admissionStatus:"PAPER_READY",entryRiskPolicy:policy}).save({session}));
  await seed(); assert.equal((await verifyExecutionIndexes(connection)).verified,true);
  assert.equal((await verifyExecutionIndexes(connection,"RECONCILIATION")).verified,false);
  assert.equal((await admission().authorizeEntry("i-1")).status,"AUTHORIZED");
  const collections=await connection.db!.listCollections({}, {nameOnly:true}).toArray();
  assert.equal(collections.some(c=>c.name.startsWith("execution_reconcil")),false);
});
test("real opted-in admission rejects missing reconciliation indexes before trusting MATCHED", async () => {
  await seed(); await configure(); await reconcile(flat);
  await models.ReconciliationRecord.collection.dropIndexes(); await models.ReconciliationLink.collection.dropIndexes();
  const before=await all(); await assert.rejects(admission().authorizeEntry("i-1"),/EXECUTION_INDEXES_NOT_READY/); assert.deepEqual(await all(),before);
});
test("real ReconciliationService rejects missing unique run index without writes", async () => {
  await configure(); const indexes=await models.ReconciliationRecord.collection.indexes();
  const runIndex=indexes.find(i=>i.key.runKey===1); assert.ok(runIndex?.name); await models.ReconciliationRecord.collection.dropIndex(runIndex.name);
  const before=await all(); await assert.rejects(reconcile(flat),/EXECUTION_INDEXES_NOT_READY/); assert.deepEqual(await all(),before);
});
test("real reconciliation opt-in cannot be enabled before its indexes are provisioned", async () => {
  await models.ReconciliationRecord.collection.dropIndexes(); await models.ReconciliationLink.collection.dropIndexes();
  await assert.rejects(configure(),/EXECUTION_INDEXES_NOT_READY/);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("reconciliationConfig"),undefined);
});
test("real reference-only gate cannot reuse pre-correction MATCHED proof", async () => {
  await configure(); const record=await reconcile(flat);
  await connection.db!.collection("execution_reconciliations").updateOne({recordId:record.recordId},{$set:{"report.reconciliationVersion":1}});
  await entryBlocked();
});

test("real explicit order/trade reference does not implicitly own manual exposure in the same instrument/product", async () => {
  await setup(4,true,true,false); const r=await reconcile({position:{quantity:54}});
  assert.equal(r.report.classification,"MATCHED"); await seed("2"); assert.equal((await admission().authorizeEntry("i-2")).status,"AUTHORIZED");
});
