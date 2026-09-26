import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { executionModels } from "../../src/db/executionModels";
import { compareExecutionIndexes, requiredExecutionIndexes } from "../../src/db/executionIndexes";
import { transitionPosition } from "../../src/domain/PositionStateMachine";
import { transitionOrder } from "../../src/domain/OrderStateMachine";
import * as f from "../fixtures";

const models = executionModels(mongoose.createConnection());
test("regression: a never-opened closing input cannot produce CLOSED", () => {
  const result = transitionPosition({ ...f.positionState(), lifecycle: "CLOSING", activeCloseIntentId: "close-1" },
    { type: "CONFIRM_CLOSED", noPotentiallyExecutingOrders: true, evidenceRefs: ["proof"] });
  assert.equal(result.ok, false);
  const aborted = f.value(transitionPosition(f.positionState(), { type: "ABORT_ENTRY", noPotentiallyExecutingOrders: true, evidenceRefs: ["never-sent"] }));
  assert.equal(aborted.lifecycle, "ABORTED");
  assert.equal(transitionPosition(aborted, { type: "MARK_INCONSISTENT" }).ok, true);
});
test("position model rejects unproved OPEN, never-opened CLOSED and whitespace evidence", async () => {
  for (const change of [
    { lifecycle: "OPEN" }, { lifecycle: "CLOSED", closureEvidenceRefs: ["proof"] },
    { lifecycle: "CLOSED", closureEvidenceRefs: [" "] },
    { lifecycle: "OPEN", executionEvidenceRefs: [" "], legs: [{ ...f.position().legs[0], entryFilledUnits: 10 }] },
    { lifecycle: "CLOSED", executionEvidenceRefs: ["entry", "exit"], closureEvidenceRefs: ["proof"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10, exitFilledUnits: 5 }] },
  ]) await assert.rejects(new models.Position({ ...f.position(), ...change }).validate());
});
test("position model accepts structurally evidenced OPEN and CLOSED; DB boundary verifies actual fills", async () => {
  await new models.Position({ ...f.position(), lifecycle: "OPEN", executionEvidenceRefs: ["entry"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10 }] }).validate();
  await new models.Position({ ...f.position(), lifecycle: "CLOSED", executionEvidenceRefs: ["entry", "exit"], closureEvidenceRefs: ["terminal-orders"], legs: [{ ...f.position().legs[0], entryFilledUnits: 10, exitFilledUnits: 10 }] }).validate();
});
test("order model rejects contradictory phase/quantity/evidence combinations", async () => {
  for (const change of [
    { filledUnits: 5 }, { filledUnits: -1 }, { filledUnits: 11 },
    { phase: "FILLED", filledUnits: 10 }, { phase: "FILLED", filledUnits: 10, executionEvidenceRefs: [" "] },
    { phase: "PARTIALLY_FILLED", filledUnits: 0 }, { phase: "PLANNED", cancellation: "CONFIRMED" },
  ]) await assert.rejects(new models.BrokerOrder({ ...f.brokerOrder(), ...change }).validate());
});
test("hydrated order validation rejects cumulative fill and observation regression", async () => {
  const original = { ...f.brokerOrder(), phase: "CANCELLED", cancellation: "CONFIRMED", filledUnits: 5, lastObservationVersion: 3, executionEvidenceRefs: ["fill-1"] };
  for (const mutation of [{ filledUnits: 4 }, { lastObservationVersion: 2 }]) {
    const doc = models.BrokerOrder.hydrate(original); doc.set(mutation); await assert.rejects(doc.validate(), /OBSERVATION_REGRESSION/);
  }
});
const wrongOwnership = [
  ["position", { positionId: "other" }], ["intent", { intentId: "other" }],
  ["order", { orderId: "other" }], ["account", { accountId: "PAPER:other" }],
  ["mode", { accountId: "LIVE:other", executionMode: "LIVE" as const, source: "BROKER_TRADE" as const }],
  ["leg", { legId: "other" }],
] as const;
for (const [name, mutation] of wrongOwnership) test(`fill ownership rejects wrong ${name} in both reducers`, () => {
  const evidence = { ...f.fill(), ...mutation };
  const ready = f.value(transitionOrder(f.orderState(), { type: "AUTHORIZE", authorization: f.authorization() }));
  const submitting = f.value(transitionOrder(ready, { type: "CLAIM_SUBMISSION", nowMs: 1000, executionEpoch: 1, policyVersion: 1 }));
  assert.equal(transitionOrder(submitting, { type: "APPLY_FILL", fill: evidence }).ok, false);
  assert.equal(transitionPosition(f.positionState(), { type: "ENTRY_FILL", fill: evidence }).ok, false);
});
test("the same fill cannot mutate two position IDs", () => {
  assert.equal(transitionPosition(f.positionState(), { type: "ENTRY_FILL", fill: f.fill() }).ok, true);
  assert.equal(transitionPosition({ ...f.positionState(), positionId: "position-2" }, { type: "ENTRY_FILL", fill: f.fill() }).ok, false);
});
test("all ordinary write APIs enforce validation boundary even with validation disabled", async () => {
  await assert.rejects(new models.Position(f.position()).save({ validateBeforeSave: false }), /PERSISTENCE_NOT_READY/);
  await assert.rejects(models.Position.insertMany([f.position()]), /LEDGER_WRITE_FORBIDDEN/);
  await assert.rejects(models.Position.updateOne({}, { lifecycle: "OPEN" }), /LEDGER_WRITE_FORBIDDEN/);
});
test("index specification verification detects absent and conflicting unique/partial constraints", () => {
  const required = requiredExecutionIndexes(); assert.equal(required.length, 28);
  const inventory: Record<string, Record<string, unknown>[]> = {};
  for (const spec of required) (inventory[spec.collection] ??= []).push({ key: spec.key, ...spec.options });
  assert.deepEqual(compareExecutionIndexes(required, inventory), []);
  assert.ok(compareExecutionIndexes(required, {}).every(issue => issue.startsWith("MISSING")));
  const entry = inventory.execution_intents.find(index => JSON.stringify(index.key) === JSON.stringify({ accountId: 1, signalId: 1 }))!;
  entry.partialFilterExpression = { purpose: "CLOSE" };
  assert.ok(compareExecutionIndexes(required, inventory).some(issue => issue.startsWith("CONFLICTING")));
  entry.partialFilterExpression = { purpose: "ENTRY" }; entry.unique = false;
  assert.ok(compareExecutionIndexes(required, inventory).some(issue => issue.startsWith("CONFLICTING")));
});

test("reconciliation indexes are a separate mandatory group with all seven constraints retained", () => {
  const base=requiredExecutionIndexes(), reconciliation=requiredExecutionIndexes("RECONCILIATION"), all=requiredExecutionIndexes("ALL");
  assert.equal(base.length,28); assert.equal(reconciliation.length,7); assert.equal(all.length,35);
  assert.ok(base.every(i=>!i.collection.startsWith("execution_reconcil")));
  assert.ok(reconciliation.every(i=>i.collection.startsWith("execution_reconcil")));
  const inventory: Record<string, Record<string, unknown>[]> = {};
  for (const spec of base) (inventory[spec.collection]??=[]).push({key:spec.key,...spec.options});
  assert.deepEqual(compareExecutionIndexes(base,inventory),[]); assert.equal(compareExecutionIndexes(reconciliation,inventory).length,7);
});
