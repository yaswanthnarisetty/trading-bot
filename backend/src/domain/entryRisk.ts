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
const legacyEntryPlanSchema = z.object({
  kind: z.literal("BUY_OPTION_LIMIT_V1"), product: z.literal("INTRADAY"), validUntil: z.date(),
  legs: z.array(z.object({
    legId: identifierSchema, contractKey: identifierSchema,
    instrumentKind: z.literal("NSE_OPTION"), optionType: z.enum(["CALL", "PUT"]),
    expiry: z.date(), qualificationRef: identifierSchema,
    lotSizeUnits: positive, tickSizeMinor: positive, limitPriceMinor: positive,
  }).strict()).min(1),
}).strict();
const identitySchema = z.object({
  canonicalId: identifierSchema, broker: z.literal("KITE"), exchange: z.literal("NFO"), segment: z.literal("NFO-OPT"),
  contractKey: identifierSchema, instrumentToken: identifierSchema, exchangeToken: identifierSchema,
  underlying: z.enum(["NIFTY", "BANKNIFTY", "FINNIFTY"]), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strikeMinor: positive, instrumentType: z.enum(["CE", "PE"]), lotSizeUnits: positive, tickSizeMinor: positive,
  masterFingerprint: identifierSchema,
}).strict();
export const classifiedEntryPlanSchema = z.object({
  kind: z.literal("NSE_STRATEGY_LIMIT_V1"), product: z.literal("INTRADAY"), validUntil: z.date(),
  family: z.enum(["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"]),
  strategyKind: z.enum(["LONG_CALL", "LONG_PUT", "BULL_CALL_DEBIT_SPREAD", "BEAR_PUT_DEBIT_SPREAD", "BULL_PUT_CREDIT_SPREAD", "BEAR_CALL_CREDIT_SPREAD"]),
  dataMode: z.enum(["MOCK", "KITE_REAL"]), source: z.enum(["MOCK", "KITE"]),
  candidateRef: identifierSchema, analyticsEvidenceId: identifierSchema, evaluatedAt: z.string().datetime(),
  candidateVersion: z.literal("TRADE_CANDIDATE_V2"), evaluatorVersion: z.literal("PHASE6A01_V1"),
  legs: z.array(legacyEntryPlanSchema.shape.legs.element.extend({
    role: z.enum(["LONG", "HEDGE", "SHORT"]), identity: identitySchema,
  }).strict()).min(1).max(2),
}).strict();
export const entryPlanSchema = z.union([legacyEntryPlanSchema, classifiedEntryPlanSchema]);
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
  riskAssert(targets.data.every(leg => leg.side === "BUY") || parsed.success && parsed.data.kind === "NSE_STRATEGY_LIMIT_V1", "UNSUPPORTED_RISK_SHAPE");
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
    return { ...terms, side: target.side, quantityUnits: target.targetUnits };
  }).sort((a, b) => a.legId.localeCompare(b.legId));
  let requiredRiskMinor = checkedRiskUnits(legs.reduce((total, leg) => total + BigInt(leg.quantityUnits) * BigInt(leg.limitPriceMinor), 0n));
  let family: "LONG_OPTION" | "DEBIT_VERTICAL" | "CREDIT_VERTICAL" | undefined;
  let widthMinor = 0, ceilingPerUnit = 0;
  if (plan.kind === "NSE_STRATEGY_LIMIT_V1") {
    family = plan.family;
    riskAssert(plan.source === (plan.dataMode === "MOCK" ? "MOCK" : "KITE"), "INVALID_RISK_ECONOMICS");
    for (const leg of plan.legs) {
      const i = leg.identity;
      riskAssert(leg.contractKey === i.contractKey && i.contractKey.startsWith("NFO:")
        && leg.qualificationRef === i.canonicalId
        && i.canonicalId === `KITE:NFO:NFO-OPT:${i.underlying}:${i.expiry}:${i.strikeMinor}:${i.instrumentType}` && leg.lotSizeUnits === i.lotSizeUnits && leg.tickSizeMinor === i.tickSizeMinor
        && leg.optionType === (i.instrumentType === "CE" ? "CALL" : "PUT")
        && leg.expiry.toISOString() === `${i.expiry}T10:00:00.000Z`, "INVALID_RISK_ECONOMICS");
    }
    const buy = legs.find(l => l.side === "BUY"), sell = legs.find(l => l.side === "SELL");
    riskAssert(buy, "UNSUPPORTED_RISK_SHAPE");
    const b = plan.legs.find(l => l.legId === buy.legId)!;
    if (family === "LONG_OPTION") {
      riskAssert(legs.length === 1 && b.role === "LONG"
        && plan.strategyKind === (b.optionType === "CALL" ? "LONG_CALL" : "LONG_PUT"), "UNSUPPORTED_RISK_SHAPE");
      ceilingPerUnit = buy.limitPriceMinor;
    } else {
      riskAssert(legs.length === 2 && sell, "UNSUPPORTED_RISK_SHAPE");
      const sh = plan.legs.find(l => l.legId === sell.legId)!;
      riskAssert(sh.role === "SHORT" && b.role === (family === "DEBIT_VERTICAL" ? "LONG" : "HEDGE")
        && b.identity.underlying === sh.identity.underlying && b.identity.expiry === sh.identity.expiry
        && b.optionType === sh.optionType && b.lotSizeUnits === sh.lotSizeUnits && buy.quantityUnits === sell.quantityUnits
        && b.identity.canonicalId !== sh.identity.canonicalId && b.identity.instrumentToken !== sh.identity.instrumentToken
        && b.identity.masterFingerprint === sh.identity.masterFingerprint, "INVALID_RISK_ECONOMICS");
      const call = b.optionType === "CALL", debit = family === "DEBIT_VERTICAL";
      riskAssert(plan.strategyKind === (debit ? call ? "BULL_CALL_DEBIT_SPREAD" : "BEAR_PUT_DEBIT_SPREAD"
        : call ? "BEAR_CALL_CREDIT_SPREAD" : "BULL_PUT_CREDIT_SPREAD")
        && (b.identity.strikeMinor < sh.identity.strikeMinor) === (call === debit)
        && b.identity.strikeMinor !== sh.identity.strikeMinor, "UNSUPPORTED_RISK_SHAPE");
      widthMinor = Math.abs(b.identity.strikeMinor - sh.identity.strikeMinor);
      const premium = debit ? buy.limitPriceMinor - sell.limitPriceMinor : sell.limitPriceMinor - buy.limitPriceMinor;
      riskAssert(premium > 0 && premium < widthMinor, "INVALID_RISK_ECONOMICS");
      ceilingPerUnit = Math.max(buy.limitPriceMinor, debit ? premium : widthMinor - premium);
    }
    requiredRiskMinor = checkedRiskUnits(BigInt(ceilingPerUnit) * BigInt(buy.quantityUnits));
  }
  const expiresAt = new Date(Math.min(plan.validUntil.getTime(), ...legs.map(leg => leg.expiry.getTime())));
  const fingerprint = createHash("sha256").update(JSON.stringify({ kind: plan.kind, product: plan.product,
    validUntil: plan.validUntil.toISOString(), legs, ...(family ? { classification: plan } : {}) })).digest("hex");
  return { requiredRiskMinor, fingerprint, legs, product: plan.product, expiresAt, family, widthMinor, ceilingPerUnit };
}

export const entryAdmissionSchema = z.object({
  family: z.enum(["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"]).optional(),
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
  if (requirement.family && requirement.family !== "LONG_OPTION") {
    const buy = requirement.legs.find(l => l.side === "BUY")!, sell = requirement.legs.find(l => l.side === "SELL")!;
    const b = progress.find(p => p.legId === buy.legId)!, sh = progress.find(p => p.legId === sell.legId)!;
    riskAssert(sh.transferredUnits <= b.transferredUnits, "RISK_PROJECTION_MISMATCH");
    const bq = BigInt(b.transferredUnits), sq = BigInt(sh.transferredUnits), cost = BigInt(b.committedMinor);
    // Allocate the actual BUY cost proportionally, rounding unmatched protection UP.
    // The matched loss is floored at zero; profits never collateralize an unmatched long.
    const unmatched = bq === 0n ? 0n : (cost * (bq - sq) + bq - 1n) / bq;
    const matched = cost - unmatched - BigInt(sh.committedMinor)
      + (requirement.family === "CREDIT_VERTICAL" ? BigInt(requirement.widthMinor) * sq : 0n);
    committed = unmatched + (matched > 0n ? matched : 0n);
    // Remaining buys retain a whole admission envelope each. Already paid,
    // unmatched BUY units need only the possible credit-width top-up. Debit
    // SELLs can only reduce risk; UNKNOWN SELL remainder retains that same bound.
    // p = (Q-b)*max(B, B+width-S) + (b-s)*max(0,width-S) for credit.
    const topUp = requirement.family === "CREDIT_VERTICAL" ? Math.max(0, requirement.widthMinor - sell.limitPriceMinor) : 0;
    pending = BigInt(buy.quantityUnits - b.transferredUnits) * BigInt(requirement.ceilingPerUnit)
      + (bq - sq) * BigInt(topUp);
    // Keep the unspent admission envelope until proven terminal settlement.
    // Cover-short-first closing can restore long-only exposure (even while the
    // cover outcome is UNKNOWN). Never lend out that capacity after SELL fills.
    // Actual adverse BUY prices also remain covered; profits do not fund a long.
    const retainedCeiling = cost > BigInt(requirement.requiredRiskMinor) ? cost : BigInt(requirement.requiredRiskMinor);
    const retained = retainedCeiling > committed ? retainedCeiling - committed : 0n;
    if (retained > pending) pending = retained;
  }
  return { progress, pendingMinor: checkedRiskUnits(pending), committedMinor: checkedRiskUnits(committed),
    reservedSlots: executed ? 0 : 1, committedSlots: executed ? 1 : 0 };
}

const riskFillSchema = z.object({ fillId: identifierSchema, intentId: identifierSchema, legId: identifierSchema,
  contractKey: identifierSchema, side: z.enum(["BUY", "SELL"]), quantityUnits: positive, priceMinor: quantityUnitsSchema });
export function entryProjectionFromFills(requirement: EntryRiskRequirement, intentId: string, input: readonly unknown[]) {
  const fills = z.array(riskFillSchema).parse(input);
  riskAssert(new Set(fills.map(f => f.fillId)).size === fills.length, "RISK_PROJECTION_MISMATCH");
  for (const fill of fills) riskAssert(fill.intentId === intentId && requirement.legs.some(leg =>
    leg.legId === fill.legId && leg.contractKey === fill.contractKey && leg.side === fill.side), "STALE_EXECUTION_CHAIN");
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
  riskAssert(admission.data.family === requirement.family, "STALE_EXECUTION_CHAIN");
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
