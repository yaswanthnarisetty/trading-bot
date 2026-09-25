import { createHash } from "node:crypto";
import { z } from "zod";
import { identifierSchema, quantityUnitsSchema } from "@trading-bot/shared";

const positive = quantityUnitsSchema.refine(n => n > 0);
export const entryRiskPolicySchema = z.object({
  policyVersion: quantityUnitsSchema,
  maxRiskPerEntryMinor: positive, maxReservedRiskMinor: positive, maxPositionSlots: positive,
}).strict();

/** Qualified immutable execution terms, persisted by the trusted planner, never an
 * authorizeEntry argument or LLM risk estimate. No market-data lookup occurs here.
 */
export const entryPlanSchema = z.object({
  kind: z.literal("BUY_OPTION_LIMIT_V1"), product: z.literal("INTRADAY"), validUntil: z.date(),
  legs: z.array(z.object({
    legId: identifierSchema, contractKey: identifierSchema,
    instrumentKind: z.literal("NSE_OPTION"), optionType: z.enum(["CALL", "PUT"]),
    expiry: z.date(), qualificationRef: identifierSchema,
    lotSizeUnits: positive, tickSizeMinor: positive, limitPriceMinor: positive,
  }).strict()).min(1),
}).strict();
const targetsSchema = z.array(z.object({
  legId: identifierSchema, contractKey: identifierSchema, side: z.enum(["BUY", "SELL"]), targetUnits: positive,
})).min(1);
export type EntryRiskReason = "INVALID_RISK_ECONOMICS" | "UNSUPPORTED_RISK_SHAPE" | "RISK_ARITHMETIC_OVERFLOW"
  | "RISK_PER_TRADE_EXCEEDED" | "RISK_CAPACITY_EXCEEDED" | "POSITION_LIMIT_EXCEEDED"
  | "ACCOUNT_NOT_READY" | "RISK_POLICY_REQUIRED" | "INTENT_NOT_FOUND" | "ENTRY_ONLY"
  | "STALE_EXECUTION_CHAIN" | "RISK_PROJECTION_MISMATCH" | "UNSUPPORTED_ACCOUNT_EXPOSURE";
export class EntryRiskError extends Error {
  constructor(readonly reason: EntryRiskReason) { super(reason); }
}
export function riskAssert(condition: unknown, reason: EntryRiskReason): asserts condition {
  if (!condition) throw new EntryRiskError(reason);
}
export function checkedRiskUnits(value: bigint): number {
  riskAssert(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), "RISK_ARITHMETIC_OVERFLOW");
  return Number(value);
}
export function calculateEntryRisk(targetInput: unknown, planInput: unknown) {
  const targets = targetsSchema.safeParse(targetInput), parsed = entryPlanSchema.safeParse(planInput);
  riskAssert(targets.success, "INVALID_RISK_ECONOMICS");
  riskAssert(targets.data.every(leg => leg.side === "BUY"), "UNSUPPORTED_RISK_SHAPE");
  riskAssert(parsed.success, "INVALID_RISK_ECONOMICS");
  const plan = parsed.data;
  riskAssert(new Set(targets.data.map(l => l.legId)).size === targets.data.length
    && new Set(targets.data.map(l => l.contractKey)).size === targets.data.length
    && new Set(plan.legs.map(l => l.legId)).size === plan.legs.length
    && plan.legs.length === targets.data.length, "INVALID_RISK_ECONOMICS");
  const legs = targets.data.map(target => {
    const terms = plan.legs.find(leg => leg.legId === target.legId);
    riskAssert(terms && terms.contractKey === target.contractKey && terms.contractKey.startsWith("NFO:"), "INVALID_RISK_ECONOMICS");
    riskAssert(BigInt(target.targetUnits) % BigInt(terms.lotSizeUnits) === 0n
      && BigInt(terms.limitPriceMinor) % BigInt(terms.tickSizeMinor) === 0n, "INVALID_RISK_ECONOMICS");
    return { ...terms, side: "BUY" as const, quantityUnits: target.targetUnits };
  }).sort((a, b) => a.legId.localeCompare(b.legId));
  const requiredRiskMinor = checkedRiskUnits(legs.reduce((total, leg) => total + BigInt(leg.quantityUnits) * BigInt(leg.limitPriceMinor), 0n));
  const expiresAt = new Date(Math.min(plan.validUntil.getTime(), ...legs.map(leg => leg.expiry.getTime())));
  const fingerprint = createHash("sha256").update(JSON.stringify({ kind: plan.kind, product: plan.product,
    validUntil: plan.validUntil.toISOString(), legs })).digest("hex");
  return { requiredRiskMinor, fingerprint, legs, product: plan.product, expiresAt };
}

export const entryAdmissionSchema = z.object({
  positionId: identifierSchema, economicsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.literal(0), executionEpoch: quantityUnitsSchema, policyVersion: quantityUnitsSchema,
}).strict();

/** 2C1 retains the full original debit and slot, including after fills/UNKNOWN/close.
 * Release or transfer is deliberately unsupported until proven settlement exists.
 */
export function verifyEntryReservation(reservation: Record<string, unknown>, intent: Record<string, unknown>, positionId: string) {
  const admission = entryAdmissionSchema.safeParse(reservation.entryAdmission);
  riskAssert(admission.success && admission.data.positionId === positionId && intent.purpose === "ENTRY"
    && reservation.kind === "ENTRY_RISK" && reservation.intentId === intent.intentId, "STALE_EXECUTION_CHAIN");
  const requirement = calculateEntryRisk(intent.targetLegs, intent.entryPlan);
  riskAssert(admission.data.economicsFingerprint === requirement.fingerprint && reservation.state === "HELD"
    && reservation.policyVersion === admission.data.policyVersion && reservation.positionSlots === 1, "RISK_PROJECTION_MISMATCH");
  for (const key of ["initialMarginMinor", "remainingMarginMinor", "initialExposureMinor", "remainingExposureMinor"])
    riskAssert(reservation[key] === requirement.requiredRiskMinor, "RISK_PROJECTION_MISMATCH");
  riskAssert(JSON.stringify(z.array(z.string()).parse(reservation.instrumentKeys).slice().sort())
    === JSON.stringify(requirement.legs.map(leg => leg.contractKey).sort()), "STALE_EXECUTION_CHAIN");
  return { requirement, admission: admission.data };
}
