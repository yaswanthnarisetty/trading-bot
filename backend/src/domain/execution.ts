import {
  executionScopeSchema, moneyMinorSchema, quantityUnitsSchema,
  type ExecutionScope, type ExecutionMode, type OrderSide,
} from "@trading-bot/shared";

export type DomainErrorCode = "ILLEGAL_TRANSITION" | "INVALID_STATE" | "EVIDENCE_REQUIRED"
  | "AUTHORIZATION_REQUIRED" | "MODE_MISMATCH" | "QUANTITY_INVALID" | "OBSERVATION_REGRESSION"
  | "DUPLICATE_CONFLICT" | "EXECUTION_DISABLED";
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: DomainErrorCode; message: string } };
export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (code: DomainErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

export function sameExecutionChain(...records: readonly ExecutionScope[]): boolean {
  return records.length > 0 && records.every(record => executionScopeSchema.safeParse({ accountId: record.accountId, executionMode: record.executionMode }).success
    && record.accountId === records[0].accountId && record.executionMode === records[0].executionMode);
}

/** Capability boundary: Phase 2A has no executor, for ANY execution mode. */
export function executionCapability(_mode: ExecutionMode): Result<never> {
  return failure("EXECUTION_DISABLED", "Phase 2A is a foundation only; no order executor is installed");
}

export function addMinorUnits(left: number, right: number): number {
  moneyMinorSchema.parse(left);
  moneyMinorSchema.parse(right);
  return moneyMinorSchema.parse(left + right);
}

export interface FillEvidence extends ExecutionScope {
  positionId: string;
  intentId: string;
  fillId: string;
  orderId: string;
  legId: string;
  side: OrderSide;
  quantityUnits: number;
  priceMinor: number;
  source: "BROKER_TRADE" | "SIMULATED_FILL";
  evidenceRef: string;
}

export function validFill(scope: ExecutionScope, fill: FillEvidence): boolean {
  return sameExecutionChain(scope, fill) && !!fill.positionId?.trim() && !!fill.intentId?.trim() && !!fill.fillId?.trim() && !!fill.orderId?.trim()
    && !!fill.legId?.trim() && !!fill.evidenceRef?.trim()
    && (fill.side === "BUY" || fill.side === "SELL")
    && quantityUnitsSchema.safeParse(fill.quantityUnits).success && fill.quantityUnits > 0
    && moneyMinorSchema.safeParse(fill.priceMinor).success && fill.priceMinor >= 0
    && ((scope.executionMode === "LIVE" && fill.source === "BROKER_TRADE")
      || (scope.executionMode === "PAPER" && fill.source === "SIMULATED_FILL"));
}

export function sameFill(left: FillEvidence, right: FillEvidence): boolean {
  return sameExecutionChain(left, right) && left.fillId === right.fillId && left.orderId === right.orderId
    && left.positionId === right.positionId && left.intentId === right.intentId
    && left.legId === right.legId && left.side === right.side && left.quantityUnits === right.quantityUnits
    && left.priceMinor === right.priceMinor && left.source === right.source && left.evidenceRef === right.evidenceRef;
}

/** Qualified order ownership supplied by the same-ledger reader, never inferred from a leg name. */
export interface ExecutionOrderIdentity extends ExecutionScope {
  orderId: string; positionId: string; intentId: string; legId: string; side: OrderSide;
}
export function ownsFill(order: ExecutionOrderIdentity, fill: FillEvidence): boolean {
  return validFill(order, fill) && order.orderId === fill.orderId && order.positionId === fill.positionId
    && order.intentId === fill.intentId && order.legId === fill.legId && order.side === fill.side;
}
