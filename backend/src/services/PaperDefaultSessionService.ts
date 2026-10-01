import { DEFAULT_LONG_SELECTION } from "../domain/strategyEvaluation";
import { capturePaperConfig, type PaperSessionConfig } from "../domain/paperOrchestration";

export function parseDefaultStartRequest(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof (body as { asset?: unknown }).asset !== "string")
    throw new Error("ASSET_ONLY_START_REQUIRED");
  return (body as { asset: string }).asset;
}

/** An operator-approved server file supplies the account, calendar and rate assumptions.
 * This resolver chooses one validated default; it never invents an open market date. */
export function resolveDefaultPaperConfig(asset: unknown, configured: readonly PaperSessionConfig[]): Readonly<PaperSessionConfig> {
  if (asset !== "NIFTY") throw new Error("DEFAULT_PAPER_ASSET_UNAVAILABLE");
  const choices = configured.filter(c => c.asset === asset && c.executionMode === "PAPER"
    && c.dataMode === "KITE_REAL" && c.strategyConfig.strategyFamily === "LONG_OPTION");
  if (choices.length !== 1) throw new Error("DEFAULT_PAPER_CONFIG_REQUIRED");
  const config = capturePaperConfig(choices[0]);
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

export function defaultPaperSummary(config: Readonly<PaperSessionConfig>) {
  return { asset: config.asset, accountId: config.accountId, configId: config.configId,
    executionMode: config.executionMode, dataMode: config.dataMode,
    strategyFamily: config.strategyConfig.strategyFamily, intervalMs: config.intervalMs,
    entryWindowStartMinuteIST: 555 + config.strategyConfig.openingBlockMinutes,
    entryCutoffMinuteIST: config.entryCutoffMinuteIST,
    minConfidence: config.strategyConfig.minConfidence,
    longOptionSelection: config.strategyConfig.longOptionSelection ?? DEFAULT_LONG_SELECTION };
}

export interface DefaultStartDependencies<T> {
  configurations(): Promise<readonly PaperSessionConfig[]>;
  connected(): boolean;
  dataMode(): string;
  active(accountId: string): Promise<T | null>;
  recover(configId: string): Promise<{ status: string }>;
  accountGate(accountId: string): Promise<void>;
  start(config: PaperSessionConfig): Promise<T>;
  schedule(accountId: string, sessionId: string, intervalMs: number): void;
  sessionId(session: T): string;
}

/** The in-process claim prevents two rapid HTTP requests from starting competing
 * recovery generations. The durable session uniqueness remains the final guard. */
export class PaperDefaultSessionService<T> {
  private readonly pending = new Map<string, Promise<T>>();
  constructor(private readonly deps: DefaultStartDependencies<T>) {}
  async config(asset: unknown) { return resolveDefaultPaperConfig(asset, await this.deps.configurations()); }
  async start(asset: unknown): Promise<T> {
    const config = await this.config(asset);
    const pending = this.pending.get(config.accountId);
    if (pending) return pending;
    const work = this.startCaptured(config);
    this.pending.set(config.accountId, work);
    try { return await work; } finally { if (this.pending.get(config.accountId) === work) this.pending.delete(config.accountId); }
  }
  private async startCaptured(config: PaperSessionConfig): Promise<T> {
    if (!this.deps.connected()) throw new Error("KITE_SESSION_REQUIRED");
    if (this.deps.dataMode() !== "KITE_REAL") throw new Error("DATA_MODE_REQUIRED");
    await this.deps.accountGate(config.accountId);
    if (!await this.deps.active(config.accountId)) {
      const ready = await this.deps.recover(config.configId);
      if (ready.status !== "READY") throw new Error(ready.status === "INCOMPLETE"
        ? "RECONCILIATION_INCOMPLETE" : "RECONCILIATION_NOT_MATCHED");
    }
    const session = await this.deps.start(config);
    this.deps.schedule(config.accountId, this.deps.sessionId(session), config.intervalMs);
    return session;
  }
}
