import { Router } from "express";
import { authMiddleware } from "./auth.middleware";
import { paperExitMonitor,paperConfigurations,paperOrchestrator,paperScheduler,recoverPaperAccount } from "../services/PaperOrchestrationRuntime";
import { safeCycleError } from "../domain/paperOrchestration";
import { kiteSession } from "../services/KiteService";
const router=Router();
router.use(authMiddleware);
const sessions=paperOrchestrator.history.Session;
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
    if(req.body?.executionMode!=="PAPER")throw new Error("PAPER_ONLY");
    const c=(await paperConfigurations()).find(c=>c.configId===req.body?.configId);
    if(!c||c.asset!==req.body.asset||c.dataMode!==req.body.dataMode||c.strategyConfig.strategyFamily!==req.body.strategyFamily){res.status(400).json({error:"EXPLICIT_PAPER_CONFIGURATION_REQUIRED"});return;}
    const session=await paperOrchestrator.start(c);
    paperScheduler.start(c.accountId,session.sessionId,c.intervalMs);
    res.json(session);
  }catch(e){res.status(409).json({error:safeCycleError(e)});}
});
router.post("/stop",async(req,res)=>{
  const id=String(req.body?.sessionId??"");paperScheduler.stop(id);
  try{res.json((await paperOrchestrator.stop(id)).toObject());}catch{res.status(404).json({error:"SESSION_NOT_FOUND"});}
});
router.get("/active",async(req,res,next)=>{try{
  const accountId=req.query.accountId;
  if(typeof accountId!=="string" || !(await paperConfigurations()).some(c=>c.accountId===accountId)) {
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
router.post("/:sessionId/progress/:cycleId",async(req,res)=>{
  try{const cycle=await paperOrchestrator.history.Cycle.findOne({sessionId:req.params.sessionId,cycleId:req.params.cycleId,executionMode:"PAPER"});
    if(!cycle){res.status(404).json({error:"DECISION_NOT_FOUND"});return;}
    res.json(await paperOrchestrator.progressEntry(req.params.cycleId));}catch(e){res.status(409).json({error:safeCycleError(e)});}
});
router.get("/:sessionId",async(req,res,next)=>{try{
  const session=await sessions.findOne({sessionId:req.params.sessionId}).lean();
  if(!session){res.status(404).json({error:"SESSION_NOT_FOUND"});return;}
  res.json({...session,kiteReadiness:kiteSession.status().tokenValid?"CONNECTED":"DISCONNECTED",execution:"PaperBroker",tradingPhase:"PAPER",exits:"DURABLE_PAPER_MONITOR"});
}catch(e){next(e);}});
export default router;
