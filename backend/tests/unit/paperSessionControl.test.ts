import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
// Execute the actual dependency-free frontend control module with Node's existing
// test runner. No duplicate implementation, browser, network or package needed.
const source=readFileSync('../frontend/lib/paperSessionControl.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const moduleObject={exports:{} as any};new Function('exports',compiled)(moduleObject.exports);
const {retainPaperSession,discoverPaperSession,pollPaperSession,stopPaperSession}=moduleObject.exports;
const session=(accountId:string,sessionId:string,status='RUNNING')=>({accountId,sessionId,status,executionMode:'PAPER',config:{configId:`config-${accountId}`}});
test('dashboard A/B retain start responses, independently poll and stop exact IDs',async()=>{
 const a=session('PAPER:A','A'),b=session('PAPER:B','B'),rows=new Map([['A',a],['B',b]]),reads:string[]=[],stops:string[]=[];
 const start=async(account:string)=>account==='PAPER:A'?a:b;
 const selectedA=retainPaperSession(await start('PAPER:A'),'PAPER:A');
 const selectedB=retainPaperSession(await start('PAPER:B'),'PAPER:B');
 assert.equal(selectedB,b);assert.equal(selectedB.config.configId,'config-PAPER:B');
 const read=async(id:string)=>{reads.push(id);return rows.get(id);};
 assert.equal(await pollPaperSession(selectedA,read),a);assert.equal(await pollPaperSession(selectedB,read),b);assert.deepEqual(reads,['A','B']);
 const stop=async(id:string)=>{stops.push(id);rows.get(id)!.status='STOPPED';};
 await stopPaperSession(selectedB,stop);assert.equal(b.status,'STOPPED');assert.equal(a.status,'RUNNING');
 await stopPaperSession(selectedA,stop);assert.deepEqual(stops,['B','A']);
});
for(const accountId of ['PAPER:A','PAPER:B'])test(`reload discovery is explicitly scoped to ${accountId}`,async()=>{
 const row=session(accountId,accountId.slice(-1));let requested='';
 assert.equal(await discoverPaperSession(accountId,async(scope:string)=>{requested=scope;return row;}),row);assert.equal(requested,accountId);
});
for(const status of ['STOPPED','CRASHED'])test(`exact ${status} session stays selected even if another account is running`,async()=>{
 const row=session('PAPER:B','B',status);assert.equal(await pollPaperSession(row,async()=>row),row);
 await assert.rejects(pollPaperSession(row,async()=>session('PAPER:A','A')),/SESSION_IDENTITY_MISMATCH/);
});
test('404 exact polling rejects safely without discovery fallback',async()=>{
 const row=session('PAPER:B','B');let reads=0;
 await assert.rejects(pollPaperSession(row,async(id:string)=>{assert.equal(id,'B');reads++;throw new Error('404 SESSION_NOT_FOUND');}),/404/);assert.equal(reads,1);
});
test('wrong-account and unscoped discovery cannot select or stop another session',async()=>{
 await assert.rejects(discoverPaperSession('PAPER:B',async()=>session('PAPER:A','A')),/SESSION_IDENTITY_MISMATCH/);
 await assert.rejects(discoverPaperSession('',async()=>{throw new Error('must not call');}),/EXPLICIT_PAPER_ACCOUNT_REQUIRED/);
 assert.throws(()=>retainPaperSession(session('PAPER:A','A'),'PAPER:B'),/SESSION_IDENTITY_MISMATCH/);
 let calls=0;await assert.rejects(stopPaperSession({...session('PAPER:B','B'),accountId:undefined},async()=>{calls++;}),/SESSION_IDENTITY_MISMATCH/);assert.equal(calls,0);
});
test('dashboard wiring retains start result and uses per-tab exact identity on reload',()=>{
 const page=readFileSync('../frontend/app/(dashboard)/dashboard/page.tsx','utf8');
 const start=page.slice(page.indexOf('async function handleStart'),page.indexOf('async function handleStop'));
 assert.match(start,/retainPaperSession\(await startSession\("NIFTY"\), config.accountId\)/);assert.doesNotMatch(start,/getActiveSession/);
 assert.match(page,/pollPaperSession\(identity, getSession\)/);assert.match(page,/sessionStorage\.setItem/);assert.doesNotMatch(page,/getActiveSession\(\)/);
 assert.match(page,/getDefaultPaperConfig\("NIFTY"\)/);assert.doesNotMatch(page,/paper-configuration|recoverPaperSession/);
 const route=readFileSync('src/routes/session.ts','utf8');assert.match(route,/activeForAccount\(accountId\)/);
 assert.match(route,/parseDefaultStartRequest\(req.body\)/);assert.match(route,/EXPLICIT_PAPER_ACCOUNT_REQUIRED/);
});
