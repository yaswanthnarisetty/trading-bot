import type {ClientSession,Connection,Document} from 'mongoose';
import { executionModels } from '../db/executionModels';
import { assertExecutionIndexes } from '../db/executionIndexes';
import { PaperExitStore } from '../db/paperExitStore';
import { verifyCloseLedger,closeOrderFinality } from '../domain/closeWorkflowEvidence';
import { classifiedEntryPlanSchema } from '../domain/entryRisk';
import { captureExitConfig,exitEconomics,exitTriggers,safeExitError,type ExitLeg,type ExitFill,type ExitPrice,type PaperExitConfig } from '../domain/paperExits';
import { transitionOrder,type OrderState } from '../domain/OrderStateMachine';
import { CloseIntentService } from './CloseIntentService';
import { CloseWorkflowService } from './CloseWorkflowService';
import { RiskSettlementService } from './RiskSettlementService';
import { OrderManager } from './OrderManager';
import { FillProcessor } from './FillProcessor';
import { saveRisk,riskAudit } from './riskAudit';
import { PaperBrokerAdapter } from '../brokers/PaperBrokerAdapter';
import type {ExitMarketProvider} from './PaperExitMarketData';
import type {ExecutionScope} from '@trading-bot/shared';
type Row=Record<string,any>;
function bufferedCloseLimits(prices:readonly ExitPrice[],plan:ReturnType<typeof classifiedEntryPlanSchema.parse>,config:PaperExitConfig){
 return prices.map(price=>{
  const tick=plan.legs.find(leg=>leg.legId===price.legId)?.tickSizeMinor;
  if(!tick||!Number.isSafeInteger(tick)||tick<=0)throw new Error('EXIT_IDENTITY_MISMATCH');
  const divisor=10000n*BigInt(tick),adjusted=BigInt(price.priceMinor)*BigInt(price.side==='SELL'
   ?10000-config.maxExitSlippageBps:10000+config.maxExitSlippageBps);
  const units=price.side==='SELL'?adjusted/divisor:(adjusted+divisor-1n)/divisor;
  const limit=units*BigInt(tick);
  if(limit<=0n||limit>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('EXIT_PRICE_NOT_EXECUTABLE');
  return{...price,priceMinor:Number(limit)};
 });
}
export interface PaperExitDependencies {clock:()=>Date;market:ExitMarketProvider;configs:()=>Promise<readonly PaperExitConfig[]>;broker:(scope:ExecutionScope)=>PaperBrokerAdapter}
/** Independent durable exposure management. Never reads entry-session status or asks an LLM. */
export class PaperExitMonitor {
 readonly store:PaperExitStore;private readonly models;private readonly busy=new Set<string>();
 constructor(private readonly connection:Connection,private readonly deps:PaperExitDependencies){this.models=executionModels(connection);this.store=new PaperExitStore(connection,deps.clock);}
 initialize(){return this.store.initialize();}
 async listPositions(){const settled=await this.store.states.find({status:'SETTLED'},{projection:{positionId:1}}).toArray();return this.models.Position.find({executionMode:'PAPER',positionId:{$nin:settled.map(s=>s.positionId)},lifecycle:{$nin:['PENDING_ENTRY','ABORTED']}}).select({positionId:1}).lean<{positionId:string}[]>();}
 private async transaction<T>(work:(session:ClientSession)=>Promise<T>){const s=await this.connection.startSession();try{return await s.withTransaction(()=>work(s),{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});}finally{await s.endSession();}}
 private async ledger(positionId:string){return this.transaction(async s=>{
  const p=await this.models.Position.findOne({positionId,executionMode:'PAPER'}).session(s).orFail(),scope={accountId:p.get('accountId'),executionMode:'PAPER' as const};
  const account=await this.models.TradingAccount.findOne(scope).session(s).orFail();if(account.get('broker')!=='PAPER')throw new Error('PAPER_ONLY');
  const position=p.toObject() as Row,entry=await this.models.OrderIntent.findOne({...scope,intentId:position.entryIntentId,purpose:'ENTRY'}).session(s).orFail();
  const orders=(await this.models.BrokerOrder.find({...scope,positionId}).session(s)).map(o=>o.toObject() as Row);
  const fills=(await this.models.Fill.find({...scope,positionId}).session(s)).map(o=>o.toObject() as Row);
  const intents=(await this.models.OrderIntent.find({...scope,intentId:{$in:[position.entryIntentId,...orders.map(o=>o.intentId)]}}).session(s)).map(o=>o.toObject());
  verifyCloseLedger(position,orders,fills,intents);return{scope,position,entry:entry.toObject() as Row,orders,fills,account:account.toObject() as Row};
 });}
 async evaluateOpenPosition(positionId:string,evaluatedAt=this.deps.clock()){
  if(this.busy.has(positionId))return{status:'BUSY',reason:'EVALUATION_IN_PROGRESS'};
  this.busy.add(positionId);let lease:Awaited<ReturnType<PaperExitStore['acquire']>>=null;
  try{
   await assertExecutionIndexes(this.connection);let ledger=await this.ledger(positionId);
   const {scope}=ledger,plan=classifiedEntryPlanSchema.parse(ledger.entry.entryPlan);
   if(ledger.position.lifecycle==='PENDING_ENTRY'||ledger.position.lifecycle==='ABORTED'||ledger.fills.length===0)return{status:'IGNORED',reason:'NO_EXPOSURE'};
   const persisted=await this.store.states.findOne({...scope,positionId});
   // Capture once per financial position, independently of entry-session activation/replacement.
   let config=persisted?.config?captureExitConfig(persisted.config):undefined;
   if(!config){try{const choices=(await this.deps.configs()).filter(c=>c.accountId===scope.accountId&&c.family===plan.family
     &&(!c.underlying||plan.legs.every(l=>l.identity.underlying===c.underlying)));
     if(choices.length===1)config=captureExitConfig(choices[0]);}catch{/* fail closed below; retained truth still runs */}}
   lease=await this.store.acquire(scope.accountId,positionId,config);if(!lease)return{status:'BUSY',reason:'EVALUATION_IN_PROGRESS'};
   config=lease.config?captureExitConfig(lease.config):config;
   const finish=async(status:string,reason:string,extra:Record<string,unknown>={})=>{await this.store.finish(lease!,status,reason,extra);return{status,reason,...extra};};
   const processor=new FillProcessor(this.connection,scope,this.deps.clock),broker=this.deps.broker(scope);
   if(!(broker instanceof PaperBrokerAdapter))throw new Error('PAPER_ONLY');
   // Retained and late simulator receipts are truth, independent of quotes/config/session/readiness.
   for(const order of ledger.orders){const retained=await processor.processRetained(order.orderId);if(retained.failedTradeKeys.length)throw new Error('FILL_PROCESSING_REQUIRED');}
   for(const trade of await broker.getTrades(scope))if(trade.positionId===positionId)await processor.process(trade);
   ledger=await this.ledger(positionId);
   if(ledger.position.lifecycle==='CLOSED'){
    await new RiskSettlementService(this.connection,scope,this.deps.clock).settleClosedPosition(positionId);return finish('SETTLED','PROVEN_FLAT');
   }
   const workflow=new CloseWorkflowService(this.connection,scope,this.deps.clock);
   if(ledger.position.activeCloseIntentId){
    const advanced=await workflow.advance(positionId);
    if(advanced.status==='CLOSED'){await new RiskSettlementService(this.connection,scope,this.deps.clock).settleClosedPosition(positionId);return finish('SETTLED','PROVEN_FLAT',{closeIntentId:advanced.intentId});}
    if(!config)return finish('BLOCKED','EXIT_CONFIG_REQUIRED',{closeIntentId:advanced.intentId});
    if(config.accountId!==scope.accountId||config.family!==plan.family
      ||(config.underlying&&!plan.legs.every(l=>l.identity.underlying===config.underlying)))throw new Error('EXIT_CONFIG_REQUIRED');
    return await this.progress(lease,config,finish);
   }
   const legs=ledger.position.legs as ExitLeg[];
   if(!legs.some(l=>l.entryFilledUnits>l.exitFilledUnits))return finish('IGNORED','NO_EXPOSURE');
   if(!config)throw new Error('EXIT_CONFIG_REQUIRED');
   if(plan.dataMode!=='KITE_REAL'||config.accountId!==scope.accountId||config.family!==plan.family
     ||(config.underlying&&!plan.legs.every(l=>l.identity.underlying===config.underlying)))throw new Error('REAL_DATA_REQUIRED');
   const evidence=await this.deps.market.capture(plan,legs,config);evidence.assertCurrent();
   const economics=exitEconomics(ledger.position as {entryIntentId:string;legs:ExitLeg[]},plan,ledger.fills as ExitFill[],[...evidence.prices]);
   const expiry=Math.min(+new Date(ledger.entry.deadline),plan.marketEvidenceExpiresAt?+plan.marketEvidenceExpiresAt:Infinity,plan.entryCutoffAt?+plan.entryCutoffAt:Infinity);
   const short=ledger.orders.filter(o=>o.intentId===ledger.entry.intentId&&o.side==='SELL');
   const cleanupSafe=short.length>0&&short.every(o=>closeOrderFinality(o,ledger.fills)==='FINAL'||
     !o.submissionClaim&&['PLANNED','READY'].includes(o.phase)&&+this.deps.clock()>expiry);
   const decision=exitTriggers(economics,config,this.deps.clock(),cleanupSafe);
   const decisionId=await this.store.record(lease,{evaluatedAt,observedAt:this.deps.clock(),entryIntentId:ledger.entry.intentId,
    family:plan.family,strategyKind:plan.strategyKind,config,economics,market:evidence.provenance,prices:evidence.prices,...decision});
   await this.store.markDecision(lease,decisionId,decision.reason,economics.stranded);
   if(!decision.reason)return finish('MONITORING','NO_TRIGGER',{decisionId,directionalStop:decision.directionalStop,stranded:economics.stranded});
   // The decision may outlive its quote while remote ledger writes complete.
   // Use a new executable quote to price the close; retain the old observation
   // only as decision history, never as submission authorization.
   const policyEvidence=await this.deps.market.capture(plan,legs,config);
   policyEvidence.assertCurrent();
   const approvedLimits=bufferedCloseLimits(policyEvidence.prices,plan,config);
   await this.transaction(async session=>{
    await this.store.fence(lease!,session);policyEvidence.assertCurrent();
    const position=await this.models.Position.findOne({...scope,positionId}).session(session).orFail();
    if(position.get('activeCloseIntentId'))return;
    if(position.get('version')!==ledger.position.version)throw new Error('POSITION_CHANGED');
    const account=await this.models.TradingAccount.findOne(scope).session(session).orFail();
    const orders=await this.models.BrokerOrder.find({...scope,intentId:ledger.entry.intentId}).session(session);
    // Retire only provably unclaimed children, under the same CAS fence as a submission claim.
    // This never cancels a possibly-sent order or releases any entry risk.
    for(const order of orders)if(!order.get('submissionClaim')&&['PLANNED','READY'].includes(order.get('phase'))&&order.get('knowledge')==='KNOWN'){
     const next=transitionOrder({...order.toObject(),fills:[]} as unknown as OrderState,{type:'PROVE_NOT_SENT',evidenceRef:decisionId,senderQuiesced:true});
     if(!next.ok)throw new Error('UNRESOLVED_ENTRY_EXPOSURE');order.set('phase',next.value.phase);await saveRisk(order,scope,session,this.deps.clock());
     await riskAudit(this.models,scope,session,this.deps.clock(),{eventId:`${order.get('orderId')}:EXIT_FENCED_NOT_SENT`,eventType:'RISK_BLOCKED',
      causationId:decisionId,reason:'EXIT_FENCED_UNCLAIMED_ENTRY',tradingDate:this.deps.clock().toISOString().slice(0,10),evidenceRefs:[decisionId],payload:{kind:'REFERENCE',entityId:order.get('orderId')}});
    }
    position.set('closePolicy',{kind:'POSITION_LIMIT_V1',monitorDecisionId:decisionId,policyVersion:account.get('policyVersion'),product:'INTRADAY',
     expiresAt:new Date(+this.deps.clock()+config!.authorizationMs),legLimits:approvedLimits.map(p=>({legId:p.legId,limitPriceMinor:p.priceMinor}))});
    await saveRisk(position,scope,session,this.deps.clock());policyEvidence.assertCurrent();await this.store.fence(lease!,session);
   });
   const close=await new CloseIntentService(this.connection,scope,this.deps.clock).requestClose(positionId,`paper-exit:${positionId}`,async session=>{
    await this.store.fence(lease!,session);
    // An elapsed quote may be replaced, but a revoked instrument master or
    // changed contract identity must abort the close before any child exists.
    try{policyEvidence.assertCurrent();}catch(error){if(safeExitError(error)!=='STALE_MARKET_DATA')throw error;}
    const current=await this.deps.market.capture(plan,legs,config!);
    const executable=approvedLimits.every(approved=>{
     const latest=current.prices.find(price=>price.legId===approved.legId);
     return latest&&latest.side===approved.side&&latest.quantityUnits===approved.quantityUnits&&
      (approved.side==='SELL'?latest.priceMinor>=approved.priceMinor:latest.priceMinor<=approved.priceMinor);
    });
    current.assertCurrent();
    if(!executable)throw new Error('EXIT_PRICE_NOT_EXECUTABLE');
   });
   await this.store.record(lease,{evaluatedAt:this.deps.clock(),kind:'CLOSE_LINK',decisionIdRef:decisionId,closeIntentId:close.intentId,reason:decision.reason});
   return await this.progress(lease,config,finish);
  }catch(error){const reason=safeExitError(error);if(lease){
   const diagnostic=error instanceof Error?error.message.slice(0,300):String(error).slice(0,300);
   await this.store.record(lease,{evaluatedAt:this.deps.clock(),kind:'BLOCKED',reason,diagnostic});
   await this.store.finish(lease,'ATTENTION',reason);
  }return{status:'ATTENTION',reason};}
  finally{this.busy.delete(positionId);}
 }
 private async progress(lease:NonNullable<Awaited<ReturnType<PaperExitStore['acquire']>>>,config:PaperExitConfig,
  finish:(status:string,reason:string,extra?:Record<string,unknown>)=>Promise<any>){
  const scope={accountId:lease.accountId,executionMode:'PAPER' as const},positionId=lease.positionId;
  const broker=this.deps.broker(scope),processor=new FillProcessor(this.connection,scope,this.deps.clock),workflow=new CloseWorkflowService(this.connection,scope,this.deps.clock);
  if(!(broker instanceof PaperBrokerAdapter))throw new Error('PAPER_ONLY');
  const manager=new OrderManager(this.connection,scope,broker,this.deps.clock);
  // At most two immutable leg children; each pass may unlock the protective long.
  for(let pass=0;pass<3;pass++){
   await this.store.fence(lease);const next=await workflow.advance(positionId);
   if(next.status==='CLOSED'){await new RiskSettlementService(this.connection,scope,this.deps.clock).settleClosedPosition(positionId);return finish('SETTLED','PROVEN_FLAT',{closeIntentId:next.intentId});}
   const ready=await this.models.BrokerOrder.find({...scope,intentId:next.intentId,phase:'READY',submissionClaim:{$exists:false}});
   if(!ready.length){
    const overdue=new Date(+this.deps.clock()-60000);
    const unresolved=next.blockingOrderIds.length>0&&await this.models.BrokerOrder.exists({...scope,intentId:next.intentId,
     orderId:{$in:next.blockingOrderIds},phase:'SUBMITTING',submissionClaim:{$exists:true},submissionOutcome:{$exists:false},
     'submissionClaim.claimedAt':{$lte:overdue}});
    return finish(unresolved?'ATTENTION':'CLOSING',unresolved?'ORDER_OUTCOME_UNRESOLVED':
     next.blockingOrderIds.length?'ORDER_TRUTH_REQUIRED':'CLOSE_DEPENDENCY_BLOCKED',{closeIntentId:next.intentId});
   }
   for(const order of ready){
    const ledger=await this.ledger(positionId),evidence=await this.deps.market.capture(ledger.entry.entryPlan,ledger.position.legs,config);
    const guard=async(session:ClientSession,child:Document)=>{
     await this.store.fence(lease,session);
     try{evidence.assertCurrent();}catch(error){if(safeExitError(error)!=='STALE_MARKET_DATA')throw error;}
     const current=await this.deps.market.capture(ledger.entry.entryPlan,ledger.position.legs,config);
     const price=current.prices.find(p=>p.legId===child.get('legId'));
     if(!price||price.side!==child.get('side')||price.quantityUnits!==child.get('quantityUnits')||
       (price.side==='SELL'?child.get('limitPriceMinor')>price.priceMinor:child.get('limitPriceMinor')<price.priceMinor))throw new Error('EXIT_PRICE_NOT_EXECUTABLE');
     current.assertCurrent();
    };
    await this.store.record(lease,{evaluatedAt:this.deps.clock(),kind:'CLAIM_MARKET',closeIntentId:next.intentId,orderId:order.get('orderId'),market:evidence.provenance,prices:evidence.prices});
    const submitted=await manager.submit(order.get('orderId'),guard);
    if(submitted.status==='UNRESOLVED')throw new Error('ORDER_OUTCOME_UNRESOLVED');
    const consumed=await processor.processRetained(order.get('orderId'));if(consumed.failedTradeKeys.length)throw new Error('FILL_PROCESSING_REQUIRED');
   }
  }
  return finish('CLOSING','CLOSE_PROGRESSION_PENDING');
 }
}
