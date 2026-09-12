import type { ExecutionScope } from "@trading-bot/shared";
import type { FillEvidence, Result } from "../src/domain/execution";
import type { OrderState, SubmissionAuthorization } from "../src/domain/OrderStateMachine";
import type { PositionState } from "../src/domain/PositionStateMachine";
import assert from "node:assert/strict";

export const scope: ExecutionScope = { accountId: "PAPER:test-account", executionMode: "PAPER" };
export const now = new Date("2026-09-11T04:00:00.000Z");
export const base = (customScope = scope) => ({ ...customScope, schemaVersion: 1, correlationId: "trade-1", createdAt: now });
export const mutable = (customScope = scope) => ({ ...base(customScope), version: 0, updatedAt: now });
export const account = (accountId = scope.accountId) => ({ ...mutable({ ...scope, accountId }), broker: "PAPER", brokerAccountRef: accountId,
  currency: "INR", admissionStatus: "DISABLED", policyVersion: 1, executionEpoch: 1,
  reservedMarginMinor: 0, reservedExposureMinor: 0, committedExposureMinor: 0, realizedPnlMinor: 0,
  positionSlots: 0, nextEventSequence: 1 });
export const signal = (id = "signal-1") => ({ ...base(), signalId: id, decisionKey: "bar-1", strategyInstanceId: "strategy-1",
  strategyVersion: "v1", decisionSlot: "2026-09-11T04:00Z", sessionId: "session-1", strategy: "BULL_PUT_SPREAD",
  decisionEvidenceRefs: ["decision-1"], expiresAt: new Date("2026-09-11T04:01:00.000Z") });
export const intent = (id = "intent-1") => ({ ...mutable(), intentId: id, commandKey: id, purpose: "ENTRY", signalId: "signal-1",
  state: "CREATED", targetLegs: [{ legId: "hedge", contractKey: "NFO:contract-1", side: "BUY", targetUnits: 10 }],
  closeGeneration: 0, policyVersion: 1, deadline: now });
export const reservation = (id = "reservation-1") => ({ ...mutable(), reservationId: id, intentId: "intent-1", strategyInstanceId: "strategy-1",
  instrumentKeys: ["contract-1"], state: "HELD", initialMarginMinor: 10000, initialExposureMinor: 5000,
  remainingMarginMinor: 10000, remainingExposureMinor: 5000, positionSlots: 1, policyVersion: 1 });
export const brokerOrder = (id = "order-1") => ({ ...mutable(), orderId: id, positionId: "position-1", intentId: "intent-1", legId: "hedge", sliceId: "slice-1",
  generation: 0, contractKey: "NFO:contract-1", side: "BUY", quantityUnits: 10, limitPriceMinor: 1000,
  requestFingerprint: "request-hash", brokerNamespace: "paper-v1", phase: "PLANNED", knowledge: "KNOWN", cancellation: "NONE",
  filledUnits: 0, lastObservationVersion: 0 });
export const fillRecord = (id = "fill-1") => ({ ...base(), fillId: id, orderId: "order-1", intentId: "intent-1", positionId: "position-1",
  legId: "hedge", broker: "PAPER", brokerNamespace: "paper-v1", brokerTradeKey: "trade-1", brokerOrderId: "broker-order-1",
  contractKey: "NFO:contract-1", side: "BUY", quantityUnits: 5, priceMinor: 1000, evidenceRef: "simulated-execution-1", executedAt: now });
export const position = (id = "position-1") => ({ ...mutable(), positionId: id, entryIntentId: "intent-1", strategyInstanceId: "strategy-1",
  sessionId: "session-1", lifecycle: "PENDING_ENTRY", integrity: "CONSISTENT", activeCloseIntentId: null, closeGeneration: 0,
  legs: [{ legId: "hedge", contractKey: "NFO:contract-1", entrySide: "BUY", targetUnits: 10, entryFilledUnits: 0, exitFilledUnits: 0,
    closeHeldUnits: 0, realizedPnlMinor: 0 }], realizedPnlMinor: 0, potentiallyExecutingOrderCount: 0 });
export const eventRecord = (id = "event-1", sequence = 1) => ({ ...base(), eventId: id, accountSequence: sequence,
  tradingDate: "2026-09-11", eventType: "INTENT_CREATED", aggregateType: "OrderIntent", aggregateId: "intent-1", aggregateVersion: 0,
  causationId: "command-1", actor: "test", occurredAt: now, recordedAt: now, reason: "command_received", evidenceRefs: [],
  payload: { kind: "REFERENCE", entityId: "intent-1" } });

export const orderState = (): OrderState => ({ ...scope, positionId: "position-1", intentId: "intent-1", orderId: "order-1", legId: "hedge", side: "BUY", phase: "PLANNED",
  knowledge: "KNOWN", cancellation: "NONE", quantityUnits: 10, filledUnits: 0, fills: [], lastObservationVersion: 0 });
export const authorization = (): SubmissionAuthorization => ({ ...scope, orderId: "order-1", intentId: "intent-1", reservationId: "reservation-1",
  claimId: "claim-1", evidenceRef: "committed-reservation", reservedQuantityUnits: 10, policyVersion: 1, executionEpoch: 1,
  committed: true, expiresAtMs: 2000 });
export const fill = (fillId = "fill-1", quantityUnits = 5): FillEvidence => ({ ...scope, positionId: "position-1", intentId: "intent-1", fillId, quantityUnits,
  orderId: "order-1", legId: "hedge", side: "BUY", priceMinor: 1000, source: "SIMULATED_FILL", evidenceRef: fillId });
export const positionState = (): PositionState => ({ ...scope, positionId: "position-1", entryIntentId: "intent-1",
  closureEvidenceRefs: [], potentiallyExecutingOrderCount: 0,
  orders: [
    { ...scope, positionId: "position-1", intentId: "intent-1", orderId: "order-1", legId: "hedge", side: "BUY" },
    { ...scope, positionId: "position-1", intentId: "intent-1", orderId: "short-order", legId: "short", side: "SELL" },
    { ...scope, positionId: "position-1", intentId: "close-1", orderId: "close-order-1", legId: "short", side: "BUY" },
    { ...scope, positionId: "position-1", intentId: "close-1", orderId: "close-order-2", legId: "hedge", side: "SELL" },
  ], lifecycle: "PENDING_ENTRY", integrity: "CONSISTENT",
  activeCloseIntentId: null, fills: [], legs: [
    { legId: "hedge", entrySide: "BUY", targetUnits: 10, entryFilledUnits: 0, exitFilledUnits: 0 },
    { legId: "short", entrySide: "SELL", targetUnits: 10, entryFilledUnits: 0, exitFilledUnits: 0 },
  ] });
export function value<T>(result: Result<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
