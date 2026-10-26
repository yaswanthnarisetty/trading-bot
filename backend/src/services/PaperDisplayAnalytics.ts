import { indicatorSnapshotSchema } from "@trading-bot/shared";
import { z } from "zod";
import { assertMarketAnalytics, type AnalyticsOutcome } from "../domain/marketAnalytics";

const finite = z.number().finite();
export const paperDisplayAnalyticsSchema = z.object({
  version: z.literal("PAPER_DISPLAY_ANALYTICS_V1"),
  dataMode: z.literal("KITE_REAL"),
  source: z.literal("KITE"),
  evaluatedAt: z.string().datetime({ offset: true }),
  spotMinor: z.number().int().positive(),
  lastFinalizedAt: z.string().datetime({ offset: true }),
  indicators: indicatorSnapshotSchema,
  // Optional so earlier durable display rows remain readable.
  directionalTrend: z.object({ adx14: finite.nonnegative(), plusDi14: finite.nonnegative(),
    minusDi14: finite.nonnegative() }).strict().optional(),
  option: z.object({
    canonicalId: z.string().min(1),
    type: z.enum(["CE", "PE"]),
    strikeMinor: z.number().int().positive(),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    impliedVolatility: finite.nonnegative(),
    delta: finite, gamma: finite.nonnegative(), thetaPerDay: finite,
    vegaPerPercent: finite.nonnegative(),
  }).strict().nullable(),
}).strict();

export type PaperDisplayAnalytics = z.infer<typeof paperDisplayAnalyticsSchema>;

/** Read-only presentation evidence; never use a persisted projection for entry or risk decisions. */
export function projectPaperDisplayAnalytics(analytics: AnalyticsOutcome, expiry: string): PaperDisplayAnalytics | null {
  if (!analytics.available) return null;
  const snapshot = analytics.snapshot;
  try { assertMarketAnalytics(snapshot); } catch { return null; }
  if (snapshot.dataMode !== "KITE_REAL" || snapshot.source !== "KITE") return null;
  const representative = snapshot.options
    .filter(option => option.instrument.expiry === expiry && option.greeks.available)
    .sort((a, b) => Math.abs(a.instrument.strikeMinor - snapshot.spotMinor)
      - Math.abs(b.instrument.strikeMinor - snapshot.spotMinor)
      || (a.instrument.instrumentType === b.instrument.instrumentType ? 0 : a.instrument.instrumentType === "CE" ? -1 : 1)
      || a.canonicalId.localeCompare(b.canonicalId))[0];
  const value = representative?.greeks.available ? representative.greeks.value : null;
  const projection = paperDisplayAnalyticsSchema.safeParse({
    version: "PAPER_DISPLAY_ANALYTICS_V1", dataMode: "KITE_REAL", source: "KITE",
    evaluatedAt: snapshot.evaluatedAt, spotMinor: snapshot.spotMinor,
    lastFinalizedAt: snapshot.indicators.lastFinalizedAt,
    indicators: snapshot.indicators.values,
    directionalTrend: snapshot.indicators.directionalTrend,
    option: representative && value ? {
      canonicalId: representative.canonicalId, type: representative.instrument.instrumentType,
      strikeMinor: representative.instrument.strikeMinor, expiry: representative.instrument.expiry,
      impliedVolatility: value.impliedVolatility, delta: value.delta, gamma: value.gamma,
      thetaPerDay: value.thetaPerDay, vegaPerPercent: value.vegaPerPercent,
    } : null,
  });
  return projection.success ? projection.data : null;
}
