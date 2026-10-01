import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { realProvider, evaluationTime } from "../fixtures/paperOrchestration";
import { readPaperMarketObservation } from "../../src/services/PaperMarketObservation";
const original = { request:http.request,get:http.get,secure:https.request,secureGet:https.get,fetch:globalThis.fetch };
let attempts=0;
before(()=>{const block=()=>{attempts++;throw new Error("EXTERNAL_HTTP_FORBIDDEN");};
  http.request=block as any;http.get=block as any;https.request=block as any;https.get=block as any;globalThis.fetch=block as any;});
after(()=>{http.request=original.request;http.get=original.get;https.request=original.secure;https.get=original.secureGet;globalThis.fetch=original.fetch;assert.equal(attempts,0);});
test("closed-market observation preserves stale broker timestamp and has no entry authority",async()=>{
  const at=new Date("2026-09-29T13:00:00Z"), fixture=await realProvider(()=>at);fixture.state.ageMs=3*3600000;
  const result=await readPaperMarketObservation(fixture.index);
  assert.equal(result.status,"AVAILABLE");assert.equal(result.tradability,"NON_TRADABLE");
  assert.equal(result.quote?.freshness.state,"STALE");assert.equal(result.quote?.brokerTimestamp,new Date(+at-fixture.state.ageMs).toISOString());
  assert.equal(result.greeks.status,"UNAVAILABLE");assert.ok(fixture.paths.every(path=>path==="/quote"));
});
test("unavailable observation never supplies synthetic price or Greeks",async()=>{
  const fixture=await realProvider(()=>evaluationTime);fixture.state.missing=true;
  const result=await readPaperMarketObservation(fixture.index);assert.equal(result.status,"UNAVAILABLE");assert.equal(result.quote,null);
  assert.equal(result.greeks.status,"UNAVAILABLE");
});
