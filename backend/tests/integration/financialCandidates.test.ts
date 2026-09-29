import { RecoveryBarrierService } from "../../src/services/RecoveryBarrierService";
import { ReconciliationService } from "../../src/services/ReconciliationService";
import { createExecutionHostContext } from "../../src/domain/ExecutionHostContext";
import { brokerSnapshot, config as reconciliationConfig } from "../reconciliationFixtures";
import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import mongoose, { type ClientSession, type Document } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { CandidateIntentAdapter, candidateEntryPlan } from "../../src/services/CandidateIntentAdapter";
import { EntryProtectionService } from "../../src/services/EntryProtectionService";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
import { RiskSettlementService } from "../../src/services/RiskSettlementService";
import { RiskControlService } from "../../src/services/RiskControlService";
import { FillProcessor } from "../../src/services/FillProcessor";
import { OrderManager } from "../../src/services/OrderManager";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import { entryProjectionFromFills } from "../../src/domain/entryRisk";
import { financialCandidate, financialFamilies } from "../fixtures/financialCandidates";
import * as f from "../fixtures";
const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection);
let now: Date, ids = 0, attempts = 0;
const clock = () => new Date(now), policy = { policyVersion: 1, maxRiskPerEntryMinor: 10000000, maxReservedRiskMinor: 10000000, maxPositionSlots: 10, maxDailyLossMinor: 1000000 };
const original = { h: http.request, hg: http.get, s: https.request, sg: https.get, fetch: globalThis.fetch };
const adapter = () => new CandidateIntentAdapter(connection, f.scope, clock), admission = () => new RiskAdmissionService(connection, f.scope, clock);
const processor = () => new FillProcessor(connection, f.scope, clock), protection = () => new EntryProtectionService(connection, f.scope, clock);
async function tx<T>(work: (session: ClientSession) => Promise<T>) { const s = await connection.startSession();
  try { return await s.withTransaction(() => work(s)); } finally { await s.endSession(); } }
async function configure(changes: Record<string, unknown>) { await tx(async s => {
  const a=await models.TradingAccount.findOne(f.scope).session(s).orFail(); a.set(changes); await a.save({session:s}); }); }
async function adapt(family: typeof financialFamilies[number] = "DEBIT_VERTICAL", direction: "BULLISH"|"BEARISH" = "BULLISH", strategy = "financial", cheapCredit = false) {
  const c = await financialCandidate(family,direction,cheapCredit); now = new Date(c.evaluatedAt);
  const context={strategyInstanceId:strategy,sessionId:"session",validUntil:new Date(now.getTime()+60000)};
  return { c,context,...await adapter().adapt(c,context), ...candidateEntryPlan(c,context.validUntil,now) };
}
async function admitted(family: typeof financialFamilies[number] = "DEBIT_VERTICAL", direction: "BULLISH"|"BEARISH" = "BULLISH", strategy = "financial", cheapCredit = false) {
  const x=await adapt(family,direction,strategy,cheapCredit); const result=await admission().authorizeEntry(x.intentId); assert.equal(result.status,"AUTHORIZED");
  const orders=await models.BrokerOrder.find({intentId:x.intentId}); return {...x,orders,buy:orders.find(o=>o.get("side")==="BUY")!,sell:orders.find(o=>o.get("side")==="SELL")};
}
async function submit(order: Document, scenario: PaperScenario) {
  let calls=0; const paper=new PaperBrokerAdapter(f.scope,{clock:{now:()=>now.toISOString()},ids:{nextId:k=>`${k}-${++ids}`},scenario:()=>{calls++;return scenario;}});
  const manager=new OrderManager(connection,f.scope,paper,clock);
  const result=await manager.submit(order.get("orderId")); return {result,paper,manager,trades:await paper.getTrades(f.scope),calls:()=>calls};
}
async function buyFull(x: Awaited<ReturnType<typeof admitted>>) {
  const submitted=await submit(x.buy,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.buy.get("limitPriceMinor")}]});
  assert.equal(submitted.result.status,"PERSISTED"); for(const t of submitted.trades) await processor().process(t); return submitted;
}
async function account() {return models.TradingAccount.findOne(f.scope).orFail();}
async function checkProjection(x: Awaited<ReturnType<typeof admitted>>) {
  const fills=await models.Fill.find({intentId:x.intentId}).lean(); const p=entryProjectionFromFills(x.requirement,x.intentId,fills);
  const a=await account(); assert.equal(a.get("reservedExposureMinor"),p.pendingMinor);assert.equal(a.get("committedExposureMinor"),p.committedMinor);
  assert.equal(a.get("positionSlots"),1); assert.equal(a.get("committedPositionSlots"),p.committedSlots);return p;
}
before(async()=>{await connection.asPromise();const block=()=>{attempts++;throw new Error("EXTERNAL_HTTP_FORBIDDEN");};
  http.request=block as typeof http.request;http.get=block as typeof http.get;https.request=block as typeof https.request;https.get=block as typeof https.get;globalThis.fetch=block as typeof fetch;});
after(async()=>{await connection.close();http.request=original.h;http.get=original.hg;https.request=original.s;https.get=original.sg;globalThis.fetch=original.fetch;assert.equal(attempts,0);});
beforeEach(async()=>{ids=0;now=new Date((await financialCandidate()).evaluatedAt);await connection.dropDatabase();await createExecutionIndexes(connection);
  await tx(s=>new models.TradingAccount({...f.account(),admissionStatus:"PAPER_READY",entryRiskPolicy:policy}).save({session:s}));});
for(const family of financialFamilies) for(const direction of ["BULLISH","BEARISH"] as const)
  test(`real ${family} ${direction}: atomic exact ceiling, immutable children, one slot, duplicate authorization`,async()=>{
    const x=await admitted(family,direction); assert.equal((await account()).get("reservedExposureMinor"),x.requirement.requiredRiskMinor);
    assert.equal((await account()).get("positionSlots"),1);assert.equal(x.buy.get("phase"),"READY");if(x.sell)assert.equal(x.sell.get("phase"),"PLANNED");
    const results=await Promise.all([admission().authorizeEntry(x.intentId),admission().authorizeEntry(x.intentId)]);
    assert.ok(results.every(r=>r.status==="AUTHORIZED"));assert.equal(await models.RiskReservation.countDocuments(),1);
    assert.equal(await models.BrokerOrder.countDocuments(),x.c.legs.length);assert.equal((await account()).get("positionSlots"),1);
  });
test("real concurrent duplicate adaptation publishes one canonical chain",async()=>{
  const c=await financialCandidate(), context={strategyInstanceId:"s",sessionId:"s",validUntil:new Date(now.getTime()+60000)};
  const r=await Promise.all([adapter().adapt(c,context),adapter().adapt(c,context)]);assert.equal(r[0].intentId,r[1].intentId);
  for(const model of [models.StrategySignal,models.OrderIntent,models.Position])assert.equal(await model.countDocuments(),1);
  assert.equal(await models.RiskReservation.countDocuments(),0);assert.equal(await models.BrokerOrder.countDocuments(),0);
});
test("real competing family admissions cannot spend same final slot",async()=>{
  await configure({entryRiskPolicy:{...policy,maxPositionSlots:1}});const a=await adapt("LONG_OPTION"),b=await adapt("DEBIT_VERTICAL","BULLISH","second");
  const results=await Promise.all([admission().authorizeEntry(a.intentId),admission().authorizeEntry(b.intentId)]);
  assert.equal(results.filter(r=>r.status==="AUTHORIZED").length,1);assert.equal(await models.RiskReservation.countDocuments(),1);assert.equal((await account()).get("positionSlots"),1);
});
for(const family of financialFamilies) for(const gate of ["capacity","perEntry","slots","kill","daily","readiness"])
  test(`real ${family} preserves ${gate} gate with no partial reservation`,async()=>{
    const x=await adapt(family);
    if(gate==="kill")await new RiskControlService(connection,f.scope,clock).setKillSwitch("stop",true,"TEST");
    else if(gate==="readiness")await configure({admissionStatus:"DISABLED"});
    else if(gate==="slots"){await configure({entryRiskPolicy:{...policy,maxPositionSlots:1}});await admitted("LONG_OPTION","BULLISH","existing");}
    else if(gate==="daily")await configure({entryRiskPolicy:{...policy,maxDailyLossMinor:undefined}});
    else await configure({entryRiskPolicy:{...policy,...(gate==="slots"?{maxPositionSlots:0}:gate==="capacity"?{maxReservedRiskMinor:x.requirement.requiredRiskMinor-1}:{maxRiskPerEntryMinor:x.requirement.requiredRiskMinor-1})}});
    assert.equal((await admission().authorizeEntry(x.intentId)).status,"REJECTED");assert.equal(await models.RiskReservation.countDocuments(),gate==="slots"?1:0);assert.equal(await models.BrokerOrder.countDocuments(),gate==="slots"?1:0);
  });
for(const family of ["DEBIT_VERTICAL","CREDIT_VERTICAL"] as const) {
  for(const submission of ["ACCEPTED","AMBIGUOUS","REJECTED"] as const)test(`real ${family} ${submission} zero-fill BUY never permits SELL`,async()=>{
    const x=await admitted(family);await submit(x.buy,{submission});assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"BLOCKED");
    const sell=await submit(x.sell!,{submission:"ACCEPTED"});assert.equal(sell.result.status,"CURRENT");assert.equal(sell.calls(),0);await checkProjection(x);
    await assert.rejects(new RiskSettlementService(connection,f.scope,clock).settleClosedPosition(x.positionId));
  });
  for(const qty of [1,32,64])test(`real ${family} partial BUY ${qty} cannot round up fixed SELL and preserves risk`,async()=>{
    const x=await admitted(family),s=await submit(x.buy,{submission:"ACCEPTED",initialFills:[{quantityUnits:qty,priceMinor:x.buy.get("limitPriceMinor")}]});
    for(const t of s.trades)await processor().process(t);const p=await checkProjection(x);assert.ok(p.pendingMinor>0);
    assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"BLOCKED");
    await assert.rejects(tx(async session=>{const o=await models.BrokerOrder.findById(x.sell!._id).session(session).orFail();o.set("phase","READY");await o.save({session});}),/PROTECTION/);
  });
  test(`real ${family} full BUY enables exactly one SELL and partial SELL uses actual risk`,async()=>{
    const x=await admitted(family);await buyFull(x);assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"READY");
    const s=await submit(x.sell!,{submission:"ACCEPTED",initialFills:[{quantityUnits:20,priceMinor:x.sell!.get("limitPriceMinor")},{quantityUnits:45,priceMinor:x.sell!.get("limitPriceMinor")+5}]});
    await processor().process(s.trades[0]);await checkProjection(x);await processor().process(s.trades[1]);const p=await checkProjection(x);assert.equal(p.pendingMinor,Math.max(0,x.requirement.requiredRiskMinor-p.committedMinor));
    assert.equal((await s.manager.submit(x.sell!.get("orderId"))).status,"CURRENT");assert.equal(s.calls(),1);
    assert.equal((await models.Position.findOne().orFail()).get("lifecycle"),"OPEN");
  });
  test(`real ${family} UNKNOWN SELL retains risk; late owned fill is ingestible without retry`,async()=>{
    const x=await admitted(family);await buyFull(x);await protection().advance(x.sell!.get("orderId"));
    const s=await submit(x.sell!,{submission:"AMBIGUOUS",initialFills:[{quantityUnits:20,priceMinor:x.sell!.get("limitPriceMinor")}]});
    for(const t of s.trades)await processor().process(t);const p=await checkProjection(x);assert.ok(p.pendingMinor+p.committedMinor>0);
    assert.equal((await s.manager.submit(x.sell!.get("orderId"))).status,"CURRENT");assert.equal(s.calls(),1);
    assert.equal((await models.BrokerOrder.findById(x.sell!._id).orFail()).get("knowledge"),"UNKNOWN");
  });
  test(`real ${family} stranded long remains truthful after SELL rejection`,async()=>{
    const x=await admitted(family);await buyFull(x);await protection().advance(x.sell!.get("orderId"));await submit(x.sell!,{submission:"REJECTED"});
    const p=await checkProjection(x);assert.equal(p.committedMinor,x.buy.get("limitPriceMinor")*65);
    const pos=await models.Position.findOne().orFail();assert.equal(pos.get("lifecycle"),"PARTIALLY_OPENED");
    assert.equal(pos.get("legs").find((l:any)=>l.entrySide==="SELL").entryFilledUnits,0);assert.equal(await models.Fill.countDocuments(),1);
    await assert.rejects(new RiskSettlementService(connection,f.scope,clock).settleClosedPosition(x.positionId));
  });
}
for(const family of financialFamilies)test(`real ${family} actual unfavorable fill persists, audits breach and kills future entry`,async()=>{
  const x=await admitted(family),s=await submit(x.buy,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.buy.get("limitPriceMinor")}]});
  const t={...s.trades[0]!,priceMinor:x.buy.get("limitPriceMinor")+100000};await processor().process(t);await checkProjection(x);
  assert.equal((await account()).get("killSwitchEnabled"),true);assert.equal(await models.Fill.countDocuments(),1);
  assert.equal(await models.TradingEvent.countDocuments({reason:"REVEALED_ACTUAL_RISK_BREACH"}),1);
  const next=await adapt("LONG_OPTION","BEARISH","next");assert.deepEqual(await admission().authorizeEntry(next.intentId),{status:"REJECTED",intentId:next.intentId,reason:"KILL_SWITCH_ACTIVE"});
});
test("real concurrent BUY Fill writers commit exact protection once without a second slot",async()=>{
  const x=await admitted(),s=await submit(x.buy,{submission:"ACCEPTED",initialFills:[{quantityUnits:20,priceMinor:x.buy.get("limitPriceMinor")},{quantityUnits:45,priceMinor:x.buy.get("limitPriceMinor")}]});
  await Promise.all(s.trades.map(t=>processor().process(t)));await checkProjection(x);assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"READY");
  const count=await models.Fill.countDocuments();await processor().process(s.trades[0]);assert.equal(await models.Fill.countDocuments(),count);
});
test("real classified intent cannot be forged through supported model API",async()=>{
  const x=await adapt();await assert.rejects(tx(async session=>{await new models.OrderIntent({...f.intent("forged"),signalId:x.signalId,entryPlan:x.plan,targetLegs:x.targets}).save({session});}),/ISSUED_CANDIDATE_ADAPTER_REQUIRED/);
});
for(const {family,stranded} of [...financialFamilies.map(family=>({family,stranded:false})),
  {family:"DEBIT_VERTICAL" as const,stranded:true},{family:"CREDIT_VERTICAL" as const,stranded:true}])
  test(`real ${family} stranded=${stranded} close and settlement preserve proven-finality requirements`,async()=>{
  const x=await admitted(family);await buyFull(x);
  if(x.sell){await protection().advance(x.sell.get("orderId"));const s=await submit(x.sell,stranded?{submission:"REJECTED"}:{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.sell.get("limitPriceMinor")}]});for(const t of s.trades)await processor().process(t);}
  const prior=await checkProjection(x);
  await tx(async session=>{const p=await models.Position.findOne({positionId:x.positionId}).session(session).orFail();
    p.set("closePolicy",{kind:"POSITION_LIMIT_V1",product:"INTRADAY",policyVersion:1,expiresAt:new Date(now.getTime()+60000),legLimits:x.orders.map(o=>({legId:o.get("legId"),limitPriceMinor:o.get("limitPriceMinor")+(o.get("side")==="BUY"?-1000:1000)}))});await p.save({session});});
  await new RiskControlService(connection,f.scope,clock).setKillSwitch("close-under-kill",true,"TEST");
  const close=await new CloseIntentService(connection,f.scope,clock).requestClose(x.positionId,"close");
  const closeAccount=await account();
  assert.ok(closeAccount.get("reservedExposureMinor")+closeAccount.get("committedExposureMinor")>=x.buy.get("limitPriceMinor")*65);
  const orders=await models.BrokerOrder.find({intentId:close.intentId});
  const workflow=new CloseWorkflowService(connection,f.scope,clock),settlement=new RiskSettlementService(connection,f.scope,clock);
  await assert.rejects(settlement.settleClosedPosition(x.positionId));
  if(stranded){
    // Approved successful-close workflow requires executed short evidence. Its
    // zero-short cleanup remains intentionally deferred; never fabricate it.
    assert.equal((await workflow.advance(x.positionId)).status,"BLOCKED");
    await assert.rejects(settlement.settleClosedPosition(x.positionId));
    assert.equal(await models.Fill.countDocuments(),1);assert.equal((await account()).get("positionSlots"),1);
    return;
  }
  if(x.sell){const long=orders.find(o=>o.get("side")==="SELL")!;assert.equal(long.get("phase"),"PLANNED");assert.equal((await submit(long,{submission:"ACCEPTED"})).calls(),0);}
  for(const o of orders.sort((a,b)=>a.get("side")==="BUY"?-1:1)){
    await workflow.advance(x.positionId);const s=await submit(o,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:o.get("limitPriceMinor")}]});
    assert.equal(s.result.status,"PERSISTED");for(const t of s.trades)await processor().process(t);
  }
  assert.equal((await workflow.advance(x.positionId)).status,"CLOSED");
  const results=await Promise.all([settlement.settleClosedPosition(x.positionId),settlement.settleClosedPosition(x.positionId)]);assert.equal(results.filter(r=>!r.replay).length,1);
  const a=await account();assert.equal(a.get("reservedExposureMinor"),0);assert.equal(a.get("committedExposureMinor"),0);assert.equal(a.get("positionSlots"),0);
  const e=await models.TradingEvent.findOne({eventType:"ENTRY_RISK_SETTLED"}).orFail();assert.equal(e.get("payload.committedReleasedMinor"),prior.committedMinor);assert.equal(e.get("payload.committedSlotsReleased"),1);
  const loss=65*1000*(family==="LONG_OPTION"||stranded?1:2);assert.equal(a.get("realizedPnlMinor"),-loss);
  await new RiskControlService(connection,f.scope,clock).setKillSwitch("manual-rearm",false,"TEST");
  await configure({entryRiskPolicy:{...policy,maxDailyLossMinor:loss}});
  const next=await adapt(family,"BEARISH","after-loss");
  assert.deepEqual(await admission().authorizeEntry(next.intentId),{status:"REJECTED",intentId:next.intentId,reason:"DAILY_LOSS_LIMIT_EXCEEDED"});
});
test("LIVE adapter, admission and protection services reject deterministically",()=>{
  const live={accountId:"LIVE:test",executionMode:"LIVE" as const};
  for(const Service of [CandidateIntentAdapter,RiskAdmissionService,EntryProtectionService])assert.throws(()=>new Service(connection,live,clock),/PAPER_ONLY/);
});
for(const family of financialFamilies) test(`real ${family} current-host recovery and reconciliation remain mandatory`,async()=>{
  const x=await adapt(family);await configure({reconciliationConfig});
  assert.deepEqual(await admission().authorizeEntry(x.intentId),{status:"REJECTED",intentId:x.intentId,reason:"RECOVERY_REQUIRED"});
  const host=createExecutionHostContext(`host-${family}`), recovery=new RecoveryBarrierService(connection,f.scope,clock,host);
  await recovery.beginRecovery(f.scope.accountId,"startup");
  const service=new RiskAdmissionService(connection,f.scope,clock,host);
  assert.equal((await service.authorizeEntry(x.intentId)).status,"REJECTED");
  now=new Date(now.getTime()+1);
  const reconcile=new ReconciliationService(connection,f.scope,clock,host);
  const matched=await reconcile.reconcileAccount(f.scope.accountId,await brokerSnapshot({time:now,orders:false,trades:false,positions:false}));
  assert.equal(matched.report.classification,"MATCHED");await recovery.completeRecovery(f.scope.accountId,matched.recordId);
  now=new Date(now.getTime()+1);
  await reconcile.reconcileAccount(f.scope.accountId,await brokerSnapshot({time:now,orders:false,trades:false,positions:false,fail:"/orders"}));
  assert.deepEqual(await service.authorizeEntry(x.intentId),{status:"REJECTED",intentId:x.intentId,reason:"RECONCILIATION_REQUIRED"});
  assert.equal(await models.RiskReservation.countDocuments(),0);
});
test("real adaptation audit failure rolls back signal, intent and position",async()=>{
  const c=await financialCandidate(),originalSave=models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save=function(){return Promise.reject(new Error("INJECTED_ADAPTER_AUDIT_FAILURE"));};
  try{await assert.rejects(adapter().adapt(c,{strategyInstanceId:"s",sessionId:"s",validUntil:new Date(now.getTime()+60000)}),/INJECTED/);}
  finally{models.TradingEvent.prototype.save=originalSave;}
  for(const m of [models.StrategySignal,models.OrderIntent,models.Position])assert.equal(await m.countDocuments(),0);
});
test("real Fill audit failure rolls back truth and risk transfer together",async()=>{
  const x=await admitted(),s=await buyFull(x);await protection().advance(x.sell!.get("orderId"));
  const short=await submit(x.sell!,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.sell!.get("limitPriceMinor")}]});
  const before=await checkProjection(x),originalSave=models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save=function(){return Promise.reject(new Error("INJECTED_FILL_AUDIT_FAILURE"));};
  try{await assert.rejects(processor().process(short.trades[0]),/INJECTED/);}finally{models.TradingEvent.prototype.save=originalSave;}
  assert.deepEqual(await checkProjection(x),before);assert.equal(await models.Fill.countDocuments(),1);
  await processor().process(short.trades[0]);await checkProjection(x);
});
test("real fixed SELL physical identity cannot be duplicated or resized",async()=>{
  const x=await admitted();const original=x.sell!.toObject();
  await assert.rejects(tx(session=>new models.BrokerOrder({...original,_id:undefined,orderId:"duplicate"}).save({session})),/E11000/);
  await assert.rejects(tx(async session=>{const o=await models.BrokerOrder.findById(x.sell!._id).session(session).orFail();o.set("quantityUnits",1);o.set("limitPriceMinor",5);await o.save({session});}),/immutable/);
  const o=await models.BrokerOrder.findById(x.sell!._id).orFail();assert.equal(o.get("quantityUnits"),65);assert.equal(o.get("limitPriceMinor"),x.sell!.get("limitPriceMinor"));
});
test("real full UNKNOWN BUY fills remain ingestible but never unlock SELL",async()=>{
  const x=await admitted(),s=await submit(x.buy,{submission:"AMBIGUOUS",initialFills:[{quantityUnits:65,priceMinor:x.buy.get("limitPriceMinor")}]});
  for(const t of s.trades)await processor().process(t);await checkProjection(x);
  assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"BLOCKED");assert.equal((await s.manager.submit(x.buy.get("orderId"))).status,"CURRENT");assert.equal(s.calls(),1);
});
test("real accepted full BUY receipt without incorporated Fills is not protection",async()=>{
  const x=await admitted();await submit(x.buy,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.buy.get("limitPriceMinor")}]});
  assert.equal(await models.Fill.countDocuments(),0);assert.equal((await protection().advance(x.sell!.get("orderId"))).status,"BLOCKED");
  assert.equal((await submit(x.sell!,{submission:"ACCEPTED"})).calls(),0);
});
test("real SELL adverse fill below intended price persists and records breach even below initial long ceiling",async()=>{
  const x=await admitted();await buyFull(x);await protection().advance(x.sell!.get("orderId"));
  const s=await submit(x.sell!,{submission:"ACCEPTED",initialFills:[{quantityUnits:65,priceMinor:x.sell!.get("limitPriceMinor")}]});
  await processor().process({...s.trades[0]!,priceMinor:x.sell!.get("limitPriceMinor")-100});await checkProjection(x);
  assert.equal(await models.Fill.countDocuments(),2);assert.equal((await account()).get("killSwitchEnabled"),true);
});
test("real changed candidate within one canonical decision conflicts rather than duplicating intent",async()=>{
  const x=await adapt();const other=await financialCandidate("LONG_OPTION");
  await assert.rejects(adapter().adapt(other,x.context),/CANDIDATE_ADAPTATION_CONFLICT/);
  assert.equal(await models.StrategySignal.countDocuments(),1);assert.equal(await models.OrderIntent.countDocuments(),1);
});
test("real eligibility is rechecked at claim if BUY becomes UNKNOWN after promotion",async()=>{
  const x=await admitted();await buyFull(x);await protection().advance(x.sell!.get("orderId"));
  await tx(async session=>{const b=await models.BrokerOrder.findById(x.buy._id).session(session).orFail();b.set("knowledge","UNKNOWN");await b.save({session});});
  await assert.rejects(submit(x.sell!,{submission:"ACCEPTED"}),/PROTECTION/);
  assert.equal((await models.BrokerOrder.findById(x.sell!._id).orFail()).get("submissionClaim"),undefined);
});
test("real credit final-risk-dominant envelope retains width top-up through partial and UNKNOWN SELL",async()=>{
  const x=await admitted("CREDIT_VERTICAL","BULLISH","cheap-credit",true);
  assert.ok(x.requirement.requiredRiskMinor>x.buy.get("limitPriceMinor")*65);
  await buyFull(x);const long=await checkProjection(x);assert.ok(long.pendingMinor>0);
  assert.equal(long.pendingMinor+long.committedMinor,x.requirement.requiredRiskMinor);
  await protection().advance(x.sell!.get("orderId"));
  const s=await submit(x.sell!,{submission:"AMBIGUOUS",initialFills:[{quantityUnits:20,priceMinor:x.sell!.get("limitPriceMinor")}]});
  await processor().process(s.trades[0]);const partial=await checkProjection(x);assert.ok(partial.pendingMinor>0);
  assert.equal(partial.pendingMinor+partial.committedMinor,x.requirement.requiredRiskMinor);
  assert.equal((await s.manager.submit(x.sell!.get("orderId"))).status,"CURRENT");assert.equal(s.calls(),1);
});
test("real second dispatched SELL fill survives a kill switch set by the first adverse fill",async()=>{
  const x=await admitted();await buyFull(x);await protection().advance(x.sell!.get("orderId"));
  const s=await submit(x.sell!,{submission:"ACCEPTED",initialFills:[{quantityUnits:20,priceMinor:x.sell!.get("limitPriceMinor")},{quantityUnits:45,priceMinor:x.sell!.get("limitPriceMinor")}]});
  await processor().process({...s.trades[0]!,priceMinor:s.trades[0]!.priceMinor-100});assert.equal((await account()).get("killSwitchEnabled"),true);
  await processor().process(s.trades[1]);await checkProjection(x);assert.equal(await models.Fill.countDocuments(),3);
});
