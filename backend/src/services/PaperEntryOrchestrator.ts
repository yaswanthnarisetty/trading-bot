import { randomUUID } from "node:crypto";
import type { Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { assertPaperHistoryIndexes } from "../db/paperSessionFence";
import { checkTransactionCapability } from "../db/executionReadiness";
import { withExecutionHost } from "../db/executionHost";
import { reconciliationAdmissionHealthy } from "../db/reconciliationAdmission";
import { requireExecutionHost, type ExecutionHostContext } from "../domain/ExecutionHostContext";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { capturePaperConfig, cycleIdentity, decisionWindow, digest, entryCutoffAt, entryCalendarBlock, safeCycleError, type PaperSessionConfig } from "../domain/paperOrchestration";
import type { AnalyticsOutcome } from "../domain/marketAnalytics";
import { MonitoringSessionSchema } from "../models/MonitoringSession";
import { SignalLogSchema } from "../models/SignalLog";
import { CandidateIntentAdapter } from "./CandidateIntentAdapter";
import { RiskAdmissionService } from "./RiskAdmissionService";
import { EntryProtectionService } from "./EntryProtectionService";
import { OrderManager } from "./OrderManager";
import { FillProcessor } from "./FillProcessor";
import { PaperBrokerAdapter } from "../brokers/PaperBrokerAdapter";
import { evaluateWithPhase5LLM, type Phase5LLMConfig, type Phase5LLMTransport } from "./Phase5LLMService";

export interface PaperMarketProvider {
  prepare(config: Readonly<PaperSessionConfig>): Promise<void>;
  capture(config: Readonly<PaperSessionConfig>): Promise<{ analytics: AnalyticsOutcome; evaluatedAt: string; expiry: string; assertCurrent?: () => void }>;
  assertCurrent(config: Readonly<PaperSessionConfig>): void;
  assertSessionCurrent?(config: Readonly<PaperSessionConfig>): void;
}
export interface PaperOrchestrationDependencies {
  host: ExecutionHostContext; clock: () => Date; market: PaperMarketProvider;
  transport: Phase5LLMTransport; llmConfig: () => Phase5LLMConfig;
  broker: (scope: ExecutionScope) => PaperBrokerAdapter;
}
export function paperHistoryModels(connection: Connection) {
  return {
    Session: connection.models.MonitoringSession ?? connection.model("MonitoringSession", MonitoringSessionSchema),
    Cycle: connection.models.SignalLog ?? connection.model("SignalLog", SignalLogSchema),
  };
}
export class PaperEntryOrchestrator {
  readonly history; private readonly models;
  private readonly running = new Set<string>(); private readonly starting = new Map<string, Promise<any>>();
  constructor(private readonly connection: Connection, private readonly deps: PaperOrchestrationDependencies) {
    requireExecutionHost(deps.host); this.models = executionModels(connection); this.history = paperHistoryModels(connection);
  }
  async initialize() {
    await this.history.Session.createIndexes(); await this.history.Cycle.createIndexes();
  }
  private scope(accountId: string): ExecutionScope { return { accountId, executionMode: "PAPER" }; }
  async assertReady(config: PaperSessionConfig) {
    await assertPaperHistoryIndexes(this.connection);
    await assertExecutionIndexes(this.connection);
    if (!(await checkTransactionCapability(this.connection)).supported) throw new Error("ACCOUNT_NOT_READY");
    const session = await this.connection.startSession();
    try { await session.withTransaction(() => withExecutionHost(session, this.deps.host, async () => {
      const account = await this.models.TradingAccount.findOne(this.scope(config.accountId)).session(session).orFail();
      if (account.get("broker") !== "PAPER" || account.get("admissionStatus") !== "PAPER_READY") throw new Error("ACCOUNT_NOT_READY");
      const policy = entryRiskPolicySchema.safeParse(account.get("entryRiskPolicy"));
      if (!policy.success || policy.data.maxDailyLossMinor === undefined || policy.data.policyVersion !== account.get("policyVersion")) throw new Error("RISK_POLICY_REQUIRED");
      // Automatic orchestration always opts into the approved current-host barrier.
      // Legacy isolated service callers may still use the approved opt-out path.
      if (!account.get("reconciliationConfig") || account.get("recoveryState.status") !== "READY") throw new Error("RECOVERY_REQUIRED");
      if (!await reconciliationAdmissionHealthy(this.connection, session, this.scope(config.accountId), account.toObject())) throw new Error("RECONCILIATION_REQUIRED");
    })); } finally { await session.endSession(); }
  }
  async start(input: unknown): Promise<Record<string, any>> {
    const config = capturePaperConfig(input), key = config.accountId;
    const pending = this.starting.get(key);
    if (pending) { await pending; return this.start(config); }
    const operation = this.startCaptured(config); this.starting.set(key, operation);
    try { return await operation; } finally { if (this.starting.get(key) === operation) this.starting.delete(key); }
  }
  private async startCaptured(config: Readonly<PaperSessionConfig>) {
    const existing = await this.history.Session.findOne({ accountId: config.accountId, executionMode: "PAPER", status: "RUNNING" });
    if (existing) {
      if (existing.get("startupId") !== this.deps.host.startupId) throw new Error("RECOVERY_REQUIRED");
      if (existing.get("configFingerprint") !== digest(config)) throw new Error("SESSION_CONFIG_CONFLICT");
      return existing.toObject();
    }
    await this.assertReady(config); await this.deps.market.prepare(config); this.deps.market.assertCurrent(config);
    const now = this.deps.clock();
    try {
      const row = await this.history.Session.create({ sessionId: randomUUID(), accountId: config.accountId, executionMode: "PAPER",
        startupId: this.deps.host.startupId, config, strategyFamily: config.strategyConfig.strategyFamily, configFingerprint: digest(config), asset: config.asset, dataMode: config.dataMode,
        startTime: now.toISOString(), status: "RUNNING", paperCapital: 0, totalSignals: 0, totalTrades: 0,
        winRate: 0, paperPnL: 0, ticksSkipped: 0, blockingReason: "EXITS_DEFERRED_TO_PHASE_6B" });
      return row.toObject();
    } catch (e) {
      if ((e as {code?:number}).code !== 11000) throw e;
      const winner = await this.history.Session.findOne({ accountId: config.accountId, status: "RUNNING", executionMode: "PAPER" }).orFail();
      if (winner.get("startupId") !== this.deps.host.startupId || winner.get("configFingerprint") !== digest(config)) throw new Error("SESSION_CONFIG_CONFLICT");
      return winner.toObject();
    }
  }
  async stop(sessionId: string) {
    // This write conflicts with each pre-dispatch financial transaction's session fence.
    return this.history.Session.findOneAndUpdate({ sessionId, executionMode: "PAPER" },
      { $set: { status: "STOPPED", stopTime: this.deps.clock().toISOString(), blockingReason: "ENTRY_STOPPED_EXPOSURE_RETAINED" } }, { new: true }).orFail();
  }
  async activeForAccount(accountId: string) {
    if (!/^PAPER:[^\s]+$/.test(accountId)) throw new Error("EXPLICIT_PAPER_ACCOUNT_REQUIRED");
    return this.history.Session.findOne({ accountId, executionMode: "PAPER", status: "RUNNING" }).lean();
  }
  async active(sessionId: string) {
    const row = await this.history.Session.findOne({ sessionId, executionMode: "PAPER", status: "RUNNING" });
    if (!row) throw new Error("SESSION_STOPPED");
    if (row.get("startupId") !== this.deps.host.startupId) throw new Error("SESSION_REPLACED");
    return row;
  }
  async runEvaluationCycle(sessionId: string, requestedAt = this.deps.clock()) {
    const row = await this.active(sessionId), config = capturePaperConfig(row.get("config"));
    if (this.running.has(config.accountId)) return { cycleId: cycleIdentity(config, requestedAt), outcome: "SKIPPED", reason: "CYCLE_IN_PROGRESS" };
    this.running.add(config.accountId);
    try { return await this.runCaptured(sessionId, config, requestedAt); }
    finally { this.running.delete(config.accountId); }
  }
  private async finish(cycleId: string, outcome: string, reason: string, extra: Record<string, unknown> = {}) {
    const cycle = await this.history.Cycle.findOneAndUpdate({ cycleId, executionMode: "PAPER" },
      { $set: { outcome, reason, ...extra } }, { new: true }).orFail();
    await this.history.Session.updateOne({ sessionId: cycle.get("sessionId"), startupId: this.deps.host.startupId },
      { $set: { lastCycleAt: this.deps.clock(), lastCycleOutcome: outcome, blockingReason: reason, lastCycleId: cycleId } });
    return { cycleId, outcome, reason, intentId: cycle.get("intentId"), positionId: cycle.get("positionId") };
  }
  private async runCaptured(sessionId: string, config: Readonly<PaperSessionConfig>, requestedAt: Date) {
    await assertPaperHistoryIndexes(this.connection);
    const cycleId = cycleIdentity(config, requestedAt), previous = await this.history.Cycle.findOne({ cycleId });
    if (previous) {
      if (previous.get("configFingerprint") !== digest(config)) throw new Error("DECISION_CONFLICT");
      // A replay never reruns the LLM/adaptation/admission and never retries an uncertain send.
      return { cycleId, outcome: previous.get("outcome"), reason: previous.get("reason"), replay: true,
        intentId: previous.get("intentId"), positionId: previous.get("positionId") };
    }
    try { await this.history.Cycle.create({ cycleId, accountId: config.accountId, executionMode: "PAPER", sessionId,
      startupId: this.deps.host.startupId, asset: config.asset, dataMode: config.dataMode,
      config, configFingerprint: digest(config), window: decisionWindow(requestedAt), timestamp: requestedAt, outcome: "EVALUATING" }); }
    catch (e) { if ((e as {code?:number}).code === 11000) return {cycleId,outcome:"SKIPPED",reason:"CYCLE_ALREADY_CLAIMED"}; throw e; }
    try {
      await this.active(sessionId); await this.assertReady(config);
      const block = entryCalendarBlock(config, this.deps.clock());
      if (block) return await this.finish(cycleId, "HOLD", block);
      if (await this.history.Cycle.exists({ accountId: config.accountId, outcome: "ATTENTION", intentId: { $exists: true } }))
        return await this.finish(cycleId, "HOLD", "EXISTING_ENTRY_REQUIRES_ATTENTION");
      const llmConfig = structuredClone(this.deps.llmConfig());
      const captured = await this.deps.market.capture(config); this.deps.market.assertCurrent(config);
      if (captured.analytics.available && (captured.analytics.snapshot.dataMode !== config.dataMode || captured.analytics.snapshot.underlying !== config.asset))
        throw new Error("DATA_MODE_REQUIRED");
      await this.active(sessionId);
      const decision = await evaluateWithPhase5LLM({ ...captured, strategyConfig: config.strategyConfig, llmConfig },
        this.deps.transport, () => this.deps.clock().getTime());
      // Store bounded structured interpretation, never prompts, credentials or hidden reasoning.
      await this.history.Cycle.updateOne({ cycleId, outcome: "EVALUATING" },
        { $set: { evaluatedAt: captured.evaluatedAt, decision: decision.evidence, outcome: "DECIDED" } });
      if (decision.action === "HOLD" || decision.evidence.strategyResult.action !== "CANDIDATE")
        return await this.finish(cycleId, "HOLD", decision.evidence.reason);
      await this.active(sessionId); this.deps.market.assertCurrent(config);
      const lateBlock = entryCalendarBlock(config, this.deps.clock());
      if (lateBlock || decisionWindow(this.deps.clock()) !== decisionWindow(requestedAt))
        return await this.finish(cycleId, "HOLD", lateBlock ?? "DECISION_WINDOW_EXPIRED");
      captured.assertCurrent?.();
      const candidate = decision.evidence.strategyResult.candidate;
      const scope = this.scope(config.accountId);
      const chain = await new CandidateIntentAdapter(this.connection, scope, this.deps.clock).adapt(candidate, {
        strategyInstanceId: `nse:${config.asset}`, sessionId,
        entryCutoffAt: entryCutoffAt(config, requestedAt),
        validUntil: new Date(Date.parse(candidate.evaluatedAt) + 60000),
        orchestration: { cycleId, sessionId, startupId: this.deps.host.startupId } });
      await this.history.Cycle.updateOne({cycleId},{$set:{intentId:chain.intentId,positionId:chain.positionId}});
      await this.active(sessionId);
      // Revalidate captured ownership after adaptation and all intervening awaits.
      captured.assertCurrent?.();
      const admission = await new RiskAdmissionService(this.connection, scope, this.deps.clock, this.deps.host).authorizeEntry(chain.intentId, captured.assertCurrent);
      if (admission.status !== "AUTHORIZED") return await this.finish(cycleId,"REJECTED",admission.reason);
      return await this.progressEntry(cycleId);
    } catch (e) {
      // Durable chains remain intact. An error after adaptation is never reported as an ordinary HOLD.
      const signal = await this.models.StrategySignal.findOne({ accountId: config.accountId, "orchestration.cycleId": cycleId });
      const intent = signal && await this.models.OrderIntent.findOne({ accountId: config.accountId, signalId: signal.get("signalId") });
      return await this.finish(cycleId, intent ? "ATTENTION" : "ERROR", safeCycleError(e), intent ? {intentId:intent.get("intentId")} : {});
    }
  }
  /** Explicit durable progression/recovery hook. Retained fills always ingest, even after stop.
   * Unclaimed children need an active current-host session and all original admission gates.
   */
  async progressEntry(cycleId: string) {
    const cycle = await this.history.Cycle.findOne({cycleId,executionMode:"PAPER"}).orFail();
    if (!cycle.get("intentId") || !["DECIDED","ENTRY","ATTENTION"].includes(cycle.get("outcome"))) throw new Error("DECISION_CONFLICT");
    const scope = this.scope(cycle.get("accountId")), sessionId = cycle.get("sessionId");
    const orders = await this.models.BrokerOrder.find({...scope,intentId:cycle.get("intentId")});
    const processor = new FillProcessor(this.connection,scope,this.deps.clock);
    const broker = this.deps.broker(scope);
    if (!(broker instanceof PaperBrokerAdapter)) throw new Error("PAPER_ONLY");
    const manager = new OrderManager(this.connection,scope,broker,this.deps.clock,this.deps.host);
    const protection = new EntryProtectionService(this.connection,scope,this.deps.clock);
    let failure: string | undefined;
    for (const original of orders.sort((a,b)=>a.get("side")===b.get("side")?0:a.get("side")==="BUY"?-1:1)) {
      const orderId = original.get("orderId");
      // Retained receipt processing is independent of kill/readiness/session gates.
      const retained = await processor.processRetained(orderId);
      if (retained.failedTradeKeys.length) { failure="FILL_PROCESSING_REQUIRED"; break; }
      try {
        const active = await this.active(sessionId), config = capturePaperConfig(active.get("config"));
        if (entryCalendarBlock(config,this.deps.clock())) {failure="ENTRY_WINDOW_CLOSED";continue;}
        if (!original.get("submissionClaim")) {
          // Preserve session/mode gates, but admitted identity no longer depends on the mutable master.
          this.deps.market.assertSessionCurrent?.(config);
          if (original.get("side")==="SELL") await protection.advance(orderId);
          await manager.submit(orderId);
        }
      } catch(e) { failure=safeCycleError(e); }
      const consumed=await processor.processRetained(orderId);
      if(consumed.failedTradeKeys.length) { failure="FILL_PROCESSING_REQUIRED";break; }
    }
    const current=await this.models.BrokerOrder.find({...scope,intentId:cycle.get("intentId")});
    const complete=current.length>0 && current.every(o=>o.get("filledUnits")===o.get("quantityUnits") && o.get("knowledge")!=="UNKNOWN");
    const reason=complete?"ENTRY_FILLED_EXITS_DEFERRED":failure??(current.some(o=>o.get("knowledge")==="UNKNOWN")?"UNKNOWN_ORDER_REQUIRES_ATTENTION":"INCOMPLETE_ENTRY_REQUIRES_ATTENTION");
    return this.finish(cycleId,complete?"ENTRY":"ATTENTION",reason);
  }
}
