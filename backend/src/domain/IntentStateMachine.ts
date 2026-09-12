import { type IntentState, intentStateSchema } from "@trading-bot/shared";
import { failure, success, type Result } from "./execution";

export const intentTransitions = {
  CREATED: ["RISK_PENDING", "ABORTED"],
  RISK_PENDING: ["RISK_RESERVED", "BLOCKED", "ABORTED"],
  RISK_RESERVED: ["EXECUTING", "ABORTED"],
  EXECUTING: ["COMPLETED", "ABORTING"],
  ABORTING: ["ABORTED"], COMPLETED: [], BLOCKED: [], ABORTED: [],
} as const satisfies Record<IntentState, readonly IntentState[]>;

export interface IntentEvidence {
  reservationId?: string;
  submissionClaimId?: string;
  evidenceRefs?: readonly string[];
  targetAchieved?: boolean;
  noPotentiallyExecutingChildren?: boolean;
}

export function transitionIntent(from: IntentState, to: IntentState, evidence: IntentEvidence = {}): Result<IntentState> {
  if (!intentStateSchema.safeParse(from).success || !intentStateSchema.safeParse(to).success) return failure("INVALID_STATE", "Unknown intent state");
  if (!(intentTransitions[from] as readonly IntentState[]).includes(to)) return failure("ILLEGAL_TRANSITION", `${from} cannot become ${to}`);
  if (to === "RISK_RESERVED" && !evidence.reservationId?.trim()) return failure("AUTHORIZATION_REQUIRED", "A committed reservation is required");
  if (to === "EXECUTING" && !evidence.submissionClaimId?.trim()) return failure("AUTHORIZATION_REQUIRED", "A durable submission claim is required");
  if ((to === "COMPLETED" || to === "ABORTED") && (!evidence.noPotentiallyExecutingChildren
    || !evidence.evidenceRefs?.length || evidence.evidenceRefs.some(ref => !ref.trim()))) {
    return failure("EVIDENCE_REQUIRED", "Terminal intent requires child-finality evidence");
  }
  if (to === "COMPLETED" && !evidence.targetAchieved) return failure("EVIDENCE_REQUIRED", "Intent target is not proven complete");
  return success(to);
}
