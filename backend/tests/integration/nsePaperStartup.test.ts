import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { bootstrapNsePaperAccount } from "../../src/db/nsePaperStartup";
import { createExecutionIndexes, executionModels } from "../../src/db/executionModels";
import { assertExecutionIndexes, executionIndexProofFor, hasVerifiedExecutionIndexes, requiredExecutionIndexes,
  verifyExecutionIndexes, withExecutionIndexProofs } from "../../src/db/executionIndexes";
import { checkTransactionCapability } from "../../src/db/executionReadiness";
import { ensureNsePaperAccount, NSE_PAPER_ACCOUNT_ID } from "../../src/services/NsePaperAccountService";
import * as fixture from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
const env = { PAPER_CAPITAL: "200000", NSE_PAPER_ACCOUNT_CONFIG_FILE: "/offline/policy.json" };
const policy = JSON.stringify({ brokerAccountId: "VERIFIED_TEST_KITE_ACCOUNT",
  entryRiskPolicy: { policyVersion: 1, maxRiskPerEntryMinor: 500000, maxReservedRiskMinor: 1500000,
    maxPositionSlots: 3, maxDailyLossMinor: 400000 },
  riskTradingCalendar: { kind: "LOCAL_DATE_V1", timeZone: "Asia/Kolkata" } });
let httpAttempts = 0;
const original = { request: http.request, get: http.get, secureRequest: https.request,
  secureGet: https.get, fetch: globalThis.fetch };
before(async () => {
  await connection.asPromise();
  assert.equal((await checkTransactionCapability(connection)).supported, true);
  const blocked = () => { httpAttempts++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); };
  http.request = blocked as any; http.get = blocked as any;
  https.request = blocked as any; https.get = blocked as any; globalThis.fetch = blocked as any;
});
after(async () => {
  await connection.close(); http.request = original.request; http.get = original.get;
  https.request = original.secureRequest; https.get = original.secureGet;
  globalThis.fetch = original.fetch; assert.equal(httpAttempts, 0);
});
beforeEach(async () => { await connection.dropDatabase(); httpAttempts = 0; });

test("fresh real Mongo startup ensures ALL indexes before canonical PAPER account creation", async () => {
  assert.equal((await verifyExecutionIndexes(connection, "ALL")).verified, false);
  let called = 0;
  await bootstrapNsePaperAccount(connection, async ready => {
    called++;
    const proof = await assertExecutionIndexes(ready, "ALL");
    assert.equal(hasVerifiedExecutionIndexes(ready, proof, "ALL"), true);
    assert.equal(hasVerifiedExecutionIndexes(ready, proof, "BASE"), false);
    assert.equal(hasVerifiedExecutionIndexes(ready, { verifiedAt: proof.verifiedAt }, "ALL"), false);
    await ensureNsePaperAccount(ready, env, async () => policy);
  });
  assert.equal(called, 1);
  assert.equal((await verifyExecutionIndexes(connection, "BASE")).verified, true);
  assert.equal((await verifyExecutionIndexes(connection, "RECONCILIATION")).verified, true);
  assert.equal((await verifyExecutionIndexes(connection, "ALL")).verified, true);
  assert.equal(requiredExecutionIndexes("ALL").length,
    requiredExecutionIndexes("BASE").length + requiredExecutionIndexes("RECONCILIATION").length);
  assert.equal(await models.TradingAccount.countDocuments({ accountId: NSE_PAPER_ACCOUNT_ID, executionMode: "PAPER", broker: "PAPER" }), 1);
  assert.equal(await models.TradingAccount.countDocuments({ executionMode: "LIVE" }), 0);
  assert.equal(await models.TradingEvent.countDocuments(), 0);
});

test("write proof reuse is limited to its operation, index group, and issued proof", async () => {
  await bootstrapNsePaperAccount(connection, async () => {});
  const base = await assertExecutionIndexes(connection);
  const reconciliation = await assertExecutionIndexes(connection, "RECONCILIATION");
  const session = await connection.startSession();
  try {
    assert.equal(executionIndexProofFor(connection, session), undefined);
    await assert.rejects(withExecutionIndexProofs(connection, session,
      { BASE: base, RECONCILIATION: reconciliation }, async () => {
        assert.equal(executionIndexProofFor(connection, session), base);
        assert.equal(executionIndexProofFor(connection, session, "RECONCILIATION"), reconciliation);
        await withExecutionIndexProofs(connection, session, { BASE: { verifiedAt: base.verifiedAt } }, async () => {
          assert.equal(executionIndexProofFor(connection, session), undefined);
          assert.equal(executionIndexProofFor(connection, session, "RECONCILIATION"), undefined);
        });
        assert.equal(executionIndexProofFor(connection, session), base);
        throw new Error("abort");
      }), /abort/);
    assert.equal(executionIndexProofFor(connection, session), undefined);
  } finally { await session.endSession(); }
});

test("normal real Mongo startup with no account policy file creates approved PAPER:NSE once", async () => {
  await bootstrapNsePaperAccount(connection, ready => ensureNsePaperAccount(ready, { PAPER_CAPITAL: "200000" }));
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(account.get("entryRiskPolicy.maxRiskPerEntryMinor"), 2000000);
  assert.equal(account.get("entryRiskPolicy.maxReservedRiskMinor"), 2400000);
  assert.equal(account.get("entryRiskPolicy.maxPositionSlots"), 3);
  assert.equal(account.get("entryRiskPolicy.maxDailyLossMinor"), 400000);
  assert.equal(account.get("riskTradingCalendar.timeZone"), "Asia/Kolkata");
  assert.equal(account.get("reconciliationConfig"), undefined);
  assert.equal(await models.TradingAccount.countDocuments(), 1);
});

test("second startup leaves correct indexes and existing account bytes unchanged", async () => {
  await bootstrapNsePaperAccount(connection, ready => ensureNsePaperAccount(ready, env, async () => policy));
  const account = await models.TradingAccount.findOne().lean();
  const collections = [...new Set(requiredExecutionIndexes("ALL").map(index => index.collection))];
  const inventory = async () => Promise.all(collections.map(async name => [name,
    await connection.db!.collection(name).listIndexes().toArray()] as const));
  const before = await inventory();
  await bootstrapNsePaperAccount(connection, ready => ensureNsePaperAccount(ready, env, async () => policy));
  assert.deepEqual(await inventory(), before);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), account);
  assert.equal(await models.TradingAccount.countDocuments(), 1);
});

test("partially initialized BASE database gains missing reconciliation indexes without resetting data", async () => {
  await createExecutionIndexes(connection, "BASE");
  await models.ReconciliationRecord.createIndexes();
  const session = await connection.startSession();
  try { await session.withTransaction(() => new models.TradingAccount(fixture.account()).save({ session })); }
  finally { await session.endSession(); }
  const existing = await models.TradingAccount.findOne().lean();
  assert.equal((await verifyExecutionIndexes(connection, "RECONCILIATION")).verified, false);
  await bootstrapNsePaperAccount(connection, async ready => { await assertExecutionIndexes(ready, "ALL"); });
  assert.equal((await verifyExecutionIndexes(connection, "ALL")).verified, true);
  assert.deepEqual(await models.TradingAccount.findOne().lean(), existing);
  assert.equal(await models.TradingAccount.countDocuments(), 1);
});

test("conflicting index fails closed before account bootstrap and never erases data", async () => {
  await connection.db!.collection("execution_accounts").createIndex({ accountId: 1 }, { unique: false });
  await connection.db!.collection("execution_accounts").insertOne(fixture.account());
  const before = await connection.db!.collection("execution_accounts").findOne({ accountId: fixture.scope.accountId });
  let called = false;
  await assert.rejects(bootstrapNsePaperAccount(connection, async () => { called = true; }), /same name as the requested index|IndexOptionsConflict|already exists|different options|E11000/i);
  assert.equal(called, false);
  assert.equal(await models.TradingAccount.countDocuments({ accountId: NSE_PAPER_ACCOUNT_ID }), 0);
  assert.deepEqual(await connection.db!.collection("execution_accounts").findOne({ accountId: fixture.scope.accountId }), before);
  assert.equal((await connection.db!.collection("execution_accounts").listIndexes().toArray())
    .find(index => index.name === "accountId_1")?.unique, undefined);
  assert.equal((await verifyExecutionIndexes(connection, "ALL")).verified, false);
});
