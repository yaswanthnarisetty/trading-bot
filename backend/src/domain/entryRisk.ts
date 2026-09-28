import { createHash } from "node:crypto";
import { z } from "zod";
import { fillAccounting } from "./fillAccounting";
import { identifierSchema, quantityUnitsSchema } from "@trading-bot/shared";

const positive = quantityUnitsSchema.refine(n => n > 0);
export const entryRiskPolicySchema = z.object({
  policyVersion: quantityUnitsSchema,
  maxRiskPerEntryMinor: positive, maxReservedRiskMinor: positive, maxPositionSlots: positive,
  maxDailyLossMinor: positive.optional(),
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
export type EntryRiskReason = "RECOVERY_REQUIRED" | "RECONCILIATION_REQUIRED" | "INVALID_RISK_ECONOMICS" | "UNSUPPORTED_RISK_SHAPE" | "RISK_ARITHMETIC_OVERFLOW"
  | "RISK_PER_TRADE_EXCEEDED" | "RISK_CAPACITY_EXCEEDED" | "POSITION_LIMIT_EXCEEDED"
  | "ACCOUNT_NOT_READY" | "RISK_POLICY_REQUIRED" | "INTENT_NOT_FOUND" | "ENTRY_ONLY"
  | "STALE_EXECUTION_CHAIN" | "RISK_PROJECTION_MISMATCH" | "UNSUPPORTED_ACCOUNT_EXPOSURE"
  | "KILL_SWITCH_ACTIVE" | "DAILY_LOSS_LIMIT_EXCEEDED" | "DAILY_LOSS_POLICY_REQUIRED" | "TRADING_DAY_CONFIG_REQUIRED" | "TRADING_DAY_REGRESSION";
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

export const entryProgressSchema = z.array(z.object({
  legId: identifierSchema, transferredUnits: quantityUnitsSchema, committedMinor: quantityUnitsSchema,
}).strict()).min(1);
export const entrySettlementSchema = z.object({
  positionId: identifierSchema, closeIntentId: identifierSchema, eventId: identifierSchema, settledAt: z.date(),
  pendingReleasedMinor: quantityUnitsSchema, committedReleasedMinor: quantityUnitsSchema,
  reservedSlotsReleased: quantityUnitsSchema, committedSlotsReleased: quantityUnitsSchema,
}).strict();
export type EntryRiskRequirement = ReturnType<typeof calculateEntryRisk>;

/** Progress is a projection, never execution evidence. Persistence proves it against
 * immutable owned Fills. Missing progress is compatible ONLY with an unfilled 2C1 hold.
 */
export function entryProjection(requirement: EntryRiskRequirement, input?: unknown) {
  const progress = entryProgressSchema.parse(input === undefined ? requirement.legs.map(leg => ({
    legId: leg.legId, transferredUnits: 0, committedMinor: 0,
  })) : input).sort((a, b) => a.legId.localeCompare(b.legId));
  riskAssert(progress.length === requirement.legs.length && new Set(progress.map(p => p.legId)).size === progress.length, "RISK_PROJECTION_MISMATCH");
  let pending = 0n, committed = 0n, executed = false;
  for (const leg of requirement.legs) {
    const item = progress.find(p => p.legId === leg.legId);
    riskAssert(item && item.transferredUnits <= leg.quantityUnits && (item.transferredUnits > 0 || item.committedMinor === 0), "RISK_PROJECTION_MISMATCH");
    pending += BigInt(leg.quantityUnits - item.transferredUnits) * BigInt(leg.limitPriceMinor);
    committed += BigInt(item.committedMinor); executed ||= item.transferredUnits > 0;
  }
  return { progress, pendingMinor: checkedRiskUnits(pending), committedMinor: checkedRiskUnits(committed),
    reservedSlots: executed ? 0 : 1, committedSlots: executed ? 1 : 0 };
}

const riskFillSchema = z.object({ fillId: identifierSchema, intentId: identifierSchema, legId: identifierSchema,
  contractKey: identifierSchema, side: z.literal("BUY"), quantityUnits: positive, priceMinor: quantityUnitsSchema });
export function entryProjectionFromFills(requirement: EntryRiskRequirement, intentId: string, input: readonly unknown[]) {
  const fills = z.array(riskFillSchema).parse(input);
  riskAssert(new Set(fills.map(f => f.fillId)).size === fills.length, "RISK_PROJECTION_MISMATCH");
  for (const fill of fills) riskAssert(fill.intentId === intentId && requirement.legs.some(leg =>
    leg.legId === fill.legId && leg.contractKey === fill.contractKey), "STALE_EXECUTION_CHAIN");
  return entryProjection(requirement, requirement.legs.map(leg => {
    const owned = fills.filter(fill => fill.legId === leg.legId);
    const transferredUnits = checkedRiskUnits(owned.reduce((sum, fill) => sum + BigInt(fill.quantityUnits), 0n));
    // Actual price is truth, including zero or a price above the authorization limit.
    const { entryNotionalMinor } = fillAccounting(owned, intentId);
    return { legId: leg.legId, transferredUnits, committedMinor: entryNotionalMinor };
  }));
}

/** Original admission remains immutable; only proved Fill progress changes pending
 * risk. HELD retains the economic history and one total slot, even after full close.
 */
export function verifyEntryReservation(reservation: Record<string, unknown>, intent: Record<string, unknown>, positionId: string) {
  const admission = entryAdmissionSchema.safeParse(reservation.entryAdmission);
  riskAssert(admission.success && admission.data.positionId === positionId && intent.purpose === "ENTRY"
    && reservation.kind === "ENTRY_RISK" && reservation.intentId === intent.intentId, "STALE_EXECUTION_CHAIN");
  const requirement = calculateEntryRisk(intent.targetLegs, intent.entryPlan);
  const projection = entryProjection(requirement, reservation.entryProgress);
  riskAssert(admission.data.economicsFingerprint === requirement.fingerprint && ["HELD", "RELEASED"].includes(String(reservation.state))
    && reservation.policyVersion === admission.data.policyVersion && reservation.positionSlots === (reservation.state === "RELEASED" ? 0 : 1), "RISK_PROJECTION_MISMATCH");
  for (const key of ["initialMarginMinor", "initialExposureMinor"])
    riskAssert(reservation[key] === requirement.requiredRiskMinor, "RISK_PROJECTION_MISMATCH");
  for (const key of ["remainingMarginMinor", "remainingExposureMinor"])
    riskAssert(reservation[key] === (reservation.state === "RELEASED" ? 0 : projection.pendingMinor), "RISK_PROJECTION_MISMATCH");
  riskAssert(JSON.stringify(z.array(z.string()).parse(reservation.instrumentKeys).slice().sort())
    === JSON.stringify(requirement.legs.map(leg => leg.contractKey).sort()), "STALE_EXECUTION_CHAIN");
  if (reservation.state === "RELEASED") {
    const settled = entrySettlementSchema.parse(reservation.entrySettlement);
    riskAssert(settled.positionId === positionId && settled.eventId === `${reservation.reservationId}:ENTRY_RISK_SETTLED`
      && settled.pendingReleasedMinor === projection.pendingMinor && settled.committedReleasedMinor === projection.committedMinor
      && settled.reservedSlotsReleased === projection.reservedSlots && settled.committedSlotsReleased === projection.committedSlots, "RISK_PROJECTION_MISMATCH");
  } else riskAssert(reservation.entrySettlement === undefined, "RISK_PROJECTION_MISMATCH");
  return { requirement, admission: admission.data, projection };
}
