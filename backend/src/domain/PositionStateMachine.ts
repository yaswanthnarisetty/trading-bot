import { positionEconomicsSchema } from "./financialInvariants";
import { positionIntegritySchema, positionLifecycleSchema, type ExecutionScope, type OrderSide, type PositionIntegrity, type PositionLifecycle } from "@trading-bot/shared";
import { failure, ownsFill, sameExecutionChain, sameFill, success, validFill, type ExecutionOrderIdentity, type FillEvidence, type Result } from "./execution";

export interface PositionLegState {
  legId: string;
  entrySide: OrderSide;
  targetUnits: number;
  entryFilledUnits: number;
  exitFilledUnits: number;
}
export interface PositionState extends ExecutionScope {
  positionId: string;
  entryIntentId: string;
  orders: readonly ExecutionOrderIdentity[];
  closureEvidenceRefs: readonly string[];
  potentiallyExecutingOrderCount: number;
  lifecycle: PositionLifecycle;
  integrity: PositionIntegrity;
  activeCloseIntentId: string | null;
  legs: readonly PositionLegState[];
  /** Evidence supplied from the fill ledger, not an unbounded embedded Mongo array. */
  fills: readonly FillEvidence[];
}
export type PositionEvent =
  | { type: "ENTRY_FILL" | "EXIT_FILL"; fill: FillEvidence }
  | { type: "REQUEST_CLOSE"; closeIntentId: string }
  | { type: "CONFIRM_CLOSED" | "ABORT_ENTRY"; noPotentiallyExecutingOrders: true; evidenceRefs: readonly string[] }
  | { type: "MARK_INCONSISTENT" }
  | { type: "RESTORE_INTEGRITY"; evidenceRefs: readonly string[] };

const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const hasEvidence = (refs: readonly string[]) => refs.length > 0 && refs.every(ref => !!ref?.trim());

export function transitionPosition(state: PositionState, event: PositionEvent): Result<PositionState> {
  if (!positionEconomicsSchema.safeParse({ ...state, executionEvidenceRefs: state.fills.map(f => f.fillId) }).success
    || !sameExecutionChain(state) || !positionLifecycleSchema.safeParse(state.lifecycle).success
    || !positionIntegritySchema.safeParse(state.integrity).success || state.legs.length === 0
    || new Set(state.legs.map(l => l.legId)).size !== state.legs.length
    || new Set(state.fills.map(f => f.fillId)).size !== state.fills.length
    || state.fills.some(f => f.positionId !== state.positionId || !state.orders.some(o => ownsFill(o, f))
      || !state.legs.some(l => l.legId === f.legId && ((f.side === l.entrySide) === (f.intentId === state.entryIntentId))))
    || state.legs.some(l => !l.legId.trim() || !["BUY", "SELL"].includes(l.entrySide)
      || !integer(l.targetUnits) || l.targetUnits === 0 || !integer(l.entryFilledUnits) || !integer(l.exitFilledUnits)
      || l.exitFilledUnits > l.entryFilledUnits || l.entryFilledUnits > l.targetUnits
      || state.fills.filter(f => f.legId === l.legId && f.side === l.entrySide).reduce((n, f) => n + f.quantityUnits, 0) !== l.entryFilledUnits
      || state.fills.filter(f => f.legId === l.legId && f.side !== l.entrySide).reduce((n, f) => n + f.quantityUnits, 0) !== l.exitFilledUnits)
) {
    return failure("INVALID_STATE", "Position quantities must be supported by its fill ledger");
  }
  const illegal = () => failure("ILLEGAL_TRANSITION", `${event.type} is illegal from ${state.lifecycle}`);
  switch (event.type) {
    case "ENTRY_FILL":
    case "EXIT_FILL": {
      if (!validFill(state, event.fill) || event.fill.positionId !== state.positionId || !state.orders.some(o => ownsFill(o, event.fill))) return failure("EVIDENCE_REQUIRED", "Position requires qualified fill evidence from the same ledger");
      const duplicate = state.fills.find(f => f.fillId === event.fill.fillId);
      if (duplicate) return sameFill(duplicate, event.fill) ? success(state) : failure("DUPLICATE_CONFLICT", "Conflicting fill identity");
      if (["CLOSED", "ABORTED"].includes(state.lifecycle)) return illegal();
      const leg = state.legs.find(l => l.legId === event.fill.legId);
      if (!leg) return failure("INVALID_STATE", "Unknown position leg");
      const entry = event.type === "ENTRY_FILL";
      if (event.fill.intentId !== (entry ? state.entryIntentId : state.activeCloseIntentId)) return failure("EVIDENCE_REQUIRED", "Fill intent does not own this operation");
      if ((event.fill.side === leg.entrySide) !== entry) return failure("EVIDENCE_REQUIRED", "Fill side does not match the operation");
      if (!entry && !state.activeCloseIntentId) return failure("AUTHORIZATION_REQUIRED", "A close intent is required");
      const updated = { ...leg, entryFilledUnits: leg.entryFilledUnits + (entry ? event.fill.quantityUnits : 0),
        exitFilledUnits: leg.exitFilledUnits + (entry ? 0 : event.fill.quantityUnits) };
      if (!integer(updated.entryFilledUnits) || !integer(updated.exitFilledUnits)
        || updated.entryFilledUnits > updated.targetUnits || updated.exitFilledUnits > updated.entryFilledUnits) {
        return failure("QUANTITY_INVALID", "Fill exceeds authorized or closable quantity; quarantine for reconciliation");
      }
      const legs = state.legs.map(l => l.legId === leg.legId ? updated : { ...l });
      const lifecycle: PositionLifecycle = state.activeCloseIntentId
        ? legs.some(l => l.exitFilledUnits > 0) ? "PARTIALLY_CLOSING" : "CLOSING"
        : legs.every(l => l.entryFilledUnits === l.targetUnits) ? "OPEN" : "PARTIALLY_OPENED";
      return success({ ...state, legs, lifecycle, fills: [...state.fills, { ...event.fill }],
        integrity: entry && state.activeCloseIntentId ? "RECONCILIATION_REQUIRED" : state.integrity });
    }
    case "REQUEST_CLOSE":
      if (!event.closeIntentId?.trim()) return failure("AUTHORIZATION_REQUIRED", "Close intent identity required");
      if (state.lifecycle === "CLOSED" || state.activeCloseIntentId) return success(state);
      if (!["OPEN", "PARTIALLY_OPENED"].includes(state.lifecycle)) return illegal();
      if (state.integrity !== "CONSISTENT") return failure("EVIDENCE_REQUIRED", "Resolve position integrity before sizing a close");
      return success({ ...state, lifecycle: "CLOSING", activeCloseIntentId: event.closeIntentId });
    case "CONFIRM_CLOSED":
      if (!["CLOSING", "PARTIALLY_CLOSING"].includes(state.lifecycle)) return illegal();
      if (state.integrity !== "CONSISTENT" || event.noPotentiallyExecutingOrders !== true || !hasEvidence(event.evidenceRefs)
        || !state.activeCloseIntentId || state.legs.some(l => l.entryFilledUnits !== l.exitFilledUnits)) {
        return failure("EVIDENCE_REQUIRED", "Closure requires evidenced flat legs, consistent state and no reopening orders");
      }
      return success({ ...state, lifecycle: "CLOSED", activeCloseIntentId: null, closureEvidenceRefs: [...event.evidenceRefs], potentiallyExecutingOrderCount: 0 });
    case "ABORT_ENTRY":
      if (state.lifecycle !== "PENDING_ENTRY") return illegal();
      if (event.noPotentiallyExecutingOrders !== true || !hasEvidence(event.evidenceRefs) || state.fills.length > 0) {
        return failure("EVIDENCE_REQUIRED", "Only a conclusively unfilled entry may be aborted");
      }
      return success({ ...state, lifecycle: "ABORTED", closureEvidenceRefs: [...event.evidenceRefs], potentiallyExecutingOrderCount: 0 });
    case "MARK_INCONSISTENT":
      return success({ ...state, integrity: "RECONCILIATION_REQUIRED" });
    case "RESTORE_INTEGRITY":
      if (!hasEvidence(event.evidenceRefs)) return failure("EVIDENCE_REQUIRED", "Integrity restoration requires reconciliation evidence");
      return success({ ...state, integrity: "CONSISTENT" });
    default: {
      const exhaustive: never = event;
      return failure("ILLEGAL_TRANSITION", `Unsupported position event ${String(exhaustive)}`);
    }
  }
}
