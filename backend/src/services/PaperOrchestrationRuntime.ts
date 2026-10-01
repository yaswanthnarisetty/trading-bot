import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createExecutionHostContext } from "../domain/ExecutionHostContext";
import { capturePaperConfig } from "../domain/paperOrchestration";
import { PaperEntryOrchestrator } from "./PaperEntryOrchestrator";
import { PaperEvaluationScheduler } from "./PaperEvaluationScheduler";
import { PaperMarketDataProvider } from "./PaperMarketDataProvider";
import { kiteIndexData } from "./KiteIndexDataRuntime";
import { kiteMarketData } from "./KiteMarketDataRuntime";
import { createKiteReadSession, kiteSession } from "./KiteService";
import { phase5LegacyCompatibleConfig, phase5OpenAITransport } from "./LLMService";
import { PaperBrokerAdapter } from "../brokers/PaperBrokerAdapter";
import { KiteReadOnlyAdapter } from "../brokers/KiteReadOnlyAdapter";
import { PaperEntryPreparationService } from "./PaperEntryPreparationService";
import { classifyNseDate, nseLocalDate } from "../domain/nseTradingCalendar";
import { executionModels } from "../db/executionModels";
import { PaperExitMonitor } from "./PaperExitMonitor";
import { PaperExitMarketData } from "./PaperExitMarketData";
import { PaperExitScheduler } from "./PaperExitScheduler";
import { operationalEntryConfiguration, operationalExitConfigurations, operationalDefaultsStatus } from "./PaperOperationalDefaults";
import type { ExecutionScope } from "@trading-bot/shared";
import { logger } from "../utils/logger";
import { PaperDefaultSessionService, evaluatePaperReadiness } from "./PaperDefaultSessionService";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { currentDailyState } from "../db/realizedRiskProjection";
import { dailyLossReached } from "../domain/realizedRisk";
import { type PaperEntryReadiness } from "../domain/paperMonitoring";
import { NSE_PAPER_ACCOUNT_ID } from "./NsePaperAccountService";
export const paperExecutionHost=createExecutionHostContext();
const paperMarket = new PaperMarketDataProvider(kiteIndexData,kiteMarketData,kiteSession);
const brokers=new Map<string,PaperBrokerAdapter>();
export const paperBrokerFor=(scope:ExecutionScope)=>{
    let broker=brokers.get(scope.accountId);
    if(!broker){broker=new PaperBrokerAdapter(scope,{clock:{now:()=>new Date().toISOString()},ids:{nextId:()=>randomUUID()},
      // Explicit PAPER simulation policy: one full fill at the admitted LIMIT.
      // These are SIMULATED_FILLs even when decision inputs came from KITE_REAL.
      scenario:request=>({submission:"ACCEPTED",initialFills:[{quantityUnits:request.quantityUnits,priceMinor:request.limitPriceMinor!}]})});brokers.set(scope.accountId,broker);}
    return broker;
  };
export const paperOrchestrator=new PaperEntryOrchestrator(mongoose.connection,{
  host:paperExecutionHost,clock:()=>new Date(),
  market:paperMarket, entryConfig:operationalEntryConfiguration,
  transport:phase5OpenAITransport(),llmConfig:phase5LegacyCompatibleConfig,
  broker:paperBrokerFor,
});
export const paperScheduler=new PaperEvaluationScheduler(async id=>{
  const row = await paperOrchestrator.active(id), session = row.toObject();
  const readiness = await paperSessionReadiness(session, true);
  if (!readiness.entryReady) {
    await paperOrchestrator.history.Session.updateOne({sessionId:id,startupId:paperExecutionHost.startupId,status:"RUNNING"},
      {$set:{lastCycleAt:new Date(),lastCycleOutcome:"HOLD",blockingReason:readiness.entryBlockingReason}});
    return readiness;
  }
  return paperOrchestrator.runEvaluationCycle(id);
},
  sessionId=>logger.warn("PAPER evaluation failed",{sessionId,reason:"CYCLE_FAILED"}));
export async function paperConfigurations(){
  const file=process.env.NSE_PAPER_CONFIG_FILE;
  if(!file)return [];
  try {
    const raw:unknown=JSON.parse(await readFile(file,"utf8"));
    if(!Array.isArray(raw)||raw.length>50)throw new Error("INVALID_PAPER_CONFIG");
    const configs=raw.map(capturePaperConfig);
    if (configs.some(c => c.dataMode !== "KITE_REAL")) throw new Error("INVALID_PAPER_CONFIG");
    if(new Set(configs.map(c=>c.configId)).size!==configs.length)throw new Error("INVALID_PAPER_CONFIG");
    return configs;
  } catch { throw new Error("INVALID_PAPER_CONFIG"); }
}
export const paperEntryPreparation = new PaperEntryPreparationService(mongoose.connection, {
  host: paperExecutionHost, clock: () => new Date(), active: id => paperOrchestrator.active(id),
  reader: async () => {
    const verified = kiteSession.status();
    if (!verified.tokenValid || !verified.brokerAccountId) throw new Error("KITE_SESSION_REQUIRED");
    return new KiteReadOnlyAdapter(await createKiteReadSession(verified.brokerAccountId));
  },
});

/** Compatibility/admin operation uses the same exact running-session preparation. */
export async function recoverPaperAccount(configId: string, expectedAccountId?: string) {
  const config = (await paperConfigurations()).find(c => c.configId === configId)
    ?? (!process.env.NSE_PAPER_CONFIG_FILE && configId === "NIFTY_PAPER_DEFAULT_V1" ? await paperDefaultSession.config("NIFTY") : undefined);
  if (!config) throw new Error("INVALID_PAPER_CONFIG");
  if (expectedAccountId && config.accountId !== expectedAccountId) throw new Error("SESSION_CONFIG_CONFLICT");
  const session = await paperOrchestrator.activeForAccount(config.accountId) as Record<string, any> | null;
  if (!session) throw new Error("SESSION_STOPPED");
  return paperEntryPreparation.prepare(config.accountId, String(session.sessionId));
}

async function accountEntryGate(accountId: string, asset: string) {
  const account = await executionModels(mongoose.connection).TradingAccount.findOne({ accountId, executionMode: "PAPER" });
  if (!account || account.get("broker") !== "PAPER" || account.get("admissionStatus") !== "PAPER_READY") throw new Error("ACCOUNT_NOT_READY");
  if (account.get("killSwitchEnabled")) throw new Error("KILL_SWITCH_ACTIVE");
  const policy = entryRiskPolicySchema.safeParse(account.get("entryRiskPolicy"));
  if (!policy.success || policy.data.policyVersion !== account.get("policyVersion") || policy.data.maxDailyLossMinor === undefined)
    throw new Error("RISK_POLICY_REQUIRED");
  const daily = currentDailyState(account.toObject(), new Date());
  if (dailyLossReached(daily.dailyRealizedPnlMinor, policy.data.maxDailyLossMinor)) throw new Error("DAILY_LOSS_LIMIT_EXCEEDED");
  if ((await paperExitConfigurations()).filter(c => c.accountId === accountId && c.family === "LONG_OPTION" && c.dataMode === "KITE_REAL"
    && (!c.underlying || c.underlying === asset)).length !== 1)
    throw new Error("EXIT_CONFIG_REQUIRED");
}

/** GET uses prepare=false: no recovery, reconciliation or financial writes.
 * Explicit Start / scheduler may invoke the existing audited recovery workflow. */
export async function paperSessionReadiness(session: Record<string, any>, prepare = false): Promise<PaperEntryReadiness> {
  const readiness = await evaluatePaperReadiness({sessionId:String(session.sessionId),config:session.config}, {
    clock: () => new Date(), active: id => paperOrchestrator.active(id),
    calendar: now => classifyNseDate(nseLocalDate(now)),
    preparation: (accountId, sessionId, mutate) => mutate ? paperEntryPreparation.prepare(accountId, sessionId) : paperEntryPreparation.read(accountId, sessionId),
    connected: () => kiteSession.status().tokenValid, mode: () => kiteSession.getMode(),
    entryConfig: config => paperOrchestrator.entryConfiguration(config), accountGate: accountId => accountEntryGate(accountId, session.config.asset),
    assertReady: config => paperOrchestrator.assertReady(config), recover: config => recoverPaperAccount(config.configId, config.accountId),
    market: async (config, refresh) => {
      return refresh ? paperMarket.prepare(config) : paperMarket.checkReadiness(config);
    },
  }, prepare);
  return { ...readiness, lastReadinessAttemptAt: readiness.lastReadinessAttemptAt ?? session.entryPreparation?.attemptedAt ?? null,
    operationalDefaults: await operationalDefaultsStatus(session.config) };
}

export const paperDefaultSession = new PaperDefaultSessionService({
  configurations: async () => (await paperConfigurations()).filter(config => config.accountId === NSE_PAPER_ACCOUNT_ID),
  hasExplicitConfiguration: () => Boolean(process.env.NSE_PAPER_CONFIG_FILE),
  accounts: () => paperOrchestrator.canonicalMonitoringAccounts(),
  start: config => paperOrchestrator.startMonitoring(config),
  readiness: (session, _config, prepare) => paperSessionReadiness(session, prepare),
  schedule: (accountId, sessionId, intervalMs) => paperScheduler.start(accountId, sessionId, intervalMs),
  sessionId: session => String(session.sessionId),
});

export const paperExitConfigurations = () => operationalExitConfigurations();
export const paperExitMonitor=new PaperExitMonitor(mongoose.connection,{clock:()=>new Date(),
 market:new PaperExitMarketData(kiteMarketData),configs:paperExitConfigurations,broker:paperBrokerFor});
export const paperExitScheduler=new PaperExitScheduler(()=>paperExitMonitor.listPositions(),id=>paperExitMonitor.evaluateOpenPosition(id),
 ()=>logger.warn("PAPER exit monitoring requires attention"),Number(process.env.NSE_PAPER_EXIT_INTERVAL_MS??5000),4);
