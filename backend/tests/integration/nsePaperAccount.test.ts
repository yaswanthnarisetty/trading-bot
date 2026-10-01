import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { createExecutionIndexes, executionModels } from "../../src/db/executionModels";
import { bindNsePaperKiteIdentity, ensureNsePaperAccount, NSE_PAPER_ACCOUNT_ID } from "../../src/services/NsePaperAccountService";
import { NSE_PAPER_POLICY_V1 } from "../../src/config/nsePaperPolicy";
import { createKiteReadSession } from "../../src/services/KiteService";
import { reconciliationAdmissionHealthy } from "../../src/db/reconciliationAdmission";
import { PaperEntryOrchestrator } from "../../src/services/PaperEntryOrchestrator";
import { PaperDefaultSessionService } from "../../src/services/PaperDefaultSessionService";
import { waitingForEntry } from "../../src/domain/paperMonitoring";
import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 500000, maxReservedRiskMinor: 1500000,
  maxPositionSlots: 3, maxDailyLossMinor: 400000 };
const provisioning = JSON.stringify({ brokerAccountId: "VERIFIED_TEST_KITE_ACCOUNT", entryRiskPolicy: policy,
  riskTradingCalendar: { kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" } });
const env = { PAPER_CAPITAL: "200000", NSE_PAPER_ACCOUNT_CONFIG_FILE: "/offline/provisioning.json" };
const ensure = (options: NodeJS.ProcessEnv = env, contents = provisioning) => ensureNsePaperAccount(connection, options,
  async () => contents);
const builtinEnv = { PAPER_CAPITAL: "200000" };
let attempts = 0;
const original = { request: http.request, get: http.get, secureRequest: https.request,
  secureGet: https.get, fetch: globalThis.fetch };
before(async () => {
  await connection.asPromise();
  const blocked = () => { attempts++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); };
  http.request = blocked as any; http.get = blocked as any;
  https.request = blocked as any; https.get = blocked as any; globalThis.fetch = blocked as any;
});
after(async () => {
  await connection.close(); http.request = original.request; http.get = original.get;
  https.request = original.secureRequest; https.get = original.secureGet;
  globalThis.fetch = original.fetch; assert.equal(attempts, 0);
});
beforeEach(async () => { await connection.dropDatabase(); await createExecutionIndexes(connection); attempts = 0; });

test("real Mongo no-file bootstrap creates the approved V1 account without broker calls or fabricated proof", async () => {
  await ensure(builtinEnv);
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(await models.TradingAccount.countDocuments(), 1);
  assert.equal(account.get("initialCapitalMinor"), 20_000_000);
  assert.deepEqual(account.get("entryRiskPolicy"), NSE_PAPER_POLICY_V1.entryRiskPolicy);
  assert.deepEqual(account.get("riskTradingCalendar"), NSE_PAPER_POLICY_V1.riskTradingCalendar);
  assert.equal(account.get("brokerAccountRef"), "PAPER:NSE");
  assert.equal(account.get("reconciliationConfig"), undefined);
  assert.equal(account.get("reconciliationState"), undefined);
  assert.equal(account.get("recoveryState"), undefined);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
  await account.validate();
  assert.equal(attempts, 0);
  assert.equal(await models.TradingAccount.countDocuments({ executionMode: "LIVE" }), 0);
  assert.equal(await models.TradingAccount.countDocuments({ accountId: { $regex: /BTC|DELTA/ } }), 0);
});

test("unbound canonical account cannot use the legacy direct-admission reconciliation opt-out", async () => {
  await ensure(builtinEnv);
  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await models.TradingAccount.findOne({ accountId: NSE_PAPER_ACCOUNT_ID }).session(session).orFail();
      await assert.rejects(reconciliationAdmissionHealthy(connection, session,
        { accountId: NSE_PAPER_ACCOUNT_ID, executionMode: "PAPER" }, account.toObject()), /RECOVERY_REQUIRED/);
    });
  } finally { await session.endSession(); }
  assert.equal(await models.TradingEvent.countDocuments(), 0);
});

test("real Mongo built-in bootstrap is one-time across repeated and concurrent hosts", async () => {
  await Promise.all(Array.from({ length: 4 }, () => ensure(builtinEnv)));
  const first = await models.TradingAccount.findOne().lean<Record<string, any>>();
  await ensure(builtinEnv);
  const restarted = mongoose.createConnection(uri);
  try { await restarted.asPromise(); await ensureNsePaperAccount(restarted, builtinEnv); }
  finally { await restarted.close(); }
  assert.equal(await models.TradingAccount.countDocuments(), 1);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), first);
});

test("verified read-only Kite profile binds comparison identity once without manufacturing readiness", async () => {
  await ensure(builtinEnv);
  const read = await createKiteReadSession("VERIFIED_TEST_KITE_ACCOUNT", {
    get: async () => ({ data: { status: "success", data: { user_id: "VERIFIED_TEST_KITE_ACCOUNT" } } }),
  } as any, () => ({ Authorization: "token testkey:testtoken" }));
  await bindNsePaperKiteIdentity(connection, read.brokerAccountId);
  const first = await models.TradingAccount.findOne().lean<Record<string, any>>();
  assert.deepEqual(first?.reconciliationConfig, { kind: "PAPER_KITE_SHADOW_V1", scope: "REFERENCE_ONLY",
    brokerAccountId: "VERIFIED_TEST_KITE_ACCOUNT" });
  assert.equal(first?.recoveryState, undefined); assert.equal(first?.reconciliationState, undefined);
  await bindNsePaperKiteIdentity(connection, read.brokerAccountId);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), first);
  await assert.rejects(bindNsePaperKiteIdentity(connection, "DIFFERENT_KITE_ACCOUNT"), /PAPER_KITE_ACCOUNT_CONFLICT/);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), first);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
  assert.equal(attempts, 0);
});

test("real Mongo empty bootstrap creates one deterministic PAPER:NSE with exact capital and validated policy", async () => {
  await ensure();
  assert.equal(await models.TradingAccount.countDocuments(), 1);
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(account.get("accountId"), NSE_PAPER_ACCOUNT_ID);
  assert.equal(account.get("executionMode"), "PAPER"); assert.equal(account.get("broker"), "PAPER");
  assert.equal(account.get("initialCapitalMinor"), 20000000);
  assert.equal(account.get("admissionStatus"), "PAPER_READY");
  assert.deepEqual(account.get("entryRiskPolicy"), policy);
  assert.equal(account.get("reconciliationConfig.kind"), "PAPER_KITE_SHADOW_V1");
  assert.equal(account.get("reconciliationConfig.scope"), "REFERENCE_ONLY");
  assert.equal(account.get("reconciliationState"), undefined); assert.equal(account.get("recoveryState"), undefined);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
  assert.equal(await models.OrderIntent.countDocuments(), 0); assert.equal(await models.Fill.countDocuments(), 0);
  await account.validate();
});

test("real Mongo sequential, concurrent and restarted hosts reuse the same one-time account", async () => {
  await Promise.all([ensure(), ensure(), ensure(), ensure()]);
  const first = await models.TradingAccount.findOne().lean();
  await ensure();
  const restarted = mongoose.createConnection(uri);
  try { await restarted.asPromise(); await ensureNsePaperAccount(restarted, env, async () => provisioning); }
  finally { await restarted.close(); }
  assert.equal(await models.TradingAccount.countDocuments(), 1);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), first);
});

test("real Mongo existing risk, P&L, kill, recovery, reconciliation, slots and versions survive bootstrap byte-for-byte", async () => {
  await ensure();
  await connection.db!.collection("execution_accounts").updateOne({ accountId: NSE_PAPER_ACCOUNT_ID }, { $set: {
    reservedMarginMinor: 100000, reservedExposureMinor: 100000, committedExposureMinor: 250000,
    positionSlots: 2, committedPositionSlots: 1, realizedPnlMinor: -20000,
    dailyRealizedPnlMinor: -20000, dailyTradingDay: "2026-09-30",
    realizedPnlDays: [{ tradingDay: "2026-09-30", realizedPnlMinor: -20000 }],
    killSwitchEnabled: true, killSwitchCommand: { commandId: "test-kill", reason: "TEST", enabled: true, changedAt: new Date() },
    recoveryState: { status: "RECOVERY_REQUIRED", startupId: "old-host", generation: 1, commandKey: "old-startup",
      beginEventId: "begin-1", requiredAt: "2026-09-30T00:00:00.000Z" },
    reconciliationState: { recordId: "record-1", classification: "INCOMPLETE", snapshotFetchedAt: "2026-09-30T00:00:00.000Z",
      endpointTimes: Array(4).fill("2026-09-30T00:00:00.000Z"), internalFingerprint: "a".repeat(64) },
    version: 7, nextEventSequence: 9,
  } });
  const before = await models.TradingAccount.findOne().lean();
  await connection.db!.collection("execution_reservations").insertOne({ accountId: NSE_PAPER_ACCOUNT_ID,
    executionMode: "PAPER", reservationId: "existing-hold", kind: "ENTRY_RISK", state: "HELD",
    remainingExposureMinor: 100000, positionSlots: 1 });
  const hold = await connection.db!.collection("execution_reservations").findOne({ reservationId: "existing-hold" });
  await ensure();
  assert.deepEqual(await models.TradingAccount.findOne().lean(), before);
  assert.deepEqual(await connection.db!.collection("execution_reservations").findOne({ reservationId: "existing-hold" }), hold);
});

test("invalid or absent capital and unapproved policy fail before creating an account", async () => {
  for (const value of [undefined, "", "0", "200000.001", "2e5", "NaN", "-1", "90071992547410"]) {
    await assert.rejects(ensure({ ...env, PAPER_CAPITAL: value }), /PAPER_CAPITAL_/);
  }
  await assert.rejects(ensure({ PAPER_CAPITAL: "200001" }), /PAPER_CAPITAL_POLICY_V1_MISMATCH/);
  await assert.rejects(ensure(env, JSON.stringify({ ...JSON.parse(provisioning), extra: true })), /PAPER_ACCOUNT_POLICY_INVALID/);
  await assert.rejects(ensure(env, JSON.stringify({ ...JSON.parse(provisioning), entryRiskPolicy: { ...policy, maxReservedRiskMinor: 30000000 } })), /PAPER_ACCOUNT_POLICY_INVALID/);
  assert.equal(await models.TradingAccount.countDocuments(), 0);
});

test("existing capital conflict never rewrites state; duplicate canonical identity fails closed", async () => {
  await ensure();
  await connection.db!.collection("execution_accounts").updateOne({ accountId: NSE_PAPER_ACCOUNT_ID },
    { $set: { initialCapitalMinor: 20_000_001 } });
  const before = await models.TradingAccount.findOne().lean();
  await assert.rejects(ensure(builtinEnv), /PAPER_ACCOUNT_CAPITAL_CONFLICT/);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), before);
  await connection.db!.collection("execution_accounts").updateOne({ accountId: NSE_PAPER_ACCOUNT_ID },
    { $set: { initialCapitalMinor: 20_000_000 } });
  const canonical = await models.TradingAccount.findOne().lean();
  await connection.db!.collection("execution_accounts").dropIndex("accountId_1");
  await connection.db!.collection("execution_accounts").insertOne({ ...canonical!, _id: new mongoose.Types.ObjectId(), brokerAccountRef: "PAPER:NSE:DUPLICATE_FIXTURE" });
  await assert.rejects(ensure(), /PAPER_ACCOUNT_AMBIGUOUS/);
});

test("pre-existing canonical account without the new capital reference is reused, never backfilled", async () => {
  await ensure();
  await connection.db!.collection("execution_accounts").updateOne({ accountId: NSE_PAPER_ACCOUNT_ID },
    { $unset: { initialCapitalMinor: "" } });
  const before = await models.TradingAccount.findOne().lean();
  await ensure({ PAPER_CAPITAL: "200000" });
  assert.deepEqual(await models.TradingAccount.findOne().lean(), before);
  assert.equal(await models.TradingAccount.countDocuments(), 1);
});

test("real Mongo NIFTY Start resolves only canonical account; repeated Start and Stop retain financial account", async () => {
  await ensure(builtinEnv);
  const host = createExecutionHostContext("bootstrap-session-test");
  const core = new PaperEntryOrchestrator(connection, { host, clock: () => new Date("2026-09-30T05:00:00Z"),
    market: { prepare: async () => {}, capture: async () => { throw new Error("NO_MARKET_CAPTURE"); }, assertCurrent: () => {} },
    transport: { complete: async () => { throw new Error("NO_LLM"); } }, llmConfig: () => { throw new Error("NO_LLM_CONFIG"); },
    broker: () => { throw new Error("NO_BROKER"); } });
  await core.initialize();
  const service = new PaperDefaultSessionService({ configurations: async () => [], hasExplicitConfiguration: () => false,
    accounts: () => core.canonicalMonitoringAccounts(), start: config => core.startMonitoring(config),
    readiness: async () => waitingForEntry("CALENDAR_NOT_READY"), schedule: () => {}, sessionId: session => String(session.sessionId) });
  const first = await service.start("NIFTY"), again = await service.start("NIFTY");
  assert.equal(first.accountId, NSE_PAPER_ACCOUNT_ID); assert.equal(first.status, "RUNNING");
  assert.equal(first.sessionId, again.sessionId); assert.equal(again.entryStatus, "WAITING");
  assert.equal(await models.TradingAccount.countDocuments(), 1);
  const before = await models.TradingAccount.findOne().lean();
  await core.stop(first.sessionId);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), before);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
});
