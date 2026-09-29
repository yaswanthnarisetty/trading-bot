import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';
import {readFileSync} from 'node:fs';
import {captureExitConfig,exitTriggers,exitEconomics,exitPriority,istEod} from '../../src/domain/paperExits';
import {PaperExitScheduler} from '../../src/services/PaperExitScheduler';
import {PaperExitMarketData} from '../../src/services/PaperExitMarketData';
import {candidateEntryPlan} from '../../src/services/CandidateIntentAdapter';
import {evaluateWithPhase5LLM} from '../../src/services/Phase5LLMService';
import {config,realProvider,evaluationTime,fakeLLM,llmConfig} from '../fixtures/paperOrchestration';
const originals={h:http.request,hg:http.get,s:https.request,sg:https.get,f:fetch};let attempts=0;
before(()=>{const block=()=>{attempts++;throw new Error('NETWORK_FORBIDDEN');};http.request=block as any;http.get=block as any;https.request=block as any;https.get=block as any;globalThis.fetch=block as any;});
after(()=>{Object.assign(http,{request:originals.h,get:originals.hg});Object.assign(https,{request:originals.s,get:originals.sg});globalThis.fetch=originals.f;assert.equal(attempts,0);});
const policy=captureExitConfig({version:'PAPER_EXIT_V1',accountId:'PAPER:test-account',executionMode:'PAPER',dataMode:'KITE_REAL',family:'LONG_OPTION',
 takeProfitBps:5000,stopLossBps:5000,maxHoldingMs:3600000,eodMinuteIST:920,maxAgeMs:30000,authorizationMs:900000,directionalStop:'DEFERRED_NO_CAPTURED_BASIS'});
const base={family:'LONG_OPTION' as const,strategyKind:'LONG_CALL' as const,legs:[],openedAt:evaluationTime,entryCashFlowMinor:-1000,entryBasisMinor:1000,liquidationValueMinor:1000,estimatedPnlMinor:0,stranded:false,widthMinor:null,fillIds:['fill']};
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)for(const [pnl,reason]of [[500,'TAKE_PROFIT'],[-500,'STOP_LOSS'],[499,null],[-499,null]] as const)
 test(`${family} exact premium-basis threshold ${pnl}`,()=>assert.equal(exitTriggers({...base,family,estimatedPnlMinor:pnl},{...policy,family},evaluationTime,false).reason,reason));
for(const [elapsed,reason]of [[3599999,null],[3600000,'TIME_EXIT']] as const)test(`holding boundary ${elapsed}`,()=>assert.equal(exitTriggers(base,policy,new Date(+evaluationTime+elapsed),false).reason,reason));
for(const [at,reason]of [['2026-09-29T09:49:59Z',null],['2026-09-29T09:50:00Z','EOD_EXIT'],['2026-09-30T03:30:00Z','EOD_EXIT']] as const)
 test(`IST EOD ${at}`,()=>assert.equal(exitTriggers(base,{...policy,maxHoldingMs:86400000},new Date(at),false).reason,reason));
test('holding start survives a restart; never monitor uptime',()=>assert.equal(exitTriggers(structuredClone(base),policy,new Date(+evaluationTime+3600000),false).reason,'TIME_EXIT'));
test('SL precedes time and EOD; EOD precedes TP',()=>{const at=new Date('2026-09-29T09:50:00Z');assert.equal(exitTriggers({...base,estimatedPnlMinor:-500},policy,at,false).reason,'STOP_LOSS');assert.equal(exitTriggers({...base,estimatedPnlMinor:500},policy,at,false).reason,'EOD_EXIT');assert.deepEqual(exitPriority,['STOP_LOSS','EOD_EXIT','DIRECTIONAL_STOP','STRANDED_LONG_CLEANUP','TAKE_PROFIT','TIME_EXIT']);});
test('invalid actual premium cannot invent profitable trigger',()=>assert.equal(exitTriggers({...base,entryBasisMinor:-1,estimatedPnlMinor:100000},policy,evaluationTime,false).reason,null));
test('directional basis absent is explicit; no default ATR/spot invented',()=>{assert.equal(exitTriggers(base,policy,evaluationTime,false).directionalStop,'DEFERRED_NO_CAPTURED_BASIS');assert.throws(()=>captureExitConfig({...policy,directionalStop:'ATR'}));});
for(const input of [{executionMode:'LIVE'},{dataMode:'MOCK'},{takeProfitBps:0},{stopLossBps:1.5},{accountId:'LIVE:x'},{authorizationMs:3600001}])test(`config rejects ${JSON.stringify(input)}`,()=>assert.throws(()=>captureExitConfig({...policy,...input})));
test('cutoff uses entry IST date independent of host timezone',()=>assert.equal(istEod(new Date('2026-09-28T19:00:00Z'),920).toISOString(),'2026-09-29T09:50:00.000Z'));
test('scheduler bounds parallelism, avoids overlap and continues after failure',async()=>{
 const calls:string[]=[];let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const scheduler=new PaperExitScheduler(async()=>['a','b','c'].map(positionId=>({positionId})),async id=>{calls.push(id);if(id==='a')await wait;if(id==='b')throw new Error('fixture');},()=>{},5000,2);
 await scheduler.tick();await new Promise(r=>setImmediate(r));await scheduler.tick();await new Promise(r=>setImmediate(r));
 assert.equal(calls.filter(x=>x==='a').length,1);assert.ok(calls.includes('c'));release();scheduler.stop();
});
for(const [interval,parallel]of [[999,1],[60001,1],[5000,0],[5000,9]])test(`invalid cadence ${interval}/${parallel}`,()=>assert.throws(()=>new PaperExitScheduler(async()=>[],async()=>{},()=>{},interval,parallel)));
async function fixture(family:'LONG_OPTION'|'DEBIT_VERTICAL'|'CREDIT_VERTICAL'='LONG_OPTION'){
 let now=new Date(evaluationTime);const wire=await realProvider(()=>now),c={...config(family),dataMode:'KITE_REAL' as const};await wire.provider.prepare(c);
 const decision=await evaluateWithPhase5LLM({...await wire.provider.capture(c),strategyConfig:c.strategyConfig,llmConfig},fakeLLM(),()=>+now);
 assert.equal(decision.evidence.strategyResult.action,'CANDIDATE');if(decision.evidence.strategyResult.action!=='CANDIDATE')throw new Error('fixture');
 const {plan,targets}=candidateEntryPlan(decision.evidence.strategyResult.candidate,new Date(+now+60000),now);
 const legs=targets.map(t=>({...t,entrySide:t.side,entryFilledUnits:t.targetUnits,exitFilledUnits:0}));
 return{wire,plan,legs,market:new PaperExitMarketData(wire.options,()=>now),advance:()=>{now=new Date(+now+30001);}};
}
for(const family of ['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL'] as const)test(`${family} qualified executable sides and actual fill basis`,async()=>{
 const f=await fixture(family),e=await f.market.capture(f.plan,f.legs,{...policy,family});
 for(const p of e.prices)assert.equal(p.side,f.legs.find(l=>l.legId===p.legId)!.entrySide==='BUY'?'SELL':'BUY');
 const fills=f.legs.map((l,i)=>({fillId:`f${i}`,intentId:'entry',legId:l.legId,side:l.entrySide,quantityUnits:l.entryFilledUnits,
 priceMinor:f.plan.legs.find(t=>t.legId===l.legId)!.limitPriceMinor+5,executedAt:evaluationTime}));
 const econ=exitEconomics({entryIntentId:'entry',legs:f.legs},f.plan,fills,[...e.prices]);
 assert.equal(econ.entryCashFlowMinor,fills.reduce((n,f)=>n+f.quantityUnits*f.priceMinor*(f.side==='SELL'?1:-1),0));assert.ok((e.provenance as any[]).every(p=>p.source==='KITE'&&p.dataMode==='KITE_REAL'));
});
for(const failure of ['stale','missing','master','mock','identity'] as const)test(`exit market ${failure} fails closed`,async()=>{
 const f=await fixture();if(failure==='stale')f.wire.state.ageMs=30001;if(failure==='missing')f.wire.state.missing=true;
 if(failure==='mock')f.wire.state.mode='MOCK';if(failure==='identity')f.legs[0].contractKey='NFO:arbitrary';
 if(failure==='master'){const e=await f.market.capture(f.plan,f.legs,policy);await f.wire.options.refreshMaster();assert.throws(()=>e.assertCurrent());}
 else await assert.rejects(f.market.capture(f.plan,f.legs,policy));
});
test('captured current close evidence expires at consumption',async()=>{const f=await fixture(),e=await f.market.capture(f.plan,f.legs,policy);f.advance();assert.throws(()=>e.assertCurrent(),/STALE/);});
test('monitor has no legacy/LLM/Kite write or quote-based realized mutation',()=>{
 const monitor=readFileSync('src/services/PaperExitMonitor.ts','utf8');assert.doesNotMatch(monitor,/PaperTradeService|OptionsPosition|Phase5LLM|OpenAI|\.submitOrder\(|set\(['"]realizedPnl|set\(['"]lifecycle/);
 assert.match(readFileSync('src/services/PositionMonitorService.ts','utf8'),/LEGACY_POSITION_MONITOR_DISABLED/);
 assert.doesNotMatch(readFileSync('src/routes/session.ts','utf8'),/paperExitScheduler\.stop/);
});
