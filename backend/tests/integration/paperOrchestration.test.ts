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
import { readPaperDashboard } from "../../src/services/PaperDashboardReadService";
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
async function start(family:Parameters<typeof config>[0]='CREDIT_VERTICAL'){return core.start(config(family));}
async function cycle(family:Parameters<typeof config>[0]='CREDIT_VERTICAL'){const s=await start(family);return{session:s,result:await core.runEvaluationCycle(s.sessionId)};}
async function zeroFinancial(){for(const name of ['OrderIntent','RiskReservation','BrokerOrder','Fill','Position'] as const)assert.equal(await models[name].countDocuments(),0);assert.deepEqual(calls,[]);}
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real ${family} complete pipeline, one slot and exact qualified economics`,async()=>{
 const {result}=await cycle(family);assert.equal(result.outcome,'ENTRY',JSON.stringify(result));assert.deepEqual(calls,family==='LONG_OPTION'?['BUY']:['BUY','SELL']);
 const p=await models.Position.findOne().orFail();assert.equal(p.get('lifecycle'),'OPEN');assert.equal(await models.Fill.countDocuments(),calls.length);
 for(const leg of p.get('legs'))assert.equal(leg.entryFilledUnits,65);
 const a=await models.TradingAccount.findOne().orFail();assert.equal(a.get('positionSlots'),1);assert.equal(a.get('committedPositionSlots'),1);
 const signal=await models.StrategySignal.findOne().orFail(),history=await core.history.Cycle.findOne().orFail();
 assert.equal(signal.get('orchestration.cycleId'),history.get('cycleId'));assert.equal(history.get('decision.strategyResult.candidate.strategyFamily'),family);
 assert.equal(history.get('decision.primary.result.model'),'fixture');assert.equal(history.get('decision.dataMode'),'MOCK');
 assert.equal(await connection.db!.collection('options_positions').countDocuments(),0);
});
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real Mongo dashboard reads fill-derived ${family} without financial writes`,async()=>{
 const {session,result}=await cycle(family);assert.equal(result.outcome,'ENTRY');
 const before=await Promise.all([models.Position.countDocuments(),models.Fill.countDocuments(),models.OrderIntent.countDocuments(),
  models.TradingEvent.countDocuments()]);
 const accountVersion=(await models.TradingAccount.findOne(f.scope).orFail()).get('version');
 const positionVersion=(await models.Position.findOne().orFail()).get('version');
 const view=await readPaperDashboard(connection,session.sessionId,true,host.startupId);
 assert.equal(view.session.sessionId,session.sessionId);assert.equal(view.session.accountId,f.scope.accountId);
 assert.equal(view.session.executionMode,'PAPER');assert.equal(view.session.strategyFamily,family);
 assert.equal(view.positions.length,1);assert.equal(view.positions[0]!.family,family);
 assert.equal(view.positions[0]!.legs.length,family==='LONG_OPTION'?1:2);
 assert.ok(view.positions[0]!.legs.every(l=>l.entryPriceEvidence==='FILL_BACKED'&&l.filledUnits===65));
 assert.equal(view.decisions[0]!.outcome,'ENTRY');assert.equal(view.decisions[0]!.family,family);
 assert.equal(view.exits.status,'ACTIVE');assert.equal(view.risk?.recoveryStatus,'READY');
 assert.deepEqual(await Promise.all([models.Position.countDocuments(),models.Fill.countDocuments(),models.OrderIntent.countDocuments(),
  models.TradingEvent.countDocuments()]),before);
 assert.equal((await models.TradingAccount.findOne(f.scope).orFail()).get('version'),accountVersion);
 assert.equal((await models.Position.findOne().orFail()).get('version'),positionVersion);
});
for(const mode of ['LIVE',undefined])test(`real start rejects mode ${mode}`,async()=>{await assert.rejects(core.start({...config(),executionMode:mode}));await zeroFinancial();});
for(const family of [undefined,'AUTO','BAD'])test(`real start rejects family ${family}`,async()=>{await assert.rejects(core.start({...config(),strategyConfig:{...config().strategyConfig,strategyFamily:family}}));});
test('real concurrent repeated start has one running session',async()=>{const s=await Promise.all([start(),start()]);assert.equal(s[0].sessionId,s[1].sessionId);assert.equal(await core.history.Session.countDocuments(),1);});
test('real disconnected KITE_REAL refuses start',async()=>{deps.market.prepare=async()=>{throw new Error('KITE_SESSION_REQUIRED');};await assert.rejects(core.start({...config(),dataMode:'KITE_REAL'}),/KITE_SESSION_REQUIRED/);assert.equal(await core.history.Session.countDocuments(),0);});
test('real stopped session cannot evaluate and stop is not flatness',async()=>{const {session}=await cycle();const before=await models.TradingAccount.findOne().lean();await core.stop(session.sessionId);await assert.rejects(core.runEvaluationCycle(session.sessionId),/SESSION_STOPPED/);assert.deepEqual(await models.TradingAccount.findOne().lean(),before);assert.equal((await models.Position.findOne().orFail()).get('lifecycle'),'OPEN');});
test('real replacement session invalidates old owner',async()=>{const s=await start();await core.stop(s.sessionId);const next=await start();assert.notEqual(s.sessionId,next.sessionId);await assert.rejects(core.runEvaluationCycle(s.sessionId),/SESSION_STOPPED/);});
test('real overlapping same-session cycles skip without LLM or entry duplication',async()=>{
 const s=await start();let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 deps.market.capture=async()=>{entered();await wait;return mockCapture(now);};const first=core.runEvaluationCycle(s.sessionId);await ready;
 assert.equal((await core.runEvaluationCycle(s.sessionId)).outcome,'SKIPPED');release();await first;assert.equal(await models.OrderIntent.countDocuments(),1);
});
test('real competing orchestrators claim one canonical cycle',async()=>{
 const s=await start(),second=new PaperEntryOrchestrator(connection,deps);await Promise.all([core.runEvaluationCycle(s.sessionId),second.runEvaluationCycle(s.sessionId)]);
 assert.equal(await core.history.Cycle.countDocuments(),1);assert.equal(await models.OrderIntent.countDocuments(),1);assert.deepEqual(calls,['BUY','SELL']);
});
test('real jitter/replay shares durable decision and no second call',async()=>{const {session}=await cycle();now=new Date(+now+45000);const r=await core.runEvaluationCycle(session.sessionId);assert.equal('replay'in r&&r.replay,true);assert.equal(await models.OrderIntent.countDocuments(),1);assert.deepEqual(calls,['BUY','SELL']);assert.equal(llmCalls,2);});
test('real later window permits distinct valid signal',async()=>{const {session}=await cycle();now=new Date(+now+300000);const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY');assert.equal(await models.OrderIntent.countDocuments(),2);});
test('real same-window config change conflicts even across sessions',async()=>{const {session}=await cycle();await core.stop(session.sessionId);const next=await start('LONG_OPTION');await assert.rejects(core.runEvaluationCycle(next.sessionId),/DECISION_CONFLICT/);assert.equal(await models.OrderIntent.countDocuments(),1);});
test('real slow cycle expires instead of admitting stale backlog',async()=>{const s=await start();deps.transport=fakeLLM('BULLISH','AGREE',()=>{now=new Date(+now+300000);});const r=await core.runEvaluationCycle(s.sessionId);assert.equal(r.outcome,'HOLD');await zeroFinancial();});
for(const reason of ['MARKET_DATA_NOT_FRESH','ANALYTICS_UNAVAILABLE','REAL_DATA_REQUIRED'] as const)test(`real ${reason} makes no OpenAI call or financial state`,async()=>{deps.market.capture=async()=>({analytics:{available:false,reason},evaluatedAt:now.toISOString(),expiry:'2026-10-06'});await cycle();assert.equal(llmCalls,0);await zeroFinancial();});
test('real MOCK evidence cannot be relabeled KITE_REAL',async()=>{const s=await core.start({...config(),dataMode:'KITE_REAL'});const r=await core.runEvaluationCycle(s.sessionId);assert.equal(r.outcome,'ERROR');assert.equal(llmCalls,0);await zeroFinancial();});
for(const kind of ['HOLD','VETO','FAIL'])test(`real LLM ${kind} has no financial state`,async()=>{deps.transport=kind==='FAIL'?{complete:async()=>{throw new Error('offline');}}:fakeLLM(kind==='HOLD'?'HOLD':'BULLISH',kind==='VETO'?'DISAGREE':'AGREE');const {result}=await cycle();assert.equal(result.outcome,'HOLD');await zeroFinancial();});
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)for(const gate of ['kill','daily','capacity'])test(`real ${family} ${gate} between candidate and admission blocks broker`,async()=>{
 let losingPosition:string|undefined;
 if(gate==='daily'){const prior=await cycle('LONG_OPTION');losingPosition=(await models.Position.findOne().orFail()).get('positionId');await core.stop(prior.session.sessionId);now=new Date(+now+300000);calls=[];await change({entryRiskPolicy:{...policy,maxDailyLossMinor:65000}});}
 deps.transport={complete:async r=>{if(r.stage==='VERIFIER'){
  if(gate==='daily')await realizeLoss(losingPosition!);
  else if(gate==='kill')await new RiskControlService(connection,f.scope,clock).setKillSwitch('stop',true,'TEST');
  else await change({entryRiskPolicy:{...policy,maxRiskPerEntryMinor:1}});
 }return fakeLLM().complete(r);}};
 const {result}=await cycle(family);assert.equal(result.outcome,'REJECTED',JSON.stringify(result));assert.deepEqual(calls,[]);assert.equal(await models.RiskReservation.countDocuments({intentId:(await core.history.Cycle.findOne({cycleId:result.cycleId}).orFail()).get('intentId')}),0);if(gate==='daily')assert.equal(result.reason,'DAILY_LOSS_LIMIT_EXCEEDED');
});
for(const gate of ['recovery','reconciliation'])test(`real ${gate} readiness blocks cycle before LLM`,async()=>{
 const s=await start();now=new Date(+now+1);
 if(gate==='recovery')await new RecoveryBarrierService(connection,f.scope,clock,host).beginRecovery(f.scope.accountId,'new-generation');
 else await new ReconciliationService(connection,f.scope,clock,host).reconcileAccount(f.scope.accountId,await brokerSnapshot({time:now,orders:false,trades:false,positions:false,fail:'/orders'}));
 const r=await core.runEvaluationCycle(s.sessionId);assert.equal(r.outcome,'ERROR');assert.equal(llmCalls,0);await zeroFinancial();
});
for(const family of ['DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)for(const qty of [0,1,32,64])test(`real ${family} BUY ${qty}/65 cannot dispatch fixed SELL`,async()=>{
 scenario=(_s,_q,p)=>({submission:'ACCEPTED',initialFills:qty?[{quantityUnits:qty,priceMinor:p}]:[]});const {result}=await cycle(family);assert.equal(result.outcome,'ATTENTION');assert.deepEqual(calls,['BUY']);
 const p=await models.Position.findOne().orFail();assert.equal(p.get('legs').find((l:any)=>l.entrySide==='SELL').entryFilledUnits,0);
});
for(const family of ['DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real ${family} rejected SELL exposes stranded long`,async()=>{
 scenario=(s,q,p)=>s==='SELL'?{submission:'REJECTED'}:{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};const {result}=await cycle(family);assert.equal(result.outcome,'ATTENTION');assert.equal(await models.Fill.countDocuments(),1);assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),1);
});
for(const side of ['BUY','SELL'])test(`real UNKNOWN ${side} cannot blind retry; owned late fills remain ingestible`,async()=>{
 scenario=(s,q,p)=>s===side?{submission:'AMBIGUOUS',steps:[{kind:'FILL',quantityUnits:q,priceMinor:p}]}:{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};
 const {session,result}=await cycle();assert.equal(result.outcome,'ATTENTION');const prior=calls.length;
 await core.runEvaluationCycle(session.sessionId);await core.progressEntry(result.cycleId!);assert.equal(calls.length,prior);
 const order=await models.BrokerOrder.findOne({side,knowledge:'UNKNOWN'}).orFail();await broker.advance({...f.scope,orderId:order.get('orderId')});
 await core.stop(session.sessionId);for(const trade of await broker.getTrades(f.scope))await new FillProcessor(connection,f.scope,clock).process(trade);
 assert.equal((await models.BrokerOrder.findById(order._id).orFail()).get('filledUnits'),65);
});
test('real stop during LLM prevents new entry',async()=>{const s=await start();deps.transport={complete:async r=>{await core.stop(s.sessionId);return fakeLLM().complete(r);}};await core.runEvaluationCycle(s.sessionId);await zeroFinancial();});
test('real stop after BUY dispatch retains receipt/fill truth and blocks new SELL claim',async()=>{
 const s=await start(),originalSubmit=broker.submitOrder.bind(broker);broker.submitOrder=async request=>{const result=await originalSubmit(request);await core.stop(s.sessionId);return result;};
 const result=await core.runEvaluationCycle(s.sessionId);assert.equal(result.outcome,'ATTENTION');assert.deepEqual(calls,['BUY']);assert.equal(await models.Fill.countDocuments(),1);
});
test('real restarted host cannot start or run old session before recovery',async()=>{
 const s=await start(),restart=new PaperEntryOrchestrator(connection,{...deps,host:createExecutionHostContext('new-host')});
 await assert.rejects(restart.runEvaluationCycle(s.sessionId),/SESSION_REPLACED/);await core.stop(s.sessionId);await assert.rejects(restart.start(config()),/RECOVERY_REQUIRED/);await zeroFinancial();
});
test('real duplicate explicit progression cannot duplicate physical calls or fills',async()=>{const {result}=await cycle();await Promise.all([core.progressEntry(result.cycleId!),core.progressEntry(result.cycleId!)]);assert.deepEqual(calls,['BUY','SELL']);assert.equal(await models.Fill.countDocuments(),2);});
test('real financial submit runs after Mongo transaction completion',async()=>{
 const sessions:ClientSession[]=[];const originalStart=connection.startSession.bind(connection);connection.startSession=async(...args)=>{const s=await originalStart(...args);sessions.push(s);return s;};
 scenario=(_side,q,p)=>{assert.ok(sessions.every(s=>!s.inTransaction()));return{submission:'ACCEPTED',initialFills:[{quantityUnits:q,priceMinor:p}]};};
 try{const {result}=await cycle('LONG_OPTION');assert.equal(result.outcome,'ENTRY');}finally{connection.startSession=originalStart;}
});

// Test-only approved close workflow supplies real realized-loss evidence. No exit
// monitor or production close automation is introduced by this fixture.
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { OrderManager } from "../../src/services/OrderManager";
async function realizeLoss(positionId:string){
 const entry=await models.BrokerOrder.findOne({side:'BUY',positionId}).orFail();
 await tx(async session=>{const p=await models.Position.findOne({positionId}).session(session).orFail();
 p.set('closePolicy',{kind:'POSITION_LIMIT_V1',product:'INTRADAY',policyVersion:1,expiresAt:new Date(+now+60000),legLimits:[{legId:entry.get('legId'),limitPriceMinor:entry.get('limitPriceMinor')-1000}]});await p.save({session});});
 const close=await new CloseIntentService(connection,f.scope,clock).requestClose(positionId,'loss-fixture');
 await new CloseWorkflowService(connection,f.scope,clock).advance(positionId);
 const child=await models.BrokerOrder.findOne({intentId:close.intentId}).orFail();
 const closingBroker=new PaperBrokerAdapter(f.scope,{clock:{now:()=>now.toISOString()},ids:{nextId:()=>`close-${++ids}`},scenario:r=>({submission:'ACCEPTED',initialFills:[{quantityUnits:r.quantityUnits,priceMinor:r.limitPriceMinor!}]})});
 await new OrderManager(connection,f.scope,closingBroker,clock,host).submit(child.get('orderId'));
 await new FillProcessor(connection,f.scope,clock).processRetained(child.get('orderId'));
 assert.equal((await models.TradingAccount.findOne().orFail()).get('dailyRealizedPnlMinor'),-65000);
}
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`real Mongo qualified KITE_REAL ${family} entry`,async()=>{
 const fixture=await realProvider(clock);deps.market=fixture.provider;const s=await core.start({...config(family),dataMode:'KITE_REAL'});
 const r=await core.runEvaluationCycle(s.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));
 assert.equal((await models.OrderIntent.findOne().orFail()).get('entryPlan.dataMode'),'KITE_REAL');assert.equal(await models.Fill.countDocuments(),family==='LONG_OPTION'?1:2);
});
for(const failure of ['stale','unavailable','replaced'] as const)test(`real qualified ${failure} evidence cannot enter`,async()=>{
 const f=await realProvider(clock);deps.market=f.provider;const s=await core.start({...config(),dataMode:'KITE_REAL'});
 if(failure==='stale')f.state.ageMs=60001;if(failure==='unavailable')f.state.missing=true;
 if(failure==='replaced')deps.transport={complete:async r=>{await f.options.refreshMaster();return fakeLLM().complete(r);}};
 const r=await core.runEvaluationCycle(s.sessionId);assert.notEqual(r.outcome,'ENTRY');await zeroFinancial();if(failure!=='replaced')assert.equal(llmCalls,0);
});
for(const index of ['cycleId_1','accountId_1'])test(`real missing ${index} unique index fails closed`,async()=>{
 const s=await start();await connection.db!.collection(index==='cycleId_1'?'signal_logs':'monitoring_sessions').dropIndex(index);
 await assert.rejects(core.runEvaluationCycle(s.sessionId),/PAPER_INDEXES_REQUIRED/);await zeroFinancial();
});
test('real stop serialized inside adaptation transaction rolls back the whole new chain',async()=>{
 const s=await start(),save=models.OrderIntent.prototype.save;let stopped=false;
 models.OrderIntent.prototype.save=async function(...args:unknown[]){if(this.isNew&&!stopped){stopped=true;await core.stop(s.sessionId);}return save.apply(this,args);};
 try{const r=await core.runEvaluationCycle(s.sessionId);assert.equal(r.outcome,'ERROR');await zeroFinancial();assert.equal(await models.StrategySignal.countDocuments(),0);}finally{models.OrderIntent.prototype.save=save;}
});
test('real post-dispatch persistence failure retains claim and reservation without blind retry',async()=>{
 const save=models.TradingEvent.prototype.save;
 models.TradingEvent.prototype.save=function(...args:unknown[]){if(this.get('eventType')==='ORDER_SUBMITTED')return Promise.reject(new Error('fixture failure'));return save.apply(this,args);};
 try{const {session,result}=await cycle('LONG_OPTION');assert.equal(result.outcome,'ATTENTION');assert.equal((await models.BrokerOrder.findOne().orFail()).get('phase'),'SUBMITTING');await core.runEvaluationCycle(session.sessionId);await core.progressEntry(result.cycleId!);assert.deepEqual(calls,['BUY']);
 assert.equal(await models.RiskReservation.countDocuments(),1);assert.ok((await models.BrokerOrder.findOne().orFail()).get('submissionClaim'));
 }finally{models.TradingEvent.prototype.save=save;}
});
test('real captured session and LLM configuration cannot change mid-evaluation',async()=>{
 const raw=structuredClone(config('LONG_OPTION')),modelsConfig={...llmConfig};deps.llmConfig=()=>modelsConfig;const s=await core.start(raw);
 deps.transport={complete:async r=>{(raw.strategyConfig as any).strategyFamily='CREDIT_VERTICAL';modelsConfig.verifierModel='mutated';assert.equal(r.model,'fixture');return fakeLLM().complete(r);}};
 const result=await core.runEvaluationCycle(s.sessionId);assert.equal(result.outcome,'ENTRY');assert.deepEqual(calls,['BUY']);
});
for(const family of ['LONG_OPTION','CREDIT_VERTICAL'] as const)test(`OFFLINE_SMOKE ${family}`,async()=>{
 const fixture=await realProvider(clock);deps.market=fixture.provider;
 const session=await core.start({...config(family),dataMode:'KITE_REAL'}),result=await core.runEvaluationCycle(session.sessionId);
 assert.equal(result.outcome,'ENTRY');assert.deepEqual(calls,family==='LONG_OPTION'?['BUY']:['BUY','SELL']);
 const position=await models.Position.findOne().orFail(),orders=await models.BrokerOrder.find();
 assert.equal(position.get('lifecycle'),'OPEN');assert.equal(await models.Fill.countDocuments(),calls.length);
 console.log('OFFLINE_SMOKE',JSON.stringify({fixtureOnly:true,family,cycleId:result.cycleId,intentId:position.get("entryIntentId"),
   positionId:position.get('positionId'),lifecycle:position.get('lifecycle'),legs:position.get('legs').map((l:any)=>({legId:l.legId,entryFilledUnits:l.entryFilledUnits})),
   orders:orders.map(o=>({orderId:o.get('orderId'),side:o.get('side'),phase:o.get('phase'),filledUnits:o.get('filledUnits')})),realHttpCalls:attempts}));
});

// Phase 6A correction: move the clock/master at actual durable boundaries.
import { CandidateIntentAdapter } from "../../src/services/CandidateIntentAdapter";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
async function realLong(at=evaluationTime) {
 now=new Date(at);const wire=await realProvider(clock);deps.market=wire.provider;
 const session=await core.start({...config('LONG_OPTION'),dataMode:'KITE_REAL'});
 return {wire,session};
}
async function afterAdapt(work:()=>Promise<void>|void, run:()=>Promise<void>) {
 const original=CandidateIntentAdapter.prototype.adapt;
 CandidateIntentAdapter.prototype.adapt=async function(...args){const result=await original.apply(this,args);await work();return result;};
 try{await run();}finally{CandidateIntentAdapter.prototype.adapt=original;}
}
async function beforeClaim(work:()=>void, run:()=>Promise<void>) {
 const original=OrderManager.prototype.submit;
 OrderManager.prototype.submit=async function(...args){work();return original.apply(this,args);};
 try{await run();}finally{OrderManager.prototype.submit=original;}
}
for(const bound of ['evidence','cutoff'] as const)test(`P1 real ${bound} expires before NEW admission; concurrent retry remains rejected`,async()=>{
 const {session}=await realLong(bound==='cutoff'?new Date('2026-09-29T09:29:45Z'):evaluationTime);
 await afterAdapt(()=>{now=new Date(+now+(bound==='cutoff'?20000:40000));},async()=>{
  const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'REJECTED',JSON.stringify(r));
  assert.equal(r.reason,bound==='cutoff'?'ENTRY_CUTOFF_PASSED':'MARKET_EVIDENCE_EXPIRED');
  const intent=await models.OrderIntent.findOne().orFail();
  const risk=new RiskAdmissionService(connection,f.scope,clock,host);
  const retries=await Promise.all([risk.authorizeEntry(intent.get('intentId')),risk.authorizeEntry(intent.get('intentId'))]);
  assert.ok(retries.every(r=>r.status==='REJECTED'));
  await core.runEvaluationCycle(session.sessionId);
  assert.equal(await models.OrderIntent.countDocuments(),1);assert.equal(await models.BrokerOrder.countDocuments(),0);
  assert.equal(await models.RiskReservation.countDocuments(),0);assert.deepEqual(calls,[]);
  assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),0);
 });
});
for(const bound of ['evidence','cutoff'] as const)test(`P1 real ${bound} expires before INITIAL claim; admitted reservation remains durable`,async()=>{
 const {session}=await realLong(bound==='cutoff'?new Date('2026-09-29T09:29:45Z'):evaluationTime);
 await beforeClaim(()=>{now=new Date(+now+(bound==='cutoff'?20000:40000));},async()=>{
  const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ATTENTION');
  assert.equal(r.reason,bound==='cutoff'?'ENTRY_CUTOFF_PASSED':'MARKET_EVIDENCE_EXPIRED');
  const order=await models.BrokerOrder.findOne().orFail();assert.equal(order.get('phase'),'READY');assert.equal(order.get('submissionClaim'),undefined);
  assert.equal(await models.RiskReservation.countDocuments({state:'HELD'}),1);assert.equal(await models.Fill.countDocuments(),0);
  assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),1);assert.deepEqual(calls,[]);
 });
});
for(const boundary of ['admission','claim'] as const)test(`P1 real evidence expiry is inclusive at ${boundary}`,async()=>{
 const {session}=await realLong();const advance=()=>{now=new Date(+evaluationTime+30000);};
 const check=async()=>{const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));assert.equal(await models.Fill.countDocuments(),1);
 const plan=(await models.OrderIntent.findOne().orFail()).get('entryPlan');assert.equal(+plan.marketEvidenceExpiresAt,+evaluationTime+30000);};
 if(boundary==='admission')await afterAdapt(advance,check);else await beforeClaim(advance,check);
});
test('P1 real cutoff is inclusive at initial physical claim',async()=>{
 const {session}=await realLong(new Date('2026-09-29T09:29:45Z'));
 await beforeClaim(()=>{now=new Date('2026-09-29T09:30:00Z');},async()=>{const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));});
});
test('P1 real master replacement after adaptation blocks NEW admission',async()=>{
 const {wire,session}=await realLong();await afterAdapt(()=>wire.options.refreshMaster().then(()=>{}),async()=>{
  assert.notEqual((await core.runEvaluationCycle(session.sessionId)).outcome,'ENTRY');assert.equal(await models.OrderIntent.countDocuments(),1);
  assert.equal(await models.RiskReservation.countDocuments(),0);assert.equal(await models.BrokerOrder.countDocuments(),0);
  assert.equal((await models.TradingAccount.findOne().orFail()).get('positionSlots'),0);assert.deepEqual(calls,[]);
 });
});
for(const stage of ['admission','dispatch'] as const)test(`P1 real master replacement after ${stage} preserves admitted economics and fill truth`,async()=>{
 const {wire,session}=await realLong();let economics='';
 const refresh=async()=>{economics=JSON.stringify((await models.OrderIntent.findOne().orFail()).get('entryPlan'));await wire.options.refreshMaster();};
 const original=RiskAdmissionService.prototype.authorizeEntry,submit=broker.submitOrder.bind(broker);
 if(stage==='admission')RiskAdmissionService.prototype.authorizeEntry=async function(...args){const r=await original.apply(this,args);if(r.status==='AUTHORIZED')await refresh();return r;};
 else broker.submitOrder=async request=>{const r=await submit(request);await refresh();return r;};
 try{const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));
 assert.equal(JSON.stringify((await models.OrderIntent.findOne().orFail()).get('entryPlan')),economics);assert.equal(await models.Fill.countDocuments(),1);
 }finally{RiskAdmissionService.prototype.authorizeEntry=original;}
});
for(const bound of ['evidence','cutoff'] as const)test(`P1 real ${bound} crossed AFTER committed claim retains broker/fill truth`,async()=>{
 const {session}=await realLong(bound==='cutoff'?new Date('2026-09-29T09:29:45Z'):evaluationTime),submit=broker.submitOrder.bind(broker);
 broker.submitOrder=async request=>{assert.ok((await models.BrokerOrder.findOne({orderId:request.orderId}).orFail()).get('submissionClaim'));
 now=new Date(+now+40000);return submit(request);};
 const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));assert.equal(await models.Fill.countDocuments(),1);assert.deepEqual(calls,['BUY']);
});
test('P1 real UNKNOWN and late confirmed fill survive BOTH deadlines without retry',async()=>{
 const {session}=await realLong(new Date('2026-09-29T09:29:45Z'));
 scenario=(_s,q,p)=>({submission:'AMBIGUOUS',steps:[{kind:'FILL',quantityUnits:q,priceMinor:p}]});
 const submit=broker.submitOrder.bind(broker);broker.submitOrder=async r=>{now=new Date(+now+40000);return submit(r);};
 const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ATTENTION');
 const order=await models.BrokerOrder.findOne().orFail();assert.equal(order.get('knowledge'),'UNKNOWN');
 await core.progressEntry(r.cycleId!);await new OrderManager(connection,f.scope,broker,clock,host).submit(order.get('orderId'));assert.deepEqual(calls,['BUY']);
 await broker.advance({...f.scope,orderId:order.get('orderId')});for(const trade of await broker.getTrades(f.scope))await new FillProcessor(connection,f.scope,clock).process(trade);
 assert.equal((await models.BrokerOrder.findById(order._id).orFail()).get('filledUnits'),65);assert.equal(await models.Fill.countDocuments(),1);
});
test('P1 real CLOSE remains permitted after entry cutoff and evidence expiry',async()=>{
 const {session}=await realLong(new Date('2026-09-29T09:29:45Z'));assert.equal((await core.runEvaluationCycle(session.sessionId)).outcome,'ENTRY');
 now=new Date('2026-09-29T09:31:00Z');await realizeLoss((await models.Position.findOne().orFail()).get('positionId'));
 assert.equal(await models.Fill.countDocuments(),2);
});
test('P1 real account scoped discovery, independent start/poll/stop and idempotent restart',async()=>{
 const scopeB={accountId:'PAPER:second-account',executionMode:'PAPER' as const};
 await tx(s=>new models.TradingAccount({...f.account(scopeB.accountId),...scopeB,admissionStatus:'PAPER_READY',entryRiskPolicy:policy,reconciliationConfig}).save({session:s}));
 const recovery=new RecoveryBarrierService(connection,scopeB,clock,host);await recovery.beginRecovery(scopeB.accountId,'startup');now=new Date(+now+1);
 const rec=await new ReconciliationService(connection,scopeB,clock,host).reconcileAccount(scopeB.accountId,await brokerSnapshot({time:now,orders:false,trades:false,positions:false}));
 await recovery.completeRecovery(scopeB.accountId,rec.recordId);
 const a=await start(),cb={...config(),configId:'second',accountId:scopeB.accountId};
 const b=await core.start(cb);assert.notEqual(a.sessionId,b.sessionId);assert.equal((await core.start(cb)).sessionId,b.sessionId);
 assert.equal((await core.activeForAccount(f.scope.accountId) as any).sessionId,a.sessionId);assert.equal((await core.activeForAccount(scopeB.accountId) as any).sessionId,b.sessionId);
 await core.stop(b.sessionId);assert.equal((await core.active(a.sessionId)).get('status'),'RUNNING');
 assert.equal((await core.history.Session.findOne({sessionId:b.sessionId}).orFail()).get('status'),'STOPPED');assert.equal(await core.activeForAccount(scopeB.accountId),null);
 await core.stop(a.sessionId);assert.equal(await core.activeForAccount(f.scope.accountId),null);await assert.rejects(core.activeForAccount(''));
});
import { calculateEntryRisk } from "../../src/domain/entryRisk";
test('P1 real previously claimed pre-correction plan still ingests outcome and fill truth',async()=>{
 const {session}=await realLong(),submit=broker.submitOrder.bind(broker);
 broker.submitOrder=async request=>{
  const outcome=await submit(request),intent=await models.OrderIntent.findOne().orFail();
  // Fixture for an already-claimed record written by the pre-correction binary.
  // Raw setup deliberately recreates its old immutable plan and matching fingerprint.
  const plan={...intent.get('entryPlan')};delete plan.marketEvidenceExpiresAt;delete plan.entryCutoffAt;
  const requirement=calculateEntryRisk(intent.get('targetLegs'),plan);
  await models.OrderIntent.collection.updateOne({_id:intent._id},{$set:{entryPlan:plan}});
  await models.RiskReservation.collection.updateOne({intentId:intent.get('intentId')},{$set:{'entryAdmission.economicsFingerprint':requirement.fingerprint}});
  now=new Date(+now+40000);return outcome;
 };
 const r=await core.runEvaluationCycle(session.sessionId);assert.equal(r.outcome,'ENTRY',JSON.stringify(r));assert.equal(await models.Fill.countDocuments(),1);
});
for(const change of ['disconnect','data-mode'] as const)test(`P1 admitted identity ignores master refresh but preserves ${change} entry gate`,async()=>{
 const {wire,session}=await realLong(),original=RiskAdmissionService.prototype.authorizeEntry;
 RiskAdmissionService.prototype.authorizeEntry=async function(...args){const r=await original.apply(this,args);
  if(change==='disconnect')wire.state.connected=false;else wire.state.mode='MOCK';return r;};
 try{assert.equal((await core.runEvaluationCycle(session.sessionId)).outcome,'ATTENTION');assert.deepEqual(calls,[]);
 assert.equal(await models.RiskReservation.countDocuments({state:'HELD'}),1);
 }finally{RiskAdmissionService.prototype.authorizeEntry=original;}
});
