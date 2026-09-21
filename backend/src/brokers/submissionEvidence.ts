import { createHash } from "node:crypto";
import { z } from "zod";
import { identifierSchema, quantityUnitsSchema, nonnegativeMoneyMinorSchema } from "@trading-bot/shared";
import { brokerOrderRequestSchema, type BrokerOrderRequest } from "./BrokerAdapter";

const evidence = z.object({ source: z.literal("PAPER_SIMULATOR"), reference: identifierSchema,
  receivedAt: z.string().datetime(), diagnostic: z.object({ code: z.enum(["INVALID_REQUEST", "MODE_MISMATCH", "DUPLICATE_CONFLICT",
    "SCENARIO_REJECTION", "NOT_FOUND", "ORDER_TERMINAL", "CANCELLATION_REJECTED"]), httpStatus: z.number().int().optional() }).strict().optional(),
  rawEvidenceRef: identifierSchema.optional() }).strict();
const identity = { accountId: identifierSchema, executionMode: z.literal("PAPER"), brokerNamespace: identifierSchema,
  brokerOrderId: identifierSchema, orderId: identifierSchema };
export const paperOrderObservationSchema = z.object({ ...identity,
  state: z.enum(["PENDING_ACK", "OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED"]), requestedUnits: quantityUnitsSchema,
  filledUnits: quantityUnitsSchema, remainingUnits: quantityUnitsSchema.nullable(), cancellation: z.enum(["NONE", "REQUESTED", "CONFIRMED"]),
  brokerTimestamp: z.string().datetime().nullable(), receivedAt: z.string().datetime(),
  observationVersion: quantityUnitsSchema.refine(n => n > 0), evidence }).strict();
export const paperTradeObservationSchema = z.object({ ...identity, brokerTradeKey: identifierSchema, intentId: identifierSchema, positionId: identifierSchema,
  legId: identifierSchema, contractKey: identifierSchema, side: z.enum(["BUY", "SELL"]), quantityUnits: quantityUnitsSchema.refine(n => n > 0),
  priceMinor: nonnegativeMoneyMinorSchema, executedAt: z.string().datetime(), receivedAt: z.string().datetime(), evidence }).strict();
export const paperSubmissionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ACCEPTED"), order: paperOrderObservationSchema, evidence }).strict(),
  z.object({ kind: z.literal("REJECTED"), reason: identifierSchema, evidence }).strict(),
  z.object({ kind: z.literal("AMBIGUOUS"), boundary: z.literal("MAY_HAVE_BEEN_ACCEPTED"), evidence }).strict(),
]);
export const submissionEvidenceSchema = z.object({ outcome: paperSubmissionOutcomeSchema,
  observedOrder: paperOrderObservationSchema.optional(), trades: z.array(paperTradeObservationSchema), evidenceComplete: z.boolean(),
  pendingFillProcessing: z.boolean() }).strict();
export type SubmissionEvidence = z.infer<typeof submissionEvidenceSchema>;

/** Authorization fingerprint excludes only the later claim ID; economic/ownership fields are canonical. */
export function submissionFingerprint(input: BrokerOrderRequest): string {
  const { claimId: _, ...authorized } = brokerOrderRequestSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(authorized)).digest("hex");
}
export function validateSubmissionEvidence(request: BrokerOrderRequest, input: unknown): SubmissionEvidence {
  const result = submissionEvidenceSchema.parse(input);
  const observations = [result.observedOrder, result.outcome.kind === "ACCEPTED" ? result.outcome.order : undefined].filter(o => o !== undefined);
  for (const observation of observations) {
    if (observation.accountId !== request.accountId || observation.orderId !== request.orderId
      || observation.brokerNamespace !== "PAPER_SIM_V1" || observation.requestedUnits !== request.quantityUnits
      || observation.filledUnits > request.quantityUnits || observation.remainingUnits !== request.quantityUnits - observation.filledUnits)
      throw new Error("BROKER_EVIDENCE_MISMATCH");
  }
  if (result.outcome.kind === "ACCEPTED" && result.observedOrder
    && result.outcome.order.brokerOrderId !== result.observedOrder.brokerOrderId) throw new Error("BROKER_IDENTITY_MISMATCH");
  if (result.outcome.kind === "REJECTED" && (result.observedOrder || result.trades.length)) throw new Error("REJECTION_WITH_EXECUTION_EVIDENCE");
  let total = 0;
  const seen = new Set<string>();
  for (const t of result.trades) {
    for (const key of ["accountId", "executionMode", "orderId", "intentId", "positionId", "legId", "contractKey", "side"] as const)
      if (t[key] !== request[key]) throw new Error("BROKER_TRADE_OWNERSHIP_MISMATCH");
    if (!result.observedOrder || t.brokerNamespace !== result.observedOrder.brokerNamespace || t.brokerOrderId !== result.observedOrder.brokerOrderId
      || seen.has(t.brokerTradeKey) || t.quantityUnits > request.quantityUnits - total) throw new Error("BROKER_TRADE_IDENTITY_OR_QUANTITY_MISMATCH");
    if (request.limitPriceMinor !== undefined && (request.side === "BUY" ? t.priceMinor > request.limitPriceMinor : t.priceMinor < request.limitPriceMinor))
      throw new Error("BROKER_TRADE_PRICE_MISMATCH");
    seen.add(t.brokerTradeKey); total += t.quantityUnits;
  }
  if (result.evidenceComplete && result.observedOrder && total !== result.observedOrder.filledUnits) throw new Error("INCOMPLETE_TRADE_EVIDENCE");
  if (result.pendingFillProcessing !== (total > 0 || observations.some(o => o.filledUnits > 0))) throw new Error("PENDING_FILL_FLAG_MISMATCH");
  return result;
}
