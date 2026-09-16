import { z } from "zod";
import { executionScopeSchema, identifierSchema, nonnegativeMoneyMinorSchema, quantityUnitsSchema, type ExecutionScope } from "@trading-bot/shared";
import {
  brokerOrderRequestSchema, type BrokerAdapter, type BrokerCapabilities, type BrokerCancellationOutcome,
  type BrokerEvidence, type BrokerOrderLookup, type BrokerOrderObservation, type BrokerOrderReference,
  type BrokerOrderRequest, type BrokerReasonCode, type BrokerRejection, type BrokerSubmissionOutcome,
  type BrokerTradeObservation, type Immutable,
} from "./BrokerAdapter";

const fillSchema = z.object({ quantityUnits: quantityUnitsSchema.refine(n => n > 0), priceMinor: nonnegativeMoneyMinorSchema }).strict();
const scenarioSchema = z.object({
  submission: z.enum(["ACCEPTED", "REJECTED", "AMBIGUOUS"]),
  delayedAcknowledgement: z.boolean().default(false),
  initialFills: z.array(fillSchema).default([]),
  steps: z.array(z.discriminatedUnion("kind", [
    fillSchema.extend({ kind: z.literal("FILL") }),
    z.object({ kind: z.literal("ACKNOWLEDGE") }).strict(),
    z.object({ kind: z.literal("CONFIRM_CANCEL") }).strict(),
  ])).default([]),
  cancellation: z.enum(["ACCEPTED", "AMBIGUOUS", "REJECTED"]).default("ACCEPTED"),
}).strict();
export type PaperScenario = Immutable<z.input<typeof scenarioSchema>>;
export interface PaperBrokerDependencies {
  readonly clock: { now(): string };
  readonly ids: { nextId(kind: "ORDER" | "TRADE" | "EVIDENCE"): string };
  readonly scenario: (request: BrokerOrderRequest) => PaperScenario;
}
interface PaperOrder {
  request: BrokerOrderRequest;
  plan: z.output<typeof scenarioSchema>;
  observation: BrokerOrderObservation;
  trades: BrokerTradeObservation[];
  nextStep: number;
  cancellationResult?: BrokerCancellationOutcome;
}
type SubmissionRecord = { fingerprint: string } & (
  | { state: "RESERVED" }
  | { state: "COMMITTED"; result: BrokerSubmissionOutcome }
);
function snapshot<T>(value: T): Immutable<T> {
  const copy: T = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze); Object.freeze(item);
    }
  };
  freeze(copy);
  return copy as Immutable<T>;
}

/** Test-instance simulator. No timers, default clock, network, Mongo or application wiring.
 * THIS IS A PAPER-BROKER GUARANTEE: claim replay is idempotent for this instance only.
 * DO NOT ASSUME KITE HAS EQUIVALENT BROKER-SIDE IDEMPOTENCY.
 */
export class PaperBrokerAdapter implements BrokerAdapter {
  readonly capabilities: BrokerCapabilities = Object.freeze({
    clientCorrelation: true, submissionIdempotency: "DURABLE_CLAIM_ID", cancellation: true,
    orderLookup: true, internalOrderLookup: true, orderListing: true, tradeLookup: true,
    modification: false, streaming: false,
  });
  private readonly scope: Readonly<ExecutionScope>;
  private readonly orders = new Map<string, PaperOrder>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  // All writes share one synchronous guard, including validation/rejection paths.
  // Reads see committed orders only; generated IDs remain consumed on failure.
  private mutationActive = false;
  private readonly internalIds = new Set<string>();
  private readonly generatedIds = new Set<string>();
  private readonly namespace = "PAPER_SIM_V1";

  constructor(scope: Readonly<ExecutionScope>, private readonly dependencies: PaperBrokerDependencies) {
    this.scope = snapshot(executionScopeSchema.parse(scope));
    if (this.scope.executionMode !== "PAPER") throw new Error("MODE_MISMATCH");
  }
  private assertScope(scope: Readonly<ExecutionScope>): void {
    const parsed = executionScopeSchema.safeParse({ accountId: scope.accountId, executionMode: scope.executionMode });
    if (!parsed.success || parsed.data.executionMode !== "PAPER" || parsed.data.accountId !== this.scope.accountId)
      throw new Error("MODE_MISMATCH");
  }
  private id(kind: "ORDER" | "TRADE" | "EVIDENCE"): string {
    const id = identifierSchema.parse(this.dependencies.ids.nextId(kind));
    const key = `${kind}:${id}`;
    if (this.generatedIds.has(key)) throw new Error("DUPLICATE_GENERATED_ID");
    this.generatedIds.add(key); return id;
  }
  private evidence(code?: BrokerReasonCode): BrokerEvidence {
    return snapshot({ source: "PAPER_SIMULATOR" as const, reference: this.id("EVIDENCE"),
      receivedAt: z.string().datetime().parse(this.dependencies.clock.now()),
      ...(code ? { diagnostic: { code } } : {}) });
  }
  private reject(reason: BrokerReasonCode): BrokerRejection {
    return snapshot({ kind: "REJECTED", reason, evidence: this.evidence(reason) });
  }
  private mutate<T>(operation: () => T): T {
    if (this.mutationActive) throw new Error("BROKER_MUTATION_IN_PROGRESS");
    this.mutationActive = true;
    try { return operation(); } finally { this.mutationActive = false; }
  }
  async submitOrder(input: BrokerOrderRequest): Promise<BrokerSubmissionOutcome> {
    return this.mutate(() => {
      const parsed = brokerOrderRequestSchema.safeParse(input);
      if (!parsed.success) return this.reject("INVALID_REQUEST");
      const request = snapshot(parsed.data);
      try { this.assertScope(request); } catch { return this.reject("MODE_MISMATCH"); }
      const fingerprint = JSON.stringify(request);
      const previous = this.submissions.get(request.claimId);
      if (previous?.state === "RESERVED") throw new Error("BROKER_MUTATION_IN_PROGRESS");
      if (previous) return previous.fingerprint === fingerprint ? previous.result : this.reject("DUPLICATE_CONFLICT");
      if (this.internalIds.has(request.orderId)) return this.reject("DUPLICATE_CONFLICT");
      this.submissions.set(request.claimId, { state: "RESERVED", fingerprint });
      this.internalIds.add(request.orderId);
      try {
        const { result, order } = this.materializeSubmission(request);
        if (order) this.orders.set(order.observation.brokerOrderId, order);
        this.submissions.set(request.claimId, { state: "COMMITTED", fingerprint, result });
        return result;
      } catch (error) {
        // Nothing has been published if scenario/dependency evaluation fails. Permit
        // an explicit later retry; consumed generated IDs are deliberately not reused.
        this.submissions.delete(request.claimId);
        this.internalIds.delete(request.orderId);
        throw error;
      }
    });
  }
  private materializeSubmission(request: BrokerOrderRequest): { result: BrokerSubmissionOutcome; order?: PaperOrder } {
    const plan = scenarioSchema.parse(this.dependencies.scenario(request));
    const fills = [...plan.initialFills, ...plan.steps.filter(step => step.kind === "FILL")];
    let total = 0;
    for (const fill of fills) {
      if (fill.quantityUnits > request.quantityUnits - total) throw new Error("SCENARIO_QUANTITY_OVERFLOW");
      total += fill.quantityUnits;
      if (request.limitPriceMinor !== undefined && (request.side === "BUY" ? fill.priceMinor > request.limitPriceMinor : fill.priceMinor < request.limitPriceMinor))
        throw new Error("SCENARIO_LIMIT_VIOLATION");
    }
    if (plan.submission === "REJECTED" && (fills.length || plan.steps.length)) throw new Error("INVALID_REJECTION_SCENARIO");
    if (plan.delayedAcknowledgement && plan.initialFills.length) throw new Error("INVALID_DELAYED_ACK_SCENARIO");
    if (plan.submission === "REJECTED") return { result: this.reject("SCENARIO_REJECTION") };
    const evidence = this.evidence();
    const brokerOrderId = this.id("ORDER");
    const order: PaperOrder = { request, plan, nextStep: 0, trades: [], observation: {
      ...this.scope, brokerNamespace: this.namespace, brokerOrderId, orderId: request.orderId,
      state: plan.delayedAcknowledgement ? "PENDING_ACK" : "OPEN", requestedUnits: request.quantityUnits,
      filledUnits: 0, remainingUnits: request.quantityUnits, cancellation: "NONE", observationVersion: 1,
      brokerTimestamp: evidence.receivedAt, receivedAt: evidence.receivedAt, evidence,
    } };
    for (const fill of plan.initialFills) this.fill(order, fill);
    const result: BrokerSubmissionOutcome = snapshot(plan.submission === "AMBIGUOUS"
      ? { kind: "AMBIGUOUS", boundary: "MAY_HAVE_BEEN_ACCEPTED", evidence }
      : { kind: "ACCEPTED", order: order.observation, evidence });
    return { result, order };
  }
  private find(lookup: BrokerOrderLookup): PaperOrder | undefined {
    this.assertScope(lookup);
    if ("brokerOrderId" in lookup) {
      const brokerOrderId = identifierSchema.parse(lookup.brokerOrderId);
      if (identifierSchema.parse(lookup.brokerNamespace) !== this.namespace) throw new Error("BROKER_NAMESPACE_MISMATCH");
      const orderId = "orderId" in lookup ? identifierSchema.parse(lookup.orderId) : undefined;
      const order = this.orders.get(brokerOrderId);
      if (order && orderId !== undefined && orderId !== order.request.orderId) throw new Error("ORDER_IDENTITY_MISMATCH");
      return order;
    }
    const orderId = identifierSchema.parse(lookup.orderId);
    return [...this.orders.values()].find(order => order.request.orderId === orderId);
  }
  private findReference(reference: BrokerOrderReference): PaperOrder | undefined {
    // Unlike internal lookups, cancellation/trade filters must supply a broker ID.
    return this.find({ ...reference, brokerOrderId: identifierSchema.parse(reference.brokerOrderId) });
  }
  async getOrder(lookup: BrokerOrderLookup): Promise<BrokerOrderObservation | null> {
    const order = this.find(lookup); return order ? snapshot(order.observation) : null;
  }
  async getOrders(scope: Readonly<ExecutionScope>): Promise<readonly BrokerOrderObservation[]> {
    this.assertScope(scope); return snapshot([...this.orders.values()].map(order => order.observation));
  }
  async getTrades(scope: Readonly<ExecutionScope>, reference?: BrokerOrderReference): Promise<readonly BrokerTradeObservation[]> {
    this.assertScope(scope);
    const orders = reference ? [this.findReference(reference)] : [...this.orders.values()];
    return snapshot(orders.flatMap(order => order?.trades ?? []));
  }
  async cancelOrder(reference: BrokerOrderReference): Promise<BrokerCancellationOutcome> {
    return this.mutate(() => {
      // Invalid/cross-ledger lookup throws before touching any simulated order.
      const existing = this.findReference(reference);
      const order = existing ? structuredClone(existing) : undefined;
      if (!order) return this.reject("NOT_FOUND");
      if (order.cancellationResult) return snapshot(order.cancellationResult);
      if (["FILLED", "CANCELLED"].includes(order.observation.state)) return this.reject("ORDER_TERMINAL");
      if (order.plan.cancellation === "REJECTED") return this.reject("CANCELLATION_REJECTED");
      const evidence = this.evidence();
      order.cancellationResult = snapshot(order.plan.cancellation === "AMBIGUOUS"
        ? { kind: "AMBIGUOUS", boundary: "MAY_HAVE_BEEN_ACCEPTED", evidence }
        : { kind: "ACCEPTED", cancellation: "REQUESTED", evidence });
      this.observe(order, { cancellation: "REQUESTED" }, evidence);
      this.orders.set(order.observation.brokerOrderId, order);
      return order.cancellationResult;
    });
  }
  /** Simulator control only, deliberately absent from BrokerAdapter. One explicit event per call.
   * Reads never advance scenarios. A CONFIRM_CANCEL step waits for an actual cancel request.
   */
  async advance(lookup: BrokerOrderLookup): Promise<BrokerOrderObservation> {
    return this.mutate(() => {
      const existing = this.find(lookup);
      if (!existing) throw new Error("NOT_FOUND");
      const order = structuredClone(existing);
      const step = order.plan.steps[order.nextStep];
      if (!step) return snapshot(order.observation);
      if (step.kind === "FILL") this.fill(order, step);
      else if (step.kind === "ACKNOWLEDGE") {
        if (order.observation.state !== "PENDING_ACK") throw new Error("INVALID_ACKNOWLEDGEMENT");
        this.observe(order, { state: "OPEN" }, this.evidence());
      } else {
        if (order.observation.cancellation !== "REQUESTED") throw new Error("CANCEL_NOT_REQUESTED");
        this.observe(order, { state: order.observation.state === "FILLED" ? "FILLED" : "CANCELLED", cancellation: "CONFIRMED" }, this.evidence());
      }
      order.nextStep++;
      const result = snapshot(order.observation);
      this.orders.set(order.observation.brokerOrderId, order);
      return result;
    });
  }
  private observe(order: PaperOrder, changes: Partial<BrokerOrderObservation>, evidence: BrokerEvidence): void {
    const observationVersion = quantityUnitsSchema.parse(order.observation.observationVersion + 1);
    order.observation = { ...order.observation, ...changes, observationVersion,
      brokerTimestamp: evidence.receivedAt, receivedAt: evidence.receivedAt, evidence };
  }
  private fill(order: PaperOrder, fill: z.infer<typeof fillSchema>): void {
    if (!["OPEN", "PARTIALLY_FILLED"].includes(order.observation.state)) throw new Error("ORDER_NOT_FILLABLE");
    if (fill.quantityUnits > order.request.quantityUnits - order.observation.filledUnits) throw new Error("SCENARIO_QUANTITY_OVERFLOW");
    const evidence = this.evidence();
    const brokerTradeKey = this.id("TRADE");
    const { orderId, intentId, positionId, legId, contractKey, side } = order.request;
    const trade: BrokerTradeObservation = { ...this.scope, brokerNamespace: this.namespace,
      brokerOrderId: order.observation.brokerOrderId, brokerTradeKey, orderId, intentId, positionId, legId,
      contractKey, side, quantityUnits: fill.quantityUnits, priceMinor: fill.priceMinor,
      executedAt: evidence.receivedAt, receivedAt: evidence.receivedAt, evidence };
    const filledUnits = order.observation.filledUnits + fill.quantityUnits;
    this.observe(order, { filledUnits, remainingUnits: order.request.quantityUnits - filledUnits,
      state: filledUnits === order.request.quantityUnits ? "FILLED" : "PARTIALLY_FILLED" }, evidence);
    order.trades.push(trade);
  }
}
