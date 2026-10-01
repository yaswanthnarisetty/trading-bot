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
import { RecoveryBarrierService } from "./RecoveryBarrierService";
import { ReconciliationService } from "./ReconciliationService";
import { executionModels } from "../db/executionModels";
import { PaperExitMonitor } from "./PaperExitMonitor";
import { PaperExitMarketData } from "./PaperExitMarketData";
import { PaperExitScheduler } from "./PaperExitScheduler";
import { captureExitConfig } from "../domain/paperExits";
import type { ExecutionScope } from "@trading-bot/shared";
import { logger } from "../utils/logger";
import { PaperDefaultSessionService } from "./PaperDefaultSessionService";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { currentDailyState } from "../db/realizedRiskProjection";
import { dailyLossReached } from "../domain/realizedRisk";
export const paperExecutionHost=createExecutionHostContext();
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
  market:new PaperMarketDataProvider(kiteIndexData,kiteMarketData,kiteSession),
  transport:phase5OpenAITransport(),llmConfig:phase5LegacyCompatibleConfig,
  broker:paperBrokerFor,
});
export const paperScheduler=new PaperEvaluationScheduler(id=>paperOrchestrator.runEvaluationCycle(id),
  sessionId=>logger.warn("PAPER evaluation failed",{sessionId,reason:"CYCLE_FAILED"}));
export async function paperConfigurations(){
  const file=process.env.NSE_PAPER_CONFIG_FILE;
  if(!file)return [];
  try {
    const raw:unknown=JSON.parse(await readFile(file,"utf8"));
    if(!Array.isArray(raw)||raw.length>50)throw new Error("INVALID_PAPER_CONFIG");
    const configs=raw.map(capturePaperConfig);
    if(new Set(configs.map(c=>c.configId)).size!==configs.length)throw new Error("INVALID_PAPER_CONFIG");
    return configs;
  } catch { throw new Error("INVALID_PAPER_CONFIG"); }
}
/** Explicit operator action. No order writes or synthetic reconciliation success. */
export async function recoverPaperAccount(configId:string){
  const config=(await paperConfigurations()).find(c=>c.configId===configId);
  if(!config)throw new Error("INVALID_PAPER_CONFIG");
  const scope={accountId:config.accountId,executionMode:"PAPER" as const};
  const account=await executionModels(mongoose.connection).TradingAccount.findOne(scope).orFail();
  const brokerAccountId=account.get("reconciliationConfig.brokerAccountId");
  if(!brokerAccountId)throw new Error("RECOVERY_REQUIRED");
  const recovery=new RecoveryBarrierService(mongoose.connection,scope,()=>new Date(),paperExecutionHost);
  const state=account.get("recoveryState");
  if(state?.startupId!==paperExecutionHost.startupId||state?.status!=="READY")
    await recovery.beginRecovery(scope.accountId,"phase6a-startup");
  const reader=new KiteReadOnlyAdapter(await createKiteReadSession(brokerAccountId));
  const result=await new ReconciliationService(mongoose.connection,scope,()=>new Date(),paperExecutionHost)
    .reconcileAccount(scope.accountId,await reader.getSnapshot());
  if(result.report.classification!=="MATCHED")return {status:result.report.classification};
  return recovery.completeRecovery(scope.accountId,result.recordId);
}

export const paperDefaultSession = new PaperDefaultSessionService({
  configurations: paperConfigurations,
  connected: () => kiteSession.status().tokenValid,
  dataMode: () => kiteSession.getMode(),
  active: accountId => paperOrchestrator.activeForAccount(accountId),
  recover: recoverPaperAccount,
  accountGate: async accountId => {
    const account = await executionModels(mongoose.connection).TradingAccount.findOne({ accountId, executionMode: "PAPER" });
    if (!account || account.get("broker") !== "PAPER" || account.get("admissionStatus") !== "PAPER_READY") throw new Error("ACCOUNT_NOT_READY");
    if (account.get("killSwitchEnabled")) throw new Error("KILL_SWITCH_ACTIVE");
    const policy = entryRiskPolicySchema.safeParse(account.get("entryRiskPolicy"));
    if (!policy.success || policy.data.policyVersion !== account.get("policyVersion") || policy.data.maxDailyLossMinor === undefined)
      throw new Error("RISK_POLICY_REQUIRED");
    const daily = currentDailyState(account.toObject(), new Date());
    if (dailyLossReached(daily.dailyRealizedPnlMinor, policy.data.maxDailyLossMinor)) throw new Error("DAILY_LOSS_LIMIT_EXCEEDED");
    if ((await paperExitConfigurations()).filter(c => c.accountId === accountId && c.family === "LONG_OPTION" && c.dataMode === "KITE_REAL").length !== 1)
      throw new Error("EXIT_CONFIG_REQUIRED");
  },
  start: config => paperOrchestrator.start(config),
  schedule: (accountId, sessionId, intervalMs) => paperScheduler.start(accountId, sessionId, intervalMs),
  sessionId: session => String(session.sessionId),
});

export async function paperExitConfigurations(){
 const file=process.env.NSE_PAPER_EXIT_CONFIG_FILE;if(!file)return [];
 try{const raw:unknown=JSON.parse(await readFile(file,"utf8"));if(!Array.isArray(raw)||raw.length>150)throw new Error("EXIT_CONFIG_REQUIRED");
  const configs=raw.map(captureExitConfig);
  if(new Set(configs.map(c=>`${c.accountId}:${c.family}`)).size!==configs.length)throw new Error("EXIT_CONFIG_REQUIRED");return configs;
 }catch{throw new Error("EXIT_CONFIG_REQUIRED");}
}
export const paperExitMonitor=new PaperExitMonitor(mongoose.connection,{clock:()=>new Date(),
 market:new PaperExitMarketData(kiteMarketData),configs:paperExitConfigurations,broker:paperBrokerFor});
export const paperExitScheduler=new PaperExitScheduler(()=>paperExitMonitor.listPositions(),id=>paperExitMonitor.evaluateOpenPosition(id),
 ()=>logger.warn("PAPER exit monitoring requires attention"),Number(process.env.NSE_PAPER_EXIT_INTERVAL_MS??5000),4);
