import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { submissionFingerprint, validateSubmissionEvidence } from "../../src/brokers/submissionEvidence";
import { PaperBrokerAdapter } from "../../src/brokers/PaperBrokerAdapter";
import { OrderManager } from "../../src/services/OrderManager";
import { TradingAccountModel } from "../../src/models/TradingAccount";
import * as f from "../fixtures";
const request = { ...f.scope, orderId: "order-1", claimId: "claim-1", intentId: "intent-1", positionId: "position-1",
  legId: "hedge", contractKey: "NFO:contract-1", side: "BUY" as const, quantityUnits: 10, orderType: "LIMIT" as const,
  limitPriceMinor: 1000, product: "INTRADAY" };
function paper() { let id = 0; return new PaperBrokerAdapter(f.scope, { clock: { now: () => f.now.toISOString() },
  ids: { nextId: kind => `${kind}-${++id}` }, scenario: () => ({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 4, priceMinor: 990 }] }) }); }
test("submission fingerprint canonicalizes IDs and ignores only the future claim identity", () => {
  const fingerprint = submissionFingerprint(request);
  assert.equal(submissionFingerprint({ ...request, orderId: " order-1 ", claimId: "different" }), fingerprint);
  for (const change of [{ quantityUnits: 9 }, { limitPriceMinor: 999 }, { contractKey: "other" }, { positionId: "other" }, { product: "other" }, { side: "SELL" as const }])
    assert.notEqual(submissionFingerprint({ ...request, ...change }), fingerprint);
});
test("pending broker evidence is typed, scoped and bounded; it is not a Fill record", async () => {
  const broker = paper(); const outcome = await broker.submitOrder(request); assert.equal(outcome.kind, "ACCEPTED");
  if (outcome.kind !== "ACCEPTED") assert.fail();
  const evidence = { outcome, observedOrder: outcome.order, trades: await broker.getTrades(f.scope), evidenceComplete: true, pendingFillProcessing: true };
  assert.equal(validateSubmissionEvidence(request, evidence).trades[0].quantityUnits, 4);
  for (const change of [{ accountId: "PAPER:other" }, { executionMode: "LIVE" }, { orderId: "other" }, { positionId: "other" },
    { quantityUnits: 11 }, { priceMinor: 1001 }, { brokerOrderId: "other" }]) {
    assert.throws(() => validateSubmissionEvidence(request, { ...evidence, trades: [{ ...evidence.trades[0], ...change }] }));
  }
  assert.throws(() => validateSubmissionEvidence(request, { ...evidence, trades: [...evidence.trades, ...evidence.trades] }));
  assert.throws(() => validateSubmissionEvidence(request, { ...evidence, pendingFillProcessing: false }));
  assert.throws(() => validateSubmissionEvidence(request, { ...evidence, secret: "not-allowed" }));
});
test("PAPER_READY never permits LIVE accounts and remains an explicit opt-in", async () => {
  await new TradingAccountModel({ ...f.account(), admissionStatus: "PAPER_READY" }).validate();
  await assert.rejects(new TradingAccountModel({ ...f.account(), accountId: "LIVE:test", executionMode: "LIVE", broker: "KITE", admissionStatus: "PAPER_READY" }).validate());
  assert.equal(new TradingAccountModel(f.account()).get("admissionStatus"), "DISABLED");
});
test("OrderManager rejects caller economics, LIVE scope and unavailable persistence before any submission", async () => {
  const connection = mongoose.createConnection(); const broker = paper();
  const manager = new OrderManager(connection, f.scope, broker);
  assert.throws(() => new OrderManager(connection, { accountId: "LIVE:test", executionMode: "LIVE" }, broker), /PAPER_ONLY/);
  await assert.rejects(manager.submit({ orderId: "order-1", quantityUnits: 100 } as unknown as string));
  await assert.rejects(manager.submit("order-1"), /PERSISTENCE_NOT_READY/);
  assert.deepEqual(await broker.getOrders(f.scope), []);
});
