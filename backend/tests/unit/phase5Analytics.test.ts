import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KiteInstrumentMasterService, type InstrumentDefinition } from "../../src/services/KiteInstrumentMasterService";
import { KiteMarketDataService } from "../../src/services/KiteMarketDataService";
import { KiteIndexDataService, qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import { computeValidatedIndicators, type AnalyticsCandle } from "../../src/domain/validatedIndicators";
import { computeQualifiedGreeks } from "../../src/domain/qualifiedGreeks";
import { buildMockMarketAnalytics, buildRealMarketAnalytics, assertMarketAnalytics,
  type MockAnalyticsInput, type MockOptionEvidence } from "../../src/domain/marketAnalytics";
import { evaluateStrategy, type StrategyQualityConfig, type StrategyEvaluationInput } from "../../src/domain/strategyEvaluation";
import { computeD1, computeD2, normalCDF } from "../../src/utils/greeksMath";

const base = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const appended = [
  "100010,410,NIFTY26O0624900PE,NIFTY,200,2026-10-06,24900,0.05,65,PE,NFO-OPT,NFO",
  "100011,411,NIFTY26O0624800PE,NIFTY,150,2026-10-06,24800,0.05,65,PE,NFO-OPT,NFO",
  "100012,412,NIFTY26O0625100CE,NIFTY,200,2026-10-06,25100,0.05,65,CE,NFO-OPT,NFO",
  "100013,413,NIFTY26O0625200CE,NIFTY,150,2026-10-06,25200,0.05,65,CE,NFO-OPT,NFO",
  "256265,1001,NIFTY 50,NIFTY 50,25000,,0,0,0,EQ,INDICES,NSE",
  "260105,1002,NIFTY BANK,NIFTY BANK,51000,,0,0,0,EQ,INDICES,NSE",
  "257801,1003,NIFTY FIN SERVICE,NIFTY FIN SERVICE,24000,,0,0,0,EQ,INDICES,NSE",
];
const csv = base + appended.join("\n") + "\n";
const at = "2026-09-29T08:30:00.000Z", expiryAt = "2026-10-06T10:00:00.000Z";
const now = Date.parse(at), success = (data: unknown) => ({ status: "success", data });
const config: StrategyQualityConfig = { version: "QUALITY_V1", minConfidence: 0.65, maxAtrPoints: 100,
  minVolumeRatio: 0, bullishRsiMax: 100, bearishRsiMin: 0, openingBlockMinutes: 15,
  minDteDays: 3, strikeStepMinor: 5000, widthMinor: 10000, shortOffsetMinor: 10000,
  minDepthUnits: 1, maxBidAskSpreadMinor: 1000, minCreditMinor: 1000 };
const assumptions = { evaluatedAt: at, expiryAtByDate: { "2026-10-06": expiryAt },
  expiryAssumptionVersion: "NSE_CLOSE_1530_V1", riskFreeRate: 0.065, riskFreeRateVersion: "TEST_RATE_V1" };
const candles: AnalyticsCandle[] = Array.from({ length: 50 }, (_, n) => ({
  timestamp: new Date(Date.parse("2026-09-29T04:20:00Z") + n * 300_000).toISOString(),
  openMinor: 2_499_000 + n * 200, highMinor: 2_500_000 + n * 200,
  lowMinor: 2_498_000 + n * 200, closeMinor: 2_499_500 + n * 200, volume: 100 + n,
}));
async function master() {
  return new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv }, () => new Date(now),
    [...(["NIFTY", "BANKNIFTY", "FINNIFTY"] as const).map(underlying =>
      ({ underlying, expiry: "2026-09-29", sourceReference: "offline-calendar" })),
      { underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "offline-calendar" }]).load();
}
const tokenPrices: Readonly<Record<string, number>> = { "100010": 200, "100011": 150, "100012": 200, "100013": 150 };
async function mockInput(): Promise<MockAnalyticsInput> {
  const m = await master();
  const options: MockOptionEvidence[] = ["100010", "100011", "100012", "100013"].map(token => {
    const instrument = m.getByCurrentInstrumentToken(token), value = tokenPrices[token]! * 100;
    return { instrument, bidMinor: value - 100, askMinor: value + 100,
      bidQuantity: 65, askQuantity: 65, optionPriceMinor: value, priceTimestamp: at };
  });
  return { ...assumptions, underlying: "NIFTY", spotMinor: 2_500_000, spotTimestamp: at,
    interval: "5minute", candles, options };
}
async function mockEvaluation(overrides: Partial<StrategyEvaluationInput> = {}) {
  const analytics = buildMockMarketAnalytics(await mockInput());
  return evaluateStrategy({ analytics, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" },
    config, evaluatedAt: at, ...overrides });
}

test("validated indicators are deterministic, immutable and use finalized chronological candles", () => {
  const a = computeValidatedIndicators({ candles, interval: "5minute", evaluatedAt: at });
  const b = computeValidatedIndicators({ candles, interval: "5minute", evaluatedAt: at });
  assert.deepEqual(a, b); assert.equal(a.available, true);
  if (a.available) { assert.equal(a.snapshot.values.candleCount, 50); assert.ok(Object.isFrozen(a.snapshot.values)); }
  assert.deepEqual(candles[0]?.timestamp, "2026-09-29T04:20:00.000Z");
});
test("indicator warmup, order, finality and invalid OHLCV fail explicitly", () => {
  const run = (data: readonly AnalyticsCandle[], time = at) => computeValidatedIndicators({ candles: data, interval: "5minute", evaluatedAt: time });
  assert.deepEqual(run(candles.slice(0, 49)), { available: false, reason: "INSUFFICIENT_HISTORY" });
  assert.deepEqual(run([...candles].reverse()), { available: false, reason: "INVALID_CANDLE" });
  assert.deepEqual(run([candles[0]!, ...candles]), { available: false, reason: "INVALID_CANDLE" });
  assert.deepEqual(run(candles.map((c, n) => n === 1 ? { ...c, closeMinor: NaN } : c)), { available: false, reason: "INVALID_CANDLE" });
  assert.deepEqual(run(candles.map((c, n) => n === 1 ? { ...c, highMinor: 1 } : c)), { available: false, reason: "INVALID_CANDLE" });
  assert.deepEqual(run(candles, "2026-09-29T08:27:00Z"), { available: false, reason: "CANDLE_NOT_FINAL" });
  assert.deepEqual(run(candles, "bad"), { available: false, reason: "INVALID_EVALUATION_TIME" });
});
test("later candles cannot affect an earlier evaluation", () => {
  const before = computeValidatedIndicators({ candles, interval: "5minute", evaluatedAt: at });
  const later = { ...candles[49]!, timestamp: "2026-09-29T08:30:00Z", closeMinor: 2_600_000, highMinor: 2_600_000 };
  assert.deepEqual(computeValidatedIndicators({ candles: [...candles, later], interval: "5minute", evaluatedAt: at }),
    { available: false, reason: "CANDLE_NOT_FINAL" });
  assert.deepEqual(computeValidatedIndicators({ candles, interval: "5minute", evaluatedAt: at }), before);
});
test("qualified CE and PE Greeks recover a known IV and retain exact provenance", async () => {
  const m = await master();
  for (const [token, call] of [["100012", true], ["100010", false]] as const) {
    const instrument = m.getByCurrentInstrumentToken(token), years = (Date.parse(expiryAt) - now) / (365 * 86400000);
    const s = 25000, k = instrument.strikeMinor / 100, r = 0.065, iv = 0.24;
    const d1 = computeD1(s, k, years, r, iv), d2 = computeD2(d1, iv, years), discounted = k * Math.exp(-r * years);
    const value = call ? s * normalCDF(d1) - discounted * normalCDF(d2) : discounted * normalCDF(-d2) - s * normalCDF(-d1);
    const result = computeQualifiedGreeks({ instrument, spotMinor: 2_500_000, optionPriceMinor: Math.round(value * 100),
      valuationAt: at, optionPriceTimestamp: at, expiryAt, expiryAssumptionVersion: "NSE_CLOSE_1530_V1",
      riskFreeRate: r, riskFreeRateVersion: "TEST_RATE_V1", dataMode: "MOCK", source: "MOCK",
      masterFingerprint: m.provenance.sourceFingerprint });
    assert.equal(result.available, true);
    if (result.available) { assert.ok(Math.abs(result.value.impliedVolatility - iv) < 0.0001);
      assert.equal(result.value.instrument, instrument); assert.equal(result.value.canonicalId, instrument.canonicalId);
      assert.equal(result.value.expiryAt, expiryAt); assert.equal(result.value.expiryAssumptionVersion, "NSE_CLOSE_1530_V1");
      assert.equal(result.value.riskFreeRateVersion, "TEST_RATE_V1"); assert.equal(result.value.masterFingerprint, m.provenance.sourceFingerprint); }
  }
});
test("Greeks reject unqualified, expiry mismatch, expired, impossible and nonfinite inputs", async () => {
  const m = await master(), instrument = m.getByCurrentInstrumentToken("100010");
  const input = { instrument, spotMinor: 2_500_000, optionPriceMinor: 20_000, valuationAt: at,
    optionPriceTimestamp: at, expiryAt, expiryAssumptionVersion: "NSE_CLOSE_1530_V1", riskFreeRate: 0.065,
    riskFreeRateVersion: "TEST_RATE_V1", dataMode: "MOCK" as const, source: "MOCK" as const,
    masterFingerprint: m.provenance.sourceFingerprint };
  for (const change of [{ instrument: { ...instrument } as InstrumentDefinition }, { spotMinor: 0 },
    { spotMinor: Infinity }, { optionPriceMinor: NaN }, { optionPriceMinor: 9_999_999 },
    { expiryAt: "2026-10-07T10:00:00Z" }, { expiryAt: at }, { expiryAt: "2026-10-06T00:00:00Z" },
    { masterFingerprint: "forged" }, { riskFreeRate: Infinity }])
    assert.equal(computeQualifiedGreeks({ ...input, ...change }).available, false);
  assert.deepEqual(computeQualifiedGreeks({ ...input, valuationAt: expiryAt, optionPriceTimestamp: expiryAt }),
    { available: false, reason: "EXPIRED_OPTION" });
  assert.deepEqual(computeQualifiedGreeks({ ...input, valuationAt: "2026-10-06T09:45:00Z" }),
    { available: false, reason: "IV_UNAVAILABLE" });
});
test("mock snapshot is immutable, visibly MOCK, and cannot be relabeled as real", async () => {
  const analytics = buildMockMarketAnalytics(await mockInput()); assert.equal(analytics.available, true);
  if (analytics.available) { assert.equal(analytics.snapshot.dataMode, "MOCK"); assert.equal(analytics.snapshot.source, "MOCK");
    assert.ok(Object.isFrozen(analytics.snapshot.options)); assertMarketAnalytics(analytics.snapshot);
    assert.throws(() => assertMarketAnalytics({ ...analytics.snapshot, dataMode: "KITE_REAL" }), /ANALYTICS_UNAVAILABLE/); }
});
test("same strategy input returns exact qualified legs and integer economics deterministically", async () => {
  const analytics = buildMockMarketAnalytics(await mockInput());
  const input: StrategyEvaluationInput = { analytics, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" }, config, evaluatedAt: at };
  const a = evaluateStrategy(input), b = evaluateStrategy(input);
  assert.deepEqual(a, b); assert.equal(a.action, "CANDIDATE");
  if (a.action === "CANDIDATE") {
    assert.equal(a.candidate.executionAuthority, "NONE"); assert.equal(a.candidate.strategy, "BULL_PUT_SPREAD");
    assert.equal(a.candidate.short.instrument.instrumentToken, "100010"); assert.equal(a.candidate.hedge.instrument.instrumentToken, "100011");
    assert.equal(a.candidate.short.canonicalId, a.candidate.short.instrument.canonicalId);
    assert.equal(a.candidate.creditPerUnitMinor, 4800); assert.equal(a.candidate.maxLossPerUnitMinor, 5200);
    assert.equal(a.candidate.creditPerLotMinor, 4800 * 65); assert.ok(Object.isFrozen(a.candidate));
    assert.match(a.candidate.candidateKey, /^NIFTY:2026-10-06:BULL_PUT_SPREAD:KITE:NFO:/);
  }
});
test("bear call uses exact CE legs and remains proposal-only", async () => {
  const result = await mockEvaluation({ proposal: { direction: "BEARISH", confidence: 0.8, expiry: "2026-10-06" } });
  assert.equal(result.action, "CANDIDATE");
  if (result.action === "CANDIDATE") { assert.equal(result.candidate.strategy, "BEAR_CALL_SPREAD");
    assert.equal(result.candidate.short.instrument.instrumentToken, "100012");
    assert.equal(result.candidate.hedge.instrument.instrumentToken, "100013"); }
});
for (const [label, overrides, reason] of [
  ["HOLD proposal", { proposal: { direction: "HOLD", confidence: 1, expiry: "2026-10-06" } }, "NO_DIRECTION"],
  ["low confidence", { proposal: { direction: "BULLISH", confidence: 0.2, expiry: "2026-10-06" } }, "CONFIDENCE_TOO_LOW"],
  ["ATR", { config: { ...config, maxAtrPoints: 0.01 } }, "ATR_GATE"],
  ["RSI", { config: { ...config, bullishRsiMax: 50 } }, "RSI_GATE"],
  ["volume", { config: { ...config, minVolumeRatio: 100 } }, "VOLUME_GATE"],
  ["opening", { evaluatedAt: "2026-09-29T03:50:00Z" }, "INVALID_INPUT"],
  ["unsupported preference", { proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06", preferredStrategy: "BEAR_CALL_SPREAD" } }, "STRATEGY_NOT_SUPPORTED"],
  ["no expiry", { proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-13" } }, "NO_QUALIFIED_CONTRACT"],
] as const) test(`strategy ${label} is stable ${reason}`, async () => {
  const result = await mockEvaluation(overrides as Partial<StrategyEvaluationInput>);
  assert.deepEqual(result, { action: "HOLD", reason });
});
test("missing exact short and hedge cannot be synthesized from a symbol", async () => {
  const input = await mockInput();
  const short = buildMockMarketAnalytics({ ...input, options: input.options.filter(o => o.instrument.instrumentToken !== "100010") });
  assert.deepEqual(evaluateStrategy({ analytics: short, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" }, config, evaluatedAt: at }),
    { action: "HOLD", reason: "NO_QUALIFIED_CONTRACT" });
  const hedge = buildMockMarketAnalytics({ ...input, options: input.options.filter(o => o.instrument.instrumentToken !== "100011") });
  assert.deepEqual(evaluateStrategy({ analytics: hedge, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" }, config, evaluatedAt: at }),
    { action: "HOLD", reason: "NO_QUALIFIED_HEDGE" });
});
test("opening block uses explicit IST evaluation time without Date.now", async () => {
  const input = await mockInput(), early = "2026-09-29T03:50:00Z";
  const historical = input.candles.map(c => ({ ...c,
    timestamp: new Date(Date.parse(c.timestamp) - 86_400_000).toISOString() }));
  const analytics = buildMockMarketAnalytics({ ...input, evaluatedAt: early, spotTimestamp: early,
    candles: historical, options: input.options.map(o => ({ ...o, priceTimestamp: early })) });
  assert.deepEqual(evaluateStrategy({ analytics, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" },
    config, evaluatedAt: early }), { action: "HOLD", reason: "OPENING_BLOCK" });
});
test("invalid Greek, depth, spread, credit and logical duplicate reject candidate", async () => {
  const input = await mockInput();
  const option = input.options.find(o => o.instrument.instrumentToken === "100010")!;
  const cases = [
    [{ ...option, optionPriceMinor: 9_999_999 }, "INVALID_GREEKS"],
    [{ ...option, bidQuantity: 0 }, "LIQUIDITY_GATE"],
    [{ ...option, bidMinor: 1 }, "LIQUIDITY_GATE"],
  ] as const;
  for (const [modified, reason] of cases) {
    const analytics = buildMockMarketAnalytics({ ...input, options: input.options.map(o => o === option ? modified : o) });
    assert.deepEqual(evaluateStrategy({ analytics, proposal: { direction: "BULLISH", confidence: 0.8, expiry: "2026-10-06" }, config, evaluatedAt: at }),
      { action: "HOLD", reason });
  }
  const r = await mockEvaluation({ config: { ...config, minCreditMinor: 5000 } });
  assert.deepEqual(r, { action: "HOLD", reason: "CREDIT_GATE" });
  const key = `NIFTY:2026-10-06:BULL_PUT_SPREAD:${input.options[0]!.instrument.canonicalId}:${input.options[1]!.instrument.canonicalId}`;
  assert.deepEqual(await mockEvaluation({ priorCandidateKeys: [key] }), { action: "HOLD", reason: "DUPLICATE_CANDIDATE" });
});

test("real analytics requires current qualified index and option quote evidence", async () => {
  const optionMaster = await master(), indexMaster = qualifyIndexMaster(csv, at);
  const index = indexMaster.resolve("NIFTY"), tokens = ["100010", "100011"];
  const optionCalls: string[] = [], indexCalls: string[] = [];
  let lastTrade: string | null = "2026-09-29 14:00:00", candleSet: readonly AnalyticsCandle[] = candles;
  const optionMarket = new KiteMarketDataService({ async get(path) { optionCalls.push(path);
    const data: Record<string, unknown> = {};
    for (const token of tokens) { const i = optionMaster.getByCurrentInstrumentToken(token), p = tokenPrices[token]!;
      data[i.contractKey] = { instrument_token: Number(token), last_price: p,
        ohlc: { open: p, high: p + 1, low: p - 1, close: p }, volume: 100, oi: 100,
        timestamp: "2026-09-29 14:00:00", last_trade_time: lastTrade,
        depth: { buy: [{ price: p - 1, quantity: 65, orders: 1 }],
          sell: [{ price: p + 1, quantity: 65, orders: 1 }] } }; }
    return success(data); } }, async () => optionMaster, () => "KITE_REAL", () => now);
  const indexMarket = new KiteIndexDataService({ async get(path) { indexCalls.push(path);
    if (path === "/quote") return success({ [index.contractKey]: { instrument_token: 256265,
      last_price: 25000, timestamp: "2026-09-29 14:00:00" } });
    return success({ candles: candleSet.map(c => [c.timestamp, c.openMinor / 100, c.highMinor / 100,
      c.lowMinor / 100, c.closeMinor / 100, c.volume]) });
  } }, async () => indexMaster, () => "KITE_REAL", () => now);
  await optionMarket.refreshMaster(); await indexMarket.refreshMaster();
  const optionQuotes = await optionMarket.getQuotes(tokens.map(t => optionMaster.getByCurrentInstrumentToken(t)), 1000);
  const indexQuote = await indexMarket.getQuote(index, 1000);
  const indexHistory = await indexMarket.getHistoricalCandles({ index, interval: "5minute",
    from: candles[0]!.timestamp, to: at });
  const input = { ...assumptions, observedAt: at, index, indexQuote, indexHistory, optionQuotes, maxAgeMs: 1000 };
  const real = buildRealMarketAnalytics(input); assert.equal(real.available, true);
  if (real.available) { assert.equal(real.snapshot.source, "KITE"); assert.equal(real.snapshot.dataMode, "KITE_REAL");
    assert.equal(real.snapshot.indexCanonicalId, index.canonicalId); assert.equal(real.snapshot.options.length, 2);
    const evaluation = evaluateStrategy({ analytics: real, proposal: { direction: "BULLISH", confidence: 0.8,
      expiry: "2026-10-06" }, config, evaluatedAt: at });
    assert.equal(evaluation.action, "CANDIDATE");
    if (evaluation.action === "CANDIDATE") { assert.equal(evaluation.candidate.dataMode, "KITE_REAL");
      assert.equal(evaluation.candidate.executionAuthority, "NONE"); }
  }
  assert.deepEqual(optionCalls, ["/quote"]);
  assert.deepEqual(indexCalls, ["/quote", "/instruments/historical/256265/5minute"]);
  assert.deepEqual(buildRealMarketAnalytics({ ...input, indexQuote: { ...indexQuote } }), { available: false, reason: "REAL_DATA_REQUIRED" });
  assert.deepEqual(buildRealMarketAnalytics({ ...input, indexHistory: { ...indexHistory } }), { available: false, reason: "REAL_DATA_REQUIRED" });
  assert.deepEqual(buildRealMarketAnalytics({ ...input, optionQuotes: [{ ...optionQuotes[0]! }] }), { available: false, reason: "REAL_DATA_REQUIRED" });
  assert.deepEqual(buildRealMarketAnalytics({ ...input, indexQuote: { ...indexQuote, source: "MOCK" } as unknown as typeof indexQuote }),
    { available: false, reason: "REAL_DATA_REQUIRED" });
  lastTrade = "2026-09-29 13:00:00";
  const oldTrade = await optionMarket.getQuotes(tokens.map(t => optionMaster.getByCurrentInstrumentToken(t)), 1000);
  assert.deepEqual(buildRealMarketAnalytics({ ...input, optionQuotes: oldTrade }),
    { available: false, reason: "MARKET_DATA_NOT_FRESH" });
  lastTrade = null;
  const unavailableTrade = await optionMarket.getQuotes(tokens.map(t => optionMaster.getByCurrentInstrumentToken(t)), 1000);
  assert.deepEqual(buildRealMarketAnalytics({ ...input, optionQuotes: unavailableTrade }),
    { available: false, reason: "INVALID_MARKET_EVIDENCE" });
  candleSet = candles.map(c => ({ ...c, timestamp: new Date(Date.parse(c.timestamp) - 35 * 60_000).toISOString() }));
  const oldHistory = await indexMarket.getHistoricalCandles({ index, interval: "5minute",
    from: candleSet[0]!.timestamp, to: at });
  assert.deepEqual(buildRealMarketAnalytics({ ...input, indexHistory: oldHistory }),
    { available: false, reason: "MARKET_DATA_NOT_FRESH" });
  assert.equal((await mockEvaluation()).action, "CANDIDATE");
});

test("real snapshot uses evaluatedAt for all exchange evidence and a trusted assembly clock", async t => {
  const optionMaster = await master(), indexMaster = qualifyIndexMaster(csv, at);
  const index = indexMaster.resolve("NIFTY"), tokens = ["100010", "100011"];
  let indexTime = "2026-09-29 14:00:00", optionTime = indexTime, tradeTime = indexTime;
  const optionMarket = new KiteMarketDataService({ async get() {
    const data: Record<string, unknown> = {};
    for (const token of tokens) {
      const instrument = optionMaster.getByCurrentInstrumentToken(token), price = tokenPrices[token]!;
      data[instrument.contractKey] = { instrument_token: Number(token), last_price: price,
        ohlc: { open: price, high: price + 1, low: price - 1, close: price }, volume: 100, oi: 100,
        timestamp: optionTime, last_trade_time: tradeTime,
        depth: { buy: [{ price: price - 1, quantity: 65, orders: 1 }],
          sell: [{ price: price + 1, quantity: 65, orders: 1 }] } };
    }
    return success(data);
  } }, async () => optionMaster, () => "KITE_REAL", () => now);
  const indexMarket = new KiteIndexDataService({ async get(path) {
    if (path === "/quote") return success({ [index.contractKey]: {
      instrument_token: Number(index.instrumentToken), last_price: 25000, timestamp: indexTime } });
    return success({ candles: candles.map(c => [c.timestamp, c.openMinor / 100, c.highMinor / 100,
      c.lowMinor / 100, c.closeMinor / 100, c.volume]) });
  } }, async () => indexMaster, () => "KITE_REAL", () => now);
  await optionMarket.refreshMaster(); await indexMarket.refreshMaster();
  const indexHistory = await indexMarket.getHistoricalCandles({ index, interval: "5minute",
    from: candles[0]!.timestamp, to: at });
  const options = () => optionMarket.getQuotes(tokens.map(token => optionMaster.getByCurrentInstrumentToken(token)), 60_000);
  const spot = () => indexMarket.getQuote(index, 60_000);
  const run = (indexQuote: Awaited<ReturnType<typeof spot>>, optionQuotes: Awaited<ReturnType<typeof options>>,
    evaluatedAt: string, observedAt = evaluatedAt) => buildRealMarketAnalytics({ ...assumptions,
    evaluatedAt, observedAt, index, indexQuote, indexHistory, optionQuotes, maxAgeMs: 60_000 });
  const evaluatedOneMinuteLater = "2026-09-29T08:31:00.000Z";
  const evaluatedOneSecondLater = "2026-09-29T08:30:01.000Z";
  const evaluatedThirtySecondsLater = "2026-09-29T08:30:30.000Z";

  indexTime = "2026-09-29 13:59:00";
  const oldIndex = await spot();
  const currentOptions = await options();
  await t.test("reproduced P1 rejects a two-minute-old index and never yields a candidate", () => {
    const result = run(oldIndex, currentOptions, evaluatedOneMinuteLater);
    assert.deepEqual(result, { available: false, reason: "MARKET_DATA_NOT_FRESH" });
    assert.deepEqual(evaluateStrategy({ analytics: result, proposal: { direction: "BULLISH", confidence: 0.8,
      expiry: "2026-10-06" }, config, evaluatedAt: evaluatedOneMinuteLater }),
    { action: "HOLD", reason: "MARKET_DATA_NOT_FRESH" });
  });
  await t.test("evidence age exactly maxAgeMs is inclusive", () => {
    assert.equal(run(oldIndex, currentOptions, at, at).available, true);
  });
  await t.test("index evidence older than maxAgeMs rejects", () => {
    assert.deepEqual(run(oldIndex, currentOptions, evaluatedOneSecondLater),
      { available: false, reason: "MARKET_DATA_NOT_FRESH" });
  });

  indexTime = "2026-09-29 14:00:00";
  const currentIndex = await spot();
  await t.test("fresh evidence and evaluatedAt equal to trusted observedAt succeed", () => {
    assert.equal(run(currentIndex, currentOptions, at, at).available, true);
    assert.equal(run(currentIndex, currentOptions, evaluatedThirtySecondsLater).available, true);
  });
  await t.test("future evaluatedAt rejects before real snapshot assembly", () => {
    assert.deepEqual(run(currentIndex, currentOptions, evaluatedOneSecondLater, at),
      { available: false, reason: "INVALID_MARKET_EVIDENCE" });
  });
  await t.test("index timestamp later than evaluatedAt rejects", () => {
    assert.equal(run(currentIndex, currentOptions, "2026-09-29T08:29:59.000Z", at).available, false);
  });

  optionTime = "2026-09-29 13:59:00";
  const oldOptionPacket = await options();
  await t.test("option packet older than maxAgeMs rejects even with a recent trade", () => {
    assert.deepEqual(run(currentIndex, oldOptionPacket, evaluatedOneSecondLater),
      { available: false, reason: "MARKET_DATA_NOT_FRESH" });
  });
  optionTime = "2026-09-29 14:00:00";
  tradeTime = "2026-09-29 13:59:00";
  const oldOptionTrade = await options();
  await t.test("option last trade older than maxAgeMs rejects", () => {
    assert.deepEqual(run(currentIndex, oldOptionTrade, evaluatedOneSecondLater),
      { available: false, reason: "MARKET_DATA_NOT_FRESH" });
  });
  await t.test("option packet timestamp later than evaluatedAt rejects", () => {
    assert.equal(run(currentIndex, currentOptions, "2026-09-29T08:29:59.000Z", at).available, false);
  });
  await t.test("MOCK replay remains deterministic without a trusted clock", async () => {
    const input = await mockInput();
    assert.deepEqual(buildMockMarketAnalytics(input), buildMockMarketAnalytics(input));
  });
});
