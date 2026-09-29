import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperExitScheduler } from '../../src/services/PaperExitScheduler';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const positions=(count:number)=>Array.from({length:count},(_,n)=>({positionId:String(n)}));
async function tick(scheduler:PaperExitScheduler){await scheduler.tick();await flush();}

test('eight stable exposures receive bounded service while position zero repeatedly runs slow',async()=>{
 const calls=Array(8).fill(0),running=new Set<string>();let releaseSlow:(()=>void)|undefined,peak=0;
 const scheduler=new PaperExitScheduler(async()=>positions(8),async id=>{
  assert.equal(running.has(id),false,'same position may not overlap');running.add(id);peak=Math.max(peak,running.size);calls[Number(id)]++;
  try{if(id==='0')await new Promise<void>(resolve=>{releaseSlow=resolve;});}finally{running.delete(id);}
 },()=>assert.fail('unexpected evaluation failure'),5000,4);
 for(let n=0;n<6;n++){
  await tick(scheduler);await tick(scheduler);
  releaseSlow?.();await flush();await tick(scheduler);
  if(n===0)assert.ok(calls[7]>0,'previously starved final position must run by the third opportunity');
 }
 assert.ok(calls.every(count=>count>0),JSON.stringify(calls));assert.ok(peak<=4);
 releaseSlow?.();await flush();assert.equal(running.size,0);
});

test('one permanently in-flight position does not starve other eligible positions',async()=>{
 const calls=Array(8).fill(0);let release!:()=>void;
 const scheduler=new PaperExitScheduler(async()=>positions(8),async id=>{
  calls[Number(id)]++;if(id==='0')await new Promise<void>(resolve=>{release=resolve;});
 },()=>assert.fail('unexpected evaluation failure'),5000,4);
 for(let n=0;n<5;n++)await tick(scheduler);
 assert.equal(calls[0],1);assert.ok(calls.slice(1).every(count=>count>0),JSON.stringify(calls));
 release();await flush();
});

test('three occupied slots still rotate the single free slot across all positions',async()=>{
 const calls=Array(8).fill(0),releases=new Map<string,()=>void>();let running=0,peak=0;
 const scheduler=new PaperExitScheduler(async()=>positions(8),async id=>{
  calls[Number(id)]++;running++;peak=Math.max(peak,running);
  try{if(['0','1','2'].includes(id))await new Promise<void>(resolve=>{releases.set(id,resolve);});}
  finally{running--;}
 },()=>assert.fail('unexpected evaluation failure'),5000,4);
 for(let n=0;n<6;n++)await tick(scheduler);
 assert.ok(calls.slice(3).every(count=>count>0),JSON.stringify(calls));assert.deepEqual(calls.slice(0,3),[1,1,1]);
 assert.ok(peak<=4);assert.equal(running,3);
 for(const release of releases.values())release();await flush();assert.equal(running,0);
});

test('identity cursor survives reordering, growth, shrinkage, and a flat position disappearing',async()=>{
 let rows=['04','01','03'];const calls:string[]=[];
 const scheduler=new PaperExitScheduler(async()=>rows.map(positionId=>({positionId})),async id=>{calls.push(id);},
  ()=>assert.fail('unexpected evaluation failure'),5000,1);
 await tick(scheduler);rows=['04','03','02','01'];await tick(scheduler);
 rows=['04','01'];await tick(scheduler);rows=['00','04','01'];await tick(scheduler);
 assert.deepEqual(calls,['01','02','04','00']);
});

test('synchronous evaluation failure releases the slot and preserves fair progress',async()=>{
 const calls:string[]=[];let errors=0;
 const scheduler=new PaperExitScheduler(async()=>[{positionId:'a'},{positionId:'b'}],id=>{
  calls.push(id);if(id==='a')throw new Error('fixture failure');return Promise.resolve();
 },()=>{errors++;},5000,1);
 await tick(scheduler);await tick(scheduler);
 assert.deepEqual(calls,['a','b']);assert.equal(errors,1);
});

test('zero free slots leave the cursor intact; repeated ticks cannot overlap or exceed capacity',async()=>{
 const calls:string[]=[],running=new Set<string>(),releases=new Map<string,()=>void>();let peak=0;
 const scheduler=new PaperExitScheduler(async()=>positions(4),async id=>{
  assert.equal(running.has(id),false);running.add(id);peak=Math.max(peak,running.size);calls.push(id);
  try{await new Promise<void>(resolve=>{releases.set(id,resolve);});}finally{running.delete(id);}
 },()=>assert.fail('unexpected evaluation failure'),5000,2);
 await tick(scheduler);for(let n=0;n<4;n++)await tick(scheduler);
 assert.deepEqual(calls,['0','1']);releases.get('0')!();await flush();await tick(scheduler);
 assert.deepEqual(calls,['0','1','2']);assert.equal(peak,2);
 for(const id of ['1','2'])releases.get(id)!();await flush();assert.equal(running.size,0);
});
