import { DEFAULT_LONG_SELECTION } from "../domain/strategyEvaluation";
import { captureMonitoringConfig, builtInNiftyPaperConfig, monitoringEntryWindow, waitingForEntry, type PaperMonitoringConfig,
  type PaperEntryReadiness } from "../domain/paperMonitoring";
import { entryCalendarBlock, safeCycleError, type PaperSessionConfig } from "../domain/paperOrchestration";
import { nseCalendarBlock, type NseCalendarEvidence } from "../domain/nseTradingCalendar";
import type { PaperPreparation } from "./PaperEntryPreparationService";

export function parseDefaultStartRequest(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof (body as { asset?: unknown }).asset !== "string")
    throw new Error("ASSET_ONLY_START_REQUIRED");
  return (body as { asset: string }).asset;
}

/** Selects one backend-owned validated default. Calendar and explicit rate inputs
 * are resolved separately before entry; the browser cannot supply these terms. */
export function resolveDefaultPaperConfig(asset: unknown, configured: readonly PaperMonitoringConfig[]): Readonly<PaperMonitoringConfig> {
  if (asset !== "NIFTY") throw new Error("DEFAULT_PAPER_ASSET_UNAVAILABLE");
  const choices = configured.filter(c => c.asset === asset && c.executionMode === "PAPER"
    && c.dataMode === "KITE_REAL" && c.strategyConfig.strategyFamily === "LONG_OPTION");
  if (choices.length !== 1) throw new Error("DEFAULT_PAPER_CONFIG_REQUIRED");
  const config = captureMonitoringConfig(choices[0]);
  const selection = config.strategyConfig.longOptionSelection ?? DEFAULT_LONG_SELECTION;
  if (config.intervalMs !== 300000 || config.entryCutoffMinuteIST !== 900
    || config.strategyConfig.openingBlockMinutes !== 15 || config.strategyConfig.minConfidence !== 0.65
    || selection.minAbsDelta !== DEFAULT_LONG_SELECTION.minAbsDelta
    || selection.maxAbsDelta !== DEFAULT_LONG_SELECTION.maxAbsDelta
    || selection.targetAbsDelta !== DEFAULT_LONG_SELECTION.targetAbsDelta
    || selection.maxStrikeDistanceMinor !== DEFAULT_LONG_SELECTION.maxStrikeDistanceMinor)
    throw new Error("DEFAULT_PAPER_CONFIG_INVALID");
  return config;
}

export function defaultPaperSummary(config: Readonly<PaperMonitoringConfig>) {
  return { asset: config.asset, accountId: config.accountId, configId: config.configId,
    executionMode: config.executionMode, dataMode: config.dataMode,
    strategyFamily: config.strategyConfig.strategyFamily, intervalMs: config.intervalMs,
    entryWindowStartMinuteIST: 555 + config.strategyConfig.openingBlockMinutes,
    entryCutoffMinuteIST: config.entryCutoffMinuteIST,
    minConfidence: config.strategyConfig.minConfidence,
    longOptionSelection: config.strategyConfig.longOptionSelection ?? DEFAULT_LONG_SELECTION };
}

/** Disabled accounts cannot be selected. Recovery/kill state remains an ENTRY gate. */
export function resolvePersonalPaperAccount(accounts: readonly { accountId: string }[]): string {
  if (!accounts.length) throw new Error("PAPER_ACCOUNT_REQUIRED");
  if (accounts.length !== 1) throw new Error("PAPER_ACCOUNT_AMBIGUOUS");
  if (!/^PAPER:[^\s]+$/.test(accounts[0].accountId)) throw new Error("PAPER_ACCOUNT_REQUIRED");
  return accounts[0].accountId;
}

export interface DefaultStartDependencies<T> {
  configurations(): Promise<readonly PaperMonitoringConfig[]>;
  hasExplicitConfiguration(): boolean;
  accounts(): Promise<readonly { accountId: string }[]>;
  start(config: PaperMonitoringConfig): Promise<T>;
  readiness(session: T, config: PaperMonitoringConfig, prepare: boolean): Promise<PaperEntryReadiness>;
  schedule(accountId: string, sessionId: string, intervalMs: number): void;
  sessionId(session: T): string;
}

export interface PaperReadinessDependencies {
  clock(): Date;
  active(sessionId: string): Promise<unknown>;
  connected(): boolean;
  mode(): string;
  entryConfig(config: PaperMonitoringConfig): Promise<PaperSessionConfig>;
  accountGate(accountId: string): Promise<void>;
  assertReady(config: PaperSessionConfig): Promise<void>;
  recover(config: PaperMonitoringConfig): Promise<{status: string}>;
  market(config: PaperSessionConfig, prepare: boolean): Promise<void>;
  calendar?(now: Date): NseCalendarEvidence;
  preparation?(accountId: string, sessionId: string, prepare: boolean): Promise<PaperPreparation | null>;
}
export async function evaluatePaperReadiness(session: {sessionId: string; config: unknown},
  deps: PaperReadinessDependencies, prepare = false): Promise<PaperEntryReadiness> {
  let calendar: NseCalendarEvidence | undefined, lastReadinessAttemptAt: string | null = null;
  const details = () => deps.calendar ? { calendar, lastReadinessAttemptAt } : {};
  try {
    const config = captureMonitoringConfig(session.config);
    calendar = deps.calendar?.(deps.clock());
    await deps.active(session.sessionId);
    if (calendar) { const blocked = nseCalendarBlock(calendar); if (blocked) throw new Error(blocked); }
    if (!deps.connected()) throw new Error("KITE_SESSION_REQUIRED");
    if (deps.mode() !== "KITE_REAL" || config.dataMode !== "KITE_REAL") throw new Error("DATA_MODE_REQUIRED");
    const window = monitoringEntryWindow(config, deps.clock(), calendar?.regularHours);
    if (window) throw new Error(window);
    if (deps.preparation) {
      const result = await deps.preparation(config.accountId, session.sessionId, prepare);
      lastReadinessAttemptAt = result?.attemptedAt ?? null;
      if (!result || result.status !== "READY") throw new Error(result?.reason ?? "READINESS_PREPARATION_REQUIRED");
    }
    const entry = await deps.entryConfig(config);
    const calendarBlock = entryCalendarBlock(entry, deps.clock());
    if (calendarBlock) throw new Error(calendarBlock);
    await deps.accountGate(config.accountId);
    try { await deps.assertReady(entry); }
    catch (e) {
      if (deps.preparation || !prepare || !(e instanceof Error) || !["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(e.message)) throw e;
      const recovered = await deps.recover(config);
      if (recovered.status !== "READY") throw new Error("RECONCILIATION_NOT_MATCHED");
      await deps.assertReady(entry);
    }
    await deps.market(entry, prepare);
    await deps.active(session.sessionId);
    await deps.accountGate(config.accountId); await deps.assertReady(entry);
    const lateCalendar = deps.calendar?.(deps.clock());
    if (lateCalendar) { calendar = lateCalendar; const blocked = nseCalendarBlock(calendar); if (blocked) throw new Error(blocked); }
    const lateWindow = monitoringEntryWindow(config, deps.clock(), calendar?.regularHours) ?? entryCalendarBlock(entry, deps.clock());
    if (lateWindow) throw new Error(lateWindow);
    return {entryReady: true, entryStatus: "READY", entryBlockingReason: null, ...details()};
  } catch (e) {
    const reason = e instanceof Error ? e.message : "";
    const allowed = ["MARKET_CALENDAR_CLOSED","OPENING_BLOCK","ENTRY_WINDOW_CLOSED","CALENDAR_NOT_READY","GREEKS_CONFIG_REQUIRED",
      "ENTRY_METADATA_INVALID","EXIT_CONFIG_REQUIRED","KILL_SWITCH_ACTIVE","DAILY_LOSS_LIMIT_EXCEEDED","TRADING_DAY_CONFIG_REQUIRED",
      "RECONCILIATION_NOT_MATCHED","RECOVERY_ALREADY_REQUIRED","RECOVERY_HOST_MISMATCH",
      "CALENDAR_AUTHORITY_CONFLICT","SPECIAL_SESSION_NOT_SUPPORTED","READINESS_PREPARATION_REQUIRED",
      "RECONCILIATION_DISCREPANCY","RECONCILIATION_INCOMPLETE","RECONCILIATION_UNAVAILABLE",
      "PAPER_KITE_ACCOUNT_CONFLICT","RECOVERY_CONFIG_REQUIRED","RECOVERY_PROOF_INVALID","RECOVERY_EVIDENCE_STALE","RECOVERY_LEDGER_CHANGED"];
    const block = allowed.includes(reason) ? reason : safeCycleError(e);
    const operator = ["CALENDAR_NOT_READY","CALENDAR_AUTHORITY_CONFLICT","SPECIAL_SESSION_NOT_SUPPORTED","GREEKS_CONFIG_REQUIRED",
      "ENTRY_METADATA_INVALID","EXIT_CONFIG_REQUIRED","RISK_POLICY_REQUIRED","ACCOUNT_NOT_READY","TRADING_DAY_CONFIG_REQUIRED",
      "PAPER_KITE_ACCOUNT_CONFLICT","RECOVERY_CONFIG_REQUIRED","RECOVERY_ALREADY_REQUIRED","RECOVERY_HOST_MISMATCH",
      "MONTHLY_METADATA_REQUIRED","KILL_SWITCH_ACTIVE","KITE_SESSION_REQUIRED","DATA_MODE_REQUIRED"].includes(block);
    return { ...waitingForEntry(block), ...details(), ...(deps.calendar ? { readinessAction: operator ? "OPERATOR_ACTION" as const : "AUTOMATIC_RETRY" as const } : {}) };
  }
}

/** One monitoring session/timer per account. Readiness never rewrites lifecycle. */
export class PaperDefaultSessionService<T> {
  private readonly pending = new Map<string, Promise<T & PaperEntryReadiness>>();
  constructor(private readonly deps: DefaultStartDependencies<T>) {}
  async config(asset: unknown): Promise<Readonly<PaperMonitoringConfig>> {
    if (asset !== "NIFTY") throw new Error("DEFAULT_PAPER_ASSET_UNAVAILABLE");
    if (this.deps.hasExplicitConfiguration()) return resolveDefaultPaperConfig(asset, await this.deps.configurations());
    return resolveDefaultPaperConfig(asset, [builtInNiftyPaperConfig(resolvePersonalPaperAccount(await this.deps.accounts()))]);
  }
  async start(asset: unknown): Promise<T & PaperEntryReadiness> {
    const config = await this.config(asset);
    const pending = this.pending.get(config.accountId);
    if (pending) return pending;
    const work = this.startCaptured(config);
    this.pending.set(config.accountId, work);
    try { return await work; } finally { if (this.pending.get(config.accountId) === work) this.pending.delete(config.accountId); }
  }
  private async startCaptured(config: PaperMonitoringConfig): Promise<T & PaperEntryReadiness> {
    // Persistence, ownership, configuration and mode are fatal Start gates.
    const session = await this.deps.start(config);
    const readiness = await this.deps.readiness(session, config, true);
    this.deps.schedule(config.accountId, this.deps.sessionId(session), config.intervalMs);
    return { ...session, ...readiness };
  }
}
