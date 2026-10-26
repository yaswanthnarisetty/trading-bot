import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { z } from "zod";
import { classifiedEntryPlanSchema } from "../domain/entryRisk";
import { assertIssuedTradeCandidate, candidateMarketEvidenceExpiry, type TradeCandidate } from "../domain/strategyEvaluation";
import { kitePaperBuyLimitMinor } from "../domain/paperBuyLimit";

const renewalSchema = z.object({
  candidateRef: z.string().min(1), candidateKey: z.string().min(1), analyticsEvidenceId: z.string().min(1),
  contractKey: z.string().min(1), priceMinor: z.number().int().positive(), observedAt: z.date(), expiresAt: z.date(),
}).strict();
export type EntryQuoteRenewal = z.infer<typeof renewalSchema>;
const issued = new WeakMap<object, string>();
const scoped = new WeakMap<ClientSession, EntryQuoteRenewal>();
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only the current qualified evaluator can extend market evidence, and only for
 * the same one-lot LONG_OPTION at a price no worse than the reserved limit. */
export function issueEntryQuoteRenewal(original: TradeCandidate, refreshed: TradeCandidate, planInput: unknown, now: Date): EntryQuoteRenewal {
  assertIssuedTradeCandidate(original);
  assertIssuedTradeCandidate(refreshed, +now);
  const plan = classifiedEntryPlanSchema.parse(planInput);
  const old = original.legs[0], next = refreshed.legs[0];
  const candidateRef = fingerprint([original.candidateKey, original.evaluatedAt, original.analyticsEvidenceId, original.selectionConfig]);
  const expiresAt = candidateMarketEvidenceExpiry(refreshed);
  if (plan.family !== "LONG_OPTION" || plan.dataMode !== "KITE_REAL" || plan.source !== "KITE"
    || plan.candidateRef !== candidateRef || plan.legs.length !== 1 || original.legs.length !== 1 || refreshed.legs.length !== 1
    || !old || !next || old.side !== "BUY" || next.side !== "BUY"
    || original.candidateKey !== refreshed.candidateKey || original.strategyKind !== refreshed.strategyKind
    || original.underlying !== refreshed.underlying || original.expiry !== refreshed.expiry
    || original.optionMasterFingerprint !== refreshed.optionMasterFingerprint
    || old.instrument.contractKey !== next.instrument.contractKey || old.instrument.contractKey !== plan.legs[0]!.contractKey
    || old.quantityUnits !== next.quantityUnits || next.quantityUnits !== plan.legs[0]!.lotSizeUnits
    || plan.legs[0]!.limitPriceMinor !== kitePaperBuyLimitMinor(old.priceMinor, old.instrument.tickSizeMinor)
    || expiresAt === null || expiresAt <= +now || +now > +plan.validUntil)
    throw new Error("MARKET_EVIDENCE_EXPIRED");
  if (next.priceMinor > plan.legs[0]!.limitPriceMinor) throw new Error("QUOTE_MOVED_BEYOND_LIMIT");
  const proof = Object.freeze(renewalSchema.parse({ candidateRef, candidateKey: refreshed.candidateKey,
    analyticsEvidenceId: refreshed.analyticsEvidenceId, contractKey: next.instrument.contractKey,
    priceMinor: next.priceMinor, observedAt: new Date(now), expiresAt: new Date(Math.min(expiresAt, +plan.validUntil)) }));
  issued.set(proof, fingerprint(plan));
  return proof;
}

export function assertEntryQuoteRenewal(proof: EntryQuoteRenewal | undefined, planInput: unknown,
  order: { contractKey: string; limitPriceMinor: number; side: string }, now: Date): asserts proof is EntryQuoteRenewal {
  const plan = classifiedEntryPlanSchema.parse(planInput);
  if (!plan.entryCutoffAt || +now > +plan.entryCutoffAt) throw new Error("ENTRY_CUTOFF_PASSED");
  const parsed = renewalSchema.safeParse(proof);
  if (!parsed.success || !proof || issued.get(proof) !== fingerprint(plan)
    || plan.family !== "LONG_OPTION" || plan.dataMode !== "KITE_REAL" || order.side !== "BUY"
    || proof.candidateRef !== plan.candidateRef || proof.contractKey !== order.contractKey
    || proof.priceMinor > order.limitPriceMinor || +proof.observedAt > +now || +proof.expiresAt < +now
    || +proof.expiresAt > +plan.validUntil)
    throw new Error("MARKET_EVIDENCE_EXPIRED");
}

export async function withEntryQuoteRenewal<T>(session: ClientSession, proof: EntryQuoteRenewal | undefined,
  work: () => Promise<T>): Promise<T> {
  if (proof) scoped.set(session, proof);
  try { return await work(); } finally { scoped.delete(session); }
}
export function entryQuoteRenewalFor(session: ClientSession): EntryQuoteRenewal | undefined { return scoped.get(session); }
