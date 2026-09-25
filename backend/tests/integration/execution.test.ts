import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { createExecutionIndexes, executionModels } from "../../src/db/executionModels";
import { verifyExecutionIndexes } from "../../src/db/executionIndexes";
import { inspectExecutionReadiness } from "../../src/db/executionReadiness";
import * as f from "../fixtures";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated replica-set Mongo URI required; use npm run test:integration");
const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
const models = executionModels(connection);
async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); }
  finally { await session.endSession(); }
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => {
  await connection.dropDatabase(); // Runner-created, uniquely named test database only.
  await createExecutionIndexes(connection);
  await transaction(async session => {
    await new models.TradingAccount(f.account()).save({ session });
    await new models.StrategySignal(f.signal()).save({ session });
    await new models.OrderIntent(f.intent()).save({ session });
    await new models.Position(f.position()).save({ session });
  });
});
test("real unique canonical decision key", async () => {
  await assert.rejects(transaction(session => new models.StrategySignal(f.signal("signal-2")).save({ session })), /E11000/);
});
test("real unique entry intent, with non-entry partial-index compatibility", async () => {
  await assert.rejects(transaction(session => new models.OrderIntent(f.intent("intent-2")).save({ session })), /E11000/);
  await transaction(session => new models.OrderIntent({ ...f.intent("close-1"), purpose: "CLOSE", signalId: undefined, positionId: "position-1",
    targetLegs: [{ ...f.intent().targetLegs[0], side: "SELL" }] }).save({ session }));
});
test("real unique physical child", async () => {
  await transaction(session => new models.BrokerOrder(f.brokerOrder()).save({ session }));
  await assert.rejects(transaction(session => new models.BrokerOrder(f.brokerOrder("order-2")).save({ session })), /E11000/);
});
async function fillSetup() {
  await transaction(async session => {
    await new models.RiskReservation(f.reservation()).save({ session });
    await new models.BrokerOrder(f.brokerOrder()).save({ session });
    // Restore historical already-dispatched evidence, never authorize a new ENTRY.
    await connection.db!.collection("execution_orders").updateOne({ orderId: "order-1" }, { $set: {
      phase: "SUBMITTED", brokerOrderId: "broker-order-1",
      submissionClaim: { claimId: "claim-1", reservationId: "reservation-1", evidenceRef: "claim-proof", policyVersion: 1, executionEpoch: 1, claimedAt: f.now, expiresAt: f.now },
    } }, { session });
  });
}
test("real Fill broker identity uniqueness and evidence-derived aggregate writes", async () => {
  await fillSetup();
  await transaction(async session => {
    await new models.Fill(f.fillRecord()).save({ session });
    const order = await models.BrokerOrder.findOne({ orderId: "order-1" }).session(session).orFail();
    order.set({ phase: "PARTIALLY_FILLED", filledUnits: 5, executionEvidenceRefs: ["fill-1"] }); await order.save({ session });
    const position = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    position.set({ lifecycle: "PARTIALLY_OPENED", executionEvidenceRefs: ["fill-1"], legs: [{ ...f.position().legs[0], entryFilledUnits: 5 }] });
    await position.save({ session });
  });
  await assert.rejects(transaction(session => new models.Fill(f.fillRecord("fill-2")).save({ session })), /E11000/);
});
test("real transaction rollback includes account fence and inserted signal", async () => {
  const before = await models.TradingAccount.findOne({ accountId: f.scope.accountId }).orFail();
  await assert.rejects(transaction(async session => {
    await new models.StrategySignal({ ...f.signal("rolled-back"), decisionKey: "rollback" }).save({ session });
    throw new Error("abort-test");
  }), /abort-test/);
  assert.equal(await models.StrategySignal.countDocuments({ signalId: "rolled-back" }), 0);
  assert.equal((await models.TradingAccount.findOne({ accountId: f.scope.accountId }).orFail()).get("version"), before.get("version"));
});
test("real optimistic concurrency rejects a stale document save", async () => {
  const first = await models.Position.findOne({ positionId: "position-1" }).orFail();
  const stale = await models.Position.findOne({ positionId: "position-1" }).orFail();
  first.set("updatedAt", new Date(f.now.getTime() + 1)); stale.set("updatedAt", new Date(f.now.getTime() + 2));
  await transaction(session => first.save({ session }));
  await assert.rejects(transaction(session => stale.save({ session })), /No matching document|version/i);
});
test("real competing entry writers produce one winner", async () => {
  await transaction(session => new models.StrategySignal({ ...f.signal("race-signal"), decisionKey: "race" }).save({ session }));
  const results = await Promise.allSettled(["race-1", "race-2"].map(id => transaction(session => new models.OrderIntent({ ...f.intent(id), signalId: "race-signal" }).save({ session }))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await models.OrderIntent.countDocuments({ signalId: "race-signal" }), 1);
});
test("account CAS fence conflicts even when overlapping transactions write different records", async () => {
  const first = await connection.startSession(), second = await connection.startSession();
  try {
    first.startTransaction({ readConcern: { level: "snapshot" } }); second.startTransaction({ readConcern: { level: "snapshot" } });
    await models.TradingAccount.findOne({ accountId: f.scope.accountId }).session(first).orFail();
    await models.TradingAccount.findOne({ accountId: f.scope.accountId }).session(second).orFail();
    await new models.StrategySignal({ ...f.signal("fenced-first"), decisionKey: "fenced-first" }).save({ session: first });
    await first.commitTransaction();
    await assert.rejects(new models.StrategySignal({ ...f.signal("fenced-second"), decisionKey: "fenced-second" }).save({ session: second }), /WriteConflict|write conflict/i);
    await second.abortTransaction();
    assert.equal(await models.StrategySignal.countDocuments({ signalId: "fenced-second" }), 0);
  } finally { await first.endSession(); await second.endSession(); }
});
test("mandatory boundary rejects cross-mode references and missing transaction", async () => {
  await transaction(session => new models.TradingAccount({ ...f.account(), accountId: "LIVE:test", executionMode: "LIVE", broker: "KITE" }).save({ session }));
  await assert.rejects(transaction(session => new models.OrderIntent({ ...f.intent("cross"), accountId: "LIVE:test", executionMode: "LIVE" }).save({ session })), /LEDGER_REFERENCE_NOT_FOUND/);
  await assert.rejects(new models.OrderIntent(f.intent("no-transaction")).save({ validateBeforeSave: false }), /PERSISTENCE_NOT_READY/);
});
test("mandatory boundary rejects wrong position/order/intent/leg Fill ownership", async () => {
  await fillSetup();
  for (const mutation of [{ positionId: "other" }, { orderId: "other" }, { intentId: "other" }, { legId: "other" }]) {
    await assert.rejects(transaction(session => new models.Fill({ ...f.fillRecord(), ...mutation }).save({ session })), /LEDGER_REFERENCE|LEDGER_RELATIONSHIP/);
  }
});
test("mandatory boundary refuses invented aggregate evidence", async () => {
  const doc = await models.Position.findOne({ positionId: "position-1" }).orFail();
  doc.set({ lifecycle: "OPEN", executionEvidenceRefs: ["invented"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10 }] });
  await assert.rejects(transaction(session => doc.save({ session, validateBeforeSave: false })), /LEDGER_RELATIONSHIP_MISMATCH/);
});
test("real open → closing → closed flow requires owned fills and terminal orders", async () => {
  await fillSetup();
  await transaction(async session => {
    await new models.Fill({ ...f.fillRecord("entry-fill"), quantityUnits: 10 }).save({ session });
    const order = await models.BrokerOrder.findOne({ orderId: "order-1" }).session(session).orFail();
    order.set({ phase: "FILLED", filledUnits: 10, executionEvidenceRefs: ["entry-fill"] }); await order.save({ session });
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ lifecycle: "OPEN", executionEvidenceRefs: ["entry-fill"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10 }] }); await pos.save({ session });
    await new models.OrderIntent({ ...f.intent("close-1"), purpose: "CLOSE", signalId: undefined, positionId: "position-1",
      targetLegs: [{ ...f.intent().targetLegs[0], side: "SELL" }] }).save({ session });
    await new models.RiskReservation({ ...f.reservation("close-reservation"), intentId: "close-1" }).save({ session });
    pos.set({ lifecycle: "CLOSING", activeCloseIntentId: "close-1" }); await pos.save({ session });
    await new models.BrokerOrder({ ...f.brokerOrder("close-order"), intentId: "close-1", side: "SELL", phase: "SUBMITTED", brokerOrderId: "close-broker-order",
      submissionClaim: { claimId: "close-claim", reservationId: "close-reservation", evidenceRef: "close-proof", policyVersion: 1, executionEpoch: 1, claimedAt: f.now, expiresAt: f.now } }).save({ session });
    await new models.Fill({ ...f.fillRecord("exit-fill"), orderId: "close-order", intentId: "close-1", brokerOrderId: "close-broker-order", brokerTradeKey: "close-trade", side: "SELL", quantityUnits: 10 }).save({ session });
    pos.set({ lifecycle: "PARTIALLY_CLOSING", executionEvidenceRefs: ["entry-fill", "exit-fill"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10, exitFilledUnits: 10 }] });
    await pos.save({ session });
  });
  await assert.rejects(transaction(async session => {
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ lifecycle: "CLOSED", activeCloseIntentId: null, closureEvidenceRefs: ["orders-final"] });
    await pos.save({ session });
  }), /CLOSURE_REQUIRES_ORDER_FINALITY/);
  await transaction(async session => {
    const order = await models.BrokerOrder.findOne({ orderId: "close-order" }).session(session).orFail();
    order.set({ phase: "FILLED", filledUnits: 10, executionEvidenceRefs: ["exit-fill"] }); await order.save({ session });
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ lifecycle: "CLOSED", activeCloseIntentId: null, closureEvidenceRefs: ["orders-final"] }); await pos.save({ session });
  });
  assert.equal((await models.Position.findOne({ positionId: "position-1" }).orFail()).get("lifecycle"), "CLOSED");
  await assert.rejects(transaction(session => new models.BrokerOrder({ ...f.brokerOrder("late-child"), sliceId: "late-slice" }).save({ session })), /TERMINAL_POSITION/);
  await assert.rejects(transaction(async session => {
    const pos = await models.Position.findOne({ positionId: "position-1" }).session(session).orFail();
    pos.set({ lifecycle: "PARTIALLY_CLOSING", activeCloseIntentId: "close-1" });
    await pos.save({ session });
  }), /TERMINAL_POSITION/);
});
test("real reservation uniqueness and reservation/order intent mismatch", async () => {
  await transaction(async session => {
    await new models.RiskReservation(f.reservation()).save({ session });
    await new models.StrategySignal({ ...f.signal("other-signal"), decisionKey: "other" }).save({ session });
    await new models.OrderIntent({ ...f.intent("other-intent"), signalId: "other-signal" }).save({ session });
    await new models.RiskReservation({ ...f.reservation("other-reservation"), intentId: "other-intent" }).save({ session });
  });
  await assert.rejects(transaction(session => new models.RiskReservation(f.reservation("duplicate-reservation")).save({ session })), /E11000/);
  await assert.rejects(transaction(session => new models.BrokerOrder({ ...f.brokerOrder(), phase: "SUBMITTED",
    submissionClaim: { claimId: "bad-claim", reservationId: "other-reservation", evidenceRef: "proof", policyVersion: 1, executionEpoch: 1, claimedAt: f.now, expiresAt: f.now } }).save({ session })), /LEDGER_RELATIONSHIP_MISMATCH/);
});
test("index inventory is verified; missing constraints block writes and readiness", async () => {
  assert.equal((await verifyExecutionIndexes(connection)).verified, true);
  await connection.db!.collection("execution_signals").dropIndex("accountId_1_decisionKey_1");
  assert.equal((await verifyExecutionIndexes(connection)).verified, false);
  assert.equal((await inspectExecutionReadiness(connection)).ready, false);
  await assert.rejects(transaction(session => new models.StrategySignal(f.signal("missing-index")).save({ session })), /EXECUTION_INDEXES_NOT_READY/);
});
