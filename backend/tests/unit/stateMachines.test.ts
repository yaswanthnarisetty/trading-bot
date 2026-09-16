import test from "node:test";
import assert from "node:assert/strict";
import { intentStateSchema, knowledgeStateSchema, orderPhaseSchema, type IntentState } from "@trading-bot/shared";
import { transitionIntent } from "../../src/domain/IntentStateMachine";
import { transitionOrder, transitionKnowledge, type OrderEvent, type OrderState } from "../../src/domain/OrderStateMachine";
import { transitionPosition, type PositionEvent } from "../../src/domain/PositionStateMachine";
import { authorization, fill, orderState, positionState, value } from "../fixtures";

const ready = () => value(transitionOrder(orderState(), { type: "AUTHORIZE", authorization: authorization() }));
const submitting = () => value(transitionOrder(ready(), { type: "CLAIM_SUBMISSION", nowMs: 1000, executionEpoch: 1, policyVersion: 1 }));
const observed = (state: OrderState, phase: "SUBMITTED" | "ACKNOWLEDGED" | "CANCELLED" | "REJECTED", version = 1) =>
  transitionOrder(state, { type: "BROKER_OBSERVED", phase, cumulativeFilledUnits: state.filledUnits, observationVersion: version, evidenceRef: "broker-read" });
const working = () => value(observed(submitting(), "ACKNOWLEDGED"));

test("intent lifecycle: every pair is explicitly allowed or rejected", () => {
  const legal: [IntentState, IntentState][] = [["CREATED", "RISK_PENDING"], ["CREATED", "ABORTED"],
    ["RISK_PENDING", "RISK_RESERVED"], ["RISK_PENDING", "BLOCKED"], ["RISK_PENDING", "ABORTED"],
    ["RISK_RESERVED", "EXECUTING"], ["RISK_RESERVED", "ABORTED"], ["EXECUTING", "COMPLETED"],
    ["EXECUTING", "ABORTING"], ["ABORTING", "ABORTED"]];
  for (const from of intentStateSchema.options) for (const to of intentStateSchema.options) {
    assert.equal(transitionIntent(from, to, { reservationId: "r", submissionClaimId: "c", evidenceRefs: ["e"],
      targetAchieved: true, noPotentiallyExecutingChildren: true }).ok, legal.some(([f, t]) => f === from && t === to), `${from} → ${to}`);
  }
  assert.equal(transitionIntent("RISK_PENDING", "RISK_RESERVED").ok, false);
  assert.equal(transitionIntent("RISK_RESERVED", "EXECUTING").ok, false);
  assert.equal(transitionIntent("EXECUTING", "COMPLETED", { targetAchieved: true }).ok, false);
  assert.equal(transitionIntent("ABORTING", "ABORTED").ok, false);
});

test("knowledge lifecycle: every pair, evidence required for resolution (INV-005)", () => {
  const legal = ["KNOWN:UNKNOWN", "KNOWN:RECONCILIATION_REQUIRED", "UNKNOWN:RECONCILIATION_REQUIRED", "RECONCILIATION_REQUIRED:KNOWN", "RECONCILIATION_REQUIRED:UNKNOWN"];
  for (const from of knowledgeStateSchema.options) for (const to of knowledgeStateSchema.options) {
    assert.equal(transitionKnowledge(from, to, "resolution").ok, legal.includes(`${from}:${to}`));
  }
  assert.equal(transitionKnowledge("RECONCILIATION_REQUIRED", "KNOWN").ok, false);
});

test("order path: planning, authorization, submission, acknowledgement and partial/full execution", () => {
  const initial = orderState();
  const serialized = JSON.stringify(initial);
  assert.equal(ready().phase, "READY");
  const sent = submitting();
  const submitted = value(observed(sent, "SUBMITTED"));
  const acknowledged = value(observed(submitted, "ACKNOWLEDGED", 2));
  const partial = value(transitionOrder(acknowledged, { type: "APPLY_FILL", fill: fill() }));
  assert.equal(partial.phase, "PARTIALLY_FILLED");
  assert.equal(partial.filledUnits, 5);
  const full = value(transitionOrder(partial, { type: "APPLY_FILL", fill: fill("fill-2") }));
  assert.equal(full.phase, "FILLED");
  assert.equal(full.filledUnits, 10);
  assert.equal(JSON.stringify(initial), serialized, "pure transitions leave inputs unchanged");
});

for (const phase of ["SUBMITTING", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED"] as const) {
  test(`legal outcomes from ${phase}: partial/full fill, rejection, cancellation, unknown`, () => {
    const state = phase === "PARTIALLY_FILLED"
      ? value(transitionOrder(working(), { type: "APPLY_FILL", fill: fill() })) : { ...submitting(), phase };
    assert.equal(value(observed(state, "REJECTED", 2)).phase, "REJECTED");
    assert.equal(value(observed(state, "CANCELLED", 2)).phase, "CANCELLED");
    const filled = value(transitionOrder(state, { type: "APPLY_FILL", fill: fill("final", 10 - state.filledUnits) }));
    assert.equal(filled.phase, "FILLED");
    const unknown = value(transitionOrder(state, { type: "OUTCOME_UNKNOWN" }));
    const reconciling = value(transitionOrder(unknown, { type: "START_RECONCILIATION" }));
    assert.equal(value(transitionOrder(reconciling, { type: "RESOLVE_KNOWLEDGE", evidenceRef: "resolved" })).knowledge, "KNOWN");
  });
}

test("INV-004 authorization is explicit, scoped, committed, sufficient and current", () => {
  assert.equal(transitionOrder({ ...orderState(), phase: "READY" }, { type: "CLAIM_SUBMISSION", nowMs: 1000, executionEpoch: 1, policyVersion: 1 }).ok, false);
  for (const auth of [
    { ...authorization(), reservationId: "" }, { ...authorization(), reservedQuantityUnits: 9 },
    { ...authorization(), accountId: "LIVE:test-account", executionMode: "LIVE" as const },
    { ...authorization(), committed: false } as unknown as ReturnType<typeof authorization>,
  ]) assert.equal(transitionOrder(orderState(), { type: "AUTHORIZE", authorization: auth }).ok, false);
  for (const changes of [{ nowMs: 2000 }, { executionEpoch: 2 }, { policyVersion: 2 }]) {
    assert.equal(transitionOrder(ready(), { type: "CLAIM_SUBMISSION", nowMs: 1000, executionEpoch: 1, policyVersion: 1, ...changes }).ok, false);
  }
});

test("INV-005 unknown state is never reset to READY or blindly resubmitted", () => {
  const unknown = value(transitionOrder(submitting(), { type: "OUTCOME_UNKNOWN" }));
  assert.equal(transitionOrder(unknown, { type: "AUTHORIZE", authorization: authorization() }).ok, false);
  assert.equal(transitionOrder(unknown, { type: "CLAIM_SUBMISSION", nowMs: 999999, executionEpoch: 1, policyVersion: 1 }).ok, false);
  assert.equal(transitionOrder(unknown, { type: "RESOLVE_KNOWLEDGE", evidenceRef: "elapsed" }).ok, false);
  assert.equal(transitionOrder(unknown, { type: "TIMER_ELAPSED" } as unknown as OrderEvent).ok, false);
});

test("conclusive non-send permits NOT_SENT; elapsed time and missing evidence do not", () => {
  for (const state of [orderState(), ready(), submitting()]) {
    assert.equal(value(transitionOrder(state, { type: "PROVE_NOT_SENT", evidenceRef: "local-validation-before-send", senderQuiesced: true })).phase, "NOT_SENT");
    assert.equal(transitionOrder(state, { type: "PROVE_NOT_SENT", evidenceRef: "", senderQuiesced: true }).ok, false);
  }
  assert.equal(transitionOrder(working(), { type: "PROVE_NOT_SENT", evidenceRef: "no", senderQuiesced: true }).ok, false);
});

test("cancellation API acceptance is not terminal confirmation; races preserve fills", () => {
  const requested = value(transitionOrder(working(), { type: "REQUEST_CANCEL" }));
  assert.deepEqual(value(transitionOrder(requested, { type: "REQUEST_CANCEL" })), requested);
  const pending = value(transitionOrder(requested, { type: "DISPATCH_CANCEL", commandId: "cancel-1" }));
  assert.deepEqual(value(transitionOrder(pending, { type: "CANCEL_API_ACCEPTED" })), pending);
  const partial = value(transitionOrder(pending, { type: "APPLY_FILL", fill: fill() }));
  assert.equal(partial.cancellation, "CANCEL_PENDING");
  const cancelled = value(observed(partial, "CANCELLED", 2));
  assert.equal(cancelled.cancellation, "CONFIRMED");
  assert.equal(cancelled.filledUnits, 5);
  const lateFill = value(transitionOrder(cancelled, { type: "APPLY_FILL", fill: fill("late", 5) }));
  assert.equal(lateFill.phase, "FILLED");
  assert.equal(lateFill.knowledge, "RECONCILIATION_REQUIRED");
  const rejected = value(transitionOrder(pending, { type: "CANCEL_REJECTED", evidenceRef: "cancel-rejected" }));
  assert.equal(value(transitionOrder(rejected, { type: "REQUEST_CANCEL" })).cancellation, "REQUESTED");
  const unknown = value(transitionOrder(pending, { type: "CANCEL_OUTCOME_UNKNOWN" }));
  assert.equal(unknown.cancellation, "UNKNOWN");
  assert.equal(transitionOrder(unknown, { type: "DISPATCH_CANCEL", commandId: "cancel-again" }).ok, false);
  assert.equal(value(observed(unknown, "CANCELLED", 2)).cancellation, "CONFIRMED");
});

test("illegal cancellation transitions are explicit", () => {
  for (const event of ["DISPATCH_CANCEL", "CANCEL_API_ACCEPTED", "CANCEL_REJECTED", "CANCEL_OUTCOME_UNKNOWN"] as const) {
    assert.equal(transitionOrder(working(), { type: event, commandId: "c", evidenceRef: "e" } as OrderEvent).ok, false);
  }
  for (const phase of ["PLANNED", "READY", "SUBMITTING", "FILLED", "NOT_SENT", "CANCELLED", "REJECTED"] as const) {
    assert.equal(transitionOrder({ ...orderState(), phase }, { type: "REQUEST_CANCEL" }).ok, false);
  }
});

test("INV-012/021 duplicates are no-ops and observations never reduce fill totals", () => {
  const partial = value(transitionOrder(working(), { type: "APPLY_FILL", fill: fill() }));
  assert.deepEqual(value(transitionOrder(partial, { type: "APPLY_FILL", fill: fill() })), partial);
  assert.equal(transitionOrder(partial, { type: "APPLY_FILL", fill: { ...fill(), priceMinor: 999 } }).ok, false);
  assert.equal(transitionOrder(partial, { type: "BROKER_OBSERVED", phase: "ACKNOWLEDGED", cumulativeFilledUnits: 0, observationVersion: 0, evidenceRef: "old" }).ok, false);
  assert.equal(value(observed(partial, "SUBMITTED", 2)).phase, "PARTIALLY_FILLED");
  assert.equal(transitionOrder(working(), { type: "BROKER_OBSERVED", phase: "ACKNOWLEDGED", cumulativeFilledUnits: 10, observationVersion: 2, evidenceRef: "no-trades" }).ok, false);
});

test("no phase can jump to FILLED using an observation instead of fills", () => {
  for (const phase of orderPhaseSchema.options) {
    assert.equal(transitionOrder({ ...orderState(), phase }, { type: "SET_FILLED" } as unknown as OrderEvent).ok, false);
  }
  assert.equal(transitionOrder(orderState(), { type: "APPLY_FILL", fill: fill() }).ok, false);
  assert.equal(transitionOrder(working(), { type: "APPLY_FILL", fill: fill("overflow", 11) }).ok, false);
});

test("fill-derived phase is independent of the last broker status identity", () => {
  let state = value(transitionOrder(working(), { type: "APPLY_FILL", fill: fill() }));
  const snapshot = { type: "BROKER_OBSERVED" as const, phase: "ACKNOWLEDGED" as const,
    cumulativeFilledUnits: 5, observationVersion: 2, evidenceRef: "partial-snapshot" };
  state = value(transitionOrder(state, snapshot));
  assert.equal(state.phase, "PARTIALLY_FILLED");
  assert.deepEqual(value(transitionOrder(state, snapshot)), state);
  state = value(transitionOrder(state, { type: "APPLY_FILL", fill: fill("rest", 5) }));
  assert.deepEqual(value(transitionOrder(state, snapshot)), state);
  assert.equal(state.phase, "FILLED"); assert.equal(state.filledUnits, 10);
  const changed = transitionOrder(state, { ...snapshot, cumulativeFilledUnits: 10 });
  assert.equal(changed.ok, false); if (!changed.ok) assert.equal(changed.error.code, "DUPLICATE_CONFLICT");
});

test("partial/full status snapshots cannot manufacture fills or regress a terminal order", () => {
  const base = working();
  for (const phase of ["PARTIALLY_FILLED", "FILLED"] as const) {
    for (const units of [0, 5, 10]) {
      assert.equal(transitionOrder(base, { type: "BROKER_OBSERVED", phase, cumulativeFilledUnits: units,
        observationVersion: 2, evidenceRef: "no-trades" }).ok, false);
    }
  }
  const full = value(transitionOrder(base, { type: "APPLY_FILL", fill: fill("full", 10) }));
  const event = { type: "BROKER_OBSERVED" as const, phase: "FILLED" as const,
    cumulativeFilledUnits: 10, observationVersion: 2, evidenceRef: "terminal-snapshot" };
  const confirmed = value(transitionOrder(full, event));
  assert.equal(confirmed.phase, "FILLED"); assert.equal(confirmed.lastObservationVersion, 2);
  assert.deepEqual(confirmed.fills, full.fills);
  assert.deepEqual(value(transitionOrder(confirmed, event)), confirmed);
  const newer = value(transitionOrder(confirmed, { ...event, observationVersion: 3, evidenceRef: "newer-terminal" }));
  assert.equal(newer.lastObservationVersion, 3); assert.equal(newer.filledUnits, 10);
  for (const phase of ["ACKNOWLEDGED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED"] as const) {
    assert.equal(transitionOrder(newer, { ...event, phase, observationVersion: 4 }).ok, false);
  }
  const stale = transitionOrder(newer, event);
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "OBSERVATION_REGRESSION");
});

test("snapshot replay without its restored evidence fails closed; version zero remains reserved", () => {
  const applied = working();
  const event = { type: "BROKER_OBSERVED" as const, phase: "ACKNOWLEDGED" as const,
    cumulativeFilledUnits: 0, observationVersion: 1, evidenceRef: "broker-read" };
  const missing = transitionOrder({ ...applied, lastObservation: undefined }, event);
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.error.code, "EVIDENCE_REQUIRED");
  assert.deepEqual(value(transitionOrder(structuredClone(applied), event)), applied);
  assert.equal(transitionOrder(submitting(), { ...event, observationVersion: 0 }).ok, false);
  assert.equal(transitionOrder({ ...applied, lastObservation: { phase: "ACKNOWLEDGED", cumulativeFilledUnits: 1, evidenceRef: "fabricated" } }, event).ok, false);
});

test("position lifecycle is independent per leg and close requests converge (INV-014/016/018)", () => {
  const initial = positionState();
  const hedge = fill("hedge-filled", 10);
  const short = { ...fill("short-filled", 10), orderId: "short-order", legId: "short", side: "SELL" as const };
  const partial = value(transitionPosition(initial, { type: "ENTRY_FILL", fill: hedge }));
  assert.equal(partial.lifecycle, "PARTIALLY_OPENED");
  const open = value(transitionPosition(partial, { type: "ENTRY_FILL", fill: short }));
  assert.equal(open.lifecycle, "OPEN");
  const closing = value(transitionPosition(open, { type: "REQUEST_CLOSE", closeIntentId: "close-1" }));
  assert.deepEqual(value(transitionPosition(closing, { type: "REQUEST_CLOSE", closeIntentId: "close-2" })), closing);
  const evidence = { type: "CONFIRM_CLOSED" as const, noPotentiallyExecutingOrders: true as const, evidenceRefs: ["orders-terminal"] };
  assert.equal(transitionPosition(closing, evidence).ok, false);
  const half = value(transitionPosition(closing, { type: "EXIT_FILL", fill: { ...short, fillId: "short-close", intentId: "close-1", orderId: "close-order-1", side: "BUY" } }));
  assert.equal(half.lifecycle, "PARTIALLY_CLOSING");
  assert.equal(transitionPosition(half, evidence).ok, false);
  const flat = value(transitionPosition(half, { type: "EXIT_FILL", fill: { ...hedge, fillId: "hedge-close", intentId: "close-1", orderId: "close-order-2", side: "SELL" } }));
  assert.notEqual(flat.lifecycle, "CLOSED", "Zero quantity still needs outstanding-order evidence");
  assert.equal(transitionPosition(flat, { ...evidence, evidenceRefs: [] }).ok, false);
  assert.equal(transitionPosition(flat, { ...evidence, noPotentiallyExecutingOrders: false } as unknown as PositionEvent).ok, false);
  const closed = value(transitionPosition(flat, evidence));
  assert.equal(closed.lifecycle, "CLOSED");
  assert.deepEqual(value(transitionPosition(closed, { type: "REQUEST_CLOSE", closeIntentId: "close-3" })), closed);
  assert.deepEqual(initial, positionState());
});

test("position quantities cannot be created by submission, acknowledgement or counterfeit state", () => {
  for (const type of ["ORDER_SUBMITTED", "ORDER_ACKNOWLEDGED", "SET_OPEN", "SET_QUANTITY"]) {
    assert.equal(transitionPosition(positionState(), { type } as unknown as PositionEvent).ok, false);
  }
  const fake = { ...positionState(), legs: [{ ...positionState().legs[0], entryFilledUnits: 10 }] };
  assert.equal(transitionPosition(fake, { type: "REQUEST_CLOSE", closeIntentId: "close" }).ok, false);
});

test("position abort, partial-entry recovery, integrity and over-close guards", () => {
  assert.equal(value(transitionPosition(positionState(), { type: "ABORT_ENTRY", noPotentiallyExecutingOrders: true, evidenceRefs: ["never-sent"] })).lifecycle, "ABORTED");
  const partial = value(transitionPosition(positionState(), { type: "ENTRY_FILL", fill: fill() }));
  assert.equal(transitionPosition(partial, { type: "ABORT_ENTRY", noPotentiallyExecutingOrders: true, evidenceRefs: ["x"] }).ok, false);
  const inconsistent = value(transitionPosition(partial, { type: "MARK_INCONSISTENT" }));
  assert.equal(inconsistent.lifecycle, "PARTIALLY_OPENED");
  assert.equal(transitionPosition(inconsistent, { type: "REQUEST_CLOSE", closeIntentId: "c" }).ok, false);
  const consistent = value(transitionPosition(inconsistent, { type: "RESTORE_INTEGRITY", evidenceRefs: ["reconciled"] }));
  const closing = value(transitionPosition(consistent, { type: "REQUEST_CLOSE", closeIntentId: "c" }));
  assert.equal(transitionPosition(closing, { type: "EXIT_FILL", fill: { ...fill("too-many", 6), side: "SELL" } }).ok, false);
  assert.deepEqual(value(transitionPosition(partial, { type: "ENTRY_FILL", fill: fill() })), partial);
});
