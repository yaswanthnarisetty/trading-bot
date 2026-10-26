import { randomUUID } from "node:crypto";
import type { Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes, type VerifiedExecutionIndexes } from "../db/executionIndexes";
import { assertPaperHistoryIndexes } from "../db/paperSessionFence";
import { checkTransactionCapability, type TransactionCapability } from "../db/executionReadiness";
import { withExecutionHost } from "../db/executionHost";
import { reconciliationAdmissionHealthy } from "../db/reconciliationAdmission";
import { requireExecutionHost, type ExecutionHostContext } from "../domain/ExecutionHostContext";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { capturePaperConfig, cycleIdentity, decisionWindow, digest, entryCutoffAt, entryCalendarBlock, safeCycleError, type PaperSessionConfig } from "../domain/paperOrchestration";
import type { AnalyticsOutcome } from "../domain/marketAnalytics";
import { MonitoringSessionSchema } from "../models/MonitoringSession";
import { SignalLogSchema } from "../models/SignalLog";
import { CandidateIntentAdapter, KITE_PAPER_LONG_OPTION_DECISION_LIFETIME_MS } from "./CandidateIntentAdapter";
import { RiskAdmissionService } from "./RiskAdmissionService";
import { RiskSettlementService } from "./RiskSettlementService";
import { EntryProtectionService } from "./EntryProtectionService";
import { OrderManager } from "./OrderManager";
import { FillProcessor } from "./FillProcessor";
import { PaperBrokerAdapter } from "../brokers/PaperBrokerAdapter";
import { evaluateWithPhase5LLM, revalidatePhase5Candidate, type Phase5LLMConfig, type Phase5LLMTransport } from "./Phase5LLMService";
import { captureMonitoringConfig, completePaperEntryConfig, type PaperMonitoringConfig } from "../domain/paperMonitoring";
import { NSE_PAPER_ACCOUNT_ID } from "./NsePaperAccountService";
import { projectPaperDisplayAnalytics } from "./PaperDisplayAnalytics";
import { issueEntryQuoteRenewal, type EntryQuoteRenewal } from "../db/entryQuoteRenewal";

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
  entryConfig?: (config: PaperMonitoringConfig) => Promise<PaperSessionConfig>;
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
  async eligibleMonitoringAccounts() {
    return this.models.TradingAccount.find({executionMode:"PAPER",broker:"PAPER",accountId:{$regex:/^PAPER:[^\s]+$/},
      admissionStatus:{$in:["PAPER_READY","RECOVERING","HALTED"]}})
      .select({accountId:1,_id:0}).limit(2).lean<{accountId:string}[]>();
  }
  async canonicalMonitoringAccounts() {
    return this.models.TradingAccount.find({executionMode:"PAPER",broker:"PAPER",accountId:NSE_PAPER_ACCOUNT_ID,
      admissionStatus:{$in:["PAPER_READY","RECOVERING","HALTED"]}})
      .select({accountId:1,_id:0}).limit(2).lean<{accountId:string}[]>();
  }
  async assertReady(config: PaperSessionConfig) {
    const [, indexProof, reconciliationProof, transactions] = await Promise.all([
      assertPaperHistoryIndexes(this.connection), assertExecutionIndexes(this.connection),
      assertExecutionIndexes(this.connection, "RECONCILIATION"), checkTransactionCapability(this.connection),
    ]);
    if (!transactions.supported) throw new Error("ACCOUNT_NOT_READY");
    const session = await this.connection.startSession();
    try { await session.withTransaction(() => withExecutionHost(session, this.deps.host, async () => {
      const account = await this.models.TradingAccount.findOne(this.scope(config.accountId)).session(session).orFail();
      if (account.get("broker") !== "PAPER" || account.get("admissionStatus") !== "PAPER_READY") throw new Error("ACCOUNT_NOT_READY");
      const policy = entryRiskPolicySchema.safeParse(account.get("entryRiskPolicy"));
      if (!policy.success || policy.data.maxDailyLossMinor === undefined || policy.data.policyVersion !== account.get("policyVersion")) throw new Error("RISK_POLICY_REQUIRED");
      // Automatic orchestration always opts into the approved current-host barrier.
      // Legacy isolated service callers may still use the approved opt-out path.
      if (!account.get("reconciliationConfig") || account.get("recoveryState.status") !== "READY") throw new Error("RECOVERY_REQUIRED");
      if (!await reconciliationAdmissionHealthy(this.connection, session, this.scope(config.accountId), account.toObject(), reconciliationProof)) throw new Error("RECONCILIATION_REQUIRED");
    })); } finally { await session.endSession(); }
    return { indexProof, reconciliationProof, transactionProof: transactions };
  }
  private async hasBlockingEntryAttention(accountId: string): Promise<boolean> {
    const scope = this.scope(accountId);
    const attention = await this.history.Cycle.find({ ...scope, outcome: "ATTENTION", intentId: { $exists: true } })
      .select({ intentId: 1 });
    if (!attention.length) return false;
    const intentIds = [...new Set(attention.map(cycle => String(cycle.get("intentId"))))];
    const [intents, orders] = await Promise.all([
      this.models.OrderIntent.find({ ...scope, intentId: { $in: intentIds } }),
      this.models.BrokerOrder.find({ ...scope, intentId: { $in: intentIds } }),
    ]);
    const now = +this.deps.clock();
    const settlement = new RiskSettlementService(this.connection, scope, this.deps.clock);
    for (const intentId of intentIds) {
      const intent = intents.find(row => row.get("intentId") === intentId);
      if (intent?.get("state") === "ABORTED") continue;
      const children = orders.filter(row => row.get("intentId") === intentId);
      const evidenceExpiry = intent?.get("entryPlan.marketEvidenceExpiresAt");
      const deadline = intent?.get("deadline");
      // A never-claimed child past either dispatch deadline has no submission
      // path. Release its risk only after an atomic, ledger-proved abort.
      if (!intent || !children.length || !(evidenceExpiry instanceof Date) || !(deadline instanceof Date)
        || Math.min(+evidenceExpiry, +deadline) >= now) return true;
      if (children.some(order => !["READY", "PLANNED"].includes(order.get("phase")) || order.get("knowledge") !== "KNOWN"
        || order.get("cancellation") !== "NONE" || order.get("filledUnits") !== 0
        || order.get("submissionClaim") || order.get("submissionOutcome") || order.get("brokerOrderId"))) return true;
      try { await settlement.abortExpiredUnclaimedEntry(intentId); }
      catch { return true; } // Failed proof or persistence leaves the original hold intact.
    }
    return false;
  }
  async start(input: unknown): Promise<Record<string, any>> {
    const config = capturePaperConfig(input), key = config.accountId;
    const pending = this.starting.get(key);
    if (pending) { await pending; return this.start(config); }
    const operation = this.startCaptured(config); this.starting.set(key, operation);
    try { return await operation; } finally { if (this.starting.get(key) === operation) this.starting.delete(key); }
  }
  /** Monitoring creation proves storage/account ownership, not tradable market readiness. */
  async startMonitoring(input: unknown): Promise<Record<string, any>> {
    const config = captureMonitoringConfig(input), pending = this.starting.get(config.accountId);
    if (config.dataMode !== "KITE_REAL") throw new Error("DATA_MODE_REQUIRED");
    if (pending) { await pending; return this.startMonitoring(config); }
    const operation = this.startCaptured(config, true); this.starting.set(config.accountId, operation);
    try { return await operation; } finally { if (this.starting.get(config.accountId) === operation) this.starting.delete(config.accountId); }
  }
  async entryConfiguration(input: unknown) {
    const config = captureMonitoringConfig(input);
    const complete = this.deps.entryConfig ? await this.deps.entryConfig(config) : completePaperEntryConfig(config);
    // A metadata refresh cannot switch the captured account, strategy or execution terms.
    const withoutMetadata = (c: PaperMonitoringConfig) => ({ ...c, calendar: null, riskFreeRate: null, riskFreeRateVersion: null });
    if (digest(withoutMetadata(config)) !== digest(withoutMetadata(complete))) throw new Error("SESSION_CONFIG_CONFLICT");
    return capturePaperConfig(complete);
  }
  private async startCaptured(config: Readonly<PaperMonitoringConfig>, monitoring = false) {
    if (monitoring) {
      await assertPaperHistoryIndexes(this.connection); await assertExecutionIndexes(this.connection);
      if (!(await checkTransactionCapability(this.connection)).supported) throw new Error("ACCOUNT_NOT_READY");
      const account = await this.models.TradingAccount.findOne(this.scope(config.accountId)).lean<{broker:string;admissionStatus:string}>();
      if (!account || account.broker !== "PAPER" || account.admissionStatus === "DISABLED") throw new Error("PAPER_ACCOUNT_REQUIRED");
    }
    const existing = await this.history.Session.findOne({ accountId: config.accountId, executionMode: "PAPER", status: "RUNNING" });
    if (existing) {
      if (existing.get("startupId") !== this.deps.host.startupId) throw new Error("RECOVERY_REQUIRED");
      if (existing.get("configFingerprint") !== digest(config)) throw new Error("SESSION_CONFIG_CONFLICT");
      return existing.toObject();
    }
    if (!monitoring) {
      const entry = capturePaperConfig(config);
      await this.assertReady(entry); await this.deps.market.prepare(entry); this.deps.market.assertCurrent(entry);
    }
    const now = this.deps.clock();
    try {
      const row = await this.history.Session.create({ sessionId: randomUUID(), accountId: config.accountId, executionMode: "PAPER",
        startupId: this.deps.host.startupId, config, strategyFamily: config.strategyConfig.strategyFamily, configFingerprint: digest(config), asset: config.asset, dataMode: config.dataMode,
        startTime: now.toISOString(), status: "RUNNING", paperCapital: 0, totalSignals: 0, totalTrades: 0,
        winRate: 0, paperPnL: 0, ticksSkipped: 0, blockingReason: "WAITING_FOR_FIRST_CYCLE" });
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
    const row = await this.active(sessionId), config = await this.entryConfiguration(row.get("config"));
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
    const owner = await this.active(sessionId);
    const sessionConfigFingerprint = owner.get("configFingerprint");
    const cycleId = cycleIdentity(config, requestedAt), previous = await this.history.Cycle.findOne({ cycleId });
    if (previous) {
      if (previous.get("configFingerprint") !== digest(config)) throw new Error("DECISION_CONFLICT");
      // A replay never reruns the LLM/adaptation/admission and never retries an uncertain send.
      return { cycleId, outcome: previous.get("outcome"), reason: previous.get("reason"), replay: true,
        intentId: previous.get("intentId"), positionId: previous.get("positionId") };
    }
    try { await this.history.Cycle.create({ cycleId, accountId: config.accountId, executionMode: "PAPER", sessionId,
      startupId: this.deps.host.startupId, asset: config.asset, dataMode: config.dataMode,
      config, configFingerprint: digest(config), sessionConfigFingerprint,
      window: decisionWindow(requestedAt), timestamp: requestedAt, outcome: "EVALUATING" }); }
    catch (e) { if ((e as {code?:number}).code === 11000) return {cycleId,outcome:"SKIPPED",reason:"CYCLE_ALREADY_CLAIMED"}; throw e; }
    try {
      await this.active(sessionId); const { indexProof, reconciliationProof, transactionProof } = await this.assertReady(config);
      const block = entryCalendarBlock(config, this.deps.clock());
      if (block) return await this.finish(cycleId, "HOLD", block);
      if (await this.hasBlockingEntryAttention(config.accountId))
        return await this.finish(cycleId, "HOLD", "EXISTING_ENTRY_REQUIRES_ATTENTION");
      const llmConfig = structuredClone(this.deps.llmConfig());
      const captured = await this.deps.market.capture(config); this.deps.market.assertCurrent(config);
      if (captured.analytics.available && (captured.analytics.snapshot.dataMode !== config.dataMode || captured.analytics.snapshot.underlying !== config.asset))
        throw new Error("DATA_MODE_REQUIRED");
      await this.active(sessionId);
      const decision = await evaluateWithPhase5LLM({ ...captured, strategyConfig: config.strategyConfig, llmConfig },
        this.deps.transport, () => this.deps.clock().getTime());
      // The AI calls consume part of a quote's strict 30-second lifetime.
      // Rebuild a candidate from current Kite evidence on the same completed
      // candle before any financial write; the original AI direction has no
      // authority to select a changed contract or bypass strategy gates.
      if (decision.action === "CANDIDATE") captured.assertCurrent?.();
      const admissionCapture = config.dataMode === "KITE_REAL" && decision.action === "CANDIDATE"
        ? await this.deps.market.capture(config) : captured;
      const finalDecision = admissionCapture === captured ? decision
        : revalidatePhase5Candidate(decision, captured.analytics, admissionCapture.analytics,
          admissionCapture.evaluatedAt, config.strategyConfig, this.deps.clock().getTime());
      // Store bounded structured interpretation, never prompts, credentials or hidden reasoning.
      const displayAnalytics = projectPaperDisplayAnalytics(admissionCapture.analytics.available
        ? admissionCapture.analytics : captured.analytics, captured.expiry);
      await this.history.Cycle.updateOne({ cycleId, outcome: "EVALUATING" },
        { $set: { evaluatedAt: finalDecision.evidence.evaluatedAt, decision: finalDecision.evidence, outcome: "DECIDED",
          ...(displayAnalytics ? { displayAnalytics } : {}) } });
      if (finalDecision.action === "HOLD" || finalDecision.evidence.strategyResult.action !== "CANDIDATE")
        return await this.finish(cycleId, "HOLD", finalDecision.evidence.reason);
      await this.active(sessionId); this.deps.market.assertCurrent(config);
      const lateBlock = entryCalendarBlock(config, this.deps.clock());
      if (lateBlock || decisionWindow(this.deps.clock()) !== decisionWindow(requestedAt))
        return await this.finish(cycleId, "HOLD", lateBlock ?? "DECISION_WINDOW_EXPIRED");
      admissionCapture.assertCurrent?.();
      const candidate = finalDecision.evidence.strategyResult.candidate;
      const scope = this.scope(config.accountId);
      const chain = await new CandidateIntentAdapter(this.connection, scope, this.deps.clock).adapt(candidate, {
        strategyInstanceId: `nse:${config.asset}`, sessionId,
        entryCutoffAt: entryCutoffAt(config, requestedAt),
        validUntil: new Date(Math.min(Date.parse(candidate.evaluatedAt)
          + (candidate.dataMode === "KITE_REAL" && candidate.strategyFamily === "LONG_OPTION"
            ? KITE_PAPER_LONG_OPTION_DECISION_LIFETIME_MS : 60_000),
          // The deadline is exclusive; +1 ms retains the approved inclusive
          // claim at the exact bar/cutoff boundary, but nothing after it.
          Math.floor(+requestedAt / 300_000) * 300_000 + 300_001)),
        orchestration: { cycleId, sessionId, startupId: this.deps.host.startupId }, indexProof, reconciliationProof });
      await this.history.Cycle.updateOne({cycleId},{$set:{intentId:chain.intentId,positionId:chain.positionId}});
      await this.active(sessionId);
      // Revalidate captured ownership after adaptation and all intervening awaits.
      admissionCapture.assertCurrent?.();
      const refreshQuote = config.dataMode === "KITE_REAL" && candidate.strategyFamily === "LONG_OPTION"
        ? async (): Promise<EntryQuoteRenewal> => {
          const fresh = await this.deps.market.capture(config);
          const renewed = revalidatePhase5Candidate(finalDecision, admissionCapture.analytics, fresh.analytics,
            fresh.evaluatedAt, config.strategyConfig, this.deps.clock().getTime());
          if (renewed.action !== "CANDIDATE" || renewed.evidence.strategyResult.action !== "CANDIDATE")
            throw new Error(renewed.evidence.reason);
          fresh.assertCurrent?.();
          return issueEntryQuoteRenewal(candidate, renewed.evidence.strategyResult.candidate, chain.entryPlan, this.deps.clock());
        } : undefined;
      const admission = await new RiskAdmissionService(this.connection, scope, this.deps.clock, this.deps.host).authorizeEntry(chain.intentId, admissionCapture.assertCurrent, indexProof, reconciliationProof, refreshQuote);
      if (admission.status !== "AUTHORIZED") return await this.finish(cycleId,"REJECTED",admission.reason);
      // Remote ledger verification can leave only a few seconds on the quote.
      // Renew while the completed-bar evidence is still qualified, before the
      // claim's database reads consume that remaining lifetime. The renewal
      // proves the same contract, lot and immutable BUY limit.
      const expiringSoon = chain.entryPlan.marketEvidenceExpiresAt instanceof Date
        && +chain.entryPlan.marketEvidenceExpiresAt - +this.deps.clock() < 15_000;
      const claimQuoteRenewal = admission.quoteRenewal ?? (refreshQuote && expiringSoon ? await refreshQuote() : undefined);
      return await this.progressEntry(cycleId, { indexProof, reconciliationProof, transactionProof }, refreshQuote, claimQuoteRenewal);
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
  async progressEntry(cycleId: string, proofs?: { indexProof?: VerifiedExecutionIndexes; reconciliationProof?: VerifiedExecutionIndexes; transactionProof?: TransactionCapability },
    refreshQuote?: () => Promise<EntryQuoteRenewal>, admissionQuoteRenewal?: EntryQuoteRenewal) {
    const cycle = await this.history.Cycle.findOne({cycleId,executionMode:"PAPER"}).orFail();
    if (!cycle.get("intentId") || !["DECIDED","ENTRY","ATTENTION"].includes(cycle.get("outcome"))) throw new Error("DECISION_CONFLICT");
    const scope = this.scope(cycle.get("accountId")), sessionId = cycle.get("sessionId");
    const orders = await this.models.BrokerOrder.find({...scope,intentId:cycle.get("intentId")});
    const intent = await this.models.OrderIntent.findOne({...scope,intentId:cycle.get("intentId")}).orFail();
    const processor = new FillProcessor(this.connection,scope,this.deps.clock);
    const broker = this.deps.broker(scope);
    if (!(broker instanceof PaperBrokerAdapter)) throw new Error("PAPER_ONLY");
    const manager = new OrderManager(this.connection,scope,broker,this.deps.clock,this.deps.host);
    const protection = new EntryProtectionService(this.connection,scope,this.deps.clock);
    let failure: string | undefined;
    for (const original of orders.sort((a,b)=>a.get("side")===b.get("side")?0:a.get("side")==="BUY"?-1:1)) {
      const orderId = original.get("orderId");
      // A newly admitted READY child cannot have retained broker evidence.
      // If another worker claims it now, submit() observes that claim and the
      // post-submit pass below still ingests any retained receipt.
      if (original.get("submissionClaim") || original.get("submissionOutcome") || original.get("phase") !== "READY") {
        const retained = await processor.processRetained(orderId);
        if (retained.failedTradeKeys.length) { failure="FILL_PROCESSING_REQUIRED"; break; }
      }
      try {
        await this.active(sessionId);
        // An admitted chain keeps its captured complete terms even if optional
        // monitoring metadata is later absent. Retained truth remains independent.
        const config = capturePaperConfig(cycle.get("config"));
        if (entryCalendarBlock(config,this.deps.clock())) {failure="ENTRY_WINDOW_CLOSED";continue;}
        if (!original.get("submissionClaim")) {
          // Preserve session/mode gates, but admitted identity no longer depends on the mutable master.
          this.deps.market.assertSessionCurrent?.(config);
          if (original.get("side")==="SELL") await protection.advance(orderId);
          const evidenceExpiry = intent.get("entryPlan.marketEvidenceExpiresAt");
          // The admitted quote is already qualified. A third full market capture
          // can consume its remaining lifetime before the first PAPER claim.
          // Claim directly while it is current; OrderManager checks the clock
          // again inside the financial transaction before any broker submission.
          const quoteRenewal = original.get("side") === "BUY"
            ? admissionQuoteRenewal && +this.deps.clock() <= +admissionQuoteRenewal.expiresAt
              ? admissionQuoteRenewal
              : evidenceExpiry instanceof Date && +this.deps.clock() > +evidenceExpiry
                ? await refreshQuote?.() : undefined
            : undefined;
          try {
            await manager.submit(orderId, undefined, { ...proofs, quoteRenewal });
          } catch (error) {
            if (original.get("side") !== "BUY" || !refreshQuote
              || safeCycleError(error) !== "MARKET_EVIDENCE_EXPIRED") throw error;
            // A clock crossing during claim can be retried only after proving
            // that no claim or outcome was committed. An uncertain send is never retried.
            const current = await this.models.BrokerOrder.findOne({...scope,orderId}).orFail();
            if (current.get("phase") !== "READY" || current.get("knowledge") !== "KNOWN"
              || current.get("filledUnits") !== 0 || current.get("submissionClaim")
              || current.get("submissionOutcome") || current.get("brokerOrderId")) throw error;
            await manager.submit(orderId, undefined, { ...proofs, quoteRenewal: await refreshQuote() });
          }
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
