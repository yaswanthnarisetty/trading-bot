import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePaperConfig } from "../../src/domain/paperOrchestration";
import { config as fixture } from "../fixtures/paperOrchestration";
import { defaultPaperSummary, parseDefaultStartRequest, PaperDefaultSessionService,
  resolveDefaultPaperConfig, resolvePersonalPaperAccount, evaluatePaperReadiness, type PaperReadinessDependencies } from "../../src/services/PaperDefaultSessionService";

const base = () => capturePaperConfig({ ...fixture("LONG_OPTION"), dataMode: "KITE_REAL" });

test("NIFTY resolves one validated server-owned LONG_OPTION PAPER/KITE_REAL five-minute default", () => {
  const resolved = resolveDefaultPaperConfig("NIFTY", [base()]);
  const summary = defaultPaperSummary(resolved);
  assert.equal(summary.strategyFamily, "LONG_OPTION"); assert.equal(summary.executionMode, "PAPER");
  assert.equal(summary.dataMode, "KITE_REAL"); assert.equal(summary.intervalMs, 300000);
  assert.equal(summary.entryWindowStartMinuteIST, 570); assert.equal(summary.entryCutoffMinuteIST, 900);
  assert.equal(summary.minConfidence, 0.65);
  assert.deepEqual([summary.longOptionSelection.minAbsDelta, summary.longOptionSelection.maxAbsDelta], [0.55, 0.70]);
  assert.deepEqual(capturePaperConfig(resolved), resolved);
});
test("missing, duplicate, unsupported or altered production default fails closed", () => {
  assert.throws(() => resolveDefaultPaperConfig("BANKNIFTY", [base()]), /DEFAULT_PAPER_ASSET_UNAVAILABLE/);
  assert.throws(() => resolveDefaultPaperConfig("FINNIFTY", [base()]), /DEFAULT_PAPER_ASSET_UNAVAILABLE/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", []), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [base(), base()]), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [capturePaperConfig({ ...base(), strategyConfig: { ...base().strategyConfig, strategyFamily: "CREDIT_VERTICAL" } })]), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [capturePaperConfig({ ...base(), intervalMs: 600000 })]), /DEFAULT_PAPER_CONFIG_INVALID/);
  assert.throws(() => capturePaperConfig({ ...base(), strategyConfig: { ...base().strategyConfig, strategyFamily: "AUTO" } }));
});
test("asset-only start request rejects browser-authored financial configuration and AUTO", () => {
  assert.equal(parseDefaultStartRequest({ asset: "NIFTY" }), "NIFTY");
  for (const body of [{ asset: "NIFTY", strategyFamily: "AUTO" }, { asset: "NIFTY", configId: "other" },
    { asset: "NIFTY", executionMode: "LIVE" }, null, { strategyFamily: "LONG_OPTION" }])
    assert.throws(() => parseDefaultStartRequest(body), /ASSET_ONLY_START_REQUIRED/);
});

function harness() {
  const calls: string[] = [];
  let reason: string | null = null, connected = true;
  const session = {sessionId:"session-1",accountId:base().accountId,status:"RUNNING",config:base()};
  let starts = 0;
  const deps: PaperReadinessDependencies = {
    clock: () => new Date("2026-09-29T05:00:00Z"), active: async () => session,
    connected: () => connected, mode: () => "KITE_REAL", entryConfig: async c => completePaperEntryConfig(c),
    accountGate: async () => {}, assertReady: async () => {
      if (reason && ["RECOVERY_REQUIRED","RECONCILIATION_REQUIRED"].includes(reason)) throw new Error(reason);
    },
    recover: async () => {calls.push("recover"); return {status:"INCOMPLETE"};},
    market: async () => {calls.push("market-read"); if (reason) throw new Error(reason);},
  };
  const scheduler = new PaperEvaluationScheduler(async () => {calls.push("tick");});
  const service = new PaperDefaultSessionService({
    configurations: async () => [base()], hasExplicitConfiguration: () => true,
    accounts: async () => [{accountId:session.accountId}],
    start: async () => { starts++; return session; },
    readiness: (s, _c, prepare) => evaluatePaperReadiness(s, deps, prepare),
    schedule: (account,id,interval) => scheduler.start(account,id,interval), sessionId: s => s.sessionId,
  });
  return {service,session,deps,calls, starts:()=>starts, setReason:(v:string|null)=>{reason=v;},
    disconnect:()=>{connected=false;}, stop:()=>scheduler.stop(session.sessionId)};
}

test("existing RUNNING session revalidates and preserves its exact ID and one timer", async () => {
  const h=harness(); try {
    const a=await h.service.start("NIFTY"), b=await h.service.start("NIFTY");
    assert.equal(a.sessionId,b.sessionId); assert.equal(b.entryReady,true); assert.equal(b.status,"RUNNING");
    assert.equal(h.calls.filter(c=>c==="tick").length,1); assert.equal(h.calls.filter(c=>c==="market-read").length,2);
  } finally {h.stop();}
});
for(const reason of ["RECOVERY_REQUIRED","RECONCILIATION_REQUIRED","INSTRUMENT_MASTER_STALE","MONTHLY_METADATA_REQUIRED","STALE_MARKET_DATA"])
 test(`running session with ${reason} stays RUNNING / WAITING with same identity`,async()=>{
  const h=harness();h.setReason(reason);try {
    const result=await h.service.start("NIFTY");assert.equal(result.status,"RUNNING");assert.equal(result.sessionId,h.session.sessionId);
    assert.equal(result.entryReady,false);assert.equal(result.entryStatus,"WAITING");
    assert.equal(result.entryBlockingReason,["RECOVERY_REQUIRED","RECONCILIATION_REQUIRED"].includes(reason)?"RECONCILIATION_NOT_MATCHED":reason);
  }finally{h.stop();}
 });
test("Kite disconnected is entry WAITING, not a failed monitoring Start",async()=>{
 const h=harness();h.disconnect();try{const r=await h.service.start("NIFTY");assert.equal(r.status,"RUNNING");assert.equal(r.entryBlockingReason,"KITE_SESSION_REQUIRED");assert.ok(!h.calls.includes("market-read"));}finally{h.stop();}
});
test("readiness restoration reuses the same running session and timer",async()=>{
 const h=harness();try{h.setReason("STALE_MARKET_DATA");const a=await h.service.start("NIFTY");h.setReason(null);const b=await h.service.start("NIFTY");
 assert.equal(a.entryReady,false);assert.equal(b.entryReady,true);assert.equal(a.sessionId,b.sessionId);assert.equal(h.calls.filter(c=>c==="tick").length,1);}finally{h.stop();}
});
test("rapid duplicate Start shares readiness and one timer",async()=>{
 const h=harness();try{const r=await Promise.all([h.service.start("NIFTY"),h.service.start("NIFTY")]);assert.equal(r[0].sessionId,r[1].sessionId);assert.equal(h.starts(),1);assert.equal(h.calls.filter(c=>c==="tick").length,1);}finally{h.stop();}
});
for (const [time,reason] of [["2026-09-29T13:00:00Z","MARKET_CALENDAR_CLOSED"],["2026-09-29T03:50:00Z","OPENING_BLOCK"]])
 test(`${reason} allows RUNNING while suppressing market/recovery work`,async()=>{
  const h=harness();h.deps.clock=()=>new Date(time);try{const r=await h.service.start("NIFTY");assert.equal(r.status,"RUNNING");assert.equal(r.entryBlockingReason,reason);
  assert.ok(!h.calls.includes("market-read"));assert.ok(!h.calls.includes("recover"));}finally{h.stop();}
 });
test("GET readiness cannot manufacture recovery/MATCHED proof",async()=>{
 const h=harness();h.setReason("RECOVERY_REQUIRED");const result=await evaluatePaperReadiness(h.session,h.deps,false);
 assert.equal(result.entryBlockingReason,"RECOVERY_REQUIRED");assert.ok(!h.calls.includes("recover"));
});
test("no config file resolves a validated built-in default from exactly one PAPER account",async()=>{
 const service=new PaperDefaultSessionService({configurations:async()=>[],hasExplicitConfiguration:()=>false,accounts:async()=>[{accountId:"PAPER:personal"}],
 start:async c=>({sessionId:"s",config:c}),readiness:async()=>waitingForEntry("CALENDAR_NOT_READY"),schedule:()=>{},sessionId:s=>s.sessionId});
 const c=await service.config("NIFTY");assert.equal(c.accountId,"PAPER:personal");assert.equal(c.strategyConfig.strategyFamily,"LONG_OPTION");
 assert.equal(c.calendar,null);assert.equal(c.riskFreeRate,null);assert.equal(c.intervalMs,300000);assert.equal(c.strategyConfig.minConfidence,.65);
 assert.deepEqual(c.strategyConfig.longOptionSelection,DEFAULT_LONG_SELECTION);
});
test("zero and multiple eligible accounts fail without arbitrary selection",()=>{
 assert.throws(()=>resolvePersonalPaperAccount([]),/PAPER_ACCOUNT_REQUIRED/);
 assert.throws(()=>resolvePersonalPaperAccount([{accountId:"PAPER:a"},{accountId:"PAPER:b"}]),/PAPER_ACCOUNT_AMBIGUOUS/);
});
test("built-in missing calendar/rate never becomes a complete entry configuration",()=>{
 const c=builtInNiftyPaperConfig("PAPER:personal");assert.throws(()=>completePaperEntryConfig(c),/CALENDAR_NOT_READY/);
 assert.throws(()=>completePaperEntryConfig(c,{calendar:base().calendar}),/GREEKS_CONFIG_REQUIRED/);
 const resolved=completePaperEntryConfig(c,{calendar:base().calendar,riskFreeRate:0.065,riskFreeRateVersion:"EXPLICIT_FIXTURE"});
 assert.equal(resolved.riskFreeRateVersion,"EXPLICIT_FIXTURE");assert.equal(resolved.accountId,c.accountId);
});

import { builtInNiftyPaperConfig, completePaperEntryConfig, waitingForEntry } from "../../src/domain/paperMonitoring";
import { DEFAULT_LONG_SELECTION } from "../../src/domain/strategyEvaluation";
import { PaperEvaluationScheduler } from "../../src/services/PaperEvaluationScheduler";

import { normalizeBacktestParams } from "../../src/domain/historicalReplay";
test("built-in quality defaults exactly match the approved Phase 5/6 defaults",()=>{
 const approved=normalizeBacktestParams({asset:"NIFTY",strategyFamily:"LONG_OPTION",from:"2026-09-29T03:45:00Z",to:"2026-09-29T10:00:00Z"}).strategyConfig;
 const {version:_approvedVersion,debitLongOffsetMinor:_unused,...expected}=approved;
 const {version:_version,...actual}=builtInNiftyPaperConfig("PAPER:personal").strategyConfig;
 assert.deepEqual(actual,expected);
});

import { PaperExitScheduler } from "../../src/services/PaperExitScheduler";
test("waiting monitoring Start leaves the independent exposure monitor running",async()=>{
 const exits=new PaperExitScheduler(async()=>[],async()=>{} ,()=>{});exits.start();const h=harness();h.disconnect();
 try{const result=await h.service.start("NIFTY");assert.equal(result.entryReady,false);assert.equal(result.status,"RUNNING");assert.equal(exits.isRunning(),true);}
 finally{h.stop();exits.stop();}
});
