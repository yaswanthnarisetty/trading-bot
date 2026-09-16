import { orderEconomicsSchema } from "./financialInvariants";
import {
  cancellationStateSchema, knowledgeStateSchema, orderPhaseSchema,
  type CancellationState, type ExecutionScope, type KnowledgeState, type OrderPhase, type OrderSide,
} from "@trading-bot/shared";
import { failure, ownsFill, sameExecutionChain, sameFill, success, validFill, type FillEvidence, type Result } from "./execution";

export interface SubmissionAuthorization extends ExecutionScope {
  orderId: string;
  intentId: string;
  reservationId: string;
  claimId: string;
  evidenceRef: string;
  reservedQuantityUnits: number;
  policyVersion: number;
  executionEpoch: number;
  committed: true;
  expiresAtMs: number;
}
export type BrokerObservationPhase = "SUBMITTED" | "ACKNOWLEDGED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
export interface BrokerStatusEvidence {
  readonly phase: BrokerObservationPhase;
  readonly cumulativeFilledUnits: number;
  readonly evidenceRef: string;
}
export interface OrderState extends ExecutionScope {
  positionId: string;
  intentId: string;
  orderId: string;
  legId: string;
  side: OrderSide;
  phase: OrderPhase;
  knowledge: KnowledgeState;
  cancellation: CancellationState;
  quantityUnits: number;
  filledUnits: number;
  lastObservationVersion: number;
  /** Identity of the last consumed snapshot, independent of subsequent fill-derived phase.
   * A reader restoring this reducer state must restore this evidence with its version.
   */
  lastObservation?: BrokerStatusEvidence;
  /** Pure reducer input assembled from the fill ledger; not an embedded Mongo fill collection. */
  fills: readonly FillEvidence[];
  authorization?: SubmissionAuthorization;
}
export type OrderEvent =
  | { type: "AUTHORIZE"; authorization: SubmissionAuthorization }
  | { type: "CLAIM_SUBMISSION"; nowMs: number; executionEpoch: number; policyVersion: number }
  | { type: "BROKER_OBSERVED"; phase: BrokerObservationPhase;
      cumulativeFilledUnits: number; observationVersion: number; evidenceRef: string }
  | { type: "APPLY_FILL"; fill: FillEvidence }
  | { type: "PROVE_NOT_SENT"; evidenceRef: string; senderQuiesced: true }
  | { type: "OUTCOME_UNKNOWN" }
  | { type: "START_RECONCILIATION" }
  | { type: "RESOLVE_KNOWLEDGE"; evidenceRef: string }
  | { type: "REQUEST_CANCEL" }
  | { type: "DISPATCH_CANCEL"; commandId: string }
  | { type: "CANCEL_API_ACCEPTED" }
  | { type: "CANCEL_REJECTED"; evidenceRef: string }
  | { type: "CANCEL_OUTCOME_UNKNOWN" };

export const knowledgeTransitions = {
  KNOWN: ["UNKNOWN", "RECONCILIATION_REQUIRED"],
  UNKNOWN: ["RECONCILIATION_REQUIRED"], RECONCILIATION_REQUIRED: ["KNOWN", "UNKNOWN"],
} as const satisfies Record<KnowledgeState, readonly KnowledgeState[]>;

export function transitionKnowledge(from: KnowledgeState, to: KnowledgeState, evidenceRef?: string): Result<KnowledgeState> {
  if (!knowledgeStateSchema.safeParse(from).success || !knowledgeStateSchema.safeParse(to).success) return failure("INVALID_STATE", "Unknown knowledge state");
  if (!(knowledgeTransitions[from] as readonly KnowledgeState[]).includes(to)) return failure("ILLEGAL_TRANSITION", `${from} cannot become ${to}`);
  if (to === "KNOWN" && !evidenceRef?.trim()) return failure("EVIDENCE_REQUIRED", "Knowledge requires explicit resolution evidence");
  return success(to);
}

const sent = ["SUBMITTING", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED"] as const;
const isSent = (phase: OrderPhase) => (sent as readonly OrderPhase[]).includes(phase);
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const observationPhases: readonly BrokerObservationPhase[] = ["SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"];

function validAuthorization(state: OrderState, auth: SubmissionAuthorization): boolean {
  return sameExecutionChain(state, auth) && auth.orderId === state.orderId && auth.intentId === state.intentId && auth.committed === true
    && [auth.intentId, auth.reservationId, auth.claimId, auth.evidenceRef].every(s => !!s?.trim())
    && integer(auth.reservedQuantityUnits) && auth.reservedQuantityUnits >= state.quantityUnits
    && integer(auth.executionEpoch) && integer(auth.policyVersion) && integer(auth.expiresAtMs);
}

export function transitionOrder(state: OrderState, event: OrderEvent): Result<OrderState> {
  if (!orderEconomicsSchema.safeParse({ ...state, executionEvidenceRefs: state.fills.map(f => f.fillId) }).success
    || !sameExecutionChain(state) || !orderPhaseSchema.safeParse(state.phase).success
    || !knowledgeStateSchema.safeParse(state.knowledge).success || !cancellationStateSchema.safeParse(state.cancellation).success
    || !integer(state.quantityUnits) || state.quantityUnits === 0 || !integer(state.filledUnits)
    || state.filledUnits > state.quantityUnits || !integer(state.lastObservationVersion)
    || (state.lastObservation !== undefined && (state.lastObservationVersion === 0
      || !observationPhases.includes(state.lastObservation.phase) || !state.lastObservation.evidenceRef?.trim()
      || !integer(state.lastObservation.cumulativeFilledUnits) || state.lastObservation.cumulativeFilledUnits > state.filledUnits))
    || state.fills.some(f => !ownsFill(state, f))
    || new Set(state.fills.map(f => f.fillId)).size !== state.fills.length
    || state.fills.reduce((n, f) => n + f.quantityUnits, 0) !== state.filledUnits
) {
    return failure("INVALID_STATE", "Order state is not supported by its fill ledger");
  }
  const illegal = () => failure("ILLEGAL_TRANSITION", `${event.type} is illegal from ${state.phase}/${state.knowledge}/${state.cancellation}`);
  switch (event.type) {
    case "AUTHORIZE":
      if (state.phase !== "PLANNED" || state.knowledge !== "KNOWN") return illegal();
      if (!validAuthorization(state, event.authorization)) return failure("AUTHORIZATION_REQUIRED", "Authorization is missing, uncommitted or from another execution chain");
      return success({ ...state, phase: "READY", authorization: { ...event.authorization } });
    case "CLAIM_SUBMISSION":
      if (state.phase !== "READY" || state.knowledge !== "KNOWN") return illegal();
      if (!state.authorization || !validAuthorization(state, state.authorization)
        || !integer(event.nowMs) || state.authorization.expiresAtMs <= event.nowMs
        || state.authorization.executionEpoch !== event.executionEpoch || state.authorization.policyVersion !== event.policyVersion) {
        return failure("AUTHORIZATION_REQUIRED", "Valid current committed authorization is required");
      }
      return success({ ...state, phase: "SUBMITTING" });
    case "BROKER_OBSERVED": {
      if (!observationPhases.includes(event.phase)) return illegal();
      if (!event.evidenceRef?.trim()) return failure("EVIDENCE_REQUIRED", "Broker observation requires evidence");
      if (!integer(event.observationVersion) || event.observationVersion === 0 || !integer(event.cumulativeFilledUnits)) return failure("INVALID_STATE", "Invalid broker observation");
      if (event.observationVersion < state.lastObservationVersion) {
        return failure("OBSERVATION_REGRESSION", "An older observation cannot erase confirmed evidence");
      }
      if (event.observationVersion === state.lastObservationVersion) {
        const previous = state.lastObservation;
        if (!previous) return failure("EVIDENCE_REQUIRED", "Restore the last snapshot evidence before replaying its version");
        return previous.phase === event.phase && previous.cumulativeFilledUnits === event.cumulativeFilledUnits
          && previous.evidenceRef === event.evidenceRef ? success(state) : failure("DUPLICATE_CONFLICT", "Conflicting observation version");
      }
      if (event.cumulativeFilledUnits < state.filledUnits) return failure("OBSERVATION_REGRESSION", "Observation cannot erase confirmed fills");
      if (event.cumulativeFilledUnits !== state.filledUnits) return failure("EVIDENCE_REQUIRED", "Ingest missing fills before applying this observation");
      // Status can confirm a fill-derived phase, but cannot create execution quantity.
      if (event.phase === "FILLED" && state.phase !== "FILLED") return illegal();
      if (event.phase === "PARTIALLY_FILLED" && state.phase !== "PARTIALLY_FILLED") return illegal();
      const lastObservation: BrokerStatusEvidence = { phase: event.phase,
        cumulativeFilledUnits: event.cumulativeFilledUnits, evidenceRef: event.evidenceRef };
      if (!isSent(state.phase) && !["FILLED", "CANCELLED", "REJECTED"].includes(state.phase)) return illegal();
      if (["FILLED", "CANCELLED", "REJECTED"].includes(state.phase)) {
        if (event.phase !== state.phase) return illegal();
        return success({ ...state, lastObservationVersion: event.observationVersion, lastObservation });
      }
      // Late HTTP acceptance/acknowledgement cannot regress a partially filled order.
      const phase = state.phase === "PARTIALLY_FILLED" && ["SUBMITTED", "ACKNOWLEDGED"].includes(event.phase)
        ? state.phase : state.phase === "ACKNOWLEDGED" && event.phase === "SUBMITTED" ? state.phase : event.phase;
      return success({ ...state, phase, lastObservationVersion: event.observationVersion, lastObservation,
        cancellation: phase === "CANCELLED" ? "CONFIRMED" : state.cancellation });
    }
    case "APPLY_FILL": {
      if (!ownsFill(state, event.fill)) {
        return failure("EVIDENCE_REQUIRED", "A fill must belong to this order, leg and execution ledger");
      }
      const duplicate = state.fills.find(f => f.fillId === event.fill.fillId);
      if (duplicate) return sameFill(duplicate, event.fill) ? success(state) : failure("DUPLICATE_CONFLICT", "Fill identity reused with different economics");
      if (!isSent(state.phase) && !["CANCELLED", "REJECTED"].includes(state.phase)) return illegal();
      const filledUnits = state.filledUnits + event.fill.quantityUnits;
      if (!integer(filledUnits) || filledUnits > state.quantityUnits) return failure("QUANTITY_INVALID", "Fill exceeds authorized order quantity; quarantine evidence for reconciliation");
      const late = ["CANCELLED", "REJECTED"].includes(state.phase);
      return success({ ...state, filledUnits, fills: [...state.fills, { ...event.fill }],
        phase: filledUnits === state.quantityUnits ? "FILLED" : late ? state.phase : "PARTIALLY_FILLED",
        knowledge: late ? "RECONCILIATION_REQUIRED" : state.knowledge });
    }
    case "PROVE_NOT_SENT":
      if (!["PLANNED", "READY", "SUBMITTING"].includes(state.phase)) return illegal();
      if (!event.evidenceRef?.trim() || event.senderQuiesced !== true || state.filledUnits !== 0) return failure("EVIDENCE_REQUIRED", "Conclusive non-send and sender fencing evidence required");
      return success({ ...state, phase: "NOT_SENT", knowledge: "KNOWN" });
    case "OUTCOME_UNKNOWN":
      if (!isSent(state.phase)) return illegal();
      return success({ ...state, knowledge: "UNKNOWN" });
    case "START_RECONCILIATION": {
      const result = transitionKnowledge(state.knowledge, "RECONCILIATION_REQUIRED");
      return result.ok ? success({ ...state, knowledge: result.value }) : result;
    }
    case "RESOLVE_KNOWLEDGE": {
      const result = transitionKnowledge(state.knowledge, "KNOWN", event.evidenceRef);
      return result.ok ? success({ ...state, knowledge: result.value }) : result;
    }
    case "REQUEST_CANCEL":
      if (!["SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED"].includes(state.phase) || state.knowledge !== "KNOWN") return illegal();
      if (["REQUESTED", "CANCEL_PENDING", "UNKNOWN"].includes(state.cancellation)) return success(state);
      if (state.cancellation !== "NONE" && state.cancellation !== "REJECTED") return illegal();
      return success({ ...state, cancellation: "REQUESTED" });
    case "DISPATCH_CANCEL":
      if (!isSent(state.phase) || state.knowledge !== "KNOWN" || state.cancellation !== "REQUESTED") return illegal();
      if (!event.commandId?.trim()) return failure("AUTHORIZATION_REQUIRED", "Durable cancellation command required");
      return success({ ...state, cancellation: "CANCEL_PENDING" });
    case "CANCEL_API_ACCEPTED":
      return state.cancellation === "CANCEL_PENDING" ? success(state) : illegal();
    case "CANCEL_REJECTED":
      if (!["CANCEL_PENDING", "UNKNOWN"].includes(state.cancellation)) return illegal();
      if (!event.evidenceRef?.trim()) return failure("EVIDENCE_REQUIRED", "Cancellation rejection requires evidence");
      return success({ ...state, cancellation: "REJECTED" });
    case "CANCEL_OUTCOME_UNKNOWN":
      if (state.cancellation !== "CANCEL_PENDING") return illegal();
      return success({ ...state, cancellation: "UNKNOWN", knowledge: "UNKNOWN" });
    default: {
      const exhaustive: never = event;
      return failure("ILLEGAL_TRANSITION", `Unsupported event ${String(exhaustive)}`);
    }
  }
}
