import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { tradingEventSchema, executionModeSchema, executionScopeSchema } from "@trading-bot/shared";
import { executionModels, executionSchemas } from "../../src/db/executionModels";
import { requireAggregateVersion } from "../../src/db/executionConcurrency";
import { addMinorUnits, executionCapability, sameExecutionChain } from "../../src/domain/execution";
import { rejectDeltaExecution } from "../../src/domain/ExecutionSafety";
import { account, base, brokerOrder, eventRecord, fillRecord, intent, now, position, reservation, scope, signal } from "../fixtures";

const models = executionModels(mongoose.createConnection());
const fixtures = { TradingAccount: account, StrategySignal: signal, OrderIntent: intent,
  RiskReservation: reservation, BrokerOrder: brokerOrder, Fill: fillRecord, Position: position, TradingEvent: eventRecord };

test("all eight ledger models require scope, schema version, UTC dates and correlation", async () => {
  for (const [name, factory] of Object.entries(fixtures)) {
    const model = models[name as keyof typeof models];
    const record = factory();
    await new model(record).validate();
    for (const field of ["accountId", "executionMode", "schemaVersion", "correlationId", "createdAt"]) {
      const copy: Record<string, unknown> = { ...record }; delete copy[field];
      await assert.rejects(new model(copy).validate(), `${name}.${field} is required`);
    }
  }
});

test("INV-001/002/003/012 required database index definitions exist (structural only)", () => {
  const required = [
    ["StrategySignal", { accountId: 1, decisionKey: 1 }],
    ["OrderIntent", { accountId: 1, signalId: 1 }],
    ["OrderIntent", { accountId: 1, commandKey: 1 }],
    ["RiskReservation", { accountId: 1, intentId: 1 }],
    ["BrokerOrder", { intentId: 1, legId: 1, sliceId: 1, generation: 1 }],
    ["Fill", { accountId: 1, broker: 1, brokerNamespace: 1, brokerTradeKey: 1 }],
  ] as const;
  for (const [name, key] of required) {
    const found = executionSchemas[name].indexes().find(([fields, opts]) => JSON.stringify(fields) === JSON.stringify(key) && opts.unique);
    assert.ok(found, `${name} unique key`);
    if (name === "OrderIntent" && "signalId" in key) assert.deepEqual(found[1].partialFilterExpression, { purpose: "ENTRY" });
  }
});

test("INV-018 mutable aggregates use explicit version CAS; close identity is structurally unique", () => {
  for (const name of ["TradingAccount", "OrderIntent", "RiskReservation", "BrokerOrder", "Position"] as const) {
    assert.equal(executionSchemas[name].get("versionKey"), "version");
    assert.equal(executionSchemas[name].get("optimisticConcurrency"), true);
  }
  const doc = new models.Position(position());
  requireAggregateVersion(doc, scope, 0);
  assert.throws(() => requireAggregateVersion(doc, scope, 1), /CAS_CONFLICT/);
  assert.ok(executionSchemas.Position.indexes().some(([key, options]) => key.activeCloseIntentId === 1 && options.unique));
});

test("INV-027 persisted scope and execution evidence cannot cross ledgers", async () => {
  const live = { accountId: "LIVE:test-account", executionMode: "LIVE" as const };
  assert.equal(sameExecutionChain(scope, live), false);
  assert.equal(sameExecutionChain(scope, { ...scope, accountId: "PAPER:someone-else" }), false);
  assert.equal(executionScopeSchema.safeParse({ ...scope, executionMode: "LIVE" }).success, false);
  for (const mode of executionModeSchema.options) assert.equal(executionCapability(mode).ok, false);
  await assert.rejects(new models.Fill({ ...fillRecord(), ...live }).validate());
  await assert.rejects(new models.Fill({ ...fillRecord(), accountId: "LEGACY_PAPER:legacy", executionMode: "LEGACY_PAPER" }).validate());
  await assert.rejects(new models.TradingAccount({ ...account(), ...live }).validate());
  assert.throws(rejectDeltaExecution, /DELTA_EXECUTION_DISABLED/);
});

test("minor units and quantities reject fractions, overflow and negative holds", async () => {
  assert.equal(addMinorUnits(101, 202), 303);
  assert.equal(addMinorUnits(-101, 202), 101);
  for (const [a, b] of [[0.1, 1], [Number.MAX_SAFE_INTEGER, 1], [NaN, 1], [Infinity, 1]]) assert.throws(() => addMinorUnits(a, b));
  for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    await assert.rejects(new models.RiskReservation({ ...reservation(), remainingMarginMinor: bad }).validate());
    await assert.rejects(new models.Fill({ ...fillRecord(), quantityUnits: bad }).validate());
  }
});

test("INV-016 model rejects closure without evidence, flatness and finality", async () => {
  await assert.rejects(new models.Position({ ...position(), lifecycle: "CLOSED" }).validate());
  await assert.rejects(new models.Position({ ...position(), lifecycle: "CLOSED", closureEvidenceRefs: ["proof"], potentiallyExecutingOrderCount: 1 }).validate());
  await assert.rejects(new models.BrokerOrder({ ...brokerOrder(), phase: "FILLED", filledUnits: 10 }).validate());
});

test("INV-032 event structure has immutable identity, sequence, typed payload and evidence", async () => {
  const event = eventRecord();
  const { createdAt, ...wire } = event;
  assert.equal(tradingEventSchema.safeParse({ ...wire, occurredAt: now.toISOString(), recordedAt: now.toISOString() }).success, true);
  await assert.rejects(new models.TradingEvent({ ...event, payload: { arbitrary: "untyped" } }).validate());
  await assert.rejects(new models.TradingEvent({ ...event, eventType: "FILL_RECEIVED" }).validate());
  await assert.rejects(new models.TradingEvent({ ...event, tradingDate: "2026-02-31" }).validate());
  await assert.rejects(new models.TradingEvent({ ...event, eventType: "POSITION_CLOSED", evidenceRefs: [] }).validate());
});

test("append-only models reject query updates, replacement, delete and bulk mutations before DB access", async () => {
  for (const name of ["TradingEvent", "Fill", "StrategySignal"] as const) {
    const model = models[name];
    await assert.rejects(model.updateOne({}, { $set: { reason: "changed" } }), /LEDGER_WRITE_FORBIDDEN/);
    await assert.rejects(model.deleteMany({}), /LEDGER_WRITE_FORBIDDEN/);
    await assert.rejects(model.replaceOne({}, base()), /LEDGER_WRITE_FORBIDDEN/);
    await assert.rejects(model.bulkWrite([{ deleteMany: { filter: {} } }]), /LEDGER_WRITE_FORBIDDEN/);
    await assert.rejects(model.insertMany([eventRecord()], { lean: true }), /LEDGER_WRITE_FORBIDDEN/);
  }
});
