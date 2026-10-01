import { Router } from "express";
import { authMiddleware } from "./auth.middleware";
import { paperDefaultSession,paperExitMonitor,paperExitScheduler,paperConfigurations,paperOrchestrator,paperScheduler,recoverPaperAccount,paperExecutionHost,paperSessionReadiness } from "../services/PaperOrchestrationRuntime";
import { safeCycleError } from "../domain/paperOrchestration";
import { kiteSession } from "../services/KiteService";
import { defaultPaperSummary,parseDefaultStartRequest } from "../services/PaperDefaultSessionService";
import mongoose from "mongoose";
import { readPaperDashboard } from "../services/PaperDashboardReadService";
import { readPaperMarketObservation } from "../services/PaperMarketObservation";
import { kiteIndexData } from "../services/KiteIndexDataRuntime";
import { operationalDefaultsStatus } from "../services/PaperOperationalDefaults";
const router=Router();
router.use(authMiddleware);
const sessions=paperOrchestrator.history.Session;
const safeStartError=(error:unknown)=>{
  const message=error instanceof Error?error.message:"";
  return ["ASSET_ONLY_START_REQUIRED","DEFAULT_PAPER_ASSET_UNAVAILABLE","DEFAULT_PAPER_CONFIG_REQUIRED","DEFAULT_PAPER_CONFIG_INVALID",
    "INVALID_PAPER_CONFIG","PAPER_ACCOUNT_REQUIRED","PAPER_ACCOUNT_AMBIGUOUS","KITE_SESSION_REQUIRED","DATA_MODE_REQUIRED","ACCOUNT_NOT_READY","KILL_SWITCH_ACTIVE",
    "RECOVERY_REQUIRED","RECOVERY_ALREADY_REQUIRED","RECOVERY_HOST_MISMATCH","RECONCILIATION_INCOMPLETE",
    "RECONCILIATION_NOT_MATCHED","RECONCILIATION_REQUIRED","RISK_POLICY_REQUIRED","DAILY_LOSS_LIMIT_EXCEEDED",
    "TRADING_DAY_CONFIG_REQUIRED","TRADING_DAY_REGRESSION","SESSION_CONFIG_CONFLICT",
    "MONTHLY_METADATA_REQUIRED","INSTRUMENT_MASTER_STALE","QUALIFIED_INSTRUMENT_REQUIRED","STALE_MARKET_DATA",
    "EXIT_CONFIG_REQUIRED"].includes(message)
    ? message : safeCycleError(error);
};
router.get("/default/:asset",async(req,res)=>{
  try{const config = await paperDefaultSession.config(req.params.asset);
    res.json({...defaultPaperSummary(config), operationalDefaults: await operationalDefaultsStatus(config)});}
  catch(e){res.status(409).json({error:safeStartError(e)});}
});
router.get("/configurations",async(_req,res)=>{
  try{res.json((await paperConfigurations()).map(c=>({configId:c.configId,accountId:c.accountId,asset:c.asset,
    executionMode:c.executionMode,dataMode:c.dataMode,strategyFamily:c.strategyConfig.strategyFamily,intervalMs:c.intervalMs})));}
  catch{res.status(409).json({error:"INVALID_PAPER_CONFIG"});}
});
router.post("/recover",async(req,res)=>{
  try{res.json(await recoverPaperAccount(String(req.body?.configId??"")));}
  catch(e){res.status(409).json({error:safeCycleError(e)});}
});
router.post("/start",async(req,res)=>{
  try{
    res.json(await paperDefaultSession.start(parseDefaultStartRequest(req.body)));
  }catch(e){res.status(409).json({error:safeStartError(e)});}
});
router.post("/stop",async(req,res)=>{
  const id=String(req.body?.sessionId??"");paperScheduler.stop(id);
  try{res.json((await paperOrchestrator.stop(id)).toObject());}catch{res.status(404).json({error:"SESSION_NOT_FOUND"});}
});
router.get("/active",async(req,res,next)=>{try{
  const accountId=req.query.accountId;
  const configured = process.env.NSE_PAPER_CONFIG_FILE ? await paperConfigurations() : [await paperDefaultSession.config("NIFTY")];
  if(typeof accountId!=="string" || !configured.some(c=>c.accountId===accountId)) {
    res.status(400).json({error:"EXPLICIT_PAPER_ACCOUNT_REQUIRED"});return;
  }
  res.json(await paperOrchestrator.activeForAccount(accountId));
}catch(e){next(e);}});
router.get("/exits/status",async(req,res,next)=>{try{
  const accountId=req.query.accountId;
  if(typeof accountId!=="string" || !/^PAPER:[^\s]+$/.test(accountId)){res.status(400).json({error:"EXPLICIT_PAPER_ACCOUNT_REQUIRED"});return;}
  res.json(await paperExitMonitor.store.states.find({accountId},{projection:{leaseId:0}}).limit(200).toArray());
}catch(e){next(e);}});
router.get("/history",async(_req,res,next)=>{try{res.json({sessions:await sessions.find({}).sort({createdAt:-1}).limit(100).lean(),total:await sessions.countDocuments()});}catch(e){next(e);}});
router.get("/:sessionId/decisions",async(req,res,next)=>{try{res.json(await paperOrchestrator.history.Cycle.find({sessionId:req.params.sessionId,executionMode:"PAPER"}).sort({timestamp:-1}).limit(50).lean());}catch(e){next(e);}});
router.get("/:sessionId/dashboard",async(req,res)=>{try{
  const dashboard = await readPaperDashboard(mongoose.connection,req.params.sessionId,paperExitScheduler.isRunning(),paperExecutionHost.startupId);
  res.json({...dashboard, observation: dashboard.session.asset === "NIFTY" ? await readPaperMarketObservation(kiteIndexData) : null});
}catch(e){const missing=e instanceof Error&&e.message==="SESSION_NOT_FOUND";
  res.status(missing?404:503).json({error:missing?"SESSION_NOT_FOUND":"DASHBOARD_READ_UNAVAILABLE"});}});
router.post("/:sessionId/progress/:cycleId",async(req,res)=>{
  try{const cycle=await paperOrchestrator.history.Cycle.findOne({sessionId:req.params.sessionId,cycleId:req.params.cycleId,executionMode:"PAPER"});
    if(!cycle){res.status(404).json({error:"DECISION_NOT_FOUND"});return;}
    res.json(await paperOrchestrator.progressEntry(req.params.cycleId));}catch(e){res.status(409).json({error:safeCycleError(e)});}
});
router.get("/:sessionId",async(req,res,next)=>{try{
  const session=await sessions.findOne({sessionId:req.params.sessionId}).lean<Record<string,any>>();
  if(!session){res.status(404).json({error:"SESSION_NOT_FOUND"});return;}
  res.json({...session,...(session.executionMode==="PAPER" ? await paperSessionReadiness(session) : {}),kiteReadiness:kiteSession.status().tokenValid?"CONNECTED":"DISCONNECTED",execution:"PaperBroker",tradingPhase:"PAPER",exits:"DURABLE_PAPER_MONITOR"});
}catch(e){next(e);}});
export default router;
