import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { createBacktestHandler } from "../../src/routes/backtest";
import { familyFixture } from "../fixtures/strategyFamilies";
import { fixtureParams, fixtureQuality } from "../fixtures/historicalReplay";
import { evaluateHistoricalBar, normalizeBacktestParams, prepareReplay,
  type HistoricalReplayDataset, type BacktestRunParams, type ReplayProposalSource } from "../../src/domain/historicalReplay";
import { evaluateStrategy, DEFAULT_LONG_SELECTION, type StrategyFamily, type StrategyQualityConfig } from "../../src/domain/strategyEvaluation";
import { runHistoricalBacktest } from "../../src/services/BacktestService";
import { assertQualifiedInstrument } from "../../src/services/KiteInstrumentMasterService";
import { evaluateWithPhase5LLM, PRIMARY_PROMPT_VERSION, VERIFIER_PROMPT_VERSION } from "../../src/services/Phase5LLMService";

let attempts = 0;
const original = { hr: http.request, hg: http.get, sr: https.request, sg: https.get, fetch: globalThis.fetch };
before(() => {
  const block = () => { attempts++; throw new Error("NETWORK_FORBIDDEN"); };
  http.request = block as typeof http.request; http.get = block as typeof http.get;
  https.request = block as typeof https.request; https.get = block as typeof https.get; globalThis.fetch = block as typeof fetch;
});
after(() => {
  http.request = original.hr; http.get = original.hg; https.request = original.sr; https.get = original.sg; globalThis.fetch = original.fetch;
  assert.equal(attempts, 0);
});
const families: StrategyFamily[] = ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"];
const directions = ["BULLISH", "BEARISH"] as const;
const source = (direction: "BULLISH" | "BEARISH" | "HOLD"): ReplayProposalSource => ({ version: "DIRECTION_FIXTURE_V1",
  propose: () => ({ direction, confidence: 0.8, reason: "FIXTURE_DIRECTION" }) });
const kinds = { LONG_OPTION: ["LONG_CALL", "LONG_PUT"], DEBIT_VERTICAL: ["BULL_CALL_DEBIT_SPREAD", "BEAR_PUT_DEBIT_SPREAD"],
  CREDIT_VERTICAL: ["BULL_PUT_CREDIT_SPREAD", "BEAR_CALL_CREDIT_SPREAD"] };
function evaluate(data: HistoricalReplayDataset, family: StrategyFamily, direction: "BULLISH" | "BEARISH" | "HOLD" = "BULLISH",
  quality: Partial<StrategyQualityConfig> = {}) {
  const config = normalizeBacktestParams({ ...fixtureParams(data), strategyFamily: family,
    strategyConfig: { ...fixtureQuality, ...quality } });
  return evaluateHistoricalBar(prepareReplay(data, config), 49, config, source(direction));
}
const run = (data: HistoricalReplayDataset, family: StrategyFamily, direction: "BULLISH" | "BEARISH" = "BULLISH",
  patch: Partial<BacktestRunParams> = {}) => runHistoricalBacktest({ ...fixtureParams(data), strategyFamily: family,
    initialCapital: 500000, riskPerTradePct: 10, ...patch },
  { provider: { load: async () => data }, proposalSource: source(direction), runTimestamp: "2026-09-30T12:00:00.000Z" });
for (const family of families) for (const [n, direction] of directions.entries()) {
  test(`${family} ${direction}: exact legs, lot quantities, economics and no authority`, async () => {
    const data = await familyFixture(), e = evaluate(data, family, direction);
    assert.equal(e.result.action, "CANDIDATE"); if (e.result.action !== "CANDIDATE") return;
    const c = e.result.candidate;
    assert.equal(c.strategyKind, kinds[family][n]); assert.equal(c.executionAuthority, "NONE");
    assert.equal(c.expiry, "2026-10-06"); assert.equal(c.quantityUnits, 65);
    assert.match(c.analyticsEvidenceId, /^ANALYTICS_SHA256_V1:/); assert.equal(c.evaluatorVersion, "PHASE6A01_V1");
    for (const leg of c.legs) {
      assertQualifiedInstrument(leg.instrument); assert.equal(leg.instrument, data.master.getInstrumentByCanonicalId(leg.canonicalId));
      assert.equal(leg.quantityUnits, 65); assert.equal(leg.instrument.expiry, c.expiry);
    }
    if (family === "LONG_OPTION") {
      assert.equal(c.legs.length, 1); assert.equal(c.legs[0]!.side, "BUY");
      assert.equal(c.legs[0]!.instrument.instrumentType, direction === "BULLISH" ? "CE" : "PE");
      assert.equal(c.maxLossPerLotMinor, c.legs[0]!.priceMinor * 65);
      assert.equal(c.maxProfitPerLotMinor, null); assert.equal(c.maxProfitPerUnitMinor, null);
      assert.ok(!("short" in c));
    } else {
      const buy = c.legs.find(l => l.side === "BUY")!, sell = c.legs.find(l => l.side === "SELL")!;
      assert.equal(c.legs.length, 2); assert.equal(buy.instrument.instrumentType, sell.instrument.instrumentType);
      assert.equal(Math.abs(buy.instrument.strikeMinor - sell.instrument.strikeMinor), 10000);
      if (family === "DEBIT_VERTICAL") {
        assert.equal(buy.instrument.strikeMinor < sell.instrument.strikeMinor, direction === "BULLISH");
        assert.equal(c.entryCashFlowPerUnitMinor, -5200); assert.equal(c.maxLossPerLotMinor, 338000);
        assert.equal(c.maxProfitPerLotMinor, 312000);
      } else {
        assert.equal(c.entryCashFlowPerUnitMinor, 4800); assert.equal(c.maxLossPerLotMinor, 338000);
        assert.equal(c.maxProfitPerLotMinor, 312000);
      }
    }
  });
  test(`directional LLM ${direction} obeys configured ${family}`, async () => {
    const e = evaluate(await familyFixture(), family, direction);
    const result = await evaluateWithPhase5LLM({ analytics: e.analytics, evaluatedAt: e.evaluatedAt, expiry: e.proposal.expiry,
      strategyConfig: { ...fixtureQuality, strategyFamily: family }, llmConfig: {
        primaryModel: "offline", verifierModel: "offline", primaryPromptVersion: PRIMARY_PROMPT_VERSION,
        verifierPromptVersion: VERIFIER_PROMPT_VERSION, verifierConfidenceThreshold: 0.75, timeoutMs: 100,
        temperature: 0, maxOutputTokens: 600 } }, { complete: async request => ({ model: "offline",
      content: JSON.stringify(request.stage === "PRIMARY" ? { direction, confidence: 0.8, reasonCode: "TREND", rationale: "fixture", riskFlags: [] }
        : { verdict: "AGREE", confidence: 0.8, reasonCode: "CHECKED", rationale: "fixture", riskFlags: [] }) }) });
    assert.equal(result.evidence.strategyResult.action, "CANDIDATE");
    if (result.evidence.strategyResult.action === "CANDIDATE") assert.equal(result.evidence.strategyResult.candidate.strategyKind, kinds[family][n]);
  });
}
for (const family of families) test(`${family} HOLD stays HOLD and config overrides preference`, async () => {
  const data = await familyFixture(); assert.equal(evaluate(data, family, "HOLD").result.action, "HOLD");
  const e = evaluate(data, family);
  const r = evaluateStrategy({ analytics: e.analytics, proposal: { ...e.proposal, preferredStrategy: "HOLD" },
    config: { ...fixtureQuality, strategyFamily: family }, evaluatedAt: e.evaluatedAt });
  assert.equal(r.action, "CANDIDATE"); if (r.action === "CANDIDATE") assert.equal(r.candidate.strategyFamily, family);
});
test("long delta band is configurable and no premium range is used", async () => {
  const data = await familyFixture();
  assert.deepEqual(evaluate(data, "LONG_OPTION", "BULLISH", { longOptionSelection: { ...DEFAULT_LONG_SELECTION,
    minAbsDelta: 0.9, maxAbsDelta: 0.95, targetAbsDelta: 0.92 } }).result, { action: "HOLD", reason: "NO_QUALIFIED_CONTRACT" });
  const e = evaluate(data, "LONG_OPTION"); assert.equal(e.result.action, "CANDIDATE");
  if (e.result.action === "CANDIDATE") assert.equal(e.result.candidate.legs[0]!.priceMinor, 30100);
});
test("long selection tie-breaking is deterministic under reversed quote order", async () => {
  const data = await familyFixture(); const e = evaluate(data, "LONG_OPTION"); assert.ok(e.analytics.available);
  const deltas = e.analytics.snapshot.options.filter(o => o.instrument.instrumentType === "CE" && o.instrument.strikeMinor <= 2490000)
    .map(o => { assert.ok(o.greeks.available); return o.greeks.value.delta; });
  const quality = { longOptionSelection: { ...DEFAULT_LONG_SELECTION, targetAbsDelta: (deltas[0]! + deltas[1]!) / 2 } };
  assert.deepEqual(evaluate(data, "LONG_OPTION", "BULLISH", quality).result,
    evaluate({ ...data, optionQuotes: [...data.optionQuotes].reverse() }, "LONG_OPTION", "BULLISH", quality).result);
});
for (const direction of directions) test(`long ${direction} never substitutes the wrong option type`, async () => {
  const data = await familyFixture(); const wrongType = direction === "BULLISH" ? "PE" : "CE";
  const changed = { ...data, optionQuotes: data.optionQuotes.filter(q => data.master.getInstrumentByCanonicalId(q.canonicalId).instrumentType === wrongType) };
  assert.equal(evaluate(changed, "LONG_OPTION", direction).result.action, "HOLD");
});
for (const price of [15000, 35000]) test(`debit rejects invalid net debit with long premium ${price}`, async () => {
  const data = await familyFixture();
  const changed = { ...data, optionQuotes: data.optionQuotes.map(q => {
    const i = data.master.getInstrumentByCanonicalId(q.canonicalId);
    return i.instrumentType === "CE" && i.strikeMinor === 2500000 ? { ...q, bidMinor: price - 100, askMinor: price + 100, lastPriceMinor: price } : q;
  }) };
  assert.deepEqual(evaluate(changed, "DEBIT_VERTICAL").result, { action: "HOLD", reason: "DEBIT_GATE" });
});
test("debit missing exact short returns HOLD, without generating another contract", async () => {
  const data = await familyFixture(); const changed = { ...data, optionQuotes: data.optionQuotes.filter(q => {
    const i = data.master.getInstrumentByCanonicalId(q.canonicalId); return !(i.instrumentType === "CE" && i.strikeMinor === 2510000);
  }) };
  assert.deepEqual(evaluate(changed, "DEBIT_VERTICAL").result, { action: "HOLD", reason: "NO_QUALIFIED_SHORT" });
});
test("debit mismatched broker lots reject", async () => {
  const data = await familyFixture(csv => csv.replace("25100,0.05,65,CE", "25100,0.05,25,CE"));
  assert.deepEqual(evaluate(data, "DEBIT_VERTICAL").result, { action: "HOLD", reason: "INVALID_INPUT" });
});
test("LLM cannot smuggle a family into its strict directional response", async () => {
  const e = evaluate(await familyFixture(), "LONG_OPTION");
  const result = await evaluateWithPhase5LLM({ analytics: e.analytics, evaluatedAt: e.evaluatedAt, expiry: e.proposal.expiry,
    strategyConfig: { ...fixtureQuality, strategyFamily: "LONG_OPTION" }, llmConfig: {
      primaryModel: "offline", verifierModel: "offline", primaryPromptVersion: PRIMARY_PROMPT_VERSION,
      verifierPromptVersion: VERIFIER_PROMPT_VERSION, verifierConfidenceThreshold: 0.75, timeoutMs: 100, temperature: 0, maxOutputTokens: 600 } },
  { complete: async () => ({ model: "offline", content: JSON.stringify({ direction: "BULLISH", confidence: 0.8,
    reasonCode: "TREND", rationale: "fixture", riskFlags: [], strategyFamily: "CREDIT_VERTICAL" }) }) });
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "SCHEMA_REJECTED");
});
for (const family of ["LONG_OPTION", "DEBIT_VERTICAL"] as const) for (const direction of directions) for (const winning of [true, false]) {
  test(`${family} ${direction} ${winning ? "win" : "loss"}: exact side fills, P&L and slippage`, async () => {
    const data = await familyFixture(), e = evaluate(data, family, direction);
    assert.equal(e.result.action, "CANDIDATE"); if (e.result.action !== "CANDIDATE") return;
    const c = e.result.candidate, buy = c.legs.find(l => l.side === "BUY")!;
    const shift = family === "LONG_OPTION" ? winning ? 20000 : -10000 : winning ? 4000 : -4000;
    const tape = { ...data, optionQuotes: data.optionQuotes.map(q => q.timestamp > e.evaluatedAt && q.canonicalId === buy.canonicalId
      ? { ...q, bidMinor: q.bidMinor + shift, askMinor: q.askMinor + shift, lastPriceMinor: q.lastPriceMinor + shift } : q) };
    const r = await run(tape, family, direction, { stopLossPctOfPremium: 0.2 }), t = r.trades[0]!;
    assert.equal(r.status, "COMPLETE"); assert.equal(t.lots, 1); assert.equal(t.strategyFamily, family);
    assert.equal(t.exitReason, winning ? "TARGET_HIT" : "STOP_HIT"); assert.equal(t.pnl > 0, winning);
    assert.equal(t.slippageCost, family === "LONG_OPTION" ? 195 : 390);
    assert.equal(r.slippageCost, r.trades.reduce((sum, trade) => sum + trade.slippageCost, 0));
    assert.equal(r.grossPnL - r.slippageCost, r.netPnL);
    assert.equal(t.grossPnL - t.slippageCost, t.pnl); assert.equal(r.finalCapital, r.initialCapital + r.netPnL);
    const cash = t.legs.reduce((sum, l) => sum + (l.side === "BUY" ? l.exitFillMinor - l.entryFillMinor
      : l.entryFillMinor - l.exitFillMinor) * l.quantityUnits, 0);
    assert.equal(t.pnlMinor, cash); assert.equal(t.maxLoss, t.entryDebit);
    if (family === "LONG_OPTION") { assert.equal(t.maxProfit, null); assert.equal(t.sellStrike, null); }
    else assert.equal(t.maxProfit, 100 * 65 - t.entryDebit!);
  });
}
for (const family of families) {
  test(`${family}: missing required quote remains INCOMPLETE without synthetic fills`, async () => {
    const data = await familyFixture(), e = evaluate(data, family); assert.equal(e.result.action, "CANDIDATE");
    if (e.result.action !== "CANDIDATE") return;
    const missing = e.result.candidate.legs[0]!.canonicalId;
    const r = await run({ ...data, optionQuotes: data.optionQuotes.filter(q => q.canonicalId !== missing) }, family);
    assert.equal(r.status, "INCOMPLETE"); assert.ok(r.completeness.missingRequiredOptionObservations > 0);
    assert.equal(r.totalTraded, 0);
  });
  test(`${family}: repeatability, future isolation, provenance and small-capital sizing`, async () => {
    const data = await familyFixture(), a = await run(data, family), b = await run(data, family);
    assert.deepEqual(a, b); assert.equal(a.strategyFamily, family); assert.equal(a.metadata.config.strategyFamily, family);
    const changed = { ...data, optionQuotes: data.optionQuotes.map(q => q.timestamp <= a.decisions[0]!.evaluatedAt ? q
      : { ...q, bidMinor: q.bidMinor + 500, askMinor: q.askMinor + 500, lastPriceMinor: q.lastPriceMinor + 500 }) };
    assert.deepEqual(a.decisions[0], (await run(changed, family)).decisions[0]);
    const small = await run(data, family, "BULLISH", { initialCapital: 50000, riskPerTradePct: 10 });
    assert.ok(small.peakCapitalReserved <= 5000);
    if (family === "LONG_OPTION") assert.equal(small.totalTraded, 0);
    assert.equal(small.executionAuthority, "NONE");
  });
}
test("family and selection changes are reflected in reproducibility identities", async () => {
  const data = await familyFixture(); const ids = await Promise.all(families.map(async family => (await run(data, family)).metadata.runId));
  assert.equal(new Set(ids).size, 3);
  assert.notEqual(ids[0], (await run(data, "LONG_OPTION", "BULLISH", { takeProfitPctOfPremium: 0.75 })).metadata.runId);
  assert.throws(() => normalizeBacktestParams({ ...fixtureParams(data), strategyFamily: "AUTO" }), /INVALID_BACKTEST_CONFIG/);
  assert.throws(() => normalizeBacktestParams({ ...fixtureParams(data), strategyFamily: "LONG_OPTION",
    strategyConfig: { ...fixtureQuality, strategyFamily: "CREDIT_VERTICAL" } }), /CONFLICTING_STRATEGY_FAMILY/);
});
test("family research loads no financial execution services and attempts no external calls", async () => {
  for (const family of families) await run(await familyFixture(), family);
  assert.equal(attempts, 0);
  assert.deepEqual(Object.keys(require.cache).filter(path => /\/src\/(?:models\/|services\/(?:RiskAdmissionService|RiskSettlementService|OrderManager|PaperBroker|FillProcessor|SignalLoopService|LLMService)\.)/.test(path)), []);
});

for (const family of ["LONG_OPTION", "DEBIT_VERTICAL"] as const) {
  test(`${family}: missing exit evidence leaves the position unresolved`, async () => {
    const data = await familyFixture(), e = evaluate(data, family);
    assert.equal(e.result.action, "CANDIDATE"); if (e.result.action !== "CANDIDATE") return;
    const missing = e.result.candidate.legs[0]!.canonicalId;
    const result = await run({ ...data, optionQuotes: data.optionQuotes.filter(q =>
      q.timestamp <= e.evaluatedAt || q.canonicalId !== missing) }, family);
    assert.equal(result.status, "INCOMPLETE"); assert.equal(result.totalTraded, 1);
    assert.equal(result.trades.length, 0); assert.equal(result.unresolvedPositions.length, 1);
    assert.ok(result.missingExitObservations > 0); assert.equal(result.netPnL, 0);
  });
  test(`${family}: different expiry cannot substitute a contract`, async () => {
    const e = evaluate(await familyFixture(), family);
    assert.deepEqual(evaluateStrategy({ analytics: e.analytics, evaluatedAt: e.evaluatedAt,
      proposal: { ...e.proposal, expiry: "2026-10-07" },
      config: { ...fixtureQuality, strategyFamily: family } }),
    { action: "HOLD", reason: "NO_QUALIFIED_CONTRACT" });
  });
}
for (const config of [{ minDepthUnits: 66 }, { maxBidAskSpreadMinor: 199 }]) {
  test(`long liquidity gate ${JSON.stringify(config)}`, async () => {
    assert.deepEqual(evaluate(await familyFixture(), "LONG_OPTION", "BULLISH", config).result,
      { action: "HOLD", reason: "LIQUIDITY_GATE" });
  });
}
for (const selection of [null, {}, { ...DEFAULT_LONG_SELECTION, minAbsDelta: 0.8 },
  { ...DEFAULT_LONG_SELECTION, targetAbsDelta: 2 }, { ...DEFAULT_LONG_SELECTION, maxStrikeDistanceMinor: 0 },
  { ...DEFAULT_LONG_SELECTION, premiumTarget: 19000 }]) {
  test(`malformed long selection fails closed: ${JSON.stringify(selection)}`, async () => {
    const data = await familyFixture();
    assert.throws(() => normalizeBacktestParams({ ...fixtureParams(data), strategyFamily: "LONG_OPTION",
      strategyConfig: { ...fixtureQuality, longOptionSelection: selection } }), /INVALID_BACKTEST_CONFIG/);
  });
}
for (const family of families) {
  test(`POST backtest handler accepts explicit ${family} without external calls`, async () => {
    const data = await familyFixture(); let body: any; let status = 200;
    const response = { status: (code: number) => { status = code; return response; }, json: (value: unknown) => { body = value; } };
    await createBacktestHandler({ load: async () => data })({ body: { ...fixtureParams(data), strategyFamily: family } } as any,
      response as any, (() => assert.fail("unexpected next")) as any);
    assert.equal(status, 200); assert.equal(body.strategyFamily, family); assert.equal(body.executionAuthority, "NONE");
  });
}
