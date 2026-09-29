import { RecoveryBarrierService } from "../../src/services/RecoveryBarrierService";
import { ReconciliationService } from "../../src/services/ReconciliationService";
import { before,after,beforeEach,test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import mongoose, {type ClientSession} from "mongoose";
import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";
import { createExecutionIndexes,executionModels } from "../../src/db/executionModels";
import { PaperEntryOrchestrator, type PaperOrchestrationDependencies } from "../../src/services/PaperEntryOrchestrator";
import { PaperBrokerAdapter,type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import { RiskControlService } from "../../src/services/RiskControlService";
import { FillProcessor } from "../../src/services/FillProcessor";
import { config,evaluationTime,fakeLLM,llmConfig,mockCapture,realProvider } from "../fixtures/paperOrchestration";
import { brokerSnapshot,config as reconciliationConfig } from "../reconciliationFixtures";
import * as f from "../fixtures";
const uri=process.env.EXECUTION_TEST_MONGO_URI;
if(!uri||!new URL(uri).pathname.startsWith('/phase2a_test_'))throw new Error('isolated real Mongo required');
const connection=mongoose.createConnection(uri),models=executionModels(connection),host=createExecutionHostContext('phase6a-host');
let now:Date, core:PaperEntryOrchestrator, deps:PaperOrchestrationDependencies, broker:PaperBrokerAdapter;
let calls:string[],llmCalls:number,scenario:(side:string,quantity:number,price:number)=>PaperScenario, ids=0, attempts=0;
const clock=()=>new Date(now), policy={policyVersion:1,maxRiskPerEntryMinor:10000000,maxReservedRiskMinor:20000000,maxPositionSlots:10,maxDailyLossMinor:1000000};
async function tx(work:(s:ClientSession)=>Promise<unknown>){const s=await connection.startSession();try{return await s.withTransaction(()=>work(s));}finally{await s.endSession();}}
async function change(values:Record<string,unknown>){await tx(async s=>{const a=await models.TradingAccount.findOne(f.scope).session(s).orFail();a.set(values);await a.save({session:s});});}
const original={h:http.request,hg:http.get,s:https.request,sg:https.get,f:fetch};
before(async()=>{await connection.asPromise();const block=()=>{attempts++;throw new Error('EXTERNAL_HTTP_FORBIDDEN');};http.request=block as any;http.get=block as any;https.request=block as any;https.get=block as any;globalThis.fetch=block as any;});
after(async()=>{await connection.close();http.request=original.h;http.get=original.hg;https.request=original.s;https.get=original.sg;globalThis.fetch=original.f;assert.equal(attempts,0);});
beforeEach(async()=>{
 await connection.dropDatabase();await createExecutionIndexes(connection);now=new Date(+evaluationTime-100);calls=[];llmCalls=0;ids=0;
 await tx(s=>new models.TradingAccount({...f.account(),admissionStatus:'PAPER_READY',entryRiskPolicy:policy,reconciliationConfig}).save({session:s}));
 const recovery=new RecoveryBarrierService(connection,f.scope,clock,host);await recovery.beginRecovery(f.scope.accountId,'startup');now=new Date(+now+1);
 const rec=await new ReconciliationService(connection,f.scope,clock,host).reconcileAccount(f.scope.accountId,await brokerSnapshot({time:now,orders:false,trades:false,positions:false}));
 await recovery.completeRecovery(f.scope.accountId,rec.recordId);now=new Date(evaluationTime);
 scenario=(_side,q,p)=>({submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]});
 broker=new PaperBrokerAdapter(f.scope,{clock:{now:()=>now.toISOString()},ids:{nextId:k=>`${k}-${++ids}`},scenario:r=>{calls.push(r.side);return scenario(r.side,r.quantityUnits,r.limitPriceMinor!);}});
 deps={host,clock,broker:()=>broker,transport:fakeLLM('BULLISH','AGREE',()=>llmCalls++),llmConfig:()=>llmConfig,
  market:{prepare:async()=>{},assertCurrent:()=>{},capture:()=>mockCapture(now)}};
 core=new PaperEntryOrchestrator(connection,deps);await core.initialize();
});
import { PaperExitMonitor } from '../../src/services/PaperExitMonitor';
import { PaperExitMarketData } from '../../src/services/PaperExitMarketData';
import { captureExitConfig } from '../../src/domain/paperExits';
import { RiskSettlementService } from '../../src/services/RiskSettlementService';
import { OrderManager } from '../../src/services/OrderManager';
import { CloseIntentService } from '../../src/services/CloseIntentService';
import { CloseWorkflowService } from '../../src/services/CloseWorkflowService';
const exitConfig=(family:Parameters<typeof config>[0])=>captureExitConfig({version:'PAPER_EXIT_V1',accountId:f.scope.accountId,executionMode:'PAPER',dataMode:'KITE_REAL',family,
 takeProfitBps:5000,stopLossBps:5000,maxHoldingMs:3600000,eodMinuteIST:920,maxAgeMs:30000,authorizationMs:900000,directionalStop:'DEFERRED_NO_CAPTURED_BASIS'});
async function open(family:Parameters<typeof config>[0]='LONG_OPTION',stranded=false){
 const wire=await realProvider(clock);deps.market=wire.provider;
 if(stranded)scenario=(side,q,p)=>side==='SELL'?{submission:'REJECTED'}:{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};
 const session=await core.start({...config(family),dataMode:'KITE_REAL'}),result=await core.runEvaluationCycle(session.sessionId);
 assert.equal(result.outcome,stranded?'ATTENTION':'ENTRY',JSON.stringify(result));
 const position=await models.Position.findOne().orFail(),positionId=position.get('positionId');
 const exitDeps={clock,market:new PaperExitMarketData(wire.options,clock),configs:async()=>[exitConfig(family)],broker:()=>broker};
 const monitor=new PaperExitMonitor(connection,exitDeps);await monitor.initialize();
 scenario=(_s,q,p)=>({submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]});
 const entries=await models.BrokerOrder.find({intentId:position.get('entryIntentId')});
 function prices(kind:'TP'|'SL'|'FLAT'){
  for(const order of entries){const p=order.get('limitPriceMinor'),buy=order.get('side')==='BUY';
   const price=kind==='FLAT'?p:kind==='TP'?(buy?p*3:Math.max(1500,p/3)):(buy?1500:p*3);
   wire.state.exitPrices[order.get('contractKey')]={bidMinor:Math.floor(price/5)*5,askMinor:Math.floor(price/5)*5};
  }
 }
 prices('FLAT');return{wire,session,positionId,monitor,exitDeps,prices,entries};
}
async function settled(id:string){
 const p=await models.Position.findOne({positionId:id}).orFail();assert.equal(p.get('lifecycle'),'CLOSED');
 for(const l of p.get('legs'))assert.equal(l.entryFilledUnits,l.exitFilledUnits);
 const a=await models.TradingAccount.findOne().orFail();assert.equal(a.get('positionSlots'),0);assert.equal(a.get('committedPositionSlots'),0);
 assert.equal(a.get('reservedExposureMinor'),0);assert.equal(a.get('committedExposureMinor'),0);
 assert.equal(await models.TradingEvent.countDocuments({eventType:'ENTRY_RISK_SETTLED'}),1);
}
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)for(const trigger of ['TP','SL'] as const)
 test(`real ${family} ${trigger}: actual fills, executable side, finality and settlement`,async()=>{
 const x=await open(family);x.prices(trigger);const r=await x.monitor.evaluateOpenPosition(x.positionId);assert.equal(r.status,'SETTLED',JSON.stringify(r));await settled(x.positionId);
 assert.deepEqual(calls,family==='LONG_OPTION'?['BUY','SELL']:['BUY','SELL','BUY','SELL']);
 const decision=await x.monitor.store.decisions.findOne({economics:{$exists:true}});assert.equal(decision!.reason,trigger==='TP'?'TAKE_PROFIT':'STOP_LOSS');
 const fills=await models.Fill.find().lean<any[]>(),cash=fills.reduce((s,f)=>s+f.quantityUnits*f.priceMinor*(f.side==='SELL'?1:-1),0);
 assert.equal((await models.Position.findOne().orFail()).get('realizedPnlMinor'),cash);
 assert.equal(decision!.economics.entryCashFlowMinor,fills.filter(f=>f.intentId===(x.entries[0].get('intentId'))).reduce((s,f)=>s+f.quantityUnits*f.priceMinor*(f.side==='SELL'?1:-1),0));
});
for(const reason of ['TIME_EXIT','EOD_EXIT'] as const)test(`real long ${reason} uses durable fill time beyond entry evidence expiry`,async()=>{
 const x=await open();now=reason==='TIME_EXIT'?new Date(+now+3600000):new Date('2026-09-29T09:50:00Z');
 const restarted=new PaperExitMonitor(connection,x.exitDeps);assert.ok((await restarted.listPositions()).some(p=>p.positionId===x.positionId));
 const r=await restarted.evaluateOpenPosition(x.positionId);assert.equal(r.status,'SETTLED',JSON.stringify(r));
 assert.equal((await restarted.store.decisions.findOne({economics:{$exists:true}}))!.reason,reason);await settled(x.positionId);
});
test('real repeated, concurrent and restarted ticks create one close chain and one settlement',async()=>{
 const x=await open('CREDIT_VERTICAL');x.prices('SL');const second=new PaperExitMonitor(connection,x.exitDeps);
 await Promise.all([x.monitor.evaluateOpenPosition(x.positionId),x.monitor.evaluateOpenPosition(x.positionId),second.evaluateOpenPosition(x.positionId)]);
 await second.evaluateOpenPosition(x.positionId);await settled(x.positionId);
 assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),1);
 const close=await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail();assert.equal(await models.BrokerOrder.countDocuments({intentId:close.get('intentId')}),2);
 assert.deepEqual(calls,['BUY','SELL','BUY','SELL']);assert.equal(await models.RiskReservation.countDocuments({kind:'CLOSE_QUANTITY'}),1);
 const service=new RiskSettlementService(connection,f.scope,clock);await Promise.all([service.settleClosedPosition(x.positionId),service.settleClosedPosition(x.positionId)]);await settled(x.positionId);
});
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real ${family} partial close preserves exposure/hedge until confirmed full cover`,async()=>{
 const x=await open(family);x.prices('SL');let first=true;
 scenario=(_s,q,p)=>{if(first){first=false;return{submission:'ACCEPTED',initialFills:[{quantityUnits:30,priceMinor:p}],steps:[{kind:'FILL',quantityUnits:q-30,priceMinor:p}]};}return{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};};
 await x.monitor.evaluateOpenPosition(x.positionId);const p=await models.Position.findOne().orFail();assert.notEqual(p.get('lifecycle'),'CLOSED');
 assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),1);assert.equal(await models.TradingEvent.countDocuments({eventType:'ENTRY_RISK_SETTLED'}),0);
 const close=await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail(),child=await models.BrokerOrder.findOne({intentId:close.get('intentId'),submissionClaim:{$exists:true}}).orFail();
 assert.equal(child.get('filledUnits'),30);if(family!=='LONG_OPTION'){assert.equal(child.get('side'),'BUY');assert.equal(p.get('legs').find((l:any)=>l.entrySide==='BUY').exitFilledUnits,0);}
 const submitted=calls.length;await x.monitor.evaluateOpenPosition(x.positionId);assert.equal(calls.length,submitted);
 await broker.advance({...f.scope,orderId:child.get('orderId')});const r=await x.monitor.evaluateOpenPosition(x.positionId);assert.equal(r.status,'SETTLED',JSON.stringify(r));await settled(x.positionId);
});
for(const family of ['LONG_OPTION','CREDIT_VERTICAL'] as const)test(`real ${family} UNKNOWN no retry across restart; late fills ingested without premature settlement`,async()=>{
 const x=await open(family);x.prices('SL');scenario=(_s,q,p)=>({submission:'AMBIGUOUS',steps:[{kind:'FILL',quantityUnits:q,priceMinor:p}]});
 await x.monitor.evaluateOpenPosition(x.positionId);const count=calls.length,close=await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail();
 const child=await models.BrokerOrder.findOne({intentId:close.get('intentId'),submissionClaim:{$exists:true}}).orFail();assert.equal(child.get('knowledge'),'UNKNOWN');
 const restart=new PaperExitMonitor(connection,x.exitDeps);await restart.evaluateOpenPosition(x.positionId);assert.equal(calls.length,count);
 await broker.advance({...f.scope,orderId:child.get('orderId')});await restart.evaluateOpenPosition(x.positionId);
 assert.equal((await models.BrokerOrder.findById(child._id).orFail()).get('filledUnits'),65);assert.equal(calls.length,count);
 assert.notEqual((await models.Position.findOne().orFail()).get('lifecycle'),'CLOSED');assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),1);
 if(family!=='LONG_OPTION')assert.equal((await models.Position.findOne().orFail()).get('legs').find((l:any)=>l.entrySide==='BUY').exitFilledUnits,0);
});
for(const failure of ['stale','missing','mock','config'] as const)test(`real ${failure} blocks durably without quote PnL; fresh later evidence recovers`,async()=>{
 const x=await open();x.prices('TP');const before=(await models.Position.findOne().orFail()).get('realizedPnlMinor');
 if(failure==='stale')x.wire.state.ageMs=30001;if(failure==='missing')x.wire.state.missing=true;if(failure==='mock')x.wire.state.mode='MOCK';if(failure==='config')x.exitDeps.configs=async()=>[];
 assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'ATTENTION');assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),0);
 assert.equal((await models.Position.findOne().orFail()).get('realizedPnlMinor'),before);assert.equal((await x.monitor.store.states.findOne({positionId:x.positionId}))!.status,'ATTENTION');
 x.wire.state.ageMs=0;x.wire.state.missing=false;x.wire.state.mode='KITE_REAL';x.exitDeps.configs=async()=>[exitConfig('LONG_OPTION')];
 assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');await settled(x.positionId);
});
test('real stranded long cleanup proves never-executed short without fabricated fills',async()=>{
 const x=await open('CREDIT_VERTICAL',true);assert.equal(await models.Fill.countDocuments(),1);
 const r=await x.monitor.evaluateOpenPosition(x.positionId);assert.equal(r.status,'SETTLED',JSON.stringify(r));await settled(x.positionId);
 assert.deepEqual(calls,['BUY','SELL','SELL']);assert.equal(await models.Fill.countDocuments(),2);
 const p=await models.Position.findOne().orFail(),short=p.get('legs').find((l:any)=>l.entrySide==='SELL');assert.equal(short.entryFilledUnits,0);assert.equal(short.exitFilledUnits,0);
 const decision=await x.monitor.store.decisions.findOne({economics:{$exists:true}});assert.equal(decision!.reason,'STRANDED_LONG_CLEANUP');
 const close=await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail();assert.equal(await models.BrokerOrder.countDocuments({intentId:close.get('intentId')}),1);
});
test('real session STOP and kill switch do not disable financial exit monitoring',async()=>{
 const x=await open();await core.stop(x.session.sessionId);await new RiskControlService(connection,f.scope,clock).setKillSwitch('exit-test',true,'TEST');
 assert.equal((await models.Position.findOne().orFail()).get('lifecycle'),'OPEN');x.prices('TP');assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');await settled(x.positionId);
});
test('real new host ENTRY remains recovery gated while approved PAPER close progresses',async()=>{
 const x=await open();await core.stop(x.session.sessionId);const restarted=new PaperEntryOrchestrator(connection,{...deps,host:createExecutionHostContext('other-host')});
 await assert.rejects(restarted.start({...config('LONG_OPTION'),dataMode:'KITE_REAL'}),/RECOVERY_REQUIRED/);
 x.prices('TP');assert.equal((await new PaperExitMonitor(connection,x.exitDeps).evaluateOpenPosition(x.positionId)).status,'SETTLED');
});
for(const boundary of ['plan','claim'] as const)for(const fault of ['master','age','lease'] as const)test(`real ${fault} loss at ${boundary} prevents new physical action`,async()=>{
 const x=await open();x.prices('TP');const prototype=boundary==='plan'?CloseIntentService.prototype:OrderManager.prototype,key=boundary==='plan'?'requestClose':'submit';
 const old=(prototype as any)[key];(prototype as any)[key]=async function(...args:any[]){if(fault==='master')await x.wire.options.refreshMaster();else now=new Date(+now+(fault==='age'?30001:60001));return old.apply(this,args);};
 try{assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'ATTENTION');assert.deepEqual(calls,['BUY']);assert.equal(await models.Fill.countDocuments(),1);
 if(boundary==='plan')assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),0);
 else assert.equal(await models.BrokerOrder.countDocuments({intentId:(await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail()).get('intentId'),submissionClaim:{$exists:true}}),0);
 }finally{(prototype as any)[key]=old;}
});
test('real quote estimate alone does not write realized PnL',async()=>{
 const x=await open();x.prices('FLAT');const before=await models.Position.findOne().lean();assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'MONITORING');assert.deepEqual(await models.Position.findOne().lean(),before);assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),0);
});
test('real settled positions excluded on restart',async()=>{const x=await open();x.prices('TP');await x.monitor.evaluateOpenPosition(x.positionId);assert.deepEqual(await x.monitor.listPositions(),[]);});
for(const [family,stranded,trigger]of [['LONG_OPTION',false,'TP'],['CREDIT_VERTICAL',false,'SL'],['CREDIT_VERTICAL',true,'FLAT']] as const)test(`OFFLINE_EXIT_SMOKE ${stranded?'STRANDED_LONG':family}`,async()=>{
 const x=await open(family,stranded);x.prices(trigger);const result=await x.monitor.evaluateOpenPosition(x.positionId);assert.equal(result.status,'SETTLED',JSON.stringify(result));await settled(x.positionId);
 console.log('OFFLINE_EXIT_SMOKE',JSON.stringify({fixtureOnly:true,family,stranded,positionId:x.positionId,result,paperSides:calls,fillCount:await models.Fill.countDocuments(),realHttpCalls:attempts}));
});
test('real zero-fill shell excluded and explicit evaluation cannot create exit',async()=>{
 const wire=await realProvider(clock);deps.market=wire.provider;const s=await core.start({...config('LONG_OPTION'),dataMode:'KITE_REAL'});
 const original=OrderManager.prototype.submit;OrderManager.prototype.submit=async()=>{throw new Error('fixture before claim');};
 try{await core.runEvaluationCycle(s.sessionId);}finally{OrderManager.prototype.submit=original;}
 const p=await models.Position.findOne().orFail();assert.equal(p.get('lifecycle'),'PENDING_ENTRY');
 const monitor=new PaperExitMonitor(connection,{clock,market:new PaperExitMarketData(wire.options,clock),configs:async()=>[exitConfig('LONG_OPTION')],broker:()=>broker});await monitor.initialize();
 assert.deepEqual(await monitor.listPositions(),[]);assert.equal((await monitor.evaluateOpenPosition(p.get('positionId'))).status,'IGNORED');assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),0);assert.equal(await models.Fill.countDocuments(),0);
});
test('real expired unclaimed short is transactionally retired before stranded cleanup',async()=>{
 const wire=await realProvider(clock);deps.market=wire.provider;const s=await core.start({...config(),dataMode:'KITE_REAL'}),submit=broker.submitOrder.bind(broker);
 broker.submitOrder=async request=>{const result=await submit(request);if(request.side==='BUY')await core.stop(s.sessionId);return result;};
 assert.equal((await core.runEvaluationCycle(s.sessionId)).outcome,'ATTENTION');assert.deepEqual(calls,['BUY']);now=new Date(+now+31000);
 const monitor=new PaperExitMonitor(connection,{clock,market:new PaperExitMarketData(wire.options,clock),configs:async()=>[exitConfig('CREDIT_VERTICAL')],broker:()=>broker});await monitor.initialize();
 const p=await models.Position.findOne().orFail(),r=await monitor.evaluateOpenPosition(p.get('positionId'));assert.equal(r.status,'SETTLED',JSON.stringify(r));await settled(p.get('positionId'));
 assert.equal((await models.BrokerOrder.findOne({intentId:p.get('entryIntentId'),side:'SELL'}).orFail()).get('phase'),'NOT_SENT');assert.deepEqual(calls,['BUY','SELL']);assert.equal(await models.Fill.countDocuments(),2);
});
test('real daily realized-loss gate blocks new ENTRY but not an existing second close',async()=>{
 await change({entryRiskPolicy:{...policy,maxDailyLossMinor:1}});const x=await open();now=new Date(+now+300000);
 assert.equal((await core.runEvaluationCycle(x.session.sessionId)).outcome,'ENTRY');const second=await models.Position.findOne({positionId:{$ne:x.positionId}}).orFail();
 x.prices('SL');assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');assert.ok((await models.TradingAccount.findOne().orFail()).get('dailyRealizedPnlMinor')<0);
 now=new Date(+now+300000);const entry=await core.runEvaluationCycle(x.session.sessionId);assert.notEqual(entry.outcome,'ENTRY');
 assert.equal((await x.monitor.evaluateOpenPosition(second.get('positionId'))).status,'SETTLED');assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),0);
});
test('real close transaction rolls back hold and children on audit failure',async()=>{
 const x=await open();x.prices('TP');const save=models.TradingEvent.prototype.save;
 models.TradingEvent.prototype.save=function(...args:unknown[]){if(this.get('eventType')==='POSITION_CLOSE_REQUESTED')return Promise.reject(new Error('fixture close audit failure'));return save.apply(this,args);};
 try{assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'ATTENTION');assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),0);assert.equal(await models.RiskReservation.countDocuments({kind:'CLOSE_QUANTITY'}),0);assert.deepEqual(calls,['BUY']);
 assert.ok((await models.Position.findOne().orFail()).get('legs').every((l:any)=>l.closeHeldUnits===0));
 }finally{models.TradingEvent.prototype.save=save;}
 assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');await settled(x.positionId);
});
test('real monitor-owned close cannot be submitted without fresh market/lease guard',async()=>{
 const x=await open();x.prices('TP');const original=OrderManager.prototype.submit;OrderManager.prototype.submit=async()=>{throw new Error('fixture pause');};
 try{await x.monitor.evaluateOpenPosition(x.positionId);}finally{OrderManager.prototype.submit=original;}
 const intent=await models.OrderIntent.findOne({purpose:'CLOSE'}).orFail(),child=await models.BrokerOrder.findOne({intentId:intent.get('intentId')}).orFail();
 await assert.rejects(new OrderManager(connection,f.scope,broker,clock).submit(child.get('orderId')),/EXIT_AUTHORIZATION_REQUIRED/);assert.deepEqual(calls,['BUY']);
 assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');
});
test('real immutable expired close authorization retains exposure without replacement or retry',async()=>{
 const x=await open();x.prices('TP');const original=OrderManager.prototype.submit;OrderManager.prototype.submit=async()=>{throw new Error('fixture pause');};
 try{await x.monitor.evaluateOpenPosition(x.positionId);}finally{OrderManager.prototype.submit=original;}
 now=new Date(+now+900001);await x.monitor.evaluateOpenPosition(x.positionId);await x.monitor.evaluateOpenPosition(x.positionId);
 assert.equal(await models.OrderIntent.countDocuments({purpose:'CLOSE'}),1);assert.deepEqual(calls,['BUY']);assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),1);
});
test('real close broker dispatch occurs outside every Mongo transaction',async()=>{
 const x=await open();x.prices('TP');const sessions:ClientSession[]=[],start=connection.startSession.bind(connection);
 connection.startSession=async(...args)=>{const s=await start(...args);sessions.push(s);return s;};
 scenario=(_s,q,p)=>{assert.ok(sessions.every(s=>!s.inTransaction()));return{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};};
 try{assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');}finally{connection.startSession=start;}
});
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real bearish ${family} closes the exact put/call legs in safe order`,async()=>{
 deps.transport=fakeLLM('BEARISH');const x=await open(family);x.prices('SL');
 assert.equal((await x.monitor.evaluateOpenPosition(x.positionId)).status,'SETTLED');await settled(x.positionId);
 assert.deepEqual(calls,family==='LONG_OPTION'?['BUY','SELL']:['BUY','SELL','BUY','SELL']);
 const state=await x.monitor.store.states.findOne({positionId:x.positionId});assert.equal(state!.triggerReason,'STOP_LOSS');
});
