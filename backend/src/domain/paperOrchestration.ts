import { createHash } from "node:crypto";
import { z } from "zod";
import { identifierSchema } from "@trading-bot/shared";
import { freeze } from "./kiteMarketData";
import { validStrategyQualityConfig, type StrategyQualityConfig } from "./strategyEvaluation";
import { NSE_FO_CALENDAR_2026 } from "../config/nseTradingCalendar";
import { classifyNseDate, nseCalendarBlock } from "./nseTradingCalendar";

export const paperSessionConfigSchema = z.object({
  configId: identifierSchema, accountId: z.string().regex(/^PAPER:[^\s]+$/).max(200),
  executionMode: z.literal("PAPER"), asset: z.enum(["NIFTY", "BANKNIFTY", "FINNIFTY"]),
  dataMode: z.enum(["MOCK", "KITE_REAL"]),
  strategyConfig: z.custom<StrategyQualityConfig>(v => !!v && typeof v === "object"
    && !!(v as StrategyQualityConfig).strategyFamily && validStrategyQualityConfig(v as StrategyQualityConfig)),
  intervalMs: z.number().int().min(300000).max(3600000).default(300000),
  entryCutoffMinuteIST: z.number().int().min(570).max(915).default(900),
  calendar: z.object({ version: identifierSchema, sourceReference: identifierSchema,
    openDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(400) }).strict(),
  maxAgeMs: z.number().int().min(1000).max(60000).default(30000),
  riskFreeRate: z.number().finite().min(0).max(0.3), riskFreeRateVersion: identifierSchema,
}).strict();
export type PaperSessionConfig = z.infer<typeof paperSessionConfigSchema>;
export function capturePaperConfig(input: unknown): Readonly<PaperSessionConfig> {
  return freeze(structuredClone(paperSessionConfigSchema.parse(input)));
}
export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Five-minute bar windows anchored to 09:15 IST, independent of timer jitter/cadence. */
export function decisionWindow(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new Error("INVALID_EVALUATION_TIME");
  return new Date(Math.floor(at.getTime() / 300000) * 300000).toISOString();
}
export function cycleIdentity(c: PaperSessionConfig, at: Date): string {
  // Session replacement cannot create a second entry for the same account/asset/bar.
  return digest(["NSE_PAPER_WINDOW_V1", c.accountId, c.asset, decisionWindow(at)]);
}
/** Absolute cutoff for this IST trading date; host timezone never participates. */
export function entryCutoffAt(c: PaperSessionConfig, at: Date): Date {
  const day = new Date(at.getTime() + 19800000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 19800000 + c.entryCutoffMinuteIST * 60000);
}
export function entryCalendarBlock(c: PaperSessionConfig, at: Date): string | null {
  const ist = new Date(at.getTime() + 19800000), day = ist.toISOString().slice(0,10);
  const minute = ist.getUTCHours()*60 + ist.getUTCMinutes();
  if (c.calendar.version === NSE_FO_CALENDAR_2026.version) {
    const blocked = nseCalendarBlock(classifyNseDate(day));
    if (blocked) return blocked;
  } else if ([0,6].includes(ist.getUTCDay())) return "MARKET_CALENDAR_CLOSED";
  if (!c.calendar.openDates.includes(day)) return "MARKET_CALENDAR_CLOSED";
  if (minute < 555 || minute >= c.entryCutoffMinuteIST) return "ENTRY_WINDOW_CLOSED";
  // The approved Phase 5 evaluator alone implements the configured opening block.
  return null;
}
export function safeCycleError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  const allowed = ["MARKET_EVIDENCE_EXPIRED","ENTRY_CUTOFF_PASSED","PAPER_ONLY","SESSION_STOPPED","SESSION_REPLACED","SESSION_CONFIG_CONFLICT","RECOVERY_REQUIRED",
    "RECONCILIATION_REQUIRED","ACCOUNT_NOT_READY","RISK_POLICY_REQUIRED","DATA_MODE_REQUIRED","KITE_SESSION_REQUIRED",
    "INSTRUMENT_MASTER_STALE","QUOTE_UNAVAILABLE","STALE_MARKET_DATA","QUALIFIED_INSTRUMENT_REQUIRED",
    "MONTHLY_METADATA_REQUIRED","MOCK_PROVIDER_REQUIRED","DECISION_CONFLICT","STALE_CANDIDATE","PAPER_INDEXES_REQUIRED"];
  return allowed.includes(code) ? code : allowed.includes(message) ? message : "CYCLE_FAILED_REQUIRES_ATTENTION";
}
