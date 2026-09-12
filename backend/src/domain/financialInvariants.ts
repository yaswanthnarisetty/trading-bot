import { z } from "zod";
import { cancellationStateSchema, identifierSchema, knowledgeStateSchema, orderPhaseSchema,
  positionIntegritySchema, positionLifecycleSchema, quantityUnitsSchema, orderSideSchema } from "@trading-bot/shared";

export const evidenceRefsSchema = z.array(identifierSchema).refine(refs => new Set(refs).size === refs.length, "Duplicate evidence");
export const orderEconomicsSchema = z.object({
  phase: orderPhaseSchema, knowledge: knowledgeStateSchema, cancellation: cancellationStateSchema,
  quantityUnits: quantityUnitsSchema.refine(n => n > 0), filledUnits: quantityUnitsSchema,
  executionEvidenceRefs: evidenceRefsSchema,
}).superRefine((s, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  if (s.filledUnits > s.quantityUnits) reject("Overfilled order");
  if (["PLANNED", "READY", "SUBMITTING", "SUBMITTED", "ACKNOWLEDGED", "NOT_SENT"].includes(s.phase) && s.filledUnits !== 0) reject("Pre-fill phase has execution quantity");
  if (s.phase === "PARTIALLY_FILLED" && !(s.filledUnits > 0 && s.filledUnits < s.quantityUnits)) reject("Partial phase requires partial execution");
  if (s.phase === "FILLED" && s.filledUnits !== s.quantityUnits) reject("FILLED requires full execution");
  if ((s.filledUnits > 0) !== (s.executionEvidenceRefs.length > 0)) reject("Execution quantity requires fill identities, and vice versa");
  if (["PLANNED", "READY", "NOT_SENT"].includes(s.phase) && s.cancellation !== "NONE") reject("Unsent order cannot have cancellation activity");
  if (s.cancellation === "CONFIRMED" && !["CANCELLED", "FILLED"].includes(s.phase)) reject("Cancellation confirmation contradicts phase");
  if (s.phase === "CANCELLED" && s.cancellation !== "CONFIRMED") reject("CANCELLED requires confirmation");
});

export const positionLegEconomicsSchema = z.object({
  legId: identifierSchema, entrySide: orderSideSchema, targetUnits: quantityUnitsSchema.refine(n => n > 0),
  entryFilledUnits: quantityUnitsSchema, exitFilledUnits: quantityUnitsSchema,
  closeHeldUnits: quantityUnitsSchema.default(0),
});
export const positionEconomicsSchema = z.object({
  lifecycle: positionLifecycleSchema, integrity: positionIntegritySchema,
  activeCloseIntentId: identifierSchema.nullable(), legs: z.array(positionLegEconomicsSchema).min(1),
  executionEvidenceRefs: evidenceRefsSchema, closureEvidenceRefs: evidenceRefsSchema,
  potentiallyExecutingOrderCount: quantityUnitsSchema,
}).superRefine((s, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  const acquired = s.legs.some(l => l.entryFilledUnits > 0);
  const exited = s.legs.some(l => l.exitFilledUnits > 0);
  const full = s.legs.every(l => l.entryFilledUnits === l.targetUnits);
  const flat = s.legs.every(l => l.entryFilledUnits === l.exitFilledUnits && l.closeHeldUnits === 0);
  if (new Set(s.legs.map(l => l.legId)).size !== s.legs.length) reject("Duplicate position legs");
  if (s.legs.some(l => l.exitFilledUnits > l.entryFilledUnits || l.entryFilledUnits > l.targetUnits || l.closeHeldUnits > l.entryFilledUnits - l.exitFilledUnits)) reject("Contradictory leg quantities");
  if (acquired !== (s.executionEvidenceRefs.length > 0)) reject("Exposure requires fill identities, and vice versa");
  if (["PENDING_ENTRY", "ABORTED"].includes(s.lifecycle) && (acquired || s.activeCloseIntentId !== null)) reject("Unopened position cannot have exposure or a close intent");
  if (s.lifecycle === "OPEN" && (!full || exited || s.activeCloseIntentId !== null)) reject("OPEN requires fully acquired, unclosed legs");
  if (s.lifecycle === "PARTIALLY_OPENED" && (!acquired || full || exited || s.activeCloseIntentId !== null)) reject("Invalid partial entry");
  if (["CLOSING", "PARTIALLY_CLOSING"].includes(s.lifecycle) && (!acquired || !s.activeCloseIntentId)) reject("Closing requires actual exposure and close intent");
  if (s.lifecycle === "CLOSING" && exited) reject("Closing executions require PARTIALLY_CLOSING");
  if (s.lifecycle === "PARTIALLY_CLOSING" && !exited) reject("Partial close requires exit executions");
  if (s.lifecycle === "CLOSED" && (!acquired || !exited || !flat || s.activeCloseIntentId !== null || s.potentiallyExecutingOrderCount !== 0 || !s.closureEvidenceRefs.length)) reject("CLOSED requires acquired exposure, closing fills, flatness and finality evidence");
  if (s.lifecycle === "ABORTED" && (s.potentiallyExecutingOrderCount !== 0 || !s.closureEvidenceRefs.length)) reject("ABORTED requires conclusive zero-exposure finality");
});
