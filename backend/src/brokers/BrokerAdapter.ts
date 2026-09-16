import { z } from "zod";
import {
  executionModeSchema, executionScopeSchema, identifierSchema, nonnegativeMoneyMinorSchema,
  orderSideSchema, quantityUnitsSchema, type ExecutionScope,
} from "@trading-bot/shared";

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** One physical order. claimId is BrokerOrder.submissionClaim.claimId, not an intent ID.
 * Prices are INR paise; quantities are integer contract units, never lots.
 */
export const brokerOrderRequestSchema = z.object({
  accountId: identifierSchema, executionMode: executionModeSchema,
  orderId: identifierSchema, claimId: identifierSchema, intentId: identifierSchema,
  positionId: identifierSchema, legId: identifierSchema, contractKey: identifierSchema,
  side: orderSideSchema, quantityUnits: quantityUnitsSchema.refine(n => n > 0),
  orderType: z.enum(["MARKET", "LIMIT"]), limitPriceMinor: nonnegativeMoneyMinorSchema.optional(),
  product: identifierSchema, correlationTag: identifierSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (!executionScopeSchema.safeParse({ accountId: request.accountId, executionMode: request.executionMode }).success)
    ctx.addIssue({ code: "custom", message: "Invalid execution scope" });
  if ((request.orderType === "LIMIT") !== (request.limitPriceMinor !== undefined))
    ctx.addIssue({ code: "custom", message: "Only LIMIT orders require a limit price" });
});
export type BrokerOrderRequest = Immutable<z.infer<typeof brokerOrderRequestSchema>>;
export type BrokerOrderReference = Readonly<ExecutionScope & { brokerNamespace: string; brokerOrderId: string }>;
/** Internal lookup is capability-dependent; it is not a promise about Kite. */
// Paper canonicalizes supported identifiers (trim) at submission and query boundaries.
export type BrokerOrderLookup = BrokerOrderReference | Readonly<ExecutionScope & { orderId: string }>;

export interface BrokerCapabilities {
  readonly clientCorrelation: boolean;
  readonly submissionIdempotency: "DURABLE_CLAIM_ID" | "NONE" | "NOT_VERIFIED";
  readonly cancellation: boolean;
  readonly orderLookup: boolean;
  readonly internalOrderLookup: boolean;
  readonly orderListing: boolean;
  readonly tradeLookup: boolean;
  readonly modification: boolean;
  readonly streaming: boolean;
}
export type BrokerReasonCode = "INVALID_REQUEST" | "MODE_MISMATCH" | "DUPLICATE_CONFLICT"
  | "SCENARIO_REJECTION" | "NOT_FOUND" | "ORDER_TERMINAL" | "CANCELLATION_REJECTED";
/** Never store arbitrary HTTP bodies, headers or errors here. rawEvidenceRef, if present,
 * identifies separately sanitized evidence; it must not contain a URL/token/credential.
 */
export interface BrokerEvidence {
  readonly source: "PAPER_SIMULATOR" | "BROKER";
  readonly reference: string;
  readonly receivedAt: string;
  readonly diagnostic?: Readonly<{ code: BrokerReasonCode; httpStatus?: number }>;
  readonly rawEvidenceRef?: string;
}
export interface BrokerOrderObservation extends BrokerOrderReference {
  readonly orderId: string;
  readonly state: "PENDING_ACK" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
  readonly requestedUnits: number;
  readonly filledUnits: number;
  /** Unfilled quantity, including a cancelled remainder; not an executable-quantity promise. */
  readonly remainingUnits: number | null;
  readonly cancellation: "NONE" | "REQUESTED" | "CONFIRMED";
  readonly brokerTimestamp: string | null;
  readonly receivedAt: string;
  /** Per-order adapter observation sequence: 0 is reserved for the ledger's initial
   * "no observation applied" state. First observation is 1; subsequent changes increase
   * it. Snapshots may skip intermediate versions (e.g. initial fills before the receipt).
   * Repeated reads retain their version. This is not a native Kite sequence claim.
   */
  readonly observationVersion: number;
  readonly evidence: BrokerEvidence;
}
export interface BrokerTradeObservation extends BrokerOrderReference {
  readonly brokerTradeKey: string;
  readonly orderId: string;
  readonly intentId: string;
  readonly positionId: string;
  readonly legId: string;
  readonly contractKey: string;
  readonly side: BrokerOrderRequest["side"];
  readonly quantityUnits: number;
  readonly priceMinor: number;
  readonly executedAt: string;
  readonly receivedAt: string;
  readonly evidence: BrokerEvidence;
}
export type BrokerRejection = Readonly<{ kind: "REJECTED"; reason: BrokerReasonCode; evidence: BrokerEvidence }>;
export type BrokerAmbiguity = Readonly<{
  kind: "AMBIGUOUS"; boundary: "MAY_HAVE_BEEN_ACCEPTED"; evidence: BrokerEvidence;
}>;
export type BrokerSubmissionOutcome = Readonly<{ kind: "ACCEPTED"; order: BrokerOrderObservation; evidence: BrokerEvidence }>
  | BrokerRejection | BrokerAmbiguity;
export type BrokerCancellationOutcome = Readonly<{ kind: "ACCEPTED"; cancellation: "REQUESTED"; evidence: BrokerEvidence }>
  | BrokerRejection | BrokerAmbiguity;

/** Evidence boundary only: no ledger writes, position mutation, retries or reconciliation.
 * All Kite capabilities and identifier semantics: NOT VERIFIED FROM BROKER CONTRACT.
 */
export interface BrokerAdapter {
  readonly capabilities: BrokerCapabilities;
  /** Paper rejects synchronous nested mutations (submit/cancel/advance) with local
   * BROKER_MUTATION_IN_PROGRESS,
   * not a broker REJECTED/AMBIGUOUS receipt. No implicit retry or waiting is performed.
   */
  submitOrder(request: BrokerOrderRequest): Promise<BrokerSubmissionOutcome>;
  cancelOrder(order: BrokerOrderReference): Promise<BrokerCancellationOutcome>;
  getOrder(order: BrokerOrderLookup): Promise<BrokerOrderObservation | null>;
  getOrders(scope: Readonly<ExecutionScope>): Promise<readonly BrokerOrderObservation[]>;
  getTrades(scope: Readonly<ExecutionScope>, order?: BrokerOrderReference): Promise<readonly BrokerTradeObservation[]>;
}
