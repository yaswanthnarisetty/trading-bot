import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";
import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { RecoveryBarrierService } from "../../src/services/RecoveryBarrierService";
import { ReconciliationService } from "../../src/services/ReconciliationService";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
import { OrderManager } from "../../src/services/OrderManager";
import { FillProcessor } from "../../src/services/FillProcessor";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { PaperBrokerAdapter } from "../../src/brokers/PaperBrokerAdapter";
import { brokerSnapshot, config, orderLink, reconciliationTime } from "../reconciliationFixtures";
import * as f from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
const host = createExecutionHostContext("test-host");
let now = new Date(reconciliationTime), ids = 0;
const clock = () => new Date(now), tick = () => { now = new Date(now.getTime() + 1000); };
const recovery = () => new RecoveryBarrierService(connection, f.scope, clock, host);
const admission = () => new RiskAdmissionService(connection, f.scope, clock, host);
const processor = () => new FillProcessor(connection, f.scope, () => f.now);
const flat = { orders: false, trades: false, positions: false };
const deadline = new Date(f.now.getTime() + 60000);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 1000000, maxReservedRiskMinor: 1000000, maxPositionSlots: 10, maxDailyLossMinor: 1000000 };
async function tx<T>(work: (session: ClientSession) => Promise<T>) { const s = await connection.startSession();
  try { return await s.withTransaction(() => work(s)); } finally { await s.endSession(); } }
async function configure() { await tx(async session => { const a = await models.TradingAccount.findOne(f.scope).session(session).orFail();
  a.set("reconciliationConfig", config); await a.save({ session }); }); }
async function seed(id = "1") { await tx(async session => {
  await new models.StrategySignal({ ...f.signal(`s-${id}`), decisionKey: `d-${id}`, expiresAt: deadline }).save({ session });
  await new models.OrderIntent({ ...f.intent(`i-${id}`), signalId: `s-${id}`, deadline,
    entryPlan: { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: deadline,
      legs: [{ legId: "hedge", contractKey: "NFO:contract-1", instrumentKind: "NSE_OPTION", optionType: "CALL", expiry: deadline,
        qualificationRef: "qualified", lotSizeUnits: 1, tickSizeMinor: 1, limitPriceMinor: 1000 }] } }).save({ session });
  await new models.Position({ ...f.position(`p-${id}`), entryIntentId: `i-${id}`,
    closePolicy: { kind: "POSITION_LIMIT_V1", product: "INTRADAY", policyVersion: 1, expiresAt: deadline,
      legLimits: [{ legId: "hedge", limitPriceMinor: 1000 }] } }).save({ session });
}); }
function paper(units = 0) { return new PaperBrokerAdapter(f.scope, {
  clock: { now: () => f.now.toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` },
  scenario: request => ({ submission: "ACCEPTED", steps: units ? [{ kind: "FILL", quantityUnits: units, priceMinor: request.side === "BUY" ? 900 : 1100 }] : [] }),
}); }
async function entry(units = 0, ingest = true) {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); assert.equal(admitted.status, "AUTHORIZED");
  if (admitted.status !== "AUTHORIZED") throw new Error("setup admission failed");
  const orderId = admitted.orderIds[0], broker = paper(units);
  await new OrderManager(connection, f.scope, broker, () => f.now, host).submit(orderId);
  if (units) await broker.advance({ ...f.scope, orderId });
  const trades = await broker.getTrades(f.scope);
  if (ingest && units) await processor().process(trades[0]);
  return { orderId, broker, trades };
}
const begin = (key = "startup-1") => recovery().beginRecovery(f.scope.accountId, key);
const complete = (recordId: string) => recovery().completeRecovery(f.scope.accountId, recordId);
async function reconcile(options: Parameters<typeof brokerSnapshot>[0] = flat) {
  return new ReconciliationService(connection, f.scope, clock, host).reconcileAccount(f.scope.accountId, await brokerSnapshot({ time: now, ...options }));
}
async function matched() { tick(); const result = await reconcile(); assert.equal(result.report.classification, "MATCHED"); return result; }
async function ready() { await begin(); const result = await matched(); await complete(result.recordId); return result; }
async function all() { const out: Record<string, unknown> = {}; for (const [key, model] of Object.entries(models)) out[key] = await model.find().sort({ _id: 1 }).lean(); return out; }
async function financial() {
  const data = await all(), account = (data.TradingAccount as Record<string, unknown>[])[0];
  const { recoveryState, reconciliationState, version, nextEventSequence, updatedAt, ...rest } = account;
  return { account: rest, ...Object.fromEntries(["BrokerOrder", "Fill", "Position", "RiskReservation", "OrderIntent"].map(k => [k, data[k]])) };
}
async function blocked(id = "1") { assert.deepEqual(await admission().authorizeEntry(`i-${id}`), { status: "REJECTED", intentId: `i-${id}`, reason: "RECOVERY_REQUIRED" }); }
function pauseSave(predicate: (doc: any) => boolean) {
  const original = models.TradingAccount.prototype.save; let entered!: () => void, release!: () => void, paused = false;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  models.TradingAccount.prototype.save = async function (options: any) {
    if (!paused && predicate(this)) { paused = true; entered(); await gate; } return original.call(this, options);
  };
  return { waiting, release, restore: () => { release(); models.TradingAccount.prototype.save = original; } };
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { now = new Date(reconciliationTime); ids = 0; await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session })); });

test("real recovery opt-out is a no-op and BASE-only admission still works", async () => {
  await connection.dropDatabase(); await createExecutionIndexes(connection, "BASE");
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session }));
  await seed(); const before = await all(); assert.deepEqual(await begin(), { status: "OPTED_OUT" });
  assert.deepEqual(await complete("unused"), { status: "OPTED_OUT" }); assert.deepEqual(await all(), before);
  assert.equal((await admission().authorizeEntry("i-1")).status, "AUTHORIZED");
  assert.equal((await connection.db!.listCollections({}, { nameOnly: true }).toArray()).some(c => c.name.startsWith("execution_reconcil")), false);
});
test("real enabled account without recovery state fails closed even with MATCHED", async () => {
  await seed(); await configure(); await reconcile(); await blocked();
});
test("real recovery begin fences account and records one audited generation without financial changes", async () => {
  await configure(); const before = await financial(), a = await models.TradingAccount.findOne().orFail();
  const state = await begin(); assert.equal(state.status, "RECOVERY_REQUIRED");
  assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.generation"), 1);
  assert.ok((await models.TradingAccount.findOne().orFail()).get("version") > a.get("version"));
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_REQUIRED" }), 1); assert.deepEqual(await financial(), before);
});
test("real prior MATCHED and completion cannot authorize a new recovery generation", async () => {
  await seed(); await configure(); const old = await ready(); tick(); await begin("startup-2");
  await blocked(); await assert.rejects(complete(old.recordId), /RECOVERY_PROOF_INVALID/);
  const current = await matched(); assert.equal(current.report.recoveryGeneration, 2);
  await complete(current.recordId); assert.equal((await admission().authorizeEntry("i-1")).status, "AUTHORIZED");
  assert.equal(await models.ReconciliationRecord.countDocuments(), 2);
});
test("real READY ENTRY cannot make an initial broker claim during recovery", async () => {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); if (admitted.status !== "AUTHORIZED") throw new Error("setup failed");
  await configure(); await begin(); const broker = paper();
  await assert.rejects(new OrderManager(connection, f.scope, broker, clock, host).submit(admitted.orderIds[0]), /RECOVERY_REQUIRED/);
  assert.equal((await broker.getOrders(f.scope)).length, 0);
  assert.equal((await models.BrokerOrder.findOne().orFail()).get("submissionClaim"), undefined);
});
test("real CLOSE planning submission and reducing Fill continue during recovery", async () => {
  await entry(10); await configure(); await begin();
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("p-1", "close-recovery");
  assert.equal(close.status, "CREATED"); await new CloseWorkflowService(connection, f.scope, clock).advance("p-1");
  const child = await models.BrokerOrder.findOne({ intentId: close.intentId }).orFail(), broker = paper(10);
  const submitted = await new OrderManager(connection, f.scope, broker, clock, host).submit(child.get("orderId"));
  assert.equal(submitted.status, "PERSISTED"); assert.equal(submitted.order?.phase, "ACKNOWLEDGED");
  await broker.advance({ ...f.scope, orderId: child.get("orderId") });
  assert.equal((await processor().process((await broker.getTrades(f.scope))[0])).status, "APPLIED");
  assert.equal((await models.Position.findOne().orFail()).get("legs")[0].exitFilledUnits, 10);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.status"), "RECOVERY_REQUIRED");
});
for (const phase of ["ACKNOWLEDGED", "SUBMITTING", "SUBMITTED", "UNKNOWN"] as const)
test(`real confirmed post-dispatch Fill in ${phase} remains ingestible during recovery`, async () => {
  const { orderId, trades } = await entry(4, false);
  // Fault/restart fixture: an existing durable physical claim has possibly crossed the boundary.
  if (phase !== "ACKNOWLEDGED") await models.BrokerOrder.collection.updateOne({ orderId }, { $set: phase === "UNKNOWN" ? { knowledge: "UNKNOWN" } : { phase } });
  await configure(); await begin(); assert.equal((await processor().process(trades[0])).status, "APPLIED");
});
test("real DISCREPANCY retains recovery and a later MATCHED completes without deleting history", async () => {
  const { orderId } = await entry(); await configure(); await begin();
  await tx(session => new models.ReconciliationLink({ ...f.base(), ...orderLink(orderId) }).save({ session }));
  tick(); const bad = await reconcile(); assert.equal(bad.report.classification, "DISCREPANCY");
  await assert.rejects(complete(bad.recordId), /RECOVERY_PROOF_INVALID/); tick();
  const good = await reconcile({ units: 0, positions: false }); assert.equal(good.report.classification, "MATCHED");
  await complete(good.recordId); assert.equal(await models.ReconciliationRecord.countDocuments(), 2);
});
test("real INCOMPLETE cannot complete recovery", async () => {
  await configure(); await begin(); tick(); const bad = await reconcile({ ...flat, fail: "/trades" });
  assert.equal(bad.report.classification, "INCOMPLETE"); await assert.rejects(complete(bad.recordId), /RECOVERY_PROOF_INVALID/);
});
test("real RECONCILIATION_REQUIRED cannot complete recovery", async () => {
  const { orderId } = await entry(); await configure(); await begin();
  await tx(async session => { const o = await models.BrokerOrder.findOne({ orderId }).session(session).orFail(); o.set("knowledge", "UNKNOWN"); await o.save({ session });
    await new models.ReconciliationLink({ ...f.base(), ...orderLink(orderId) }).save({ session }); });
  tick(); const bad = await reconcile({ units: 0, positions: false }); assert.equal(bad.report.classification, "RECONCILIATION_REQUIRED");
  await assert.rejects(complete(bad.recordId), /RECOVERY_PROOF_INVALID/);
});
test("real MATCHED alone leaves barrier active until completion atomically commits", async () => {
  await seed(); await configure(); await begin(); const result = await matched(); await blocked(); const before = await financial();
  assert.equal((await complete(result.recordId)).status, "READY"); assert.deepEqual(await financial(), before);
  assert.equal((await admission().authorizeEntry("i-1")).status, "AUTHORIZED");
});
test("real snapshot acquired before recovery cannot be relabelled as current proof", async () => {
  await configure(); const snapshot = await brokerSnapshot({ ...flat, time: now }); tick(); await begin(); tick();
  const result = await new ReconciliationService(connection, f.scope, clock, host).reconcileAccount(f.scope.accountId, snapshot);
  assert.equal(result.report.classification, "INCOMPLETE"); await assert.rejects(complete(result.recordId), /RECOVERY_PROOF_INVALID/);
});
test("real regressing broker watermark never clears recovery", async () => {
  await configure(); await begin(); tick(); const old = new Date(now); tick(); await reconcile({ ...flat, fail: "/trades" });
  const result = await reconcile({ ...flat, time: old }); assert.equal(result.report.classification, "INCOMPLETE");
  await assert.rejects(complete(result.recordId), /RECOVERY_PROOF_INVALID/);
});
for (const [label, change] of [
  ["wrong account", { accountId: "PAPER:foreign" }], ["wrong broker account", { brokerAccountId: "OTHER" }],
  ["wrong scope", { "report.scope": "BROKER_BACKED_EXECUTION" }], ["old comparison version", { "report.reconciliationVersion": 1 }],
  ["old generation", { "report.recoveryGeneration": 0 }],
] as const) test(`real recovery rejects ${label} proof`, async () => {
  await configure(); await begin(); const result = await matched();
  // Deliberately corrupted durable evidence must not become authority; Mongo is real.
  await models.ReconciliationRecord.collection.updateOne({ recordId: result.recordId }, { $set: change });
  await assert.rejects(complete(result.recordId), /RECOVERY_PROOF_INVALID/);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.status"), "RECOVERY_REQUIRED");
});
test("real new Mongo connection and new services preserve recovery barrier", async () => {
  await seed(); await configure(); await ready(); tick(); await begin("restart");
  const other = await mongoose.createConnection(uri!).asPromise();
  try {
    const fresh = new RecoveryBarrierService(other, f.scope, clock, host);
    assert.equal((await fresh.beginRecovery(f.scope.accountId, "restart")).status, "RECOVERY_REQUIRED");
    assert.deepEqual(await new RiskAdmissionService(other, f.scope, clock, host).authorizeEntry("i-1"), { status: "REJECTED", intentId: "i-1", reason: "RECOVERY_REQUIRED" });
    tick(); const r = await new ReconciliationService(other, f.scope, clock, host).reconcileAccount(f.scope.accountId, await brokerSnapshot({ ...flat, time: now }));
    assert.equal((await fresh.completeRecovery(f.scope.accountId, r.recordId)).status, "READY");
  } finally { await other.close(); }
});
test("real begin replay remains idempotent even after a later generation", async () => {
  await configure(); await ready(); tick(); await begin("startup-2"); const before = await all();
  await begin("startup-1"); assert.deepEqual(await all(), before);
});
test("real concurrent same startup begins commit one generation and event", async () => {
  await configure(); const results = await Promise.all([begin(), begin()]); assert.deepEqual(results[0], results[1]);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_REQUIRED" }), 1);
});
test("real competing different startup keys cannot churn an active generation", async () => {
  await configure(); const results = await Promise.allSettled([begin("worker-a"), begin("worker-b")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_REQUIRED" }), 1);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.generation"), 1);
});
test("real completion replay adds no readiness effects", async () => {
  await configure(); const result = await ready(), before = await all(); await complete(result.recordId); assert.deepEqual(await all(), before);
});
test("real concurrent completion commits one readiness transition and event", async () => {
  await configure(); await begin(); const result = await matched();
  const results = await Promise.all([complete(result.recordId), complete(result.recordId)]); assert.deepEqual(results[0], results[1]);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_READY" }), 1);
});
for (const operation of ["begin", "complete"] as const) for (const entity of ["TradingEvent", "TradingAccount"] as const)
test(`real recovery ${operation} ${entity} failure rolls back state version and event sequence`, async () => {
  await seed(); await configure(); let recordId = "";
  if (operation === "complete") { await begin(); recordId = (await matched()).recordId; }
  const before = await all(), original = models[entity].prototype.save;
  models[entity].prototype.save = async function (options: any) { await original.call(this, options); throw new Error("injected-recovery-failure"); };
  try { await assert.rejects(operation === "begin" ? begin() : complete(recordId), /injected-recovery-failure/); }
  finally { models[entity].prototype.save = original; }
  assert.deepEqual(await all(), before); await blocked();
  assert.equal((await (operation === "begin" ? begin() : complete(recordId))).status, operation === "begin" ? "RECOVERY_REQUIRED" : "READY");
});
test("real winning recovery fences stale competing ENTRY admission", async () => {
  await seed(); await configure(); await ready(); const pause = pauseSave(d => d.get("reservedExposureMinor") > 0);
  const pending = admission().authorizeEntry("i-1");
  try { await pause.waiting; tick(); await begin("restart"); pause.release();
    assert.deepEqual(await pending, { status: "REJECTED", intentId: "i-1", reason: "RECOVERY_REQUIRED" });
    assert.equal(await models.RiskReservation.countDocuments(), 0);
  } finally { pause.restore(); }
});
test("real winning FillProcessor prevents stale recovery completion", async () => {
  const { trades } = await entry(4, false); await configure(); await begin(); const result = await matched();
  const pause = pauseSave(d => d.get("recoveryState.status") === "READY");
  const pending = complete(result.recordId); const rejected = assert.rejects(pending, /RECOVERY_LEDGER_CHANGED/);
  try { await pause.waiting; await processor().process(trades[0]); pause.release(); await rejected;
    assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.status"), "RECOVERY_REQUIRED");
    assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_READY" }), 0);
  } finally { pause.restore(); }
});
test("real newer discrepancy prevents completion of older MATCHED", async () => {
  const { orderId } = await entry(); await configure(); await begin();
  await tx(session => new models.ReconciliationLink({ ...f.base(), ...orderLink(orderId) }).save({ session }));
  tick(); const good = await reconcile({ units: 0, positions: false }); assert.equal(good.report.classification, "MATCHED");
  tick(); const bad = await reconcile(); assert.equal(bad.report.classification, "DISCREPANCY");
  await assert.rejects(complete(good.recordId), /RECOVERY_PROOF_INVALID/);
  assert.equal((await models.TradingAccount.findOne().orFail()).get("reconciliationState.recordId"), bad.recordId);
});
test("real concurrent newer discrepancy fences a pending completion", async () => {
  const { orderId } = await entry(); await configure(); await begin();
  await tx(session => new models.ReconciliationLink({ ...f.base(), ...orderLink(orderId) }).save({ session }));
  tick(); const good = await reconcile({ units: 0, positions: false });
  const pause = pauseSave(d => d.get("recoveryState.status") === "READY");
  const rejected = assert.rejects(complete(good.recordId), /RECOVERY_PROOF_INVALID/);
  try { await pause.waiting; tick(); await reconcile(); pause.release(); await rejected;
    assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_READY" }), 0);
  } finally { pause.restore(); }
});
test("real enabled recovery rejects missing reconciliation indexes before any writes", async () => {
  await configure(); await models.ReconciliationRecord.collection.dropIndexes(); const before = await all();
  await assert.rejects(begin(), /EXECUTION_INDEXES_NOT_READY/); assert.deepEqual(await all(), before);
});
test("real direct recovery metadata edits cannot bypass the audited service", async () => {
  await configure(); await ready();
  await assert.rejects(tx(async session => { const a = await models.TradingAccount.findOne().session(session).orFail();
    a.set("recoveryState", undefined); await a.save({ session }); }), /AUDITED_RECOVERY_SERVICE_REQUIRED/);
});
test("real missing recovery completion event cannot authorize ENTRY", async () => {
  await seed(); await configure(); await ready(); await models.TradingEvent.collection.deleteOne({ eventType: "RECOVERY_READY" }); await blocked();
});
test("real recovery completion rejects missing reconciliation indexes", async () => {
  await configure(); await begin(); const result = await matched(); await models.ReconciliationLink.collection.dropIndexes();
  const before = await all(); await assert.rejects(complete(result.recordId), /EXECUTION_INDEXES_NOT_READY/); assert.deepEqual(await all(), before);
});
test("real recovery completion needs a durable begin event", async () => {
  await configure(); await begin(); const result = await matched(); await models.TradingEvent.collection.deleteOne({ eventType: "RECOVERY_REQUIRED" });
  await assert.rejects(complete(result.recordId), /RECOVERY_BEGIN_PROOF_REQUIRED/);
});
test("real active recovery snapshot replay remains the same generation and record", async () => {
  await configure(); await begin(); tick(); const snapshot = await brokerSnapshot({ ...flat, time: now });
  const service = new ReconciliationService(connection, f.scope, clock, host), first = await service.reconcileAccount(f.scope.accountId, snapshot);
  const before = await all(); assert.deepEqual(await service.reconcileAccount(f.scope.accountId, snapshot), first); assert.deepEqual(await all(), before);
  assert.equal(first.report.recoveryGeneration, 1);
});
test("real recovery rejects cross-account calls and LIVE construction", async () => {
  await configure(); await assert.rejects(recovery().beginRecovery("PAPER:other", "startup"), /LEDGER_SCOPE_MISMATCH/);
  await assert.rejects(recovery().completeRecovery("PAPER:other", "record"), /LEDGER_SCOPE_MISMATCH/);
  assert.throws(() => new RecoveryBarrierService(connection, { accountId: "LIVE:other", executionMode: "LIVE" }), /PAPER_ONLY/);
});
test("real recovery commit wins against an in-flight initial ENTRY claim", async () => {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); if (admitted.status !== "AUTHORIZED") throw new Error("setup failed");
  await configure(); await ready(); const broker = paper(), original = models.BrokerOrder.prototype.save;
  let entered!: () => void, release!: () => void, paused = false;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  models.BrokerOrder.prototype.save = async function (options: any) {
    if (!paused && this.get("phase") === "SUBMITTING") { paused = true; entered(); await gate; } return original.call(this, options);
  };
  const rejected = assert.rejects(new OrderManager(connection, f.scope, broker, clock, host).submit(admitted.orderIds[0]), /RECOVERY_REQUIRED/);
  try { await waiting; tick(); await begin("restart"); release(); await rejected;
    assert.equal((await broker.getOrders(f.scope)).length, 0);
    assert.equal((await models.BrokerOrder.findOne().orFail()).get("submissionClaim"), undefined);
  } finally { release(); models.BrokerOrder.prototype.save = original; }
});

test("real host A READY cannot authorize restarted host B without begin; B recovery restores admission and the old child", async () => {
  await seed("1"); await seed("2"); await seed("3"); await configure(); const proofA = await ready();
  const first = await admission().authorizeEntry("i-1"), pending = await admission().authorizeEntry("i-2");
  assert.equal(first.status, "AUTHORIZED"); if (pending.status !== "AUTHORIZED") throw new Error("setup failed");
  const stateA = (await models.TradingAccount.findOne().orFail()).get("recoveryState");
  await connection.close();
  const other = await mongoose.createConnection(uri!).asPromise(), hostB = createExecutionHostContext("host-B");
  try {
    tick(); const otherModels = executionModels(other), broker = paper(); let calls = 0;
    const original = broker.submitOrder.bind(broker); broker.submitOrder = async request => { calls++; return original(request); };
    const entryB = new RiskAdmissionService(other, f.scope, clock, hostB), managerB = new OrderManager(other, f.scope, broker, clock, hostB);
    assert.deepEqual(await entryB.authorizeEntry("i-3"), { status: "REJECTED", intentId: "i-3", reason: "RECOVERY_REQUIRED" });
    await assert.rejects(managerB.submit(pending.orderIds[0]), /RECOVERY_REQUIRED/); assert.equal(calls, 0);
    assert.equal((await otherModels.BrokerOrder.findOne({ orderId: pending.orderIds[0] }).orFail()).get("submissionClaim"), undefined);
    assert.deepEqual((await otherModels.TradingAccount.findOne().orFail()).get("recoveryState"), stateA);
    assert.equal(await otherModels.ReconciliationRecord.countDocuments(), 1);
    const recoveryB = new RecoveryBarrierService(other, f.scope, clock, hostB);
    // The SAME bootstrap command text is a new receipt for a different host startup.
    const begun = await recoveryB.beginRecovery(f.scope.accountId, "startup-1");
    if (begun.status === "OPTED_OUT") throw new Error("unexpected opt-out");
    assert.equal(begun.generation, 2); assert.equal(begun.startupId, hostB.startupId);
    await assert.rejects(recoveryB.completeRecovery(f.scope.accountId, proofA.recordId), /RECOVERY_PROOF_INVALID/);
    tick(); const proofB = await new ReconciliationService(other, f.scope, clock, hostB)
      .reconcileAccount(f.scope.accountId, await brokerSnapshot({ ...flat, time: now }));
    assert.equal(proofB.report.recoveryStartupId, hostB.startupId);
    await recoveryB.completeRecovery(f.scope.accountId, proofB.recordId);
    assert.equal((await entryB.authorizeEntry("i-3")).status, "AUTHORIZED");
    assert.equal((await managerB.submit(pending.orderIds[0])).order?.phase, "ACKNOWLEDGED"); assert.equal(calls, 1);
    assert.equal((await otherModels.TradingAccount.findOne().orFail()).get("executionEpoch"), 1);
  } finally { await other.close(); await connection.openUri(uri!); }
});
test("real same-host service and connection recreation keeps READY without another begin", async () => {
  await seed(); await configure(); const proof = await ready();
  const other = await mongoose.createConnection(uri!).asPromise();
  try {
    const admitted = await new RiskAdmissionService(other, f.scope, clock, host).authorizeEntry("i-1");
    if (admitted.status !== "AUTHORIZED") throw new Error("same host incorrectly blocked");
    const broker = paper(); assert.equal((await new OrderManager(other, f.scope, broker, clock, host).submit(admitted.orderIds[0])).order?.phase, "ACKNOWLEDGED");
    const a = await executionModels(other).TradingAccount.findOne().orFail();
    assert.equal(a.get("recoveryState.generation"), 1); assert.equal(a.get("reconciliationState.recordId"), proof.recordId);
    assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_REQUIRED" }), 1);
  } finally { await other.close(); }
});
for (const wrongId of ["host-A", "host-C"]) test(`real ${wrongId} cannot complete recovery owned by host B`, async () => {
  await configure(); const hostB = createExecutionHostContext("host-B"), wrong = createExecutionHostContext(wrongId);
  await new RecoveryBarrierService(connection, f.scope, clock, hostB).beginRecovery(f.scope.accountId, "B-start"); tick();
  const proof = await new ReconciliationService(connection, f.scope, clock, hostB)
    .reconcileAccount(f.scope.accountId, await brokerSnapshot({ ...flat, time: now }));
  const before = await all();
  await assert.rejects(new RecoveryBarrierService(connection, f.scope, clock, wrong).completeRecovery(f.scope.accountId, proof.recordId), /RECOVERY_HOST_MISMATCH/);
  assert.deepEqual(await all(), before);
});
test("real current generation with wrong report startup cannot complete recovery", async () => {
  await configure(); await begin(); const proof = await matched();
  await models.ReconciliationRecord.collection.updateOne({ recordId: proof.recordId }, { $set: { "report.recoveryStartupId": "other-startup" } });
  await assert.rejects(complete(proof.recordId), /RECOVERY_PROOF_INVALID/);
});
test("real missing host context blocks enabled-account NEW ENTRY", async () => {
  await seed(); await configure(); await ready();
  assert.deepEqual(await new RiskAdmissionService(connection, f.scope, clock).authorizeEntry("i-1"),
    { status: "REJECTED", intentId: "i-1", reason: "RECOVERY_REQUIRED" });
});
test("real missing host context blocks initial ENTRY submission with zero broker calls", async () => {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); if (admitted.status !== "AUTHORIZED") throw new Error("setup failed");
  await configure(); await ready(); const broker = paper(); let calls = 0;
  const original = broker.submitOrder.bind(broker); broker.submitOrder = async request => { calls++; return original(request); };
  await assert.rejects(new OrderManager(connection, f.scope, broker, clock).submit(admitted.orderIds[0]), /RECOVERY_REQUIRED/);
  assert.equal(calls, 0);
});
test("real CLOSE completes under host mismatch without ENTRY readiness", async () => {
  await entry(10); await configure(); await ready(); const hostB = createExecutionHostContext("host-B");
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose("p-1", "close-host-mismatch");
  const workflow = new CloseWorkflowService(connection, f.scope, clock); await workflow.advance("p-1");
  const child = await models.BrokerOrder.findOne({ intentId: close.intentId }).orFail(), broker = paper(10);
  assert.equal((await new OrderManager(connection, f.scope, broker, clock, hostB).submit(child.get("orderId"))).order?.phase, "ACKNOWLEDGED");
  await broker.advance({ ...f.scope, orderId: child.get("orderId") }); await processor().process((await broker.getTrades(f.scope))[0]);
  await workflow.advance("p-1"); assert.equal((await models.Position.findOne().orFail()).get("lifecycle"), "CLOSED");
  assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.startupId"), host.startupId);
});
for (const phase of ["SUBMITTING", "SUBMITTED", "UNKNOWN"] as const)
test(`real new host ingests confirmed ${phase} Fill without current-host recovery`, async () => {
  const { orderId, trades } = await entry(4, false); await configure(); await ready();
  await models.BrokerOrder.collection.updateOne({ orderId }, { $set: phase === "UNKNOWN" ? { knowledge: "UNKNOWN" } : { phase } });
  const other = await mongoose.createConnection(uri!).asPromise();
  try {
    // FillProcessor intentionally needs no host context or ENTRY-readiness proof.
    assert.equal((await new FillProcessor(other, f.scope, () => f.now).process(trades[0])).status, "APPLIED");
    assert.equal((await models.TradingAccount.findOne().orFail()).get("recoveryState.startupId"), host.startupId);
  } finally { await other.close(); }
});
test("real wrong host cannot publish a reconciliation under another startup's generation", async () => {
  await configure(); await begin(); tick(); const before = await all();
  await assert.rejects(new ReconciliationService(connection, f.scope, clock, createExecutionHostContext("host-B"))
    .reconcileAccount(f.scope.accountId, await brokerSnapshot({ ...flat, time: now })), /RECOVERY_HOST_MISMATCH/);
  assert.deepEqual(await all(), before);
});
test("real snapshot reconciled before host recovery cannot complete its later cycle", async () => {
  await configure(); const prior = await reconcile(); tick(); await begin();
  await assert.rejects(complete(prior.recordId), /RECOVERY_PROOF_INVALID/);
});
test("real unbound historical READY is not compatible with a current host", async () => {
  await seed(); await configure(); await ready();
  await models.TradingAccount.collection.updateOne(f.scope, { $unset: { "recoveryState.startupId": "" } });
  await blocked();
  tick(); await begin("bind-existing-history"); const proof = await matched(); await complete(proof.recordId);
  assert.equal((await admission().authorizeEntry("i-1")).status, "AUTHORIZED");
});
test("real direct initial claim save cannot borrow a service host binding", async () => {
  await seed(); const admitted = await admission().authorizeEntry("i-1"); if (admitted.status !== "AUTHORIZED") throw new Error("setup failed");
  await configure(); await ready(); const broker = paper(), original = models.BrokerOrder.prototype.save; let candidate: any;
  models.BrokerOrder.prototype.save = async function (options: any) {
    if (this.get("phase") === "SUBMITTING") { candidate = this.toObject(); throw new Error("capture-claim"); } return original.call(this, options);
  };
  try { await assert.rejects(new OrderManager(connection, f.scope, broker, clock, host).submit(admitted.orderIds[0]), /capture-claim/); }
  finally { models.BrokerOrder.prototype.save = original; }
  await assert.rejects(tx(async session => { const order = await models.BrokerOrder.findOne().session(session).orFail();
    order.set({ phase: candidate.phase, submissionClaim: candidate.submissionClaim }); await order.save({ session }); }), /RECOVERY_REQUIRED/);
});
