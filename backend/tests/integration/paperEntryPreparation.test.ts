import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { createExecutionIndexes, executionModels } from "../../src/db/executionModels";
import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";
import { builtInNiftyPaperConfig } from "../../src/domain/paperMonitoring";
import { operationalEntryConfiguration, operationalExitConfigurations } from "../../src/services/PaperOperationalDefaults";
import { classifyNseDate, nseLocalDate } from "../../src/domain/nseTradingCalendar";
import { ensureNsePaperAccount, bindNsePaperKiteIdentity } from "../../src/services/NsePaperAccountService";
import { PaperEntryOrchestrator } from "../../src/services/PaperEntryOrchestrator";
import { PaperEntryPreparationService } from "../../src/services/PaperEntryPreparationService";
import { evaluatePaperReadiness } from "../../src/services/PaperDefaultSessionService";
import { RecoveryBarrierService } from "../../src/services/RecoveryBarrierService";
import { ReconciliationService } from "../../src/services/ReconciliationService";
import { realProvider, fakeLLM, llmConfig } from "../fixtures/paperOrchestration";
import { NIFTY_OPERATIONAL_DEFAULTS } from "../../src/config/niftyOperationalDefaults";
import { brokerSnapshot, ledger } from "../reconciliationFixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
const scope = { accountId: "PAPER:NSE", executionMode: "PAPER" as const };
const config = builtInNiftyPaperConfig(scope.accountId);
const host = createExecutionHostContext("auto-readiness-host");
let now: Date, reads = 0, attempts = 0, available = true, failEndpoint = false;
const clock = () => new Date(now), advance = () => { now = new Date(+now + 300001); };
const originals = { request: http.request, get: http.get, secureRequest: https.request, secureGet: https.get, fetch: globalThis.fetch };
before(async () => {
  await connection.asPromise();
  const blocked = () => { attempts++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); };
  http.request = blocked as any; http.get = blocked as any; https.request = blocked as any; https.get = blocked as any; globalThis.fetch = blocked as any;
});
after(async () => {
  await connection.close(); http.request = originals.request; http.get = originals.get;
  https.request = originals.secureRequest; https.get = originals.secureGet; globalThis.fetch = originals.fetch;
  assert.equal(attempts, 0);
});
beforeEach(async () => {
  now = new Date("2026-09-11T04:01:00Z"); reads = 0; available = true; failEndpoint = false;
  await connection.dropDatabase(); await createExecutionIndexes(connection);
  await ensureNsePaperAccount(connection, { PAPER_CAPITAL: "200000" });
});
async function setup(currentHost = host, hold = false) {
  const market = await realProvider(clock, true);
  let llmCalls = 0;
  const core = new PaperEntryOrchestrator(connection, { host: currentHost, clock, market: market.provider,
    entryConfig: c => operationalEntryConfiguration(c, clock(), {}),
    transport: hold ? fakeLLM("HOLD", "AGREE", () => { llmCalls++; }) : { complete: async () => { throw new Error("NO_LLM"); } },
    llmConfig: () => { if (!hold) throw new Error("NO_LLM_CONFIG"); return llmConfig; },
    broker: () => { throw new Error("NO_EXECUTION"); } });
  await core.initialize();
  const session = await core.startMonitoring(config);
  const preparation = new PaperEntryPreparationService(connection, { host: currentHost, clock, active: id => core.active(id),
    reader: async () => {
      reads++; if (!available) throw new Error("KITE_SESSION_REQUIRED");
      return { brokerAccountId: "AB1234", getSnapshot: async () => {
        now = new Date(+now + 1);
        return brokerSnapshot({ time: clock(), orders: false, trades: false, positions: false, ...(failEndpoint ? { fail: "/orders" as const } : {}) });
      } };
    } });
  const readiness = (prepare: boolean) => evaluatePaperReadiness({ sessionId: session.sessionId, config }, {
    clock, active: id => core.active(id), connected: () => available, mode: () => "KITE_REAL",
    calendar: time => classifyNseDate(nseLocalDate(time)), entryConfig: async c => operationalEntryConfiguration(c, clock(), {}),
    preparation: (account, id, run) => run ? preparation.prepare(account, id) : preparation.read(account, id),
    accountGate: async () => { const a = await models.TradingAccount.findOne(scope).orFail(); assert.equal(a.get("killSwitchEnabled"), false);
      const policies = await operationalExitConfigurations({}); assert.equal(policies.length, 1); assert.equal(policies[0].accountId, scope.accountId); },
    assertReady: c => core.assertReady(c), recover: async () => { throw new Error("NO_LEGACY_RECOVERY"); },
    market: async (c, run) => { if (run) await market.provider.prepare(c); else await market.provider.checkReadiness(c); },
  }, prepare);
  return { core, session, preparation, readiness, market, llmCalls: () => llmCalls };
}
async function financial() {
  const a = (await models.TradingAccount.findOne(scope).lean())! as Record<string, any>;
  const { reconciliationConfig, recoveryState, reconciliationState, version, nextEventSequence, updatedAt, ...account } = a;
  return { account, rows: await Promise.all([models.OrderIntent, models.BrokerOrder, models.Fill, models.Position, models.RiskReservation]
    .map(m => m.find().sort({ _id: 1 }).lean())) };
}
async function linkedExposure() {
  const data = ledger(0);
  await models.BrokerOrder.collection.insertMany(data.orders.map(row => ({ ...row, ...scope })));
  await models.Position.collection.insertMany(data.positions.map(row => ({ ...row, ...scope })));
  await models.ReconciliationLink.collection.insertMany(data.links.map(row => ({ ...row, ...scope })));
}

test("real Mongo same RUNNING session moves WAITING to READY through actual generation/proof and qualified market gates", async () => {
  const s = await setup(), before = await financial();
  assert.equal((await s.readiness(false)).entryBlockingReason, "READINESS_PREPARATION_REQUIRED");
  assert.equal(reads, 0);
  const ready = await s.readiness(true); assert.equal(ready.entryStatus, "READY", JSON.stringify(ready));
  assert.equal(ready.calendar?.status, "OPEN"); assert.ok(ready.lastReadinessAttemptAt);
  const account = await models.TradingAccount.findOne(scope).orFail();
  assert.equal(account.get("recoveryState.status"), "READY"); assert.equal(account.get("recoveryState.generation"), 1);
  assert.equal(account.get("reconciliationState.classification"), "MATCHED");
  assert.equal(account.get("reconciliationConfig.scope"), "REFERENCE_ONLY");
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_READY" }), 1);
  assert.equal((await s.core.active(s.session.sessionId)).get("sessionId"), s.session.sessionId);
  assert.equal(await s.core.history.Session.countDocuments(), 1); assert.deepEqual(await financial(), before);
  const snapshot = await models.TradingAccount.findOne(scope).lean(), records = await models.ReconciliationRecord.countDocuments();
  assert.equal((await s.readiness(false)).entryStatus, "READY");
  assert.deepEqual(await models.TradingAccount.findOne(scope).lean(), snapshot); assert.equal(reads, 1);
  assert.equal(await models.ReconciliationRecord.countDocuments(), records); assert.equal(attempts, 0);
});
test("no-file operational defaults produce qualified Greeks and a durable HOLD cycle without financial entries", async () => {
  const s = await setup(host, true), before = await financial();
  assert.equal((await s.readiness(true)).entryStatus, "READY");
  const entry = await s.core.entryConfiguration(config), capture = await s.market.provider.capture(entry);
  assert.equal(capture.analytics.available, true);
  if (!capture.analytics.available) return;
  const greeks = capture.analytics.snapshot.options.filter(o => o.greeks.available);
  assert.ok(greeks.length > 0);
  for (const option of greeks) if (option.greeks.available)
    assert.equal(option.greeks.value.riskFreeRateVersion, NIFTY_OPERATIONAL_DEFAULTS.greeks.riskFreeRateVersion);
  const result = await s.core.runEvaluationCycle(s.session.sessionId);
  assert.equal(result.outcome, "HOLD", JSON.stringify(result)); assert.ok(s.llmCalls() > 0);
  const cycle = await s.core.history.Cycle.findOne({ cycleId: result.cycleId }).orFail();
  assert.equal(cycle.get("config.riskFreeRateVersion"), NIFTY_OPERATIONAL_DEFAULTS.greeks.riskFreeRateVersion);
  assert.equal(cycle.get("decision.dataMode"), "KITE_REAL"); assert.deepEqual(await financial(), before);
});
test("concurrent/repeated preparation shares one actual recovery generation and one broker read", async () => {
  const s = await setup();
  const results = await Promise.all(Array.from({ length: 4 }, () => s.preparation.prepare(scope.accountId, s.session.sessionId)));
  assert.ok(results.every(r => r.status === "READY")); assert.equal(reads, 1);
  assert.deepEqual(await s.preparation.prepare(scope.accountId, s.session.sessionId), results[0]);
  assert.equal(await models.ReconciliationRecord.countDocuments(), 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_REQUIRED" }), 1);
});
test("INCOMPLETE evidence stays WAITING then retries on normal cadence in the exact same session", async () => {
  const s = await setup(); failEndpoint = true;
  assert.equal((await s.readiness(true)).entryBlockingReason, "RECONCILIATION_INCOMPLETE");
  assert.equal((await models.TradingAccount.findOne(scope).orFail()).get("recoveryState.status"), "RECOVERY_REQUIRED");
  failEndpoint = false; assert.equal((await s.readiness(true)).entryStatus, "WAITING"); assert.equal(reads, 1);
  advance(); assert.equal((await s.readiness(true)).entryStatus, "READY"); assert.equal(reads, 2);
  assert.equal(await s.core.history.Session.countDocuments(), 1);
});
test("Kite unavailable never fabricates MATCHED; reconnect automatically prepares the same session", async () => {
  const s = await setup(); available = false;
  assert.equal((await s.readiness(true)).entryBlockingReason, "KITE_SESSION_REQUIRED");
  const failed = await s.preparation.prepare(scope.accountId, s.session.sessionId); assert.equal(failed.reason, "KITE_SESSION_REQUIRED");
  assert.equal(await models.ReconciliationRecord.countDocuments(), 0);
  available = true; advance(); assert.equal((await s.readiness(true)).entryStatus, "READY");
  available = false; assert.equal((await s.readiness(false)).entryBlockingReason, "KITE_SESSION_REQUIRED");
  available = true; advance(); assert.equal((await s.readiness(true)).entryStatus, "READY");
  assert.equal(await s.core.history.Session.countDocuments(), 1);
});
test("linked DISCREPANCY never completes recovery or changes any financial row", async () => {
  const s = await setup(); await linkedExposure(); const before = await financial();
  assert.equal((await s.readiness(true)).entryBlockingReason, "RECONCILIATION_DISCREPANCY");
  assert.equal((await models.TradingAccount.findOne(scope).orFail()).get("recoveryState.status"), "RECOVERY_REQUIRED");
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "RECOVERY_READY" }), 0);
  assert.deepEqual(await financial(), before); await s.core.active(s.session.sessionId);
});
test("later actual discrepancy blocks NEW ENTRY even when operational preparation receipt is cached READY", async () => {
  const s = await setup(); assert.equal((await s.readiness(true)).entryStatus, "READY");
  await linkedExposure(); const before = await financial(); now = new Date(+now + 1);
  const report = await new ReconciliationService(connection, scope, clock, host).reconcileAccount(scope.accountId,
    await brokerSnapshot({ time: clock(), orders: false, trades: false, positions: false }));
  assert.equal(report.report.classification, "DISCREPANCY");
  assert.equal((await s.readiness(false)).entryStatus, "WAITING");
  advance(); assert.equal((await s.readiness(true)).entryBlockingReason, "RECONCILIATION_DISCREPANCY");
  assert.deepEqual(await financial(), before);
});
test("new host cannot use old READY proof; explicit new lifecycle obtains a new approved generation", async () => {
  const first = await setup(); assert.equal((await first.readiness(true)).entryStatus, "READY");
  await first.core.stop(first.session.sessionId); advance();
  const nextHost = createExecutionHostContext("next-host"), next = await setup(nextHost);
  await assert.rejects(next.core.assertReady(await operationalEntryConfiguration(config, clock(), {})), /RECOVERY_REQUIRED/);
  assert.equal((await next.readiness(true)).entryStatus, "READY");
  assert.equal((await models.TradingAccount.findOne(scope).orFail()).get("recoveryState.generation"), 2);
});
test("old-generation record cannot complete a newer current-host recovery generation", async () => {
  const s = await setup(); await s.readiness(true);
  const old = (await models.TradingAccount.findOne(scope).orFail()).get("recoveryState.recordId");
  advance(); const recovery = new RecoveryBarrierService(connection, scope, clock, host);
  await recovery.beginRecovery(scope.accountId, "explicit-new-generation");
  await assert.rejects(recovery.completeRecovery(scope.accountId, old), /RECOVERY_PROOF_INVALID/);
  assert.equal((await s.readiness(true)).entryStatus, "READY");
  assert.equal((await models.TradingAccount.findOne(scope).orFail()).get("recoveryState.generation"), 2);
});
test("unfinished old-host recovery remains fail closed without resetting account or proof", async () => {
  const s = await setup(); await bindNsePaperKiteIdentity(connection, "AB1234");
  await new RecoveryBarrierService(connection, scope, clock, createExecutionHostContext("old-unfinished")).beginRecovery(scope.accountId, "old-start");
  const before = await models.TradingAccount.findOne(scope).lean();
  const result = await s.readiness(true); assert.equal(result.entryBlockingReason, "RECOVERY_ALREADY_REQUIRED");
  assert.equal(result.readinessAction, "OPERATOR_ACTION"); assert.deepEqual(await models.TradingAccount.findOne(scope).lean(), before);
});
test("unrelated manual Kite activity retains REFERENCE_ONLY semantics without application links", async () => {
  const s = await setup(); await s.readiness(true); advance();
  const report = await new ReconciliationService(connection, scope, clock, host).reconcileAccount(scope.accountId, await brokerSnapshot({ time: clock() }));
  assert.equal(report.report.classification, "MATCHED");
  await s.core.assertReady(await operationalEntryConfiguration(config, clock(), {}));
});
