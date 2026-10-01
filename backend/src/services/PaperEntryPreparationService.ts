import type { Connection } from "mongoose";
import { z } from "zod";
import type { ExecutionHostContext } from "../domain/ExecutionHostContext";
import { requireExecutionHost } from "../domain/ExecutionHostContext";
import { executionModels } from "../db/executionModels";
import { RecoveryBarrierService } from "./RecoveryBarrierService";
import { ReconciliationService } from "./ReconciliationService";
import { paperHistoryModels } from "./PaperEntryOrchestrator";
import { bindNsePaperKiteIdentity, NSE_PAPER_ACCOUNT_ID } from "./NsePaperAccountService";
import type { KiteReadOnlyAdapter } from "../brokers/KiteReadOnlyAdapter";

const receiptSchema = z.object({ status: z.enum(["READY", "WAITING"]), reason: z.string().nullable(),
  attemptedAt: z.string().datetime(), completedAt: z.string().datetime() }).strict();
export type PaperPreparation = z.infer<typeof receiptSchema>;
const cadence = 300000;
export function preparationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (["KITE_SESSION_REQUIRED", "PAPER_KITE_ACCOUNT_CONFLICT", "RECOVERY_ALREADY_REQUIRED", "RECOVERY_HOST_MISMATCH",
    "RECOVERY_PROOF_INVALID", "RECOVERY_EVIDENCE_STALE", "RECOVERY_LEDGER_CHANGED", "RECOVERY_CONFIG_REQUIRED",
    "SESSION_STOPPED", "SESSION_REPLACED", "SESSION_CONFIG_CONFLICT", "PAPER_ONLY", "ACCOUNT_NOT_READY"].includes(message)) return message;
  if (["AUTHENTICATION_FAILED", "SESSION_REQUIRED"].includes(message)) return "KITE_SESSION_REQUIRED";
  return "RECONCILIATION_UNAVAILABLE";
}

/** Runs only from explicit Start or the normal five-minute cycle. All broker reads
 * are outside the existing services' Mongo transactions. GET calls read() only. */
export class PaperEntryPreparationService {
  private pending = new Map<string, { sessionId: string; work: Promise<PaperPreparation> }>();
  private readonly models;
  private readonly history;
  constructor(private readonly connection: Connection, private readonly deps: {
    host: ExecutionHostContext; clock(): Date;
    active(sessionId: string): Promise<{ get(path: string): any }>;
    reader(): Promise<Pick<KiteReadOnlyAdapter, "brokerAccountId" | "getSnapshot">>;
  }) {
    requireExecutionHost(deps.host); this.models = executionModels(connection); this.history = paperHistoryModels(connection);
  }
  private async active(accountId: string, sessionId: string) {
    const row = await this.deps.active(sessionId);
    if (row.get("accountId") !== accountId || row.get("executionMode") !== "PAPER") throw new Error("SESSION_CONFIG_CONFLICT");
    return row;
  }
  async read(accountId: string, sessionId: string): Promise<PaperPreparation | null> {
    const row = await this.active(accountId, sessionId), parsed = receiptSchema.safeParse(row.get("entryPreparation"));
    if (!parsed.success) return null;
    const now = +this.deps.clock(), at = Date.parse(parsed.data.completedAt);
    if (at > now || now - at > cadence) return { ...parsed.data, status: "WAITING", reason: "READINESS_PREPARATION_REQUIRED" };
    return parsed.data;
  }
  async prepare(accountId: string, sessionId: string): Promise<PaperPreparation> {
    await this.active(accountId, sessionId);
    const pending = this.pending.get(accountId);
    if (pending) {
      if (pending.sessionId !== sessionId) throw new Error("SESSION_CONFIG_CONFLICT");
      return pending.work;
    }
    const work = this.attempt(accountId, sessionId);
    this.pending.set(accountId, { sessionId, work });
    try { return await work; } finally { if (this.pending.get(accountId)?.work === work) this.pending.delete(accountId); }
  }
  private async attempt(accountId: string, sessionId: string): Promise<PaperPreparation> {
    const previous = await this.read(accountId, sessionId);
    if (previous && previous.reason !== "READINESS_PREPARATION_REQUIRED") return previous;
    const attemptedAt = this.deps.clock().toISOString(), scope = { accountId, executionMode: "PAPER" as const };
    let status: PaperPreparation["status"] = "WAITING", reason: string | null = null;
    try {
      const account = await this.models.TradingAccount.findOne(scope).orFail();
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      const reader = await this.deps.reader(); // Authenticated profile identity, never input from HTTP.
      await this.active(accountId, sessionId);
      const identity = account.get("reconciliationConfig.brokerAccountId");
      if (identity && identity !== reader.brokerAccountId) throw new Error("PAPER_KITE_ACCOUNT_CONFLICT");
      if (!identity) {
        if (accountId !== NSE_PAPER_ACCOUNT_ID) throw new Error("RECOVERY_CONFIG_REQUIRED");
        await bindNsePaperKiteIdentity(this.connection, reader.brokerAccountId);
      }
      const recovery = new RecoveryBarrierService(this.connection, scope, this.deps.clock, this.deps.host);
      const state = account.get("recoveryState");
      if (state?.startupId !== this.deps.host.startupId || state?.status !== "READY")
        await recovery.beginRecovery(accountId, state?.startupId === this.deps.host.startupId ? state.commandKey : "phase6a-startup");
      await this.active(accountId, sessionId);
      const snapshot = await reader.getSnapshot();
      await this.active(accountId, sessionId);
      const report = await new ReconciliationService(this.connection, scope, this.deps.clock, this.deps.host).reconcileAccount(accountId, snapshot);
      if (report.report.classification !== "MATCHED") {
        reason = report.report.classification === "DISCREPANCY" ? "RECONCILIATION_DISCREPANCY" : "RECONCILIATION_INCOMPLETE";
      } else {
        await this.active(accountId, sessionId);
        const completed = await recovery.completeRecovery(accountId, report.recordId);
        if (completed.status === "READY") status = "READY";
        else reason = "RECOVERY_REQUIRED";
      }
    } catch (error) { reason = preparationError(error); }
    await this.active(accountId, sessionId);
    const result = { status, reason, attemptedAt, completedAt: this.deps.clock().toISOString() };
    const saved = await this.history.Session.updateOne({ accountId, sessionId, executionMode: "PAPER",
      startupId: this.deps.host.startupId, status: "RUNNING" }, { $set: { entryPreparation: result } });
    if (saved.matchedCount !== 1) throw new Error("SESSION_REPLACED");
    return result;
  }
}
