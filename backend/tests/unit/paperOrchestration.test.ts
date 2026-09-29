import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { capturePaperConfig,cycleIdentity,decisionWindow,entryCalendarBlock,safeCycleError } from "../../src/domain/paperOrchestration";
import { PaperEvaluationScheduler } from "../../src/services/PaperEvaluationScheduler";
import { evaluateWithPhase5LLM } from "../../src/services/Phase5LLMService";
import { config,evaluationTime,fakeLLM,llmConfig,mockCapture } from "../fixtures/paperOrchestration";
const originals={h:http.request,hg:http.get,s:https.request,sg:https.get,f:fetch};let attempts=0;
before(()=>{const block=()=>{attempts++;throw new Error("NETWORK_FORBIDDEN");};http.request=block as any;http.get=block as any;https.request=block as any;https.get=block as any;globalThis.fetch=block as any;});
after(()=>{http.request=originals.h;http.get=originals.hg;https.request=originals.s;https.get=originals.sg;globalThis.fetch=originals.f;assert.equal(attempts,0);});
for(const [field,value] of [["executionMode","LIVE"],["executionMode",undefined],["dataMode","LIVE"],["intervalMs",299999],["intervalMs",3600001],["asset","BTC"],["entryCutoffMinuteIST",931]] as const)
  test(`configuration rejects ${field}=${value}`,()=>assert.throws(()=>capturePaperConfig({...config(),[field]:value})));
for(const family of [undefined,"AUTO","NAKED_SELL"])test(`explicit family rejects ${family}`,()=>assert.throws(()=>capturePaperConfig({...config(),strategyConfig:{...config().strategyConfig,strategyFamily:family}})));
test("captured configuration is detached and deeply frozen",()=>{const raw=structuredClone(config());const c=capturePaperConfig(raw);(raw.strategyConfig as any).minConfidence=0;assert.equal(c.strategyConfig.minConfidence,0.65);assert.ok(Object.isFrozen(c.strategyConfig));});
test("jitter shares a canonical market window",()=>{assert.equal(cycleIdentity(config(),new Date(+evaluationTime+1000)),cycleIdentity(config(),new Date(+evaluationTime+45000)));});
test("later bar has a separate canonical decision",()=>assert.notEqual(cycleIdentity(config(),evaluationTime),cycleIdentity(config(),new Date(+evaluationTime+300000))));
test("family changes cannot evade same-bar identity",()=>assert.equal(cycleIdentity(config("LONG_OPTION"),evaluationTime),cycleIdentity(config("CREDIT_VERTICAL"),evaluationTime)));
for(const [at,reason]of [["2026-09-29T03:44:59Z","ENTRY_WINDOW_CLOSED"],["2026-09-29T09:30:00Z","ENTRY_WINDOW_CLOSED"],["2026-09-30T06:00:00Z","MARKET_CALENDAR_CLOSED"],["2026-10-03T06:00:00Z","MARKET_CALENDAR_CLOSED"],["2026-09-29T06:00:00Z",null]] as const)
 test(`IST entry calendar ${at}`,()=>assert.equal(entryCalendarBlock(config(),new Date(at)),reason));
test("unknown exceptions cannot expose credentials",()=>assert.equal(safeCycleError(new Error("token secret mongodb://credentials")),"CYCLE_FAILED_REQUIRES_ATTENTION"));
for(const family of ["LONG_OPTION","DEBIT_VERTICAL","CREDIT_VERTICAL"] as const)test(`actual analytics + LLM + evaluator ${family}`,async()=>{
 const captured=await mockCapture();const d=await evaluateWithPhase5LLM({...captured,strategyConfig:config(family).strategyConfig,llmConfig},fakeLLM(),()=>+evaluationTime);
 assert.equal(d.action,"CANDIDATE");if(d.evidence.strategyResult.action==="CANDIDATE"){assert.equal(d.evidence.strategyResult.candidate.strategyFamily,family);assert.equal(d.evidence.strategyResult.candidate.dataMode,"MOCK");}
});
for(const [direction,verdict]of [["HOLD","AGREE"],["BULLISH","DISAGREE"]])test(`LLM ${direction}/${verdict} holds`,async()=>{
 const d=await evaluateWithPhase5LLM({...await mockCapture(),strategyConfig:config().strategyConfig,llmConfig},fakeLLM(direction,verdict),()=>+evaluationTime);assert.equal(d.action,"HOLD");});
test("scheduler start is idempotent; stop/replacement cannot queue a stale successor",async()=>{
 const called:string[]=[];let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
 const scheduler=new PaperEvaluationScheduler(async id=>{called.push(id);await blocked;});
 scheduler.start("a","old",300000);scheduler.start("a","old",300000);assert.deepEqual(called,["old"]);
 scheduler.stop("old");scheduler.start("a","new",300000);release();await new Promise(r=>setImmediate(r));scheduler.stop("new");assert.deepEqual(called,["old","new"]);
});
test("scheduler error is isolated",async()=>{let errors=0;const s=new PaperEvaluationScheduler(async()=>{throw new Error("offline");},()=>errors++);s.start("a","s",300000);await new Promise(r=>setImmediate(r));s.stop("s");assert.equal(errors,1);});
test("retired loop cannot call legacy execution",async()=>{const loop=await import("../../src/services/SignalLoopService");await assert.rejects(loop.start("x","NIFTY"),/DISABLED/);await assert.rejects(loop._runTick("x","NIFTY"),/DISABLED/);assert.equal(loop.isRunning(),false);});
test("runtime/session wiring has no legacy entry or exit authority",()=>{
 for(const file of ["src/services/PaperEntryOrchestrator.ts","src/routes/session.ts","src/index.ts"]){const s=readFileSync(file,"utf8");assert.doesNotMatch(s,/PaperTradeService|PositionMonitorService|openPosition\(/);}
});

for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`qualified wire-fixture KITE_REAL ${family} composition`,async()=>{
 const {realProvider}=await import('../fixtures/paperOrchestration');const f=await realProvider(),c={...config(family),dataMode:'KITE_REAL' as const};
 await f.provider.prepare(c);const captured=await f.provider.capture(c);assert.equal(captured.analytics.available,true,JSON.stringify(captured.analytics));
 const result=await evaluateWithPhase5LLM({...captured,strategyConfig:c.strategyConfig,llmConfig},fakeLLM(),()=>+evaluationTime);
 assert.equal(result.action,'CANDIDATE',JSON.stringify(result.evidence));assert.equal(result.evidence.dataMode,'KITE_REAL');captured.assertCurrent();
 assert.ok(f.paths.every(p=>p==='/quote'||p.startsWith('/instruments/historical/')));
});
for(const failure of ['disconnected','mode','stale','unavailable'] as const)test(`qualified provider ${failure} never falls back`,async()=>{
 const {realProvider}=await import('../fixtures/paperOrchestration');const f=await realProvider(),c={...config(),dataMode:'KITE_REAL' as const};
 if(failure==='disconnected')f.state.connected=false;if(failure==='mode')f.state.mode='MOCK';
 if(failure==='stale')f.state.ageMs=60001;if(failure==='unavailable')f.state.missing=true;
 await assert.rejects(f.provider.prepare(c));
});
test('captured qualified instruments expire on same-content master replacement',async()=>{
 const {realProvider}=await import('../fixtures/paperOrchestration');const f=await realProvider(),c={...config(),dataMode:'KITE_REAL' as const};
 await f.provider.prepare(c);const captured=await f.provider.capture(c);await f.options.refreshMaster();assert.throws(()=>captured.assertCurrent());
});

import { entryCutoffAt } from "../../src/domain/paperOrchestration";
import { marketEvidenceExpiry, isMarketAnalyticsFresh } from "../../src/domain/marketAnalytics";
import { candidateEntryPlan } from "../../src/services/CandidateIntentAdapter";
import { assertEntryTemporalAuthorization } from "../../src/domain/entryRisk";
for(const [at,cutoff] of [['2026-09-29T09:29:45Z','2026-09-29T09:30:00.000Z'],['2026-09-28T19:00:00Z','2026-09-29T09:30:00.000Z'],['2026-09-29T19:00:00Z','2026-09-30T09:30:00.000Z']])
 test(`absolute IST cutoff is host-independent: ${at}`,()=>assert.equal(entryCutoffAt(config(),new Date(at)).toISOString(),cutoff));
test('issued real evidence expiry uses exchange evidence, not newer fetch time; inclusive boundary',async()=>{
 const {realProvider}=await import('../fixtures/paperOrchestration');const wire=await realProvider(),c={...config(),dataMode:'KITE_REAL' as const};
 wire.state.ageMs=10000;await wire.provider.prepare(c);const captured=await wire.provider.capture(c);assert.ok(captured.analytics.available);
 const snapshot=captured.analytics.snapshot;assert.equal(marketEvidenceExpiry(snapshot),+evaluationTime+20000);
 assert.equal(isMarketAnalyticsFresh(snapshot,+evaluationTime+20000),true);assert.equal(isMarketAnalyticsFresh(snapshot,+evaluationTime+20001),false);
 const decision=await evaluateWithPhase5LLM({...captured,strategyConfig:c.strategyConfig,llmConfig},fakeLLM(),()=>+evaluationTime);
 assert.equal(decision.evidence.strategyResult.action,'CANDIDATE');if(decision.evidence.strategyResult.action!=='CANDIDATE')throw new Error('fixture');
 const {plan}=candidateEntryPlan(decision.evidence.strategyResult.candidate,new Date(+evaluationTime+60000),evaluationTime,entryCutoffAt(c,evaluationTime));
 assert.equal(+plan.marketEvidenceExpiresAt!,+evaluationTime+20000);
 assert.doesNotThrow(()=>assertEntryTemporalAuthorization(plan,new Date(+evaluationTime+20000)));
 assert.throws(()=>assertEntryTemporalAuthorization(plan,new Date(+evaluationTime+20001)),/MARKET_EVIDENCE_EXPIRED/);
});
test('MOCK carries explicit null evidence expiry without real freshness authority; cutoff still enforced',async()=>{
 const captured=await mockCapture();assert.ok(captured.analytics.available);assert.equal(marketEvidenceExpiry(captured.analytics.snapshot),null);
 const decision=await evaluateWithPhase5LLM({...captured,strategyConfig:config().strategyConfig,llmConfig},fakeLLM(),()=>+evaluationTime);
 assert.equal(decision.evidence.strategyResult.action,'CANDIDATE');if(decision.evidence.strategyResult.action!=='CANDIDATE')throw new Error('fixture');
 const cutoff=entryCutoffAt(config(),evaluationTime),{plan}=candidateEntryPlan(decision.evidence.strategyResult.candidate,new Date(+evaluationTime+60000),evaluationTime,cutoff);
 assert.equal(plan.marketEvidenceExpiresAt,null);assert.doesNotThrow(()=>assertEntryTemporalAuthorization(plan,cutoff));
 assert.throws(()=>assertEntryTemporalAuthorization(plan,new Date(+cutoff+1)),/ENTRY_CUTOFF_PASSED/);
 assert.throws(()=>assertEntryTemporalAuthorization({...plan,dataMode:'KITE_REAL',source:'KITE'},evaluationTime),/INVALID_RISK_ECONOMICS/);
});
