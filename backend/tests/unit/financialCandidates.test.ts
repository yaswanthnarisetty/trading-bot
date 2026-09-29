import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { financialCandidate, financialFamilies } from "../fixtures/financialCandidates";
import { candidateEntryPlan } from "../../src/services/CandidateIntentAdapter";
import { calculateEntryRisk, entryProjectionFromFills } from "../../src/domain/entryRisk";
const original = { h: http.request, hg: http.get, s: https.request, sg: https.get, fetch: globalThis.fetch };
let attempts = 0;
before(() => { const block = () => { attempts++; throw new Error("NETWORK_FORBIDDEN"); };
  http.request = block as typeof http.request; http.get = block as typeof http.get; https.request = block as typeof https.request;
  https.get = block as typeof https.get; globalThis.fetch = block as typeof fetch; });
after(() => { http.request = original.h; http.get = original.hg; https.request = original.s; https.get = original.sg;
  globalThis.fetch = original.fetch; assert.equal(attempts, 0); });
async function terms(family = "DEBIT_VERTICAL" as typeof financialFamilies[number], direction: "BULLISH" | "BEARISH" = "BULLISH") {
  const c = await financialCandidate(family, direction), now = new Date(c.evaluatedAt);
  return { c, now, ...candidateEntryPlan(c, new Date(now.getTime() + 60000), now) };
}
for (const family of financialFamilies) for (const direction of ["BULLISH", "BEARISH"] as const)
  test(`${family} ${direction}: issued exact PAPER economics and conservative ceiling`, async () => {
    const { c, plan, requirement: r } = await terms(family, direction);
    assert.equal(c.executionAuthority, "NONE"); assert.equal(plan.dataMode, "MOCK"); assert.equal(plan.source, "MOCK");
    const buy = c.legs.find(l => l.side === "BUY")!;
    assert.equal(r.requiredRiskMinor, Math.max(buy.priceMinor * buy.quantityUnits, c.maxLossPerLotMinor));
    assert.equal(r.legs.length, family === "LONG_OPTION" ? 1 : 2);
    assert.equal(plan.analyticsEvidenceId, c.analyticsEvidenceId);
    for (const l of plan.legs) assert.equal(l.identity.instrumentToken, c.legs.find(x => x.role === l.role)!.instrument.instrumentToken);
  });
for (const shape of ["clone", "forged", "version", "authority"])
  test(`reject pseudo candidate: ${shape}`, async () => { const { c, now } = await terms();
    const input = shape === "clone" ? structuredClone(c) : { ...c, ...(shape === "version" ? { version: "v3" }
      : shape === "authority" ? { executionAuthority: "EXECUTE" } : { legs: [] }) };
    assert.throws(() => candidateEntryPlan(input, new Date(now.getTime() + 1000), now), /ISSUED_CANDIDATE_REQUIRED/); });
for (const expiry of [-1, 60001]) test(`candidate authorization lifetime rejects ${expiry}`, async () => {
  const { c, now } = await terms(); assert.throws(() => candidateEntryPlan(c, new Date(now.getTime() + expiry), now), /STALE_CANDIDATE/);
});
const edits: Record<string, (x: Awaited<ReturnType<typeof terms>>) => void> = {
  expiry: x => { x.plan.legs[1]!.identity.expiry = "2026-10-07"; },
  option: x => { x.plan.legs[1]!.optionType = x.plan.legs[1]!.optionType === "PUT" ? "CALL" : "PUT"; }, underlying: x => { x.plan.legs[1]!.identity.underlying = "BANKNIFTY"; },
  quantity: x => { x.targets[1]!.targetUnits *= 2; }, lot: x => { x.targets[1]!.targetUnits--; },
  equalStrike: x => { x.plan.legs[1]!.identity.strikeMinor = x.plan.legs[0]!.identity.strikeMinor; },
  reversedStrike: x => { const [a,b] = x.plan.legs; [a!.identity.strikeMinor,b!.identity.strikeMinor] = [b!.identity.strikeMinor,a!.identity.strikeMinor]; },
  role: x => { x.plan.legs[0]!.role = x.plan.legs[0]!.role === "SHORT" ? "LONG" : "SHORT"; }, tick: x => { x.plan.legs[0]!.limitPriceMinor++; },
  token: x => { x.plan.legs[1]!.identity.instrumentToken = x.plan.legs[0]!.identity.instrumentToken; },
  master: x => { x.plan.legs[1]!.identity.masterFingerprint = "other-master"; },
  exchange: x => { (x.plan.legs[0]!.identity as any).exchange = "NSE"; },
  zeroPremium: x => { x.plan.legs[1]!.limitPriceMinor = x.plan.legs[0]!.limitPriceMinor; },
  oversizedPremium: x => { const b = x.plan.legs.find(l => l.role !== "SHORT")!, s = x.plan.legs.find(l => l.role === "SHORT")!;
    if (x.plan.family === "DEBIT_VERTICAL") b.limitPriceMinor = s.limitPriceMinor + 10000; else s.limitPriceMinor = b.limitPriceMinor + 10000; },
  extraLeg: x => { x.plan.legs.push(x.plan.legs[0]!); x.targets.push(x.targets[0]!); },
  ratio: x => { x.targets[0]!.targetUnits *= 2; },
};
for (const family of ["DEBIT_VERTICAL", "CREDIT_VERTICAL"] as const) for (const [name, edit] of Object.entries(edits))
  test(`${family} rejects ${name}`, async () => { const x = await terms(family); edit(x); assert.throws(() => calculateEntryRisk(x.targets, x.plan)); });
function fills(r: ReturnType<typeof calculateEntryRisk>, buy: number, sell: number, buyPrice?: number, sellPrice?: number) {
  return r.legs.flatMap(l => { const q = l.side === "BUY" ? buy : sell; return q ? [{ fillId: l.legId, intentId: "i", legId: l.legId,
    contractKey: l.contractKey, side: l.side, quantityUnits: q, priceMinor: (l.side === "BUY" ? buyPrice : sellPrice) ?? l.limitPriceMinor }] : []; });
}
for (const family of financialFamilies) test(`${family}: exhaustive partial conservation, one slot and actual gross consideration`, async () => {
  const { requirement: r } = await terms(family), b = r.legs.find(l => l.side === "BUY")!, sh = r.legs.find(l => l.side === "SELL");
  const empty = entryProjectionFromFills(r, "i", []); assert.equal(empty.pendingMinor, r.requiredRiskMinor); assert.equal(empty.reservedSlots, 1);
  for (let buy = 1; buy <= b.quantityUnits; buy++) for (let sell = 0; sell <= (sh && buy === b.quantityUnits ? buy : 0); sell++) {
    const p = entryProjectionFromFills(r, "i", fills(r, buy, sell));
    const unmatched = (buy - sell) * b.limitPriceMinor;
    const matched = sell * (family === "CREDIT_VERTICAL" ? r.widthMinor + b.limitPriceMinor - sh!.limitPriceMinor : b.limitPriceMinor - (sh?.limitPriceMinor ?? 0));
    assert.equal(p.committedMinor, unmatched + matched);
    assert.ok(p.pendingMinor + p.committedMinor >= unmatched + matched); assert.ok(p.pendingMinor <= r.requiredRiskMinor);
    assert.equal(p.reservedSlots, 0); assert.equal(p.committedSlots, 1);
    if (buy === b.quantityUnits && (!sh || sell === buy)) assert.equal(p.pendingMinor, Math.max(0,r.requiredRiskMinor-p.committedMinor));
  }
});
for (const [buy, sell, expected] of [[9000,11500,9000],[1000,2000,9000]] as const)
  test(`credit ceiling covers long=${buy} and final=${10000+buy-sell}`, async () => {
    const x = await terms("CREDIT_VERTICAL"); for (const l of x.plan.legs) l.limitPriceMinor = l.role === "HEDGE" ? buy : sell;
    const r = calculateEntryRisk(x.targets,x.plan); assert.equal(r.requiredRiskMinor, expected*65);
  });
test("generic SELL remains unsupported", async () => { const x = await terms();
  const legacy = { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: x.plan.validUntil,
    legs: x.plan.legs.map(({role,identity,...l}) => l) };
  assert.throws(() => calculateEntryRisk(x.targets,legacy), /UNSUPPORTED_RISK_SHAPE/);
});
test("short fill without protection fails projection", async () => { const {requirement:r}=await terms();
  assert.throws(() => entryProjectionFromFills(r,"i",fills(r,0,1)), /RISK_PROJECTION_MISMATCH/); });
test("actual fill price above authorization remains financial truth", async () => { const {requirement:r}=await terms();
  const p=entryProjectionFromFills(r,"i",fills(r,65,65,40000,10000)); assert.equal(p.committedMinor,1950000);
  assert.ok(p.committedMinor>r.requiredRiskMinor); });
test("round unmatched premium upward without floating accumulation", async () => { const {requirement:r}=await terms();
  const f=fills(r,65,1,1,10000); f[0]!.priceMinor = f[0]!.side === "BUY" ? 1 : 10000;
  const p=entryProjectionFromFills(r,"i",f); assert.equal(p.committedMinor,64); });
for (const family of ["DEBIT_VERTICAL", "CREDIT_VERTICAL"] as const)
  test(`${family}: pending plus actual risk bounds every legal remaining completion`, async () => {
    const {requirement:r} = await terms(family), b=r.legs.find(l=>l.side==="BUY")!, sh=r.legs.find(l=>l.side==="SELL")!;
    for(const price of [0,b.limitPriceMinor-5,b.limitPriceMinor,b.limitPriceMinor+10000])
      for(const bq of [0,1,32,65]) for(const sq of bq===65?[0,1,32,65]:[0]) {
        const current=fills(r,bq,sq,price,sh.limitPriceMinor+5), p=entryProjectionFromFills(r,"i",current);
        const fullBuy=[...current,...(bq<65?[{fillId:"future-buy",intentId:"i",legId:b.legId,contractKey:b.contractKey,side:"BUY" as const,quantityUnits:65-bq,priceMinor:b.limitPriceMinor}]:[])];
        for(const futureShort of [0,Math.floor((65-sq)/2),65-sq]) {
          const possible=[...fullBuy,...(futureShort?[{fillId:"future-sell",intentId:"i",legId:sh.legId,contractKey:sh.contractKey,side:"SELL" as const,quantityUnits:futureShort,priceMinor:sh.limitPriceMinor}]:[])];
          assert.ok(p.pendingMinor+p.committedMinor>=entryProjectionFromFills(r,"i",possible).committedMinor);
        }
      }
  });
