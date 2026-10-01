import { freeze } from "./kiteMarketData";
import { paperSessionConfigSchema, type PaperSessionConfig } from "./paperOrchestration";
import { MIN_CONFIDENCE_DEFAULT, MIN_DTE_FOR_BUYING, TICK_INTERVAL_MS } from "../config/constants";
import { DEFAULT_LONG_SELECTION } from "./strategyEvaluation";
import { nsePaperCalendar, type NseCalendarEvidence } from "./nseTradingCalendar";

// Missing entry evidence is explicit. This schema has no financial authority;
// every evaluation must still pass the original complete PaperSessionConfig.
export const paperMonitoringConfigSchema = paperSessionConfigSchema.extend({
  calendar: paperSessionConfigSchema.shape.calendar.nullable().default(null),
  riskFreeRate: paperSessionConfigSchema.shape.riskFreeRate.nullable().default(null),
  riskFreeRateVersion: paperSessionConfigSchema.shape.riskFreeRateVersion.nullable().default(null),
});
export type PaperMonitoringConfig = ReturnType<typeof paperMonitoringConfigSchema.parse>;
export const captureMonitoringConfig = (input: unknown): Readonly<PaperMonitoringConfig> =>
  freeze(structuredClone(paperMonitoringConfigSchema.parse(input)));
export const paperEntryMetadataSchema = paperMonitoringConfigSchema.pick({
  calendar: true, riskFreeRate: true, riskFreeRateVersion: true,
}).strict();

export function builtInNiftyPaperConfig(accountId: string): Readonly<PaperMonitoringConfig> {
  return captureMonitoringConfig({ configId: "NIFTY_PAPER_DEFAULT_V1", accountId,
    asset: "NIFTY", executionMode: "PAPER", dataMode: "KITE_REAL", intervalMs: TICK_INTERVAL_MS,
    entryCutoffMinuteIST: 900, maxAgeMs: 30000,
    // Same approved quality defaults as Phase 5/6 normalizeBacktestParams;
    // no backtest, legacy capital or risk settings are imported into this account.
    strategyConfig: { version: "NIFTY_PAPER_QUALITY_V1", strategyFamily: "LONG_OPTION",
      minConfidence: MIN_CONFIDENCE_DEFAULT, longOptionSelection: DEFAULT_LONG_SELECTION,
      maxAtrPoints: 70, minVolumeRatio: 0, bullishRsiMax: 70, bearishRsiMin: 30,
      openingBlockMinutes: 15, minDteDays: MIN_DTE_FOR_BUYING, strikeStepMinor: 5000,
      widthMinor: 10000, shortOffsetMinor: 10000, minDepthUnits: 1,
      maxBidAskSpreadMinor: 1000, minCreditMinor: 2500 },
  });
}

export function completePaperEntryConfig(config: PaperMonitoringConfig, metadata: unknown = {}): PaperSessionConfig {
  const supplied = paperEntryMetadataSchema.parse(metadata);
  const resolved = { ...config, calendar: config.calendar ?? supplied.calendar,
    riskFreeRate: config.riskFreeRate ?? supplied.riskFreeRate,
    riskFreeRateVersion: config.riskFreeRateVersion ?? supplied.riskFreeRateVersion };
  if (!resolved.calendar) throw new Error("CALENDAR_NOT_READY");
  if (resolved.riskFreeRate === null || resolved.riskFreeRateVersion === null) throw new Error("GREEKS_CONFIG_REQUIRED");
  return freeze(paperSessionConfigSchema.parse(resolved));
}

/** Production calendar authority is server-owned. Conflicting explicit calendars
 * fail; explicit rate assumptions remain required and are never defaulted. */
export function completeOperationalPaperEntryConfig(config: PaperMonitoringConfig, metadata: unknown, now: Date) {
  const supplied = paperEntryMetadataSchema.parse(metadata), calendar = nsePaperCalendar(now);
  for (const explicit of [config.calendar, supplied.calendar]) {
    if (explicit && (explicit.version !== calendar.version || explicit.sourceReference !== calendar.sourceReference
      || JSON.stringify([...explicit.openDates].sort()) !== JSON.stringify(calendar.openDates)))
      throw new Error("CALENDAR_AUTHORITY_CONFLICT");
  }
  return completePaperEntryConfig({ ...config, calendar }, supplied);
}

export type PaperEntryReadiness = { entryReady: boolean; entryStatus: "READY" | "WAITING";
  operationalDefaults?: Awaited<ReturnType<typeof import("../services/PaperOperationalDefaults").operationalDefaultsStatus>>;
  entryBlockingReason: string | null; calendar?: NseCalendarEvidence;
  lastReadinessAttemptAt?: string | null; readinessAction?: "AUTOMATIC_RETRY" | "OPERATOR_ACTION" | null };
export const waitingForEntry = (reason: string): PaperEntryReadiness =>
  ({ entryReady: false, entryStatus: "WAITING", entryBlockingReason: reason });

export function monitoringEntryWindow(config: PaperMonitoringConfig, now: Date, qualifiedOpenDate = false): string | null {
  const ist = new Date(+now + 19800000), minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if ((!qualifiedOpenDate && [0, 6].includes(ist.getUTCDay())) || minute >= 930 || minute < 555) return "MARKET_CALENDAR_CLOSED";
  if (minute < 555 + config.strategyConfig.openingBlockMinutes) return "OPENING_BLOCK";
  if (minute >= config.entryCutoffMinuteIST) return "ENTRY_WINDOW_CLOSED";
  return null;
}
