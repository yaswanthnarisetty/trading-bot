import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryStateSchema, recoveryBeginId, recoveryReadyId } from "../../src/domain/recovery";
import { tradingEventSchema } from "@trading-bot/shared";
import * as f from "../fixtures";
import { createExecutionHostContext, requireExecutionHost, validateExecutionHost } from "../../src/domain/ExecutionHostContext";
const required = { status: "RECOVERY_REQUIRED", generation: 1, commandKey: "startup", beginEventId: "begin", requiredAt: f.now.toISOString() };
test("recovery generations require positive safe integers", () => {
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(recoveryStateSchema.safeParse({ ...required, generation }).success, false);
  assert.equal(recoveryStateSchema.safeParse(required).success, true);
});
test("READY requires explicit completion identity and time", () => {
  assert.equal(recoveryStateSchema.safeParse({ ...required, status: "READY" }).success, false);
  assert.equal(recoveryStateSchema.safeParse({ ...required, status: "READY", recordId: "record", readyEventId: "ready", readyAt: f.now.toISOString() }).success, true);
});
test("recovery command and readiness identities are deterministic and account scoped", () => {
  assert.equal(recoveryBeginId("PAPER:a", "one", "host-A"), recoveryBeginId("PAPER:a", "one", "host-A"));
  assert.notEqual(recoveryBeginId("PAPER:a", "one", "host-A"), recoveryBeginId("PAPER:b", "one", "host-A"));
  assert.notEqual(recoveryReadyId("PAPER:a", 1), recoveryReadyId("PAPER:a", 2));
});
test("recovery audit events require their typed payload and evidence", () => {
  const event = { eventId: "ready", ...f.scope, accountSequence: 1, tradingDate: "2026-09-11", eventType: "RECOVERY_READY",
    aggregateType: "TradingAccount", aggregateId: f.scope.accountId, aggregateVersion: 1, correlationId: "c", causationId: "record",
    actor: "RecoveryBarrierService", schemaVersion: 1, occurredAt: f.now.toISOString(), recordedAt: f.now.toISOString(),
    reason: "READY", evidenceRefs: ["record"], payload: { kind: "RECOVERY", generation: 1, commandKey: "startup", recordId: "record" } };
  assert.equal(tradingEventSchema.safeParse(event).success, true);
  assert.equal(tradingEventSchema.safeParse({ ...event, evidenceRefs: [] }).success, false);
  assert.equal(tradingEventSchema.safeParse({ ...event, payload: { kind: "REFERENCE", entityId: "record" } }).success, false);
  assert.equal(tradingEventSchema.safeParse({ ...event, payload: { ...event.payload, recordId: null } }).success, false);
});
test("host factory creates immutable distinct startup identities while services may share one", () => {
  const a = createExecutionHostContext(), b = createExecutionHostContext();
  assert.notEqual(a.startupId, b.startupId); assert.ok(Object.isFrozen(a));
  assert.equal(requireExecutionHost(a), a);
  assert.throws(() => { (a as { startupId: string }).startupId = b.startupId; }, TypeError);
});
test("missing or request-shaped host identity cannot become a trusted context", () => {
  assert.throws(() => requireExecutionHost(undefined), /RECOVERY_REQUIRED/);
  assert.throws(() => validateExecutionHost({ startupId: "forged-request-host" }), /INVALID_EXECUTION_HOST_CONTEXT/);
  assert.throws(() => createExecutionHostContext("hostname with whitespace"));
});
test("recovery command receipts are scoped to host startup as well as account", () => {
  assert.notEqual(recoveryBeginId("PAPER:a", "same-command", "A"), recoveryBeginId("PAPER:a", "same-command", "B"));
});
