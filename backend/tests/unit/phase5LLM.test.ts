import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KiteInstrumentMasterService } from "../../src/services/KiteInstrumentMasterService";
import { KiteMarketDataService } from "../../src/services/KiteMarketDataService";
import { KiteIndexDataService, qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import { buildMockMarketAnalytics, buildRealMarketAnalytics, type MockAnalyticsInput } from "../../src/domain/marketAnalytics";
import { analyticsEvidenceId } from "../../src/domain/analyticsEvidence";
import { evaluateWithPhase5LLM, PRIMARY_PROMPT_VERSION, VERIFIER_PROMPT_VERSION,
  type LLMCompletion, type LLMCompletionRequest, type Phase5LLMConfig,
  type Phase5LLMTransport } from "../../src/services/Phase5LLMService";
import { phase5LegacyCompatibleConfig } from "../../src/services/LLMService";
import { evaluateStrategy, type StrategyQualityConfig } from "../../src/domain/strategyEvaluation";

const at = "2026-09-29T08:30:00.000Z", expiryAt = "2026-10-06T10:00:00.000Z";
const base = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const csv = base + [
  "100010,410,NIFTY26O0624900PE,NIFTY,200,2026-10-06,24900,0.05,65,PE,NFO-OPT,NFO",
  "100011,411,NIFTY26O0624800PE,NIFTY,150,2026-10-06,24800,0.05,65,PE,NFO-OPT,NFO",
  "100012,412,NIFTY26O0625100CE,NIFTY,200,2026-10-06,25100,0.05,65,CE,NFO-OPT,NFO",
  "100013,413,NIFTY26O0625200CE,NIFTY,150,2026-10-06,25200,0.05,65,CE,NFO-OPT,NFO",
  "256265,1001,NIFTY 50,NIFTY 50,25000,,0,0,0,EQ,INDICES,NSE",
  "260105,1002,NIFTY BANK,NIFTY BANK,51000,,0,0,0,EQ,INDICES,NSE",
  "257801,1003,NIFTY FIN SERVICE,NIFTY FIN SERVICE,24000,,0,0,0,EQ,INDICES,NSE",
].join("\n") + "\n";
const tokens = ["100010", "100011", "100012", "100013"];
const prices: Record<string, number> = { "100010": 200, "100011": 150, "100012": 200, "100013": 150 };
const assumptions = { evaluatedAt: at, expiryAtByDate: { "2026-10-06": expiryAt },
  expiryAssumptionVersion: "NSE_CLOSE_1530_V1", riskFreeRate: 0.065, riskFreeRateVersion: "TEST_RATE_V1" };
const candles = Array.from({ length: 50 }, (_, n) => ({
  timestamp: new Date(Date.parse("2026-09-29T04:20:00Z") + n * 300_000).toISOString(),
  openMinor: 2_499_000 + n * 200, highMinor: 2_500_000 + n * 200,
  lowMinor: 2_498_000 + n * 200, closeMinor: 2_499_500 + n * 200, volume: 100 + n,
}));
const quality: StrategyQualityConfig = { version: "QUALITY_V1", minConfidence: 0.65,
  maxAtrPoints: 100, minVolumeRatio: 0, bullishRsiMax: 100, bearishRsiMin: 0,
  openingBlockMinutes: 15, minDteDays: 3, strikeStepMinor: 5000, widthMinor: 10000,
  shortOffsetMinor: 10000, minDepthUnits: 1, maxBidAskSpreadMinor: 1000, minCreditMinor: 1000 };
const llm: Phase5LLMConfig = { primaryModel: "gpt-4o-mini", verifierModel: "gpt-4o-mini",
  primaryPromptVersion: PRIMARY_PROMPT_VERSION, verifierPromptVersion: VERIFIER_PROMPT_VERSION,
  verifierConfidenceThreshold: 0.75, timeoutMs: 100, temperature: 0.2, maxOutputTokens: 600 };
async function master() {
  return new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv },
    () => new Date(at), [...(["NIFTY", "BANKNIFTY", "FINNIFTY"] as const).map(underlying =>
      ({ underlying, expiry: "2026-09-29", sourceReference: "offline-calendar" })),
      { underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "offline-calendar" }]).load();
}
async function mockInput(): Promise<MockAnalyticsInput> {
  const m = await master();
  return { ...assumptions, underlying: "NIFTY", spotMinor: 2_500_000, spotTimestamp: at,
    interval: "5minute", candles,
    options: tokens.map(token => { const price = prices[token]! * 100;
      return { instrument: m.getByCurrentInstrumentToken(token), bidMinor: price - 100,
        askMinor: price + 100, bidQuantity: 65, askQuantity: 65, optionPriceMinor: price,
        priceTimestamp: at }; }) };
}
const primary = (direction: "BULLISH" | "BEARISH" | "HOLD" = "BULLISH", confidence = 0.8) =>
  JSON.stringify({ direction, confidence, reasonCode: "TREND", rationale: "Indicator trend supports the view.", riskFlags: [] });
const verifier = (verdict: "AGREE" | "DISAGREE" | "HOLD" = "AGREE", confidence = 0.8) =>
  JSON.stringify({ verdict, confidence, reasonCode: "CHECKED", rationale: "Direction reviewed.", riskFlags: [] });
const completion = (content: string | null): LLMCompletion => ({ content, model: "gpt-4o-mini-test",
  usage: { inputTokens: 75, outputTokens: 25 }, latencyMs: 2 });
function fake(...responses: Array<string | null | Error | (() => Promise<LLMCompletion>)>) {
  const requests: LLMCompletionRequest[] = [];
  const transport: Phase5LLMTransport = { async complete(request) {
    requests.push(request);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function") return response();
    return completion(response ?? null);
  } };
  return { transport, requests };
}
async function run(responses: Array<string | null | Error | (() => Promise<LLMCompletion>)>,
  overrides: Partial<Parameters<typeof evaluateWithPhase5LLM>[0]> = {}, clock?: () => number) {
  const analytics = buildMockMarketAnalytics(await mockInput()), f = fake(...responses);
  const result = await evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm, ...overrides }, f.transport, clock);
  return { result, requests: f.requests, analytics };
}

test("legacy compatible model configuration retains the deployed model and versioned prompts", () => {
  const value = phase5LegacyCompatibleConfig();
  assert.equal(value.primaryModel, "gpt-4o-mini");
  assert.equal(value.primaryPromptVersion, PRIMARY_PROMPT_VERSION);
  assert.equal(value.verifierPromptVersion, VERIFIER_PROMPT_VERSION);
});
for (const [direction, strategy] of [["BULLISH", "BULL_PUT_SPREAD"],
  ["BEARISH", "BEAR_CALL_SPREAD"]] as const) test(`valid ${direction} analysis uses deterministic ${strategy} legs`, async () => {
  const { result, requests } = await run([primary(direction), verifier()]);
  assert.equal(result.action, "CANDIDATE");
  assert.equal(result.evidence.strategyResult.action, "CANDIDATE");
  if (result.evidence.strategyResult.action === "CANDIDATE") {
    assert.equal(result.evidence.strategyResult.candidate.strategy, strategy);
    assert.equal(result.evidence.strategyResult.candidate.executionAuthority, "NONE");
    assert.equal(result.evidence.strategyResult.candidate.dataMode, "MOCK");
  }
  assert.equal(result.evidence.finalProposal.direction, direction);
  assert.equal(requests.length, 2);
});
test("primary HOLD returns HOLD and explicitly skips verifier", async () => {
  const { result, requests } = await run([primary("HOLD")]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "PRIMARY_HOLD");
  assert.deepEqual(result.evidence.verifier, { status: "NOT_RUN", reason: "PRIMARY_HOLD" });
  assert.equal(requests.length, 1);
});
for (const boundary of [0, 1]) test(`primary confidence ${boundary} is accepted without repair`, async () => {
  const { result } = await run([primary("BULLISH", boundary), verifier()],
    { llmConfig: { ...llm, verifierConfidenceThreshold: 0 } });
  assert.equal(result.evidence.primary.status, "COMPLETED");
  if (result.evidence.primary.status === "COMPLETED") assert.equal(result.evidence.primary.result.confidence, boundary);
});
for (const value of [-0.01, 1.01, "0.8", null]) test(`invalid primary confidence ${String(value)} is rejected`, async () => {
  const raw = JSON.stringify({ direction: "BULLISH", confidence: value, reasonCode: "TREND",
    rationale: "Trend.", riskFlags: [] });
  const { result, requests } = await run([raw]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "SCHEMA_REJECTED");
  assert.equal(requests.length, 1);
});
for (const raw of ["not-json", JSON.stringify({ direction: "BULLISH", confidence: 0.8 }),
  JSON.stringify({ direction: "NEUTRAL", confidence: 0.8, reasonCode: "TREND", rationale: "x", riskFlags: [] }),
  JSON.stringify({ direction: "BULLISH", confidence: 0.8, reasonCode: "TREND", rationale: "x",
    riskFlags: [], instrumentToken: "FAKE", strike: 24900, quantity: 100 })])
  test(`malformed, missing, unsupported or executable primary output cannot become a candidate: ${raw.slice(0, 24)}`, async () => {
    const { result, requests } = await run([raw]);
    assert.equal(result.action, "HOLD");
    assert.equal(result.evidence.finalProposal.direction, "HOLD");
    assert.equal(requests.length, 1);
  });
for (const [first, last] of [["HOLD", "BULLISH"], ["BULLISH", "HOLD"]] as const)
  test(`duplicate primary direction ${first} then ${last} fails closed`, async () => {
    const raw = `{"direction":"${first}","direction":"${last}","confidence":0.8,"reasonCode":"TREND","rationale":"x","riskFlags":[]}`;
    const { result, requests } = await run([raw]);
    assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "SCHEMA_REJECTED");
    assert.equal(requests.length, 1);
  });
for (const [first, last] of [["DISAGREE", "AGREE"], ["AGREE", "DISAGREE"]] as const)
  test(`duplicate verifier verdict ${first} then ${last} fails closed`, async () => {
    const raw = `{"verdict":"${first}","verdict":"${last}","confidence":0.8,"reasonCode":"CHECKED","rationale":"x","riskFlags":[]}`;
    const { result, requests } = await run([primary(), raw]);
    assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "SCHEMA_REJECTED");
    assert.equal(requests.length, 2);
  });
test("escaped duplicate member names reject while quoted JSON-looking text is harmless", async () => {
  const duplicate = '{"direction":"HOLD","dir\\u0065ction":"BULLISH","confidence":0.8,"reasonCode":"TREND","rationale":"x","riskFlags":[]}';
  const rejected = await run([duplicate]);
  assert.equal(rejected.result.evidence.reason, "SCHEMA_REJECTED");
  const rationale = 'The string "\\"direction\\":\\"HOLD\\"" and \\ path are data.';
  const safe = await run([JSON.stringify({ direction: "BULLISH", confidence: 0.7,
    reasonCode: "TREND", rationale, riskFlags: [] })]);
  assert.equal(safe.result.action, "CANDIDATE");
  assert.equal(safe.result.evidence.primary.status, "COMPLETED");
});
test("duplicate nested JSON keys reject even when outer schema would reject the object", async () => {
  const raw = '{"direction":"BULLISH","confidence":0.8,"reasonCode":"TREND","rationale":"x","riskFlags":[{"flag":"A","flag":"B"}]}';
  const { result } = await run([raw]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "SCHEMA_REJECTED");
});
test("high confidence invokes verifier with the same evidence and primary view", async () => {
  const { result, requests } = await run([primary(), verifier()]);
  assert.equal(requests.length, 2);
  const first = JSON.parse(requests[0]!.userPrompt), second = JSON.parse(requests[1]!.userPrompt);
  assert.equal(first.evidenceId, second.evidenceId);
  assert.equal(first.evaluatedAt, second.evaluatedAt);
  assert.equal(second.primary.direction, "BULLISH");
  assert.equal(result.evidence.verifier.status, "COMPLETED");
});
test("below-threshold proposal skips verifier and still faces Phase 5B confidence gate", async () => {
  const { result, requests } = await run([primary("BULLISH", 0.7)]);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.evidence.verifier, { status: "NOT_RUN", reason: "BELOW_THRESHOLD" });
  assert.equal(result.action, "CANDIDATE");
});
for (const verdict of ["DISAGREE", "HOLD"] as const) test(`verifier ${verdict} vetoes primary`, async () => {
  const { result } = await run([primary(), verifier(verdict)]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "VERIFIER_REJECTED");
  assert.equal(result.evidence.finalProposal.direction, "HOLD");
});
for (const invalid of ["not-json", JSON.stringify({ verdict: "AGREE", confidence: 0.8 }),
  JSON.stringify({ verdict: "AGREE", confidence: 0.8, reasonCode: "OK", rationale: "x",
    riskFlags: [], instrumentToken: "FAKE" })]) test("malformed verifier fails closed", async () => {
  const { result } = await run([primary(), invalid]);
  assert.equal(result.action, "HOLD");
  assert.equal(result.evidence.verifier.status, "FAILED");
});
test("verifier may lower but cannot raise primary confidence", async () => {
  const { result } = await run([primary("BULLISH", 0.8), verifier("AGREE", 0.2)]);
  assert.equal(result.evidence.finalProposal.confidence, 0.2);
  assert.equal(result.action, "HOLD");
  assert.equal(result.evidence.reason, "CONFIDENCE_TOO_LOW");
});
for (const [name, error, reason] of [
  ["timeout", Object.assign(new Error("timeout"), { name: "AbortError" }), "TIMEOUT"],
  ["rate limit", Object.assign(new Error("rate"), { status: 429 }), "RATE_LIMITED"],
  ["unavailable", Object.assign(new Error("offline"), { code: "MODEL_UNAVAILABLE" }), "MODEL_UNAVAILABLE"],
  ["transport", new Error("transport"), "MODEL_UNAVAILABLE"],
] as const) test(`primary ${name} produces HOLD with ${reason}`, async () => {
  const { result } = await run([error]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, reason);
  assert.equal(result.evidence.primary.status, "FAILED");
});
test("empty model content is INVALID_RESPONSE and cannot produce a candidate", async () => {
  const { result } = await run([null]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "INVALID_RESPONSE");
});
for (const [name, error, reason] of [
  ["timeout", Object.assign(new Error("timeout"), { name: "AbortError" }), "TIMEOUT"],
  ["rate limit", Object.assign(new Error("rate"), { status: 429 }), "RATE_LIMITED"],
  ["unavailable", new Error("offline"), "MODEL_UNAVAILABLE"],
] as const) test(`required verifier ${name} fails closed with ${reason}`, async () => {
  const { result } = await run([primary(), error]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, reason);
  assert.equal(result.evidence.verifier.status, "FAILED");
});
test("transport that never resolves is bounded by configured timeout", async () => {
  const { result } = await run([() => new Promise<LLMCompletion>(() => {})]);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "TIMEOUT");
});
for (const [label, changed, reason] of [
  ["ATR", { maxAtrPoints: 0.01 }, "ATR_GATE"],
  ["RSI", { bullishRsiMax: 50 }, "RSI_GATE"],
  ["liquidity", { minDepthUnits: 66 }, "LIQUIDITY_GATE"],
  ["confidence", { minConfidence: 0.9 }, "CONFIDENCE_TOO_LOW"],
] as const) test(`LLM direction cannot bypass ${label} gate`, async () => {
  const { result } = await run([primary(), verifier()], { strategyConfig: { ...quality, ...changed } });
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, reason);
});
test("LLM direction cannot bypass opening block", async () => {
  const input = await mockInput(), early = "2026-09-29T03:50:00.000Z";
  const oldCandles = input.candles.map(c => ({ ...c,
    timestamp: new Date(Date.parse(c.timestamp) - 86_400_000).toISOString() }));
  const analytics = buildMockMarketAnalytics({ ...input, evaluatedAt: early, spotTimestamp: early,
    candles: oldCandles, options: input.options.map(option => ({ ...option, priceTimestamp: early })) });
  const { result } = await run([primary(), verifier()], { analytics, evaluatedAt: early });
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "OPENING_BLOCK");
});
test("missing exact qualified contract rejects despite LLM direction", async () => {
  const { result } = await run([primary(), verifier()], { expiry: "2026-10-13" });
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "NO_QUALIFIED_CONTRACT");
});
test("candidate digest is stable, option ordering is canonical, and changed evidence changes it", async () => {
  const input = await mockInput();
  const a = buildMockMarketAnalytics(input), b = buildMockMarketAnalytics({ ...input, options: [...input.options].reverse() });
  const c = buildMockMarketAnalytics({ ...input, spotMinor: input.spotMinor + 100 });
  assert.equal(a.available, true); assert.equal(b.available, true); assert.equal(c.available, true);
  if (a.available && b.available && c.available) {
    assert.equal(analyticsEvidenceId(a.snapshot), analyticsEvidenceId(a.snapshot));
    assert.equal(analyticsEvidenceId(a.snapshot), analyticsEvidenceId(b.snapshot));
    assert.notEqual(analyticsEvidenceId(a.snapshot), analyticsEvidenceId(c.snapshot));
    assert.match(analyticsEvidenceId(a.snapshot), /^ANALYTICS_SHA256_V1:[a-f0-9]{64}$/);
    assert.throws(() => analyticsEvidenceId({ ...a.snapshot }), /ANALYTICS_UNAVAILABLE/);
  }
});
test("decision evidence retains model, prompt, digest, mode, usage and NOT_RUN verifier", async () => {
  const { result, requests, analytics } = await run([primary("BULLISH", 0.7)]);
  assert.equal(result.evidence.dataMode, "MOCK");
  assert.equal(result.evidence.primaryModel, llm.primaryModel);
  assert.equal(result.evidence.primaryPromptVersion, PRIMARY_PROMPT_VERSION);
  assert.equal(result.evidence.verifierPromptVersion, VERIFIER_PROMPT_VERSION);
  assert.equal(result.evidence.verifier.status, "NOT_RUN");
  assert.equal(result.evidence.analyticsEvidenceId, analytics.available ? analyticsEvidenceId(analytics.snapshot) : null);
  if (result.evidence.primary.status === "COMPLETED") {
    assert.equal(result.evidence.primary.result.model, "gpt-4o-mini-test");
    assert.deepEqual(result.evidence.primary.result.usage, { inputTokens: 75, outputTokens: 25 });
  }
  assert.equal(requests.length, 1);
  assert.ok(Object.isFrozen(result.evidence));
});
test("replacing analytics during primary cannot change economics or the recorded digest", async () => {
  const input = await mockInput(), a = buildMockMarketAnalytics(input);
  const b = buildMockMarketAnalytics({ ...input, options: input.options.map(option =>
    option.instrument.strikeMinor === 2_490_000 ? { ...option, bidMinor: option.bidMinor - 100 } : option) });
  assert.equal(a.available, true); assert.equal(b.available, true);
  if (!a.available || !b.available) return;
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const caller = { analytics: a as typeof a | typeof b, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm };
  const decision = evaluateWithPhase5LLM(caller, fake(() => pending).transport);
  caller.analytics = b;
  resolve(completion(primary("BULLISH", 0.7)));
  const result = await decision;
  const original = evaluateStrategy({ analytics: a, proposal: { direction: "BULLISH", confidence: 0.7,
    expiry: caller.expiry }, config: quality, evaluatedAt: at });
  assert.equal(result.action, "CANDIDATE"); assert.equal(original.action, "CANDIDATE");
  assert.equal(result.evidence.analyticsEvidenceId, analyticsEvidenceId(a.snapshot));
  assert.notEqual(result.evidence.analyticsEvidenceId, analyticsEvidenceId(b.snapshot));
  assert.deepEqual(result.evidence.strategyResult, original);
});
test("mutating a caller-owned analytics wrapper during primary cannot replace its issued snapshot", async () => {
  const input = await mockInput(), a = buildMockMarketAnalytics(input);
  const b = buildMockMarketAnalytics({ ...input, options: input.options.map(option =>
    option.instrument.strikeMinor === 2_490_000 ? { ...option, bidMinor: option.bidMinor - 100 } : option) });
  assert.equal(a.available, true); assert.equal(b.available, true);
  if (!a.available || !b.available) return;
  const mutableAnalytics = { available: true as const, snapshot: a.snapshot };
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const decision = evaluateWithPhase5LLM({ analytics: mutableAnalytics, evaluatedAt: at,
    expiry: "2026-10-06", strategyConfig: quality, llmConfig: llm }, fake(() => pending).transport);
  mutableAnalytics.snapshot = b.snapshot;
  resolve(completion(primary("BULLISH", 0.7)));
  const result = await decision;
  const original = evaluateStrategy({ analytics: a, proposal: { direction: "BULLISH", confidence: 0.7,
    expiry: "2026-10-06" }, config: quality, evaluatedAt: at });
  assert.equal(result.action, "CANDIDATE");
  assert.equal(result.evidence.analyticsEvidenceId, analyticsEvidenceId(a.snapshot));
  assert.deepEqual(result.evidence.strategyResult, original);
});
test("strategy and verifier configuration are captured before the primary await", async () => {
  const strategyConfig = { ...quality }, llmConfig = { ...llm };
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const analytics = buildMockMarketAnalytics(await mockInput()), f = fake(() => pending, verifier());
  const decision = evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig, llmConfig }, f.transport);
  strategyConfig.minConfidence = 0.95;
  llmConfig.verifierConfidenceThreshold = 0.95;
  llmConfig.primaryModel = "changed-model";
  resolve(completion(primary()));
  const result = await decision;
  assert.equal(result.action, "CANDIDATE");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.model, llm.verifierModel);
  assert.equal(result.evidence.primaryModel, llm.primaryModel);
  assert.equal(result.evidence.strategyConfigVersion, quality.version);
});
test("caller collection mutation while verifier waits cannot alter duplicate screening", async () => {
  const analytics = buildMockMarketAnalytics(await mockInput());
  const baseline = evaluateStrategy({ analytics, proposal: { direction: "BULLISH", confidence: 0.8,
    expiry: "2026-10-06" }, config: quality, evaluatedAt: at });
  assert.equal(baseline.action, "CANDIDATE");
  if (baseline.action !== "CANDIDATE") return;
  const priorCandidateKeys: string[] = [];
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const f = fake(primary(), () => pending);
  const decision = evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm, priorCandidateKeys }, f.transport);
  for (let n = 0; n < 4 && f.requests.length < 2; n++) await Promise.resolve();
  assert.equal(f.requests.length, 2);
  priorCandidateKeys.push(baseline.candidate.candidateKey);
  resolve(completion(verifier()));
  const result = await decision;
  assert.equal(result.action, "CANDIDATE");
  assert.deepEqual(result.evidence.strategyResult, baseline);
});
test("prompts contain bounded validated analytics and no instrument token or secrets", async () => {
  const { requests, result } = await run([primary(), verifier()]);
  for (const request of requests) {
    assert.doesNotMatch(request.userPrompt, /instrumentToken|apiKey|accessToken|jwtSecret|mongoUri|OPENAI_API_KEY/);
    assert.doesNotMatch(request.userPrompt, /100010|100011/);
    assert.doesNotMatch(request.userPrompt, /candles\s*:/);
    const content = JSON.parse(request.userPrompt);
    assert.ok(content.optionGreeksSummary.length <= 4);
    assert.equal(content.dataMode, "MOCK");
  }
  assert.doesNotMatch(JSON.stringify(result.evidence), /apiKey|accessToken|jwtSecret|mongoUri/);
});
test("invalid model configuration and forged analytics fail before any model call", async () => {
  const invalid = await run([primary()], { llmConfig: { ...llm, verifierConfidenceThreshold: 2 } });
  assert.equal(invalid.result.action, "HOLD"); assert.equal(invalid.requests.length, 0);
  const legitimate = buildMockMarketAnalytics(await mockInput());
  assert.equal(legitimate.available, true);
  if (legitimate.available) {
    const forged = await run([primary()], { analytics: { available: true, snapshot: { ...legitimate.snapshot } } });
    assert.equal(forged.result.action, "HOLD"); assert.equal(forged.requests.length, 0);
  }
});
test("unavailable KITE_REAL analytics does not call the model or fall back to MOCK", async () => {
  const { result, requests } = await run([primary()],
    { analytics: { available: false, reason: "REAL_DATA_REQUIRED" } });
  assert.equal(result.action, "HOLD");
  assert.equal(result.evidence.strategyResult.action, "HOLD");
  assert.equal(result.evidence.dataMode, null);
  assert.equal(requests.length, 0);
});
test("fixed LLM proposal and issued snapshot produce the same deterministic decision", async () => {
  const analytics = buildMockMarketAnalytics(await mockInput());
  const overrides = { analytics }, a = await run([primary(), verifier()], overrides);
  const b = await run([primary(), verifier()], overrides);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.requests.map(r => [r.systemPrompt, r.userPrompt]),
    b.requests.map(r => [r.systemPrompt, r.userPrompt]));
});

async function realFixture(clock: () => number = () => Date.parse(at)) {
  const optionMaster = await master(), indexMaster = qualifyIndexMaster(csv, at), index = indexMaster.resolve("NIFTY");
  const calls: string[] = [], success = (data: unknown) => ({ status: "success", data });
  const optionMarket = new KiteMarketDataService({ async get(path) {
    calls.push(path); const data: Record<string, unknown> = {};
    for (const token of ["100010", "100011"]) {
      const instrument = optionMaster.getByCurrentInstrumentToken(token), price = prices[token]!;
      data[instrument.contractKey] = { instrument_token: Number(token), last_price: price,
        ohlc: { open: price, high: price + 1, low: price - 1, close: price }, volume: 100, oi: 100,
        timestamp: "2026-09-29 14:00:00", last_trade_time: "2026-09-29 14:00:00",
        depth: { buy: [{ price: price - 1, quantity: 65, orders: 1 }],
          sell: [{ price: price + 1, quantity: 65, orders: 1 }] } };
    }
    return success(data);
  } }, async () => optionMaster, () => "KITE_REAL", clock);
  const indexMarket = new KiteIndexDataService({ async get(path) {
    calls.push(path);
    if (path === "/quote") return success({ [index.contractKey]: { instrument_token: Number(index.instrumentToken),
      last_price: 25000, timestamp: "2026-09-29 14:00:00" } });
    return success({ candles: candles.map(c => [c.timestamp, c.openMinor / 100, c.highMinor / 100,
      c.lowMinor / 100, c.closeMinor / 100, c.volume]) });
  } }, async () => indexMaster, () => "KITE_REAL", clock);
  await optionMarket.refreshMaster(); await indexMarket.refreshMaster();
  const optionQuotes = await optionMarket.getQuotes(["100010", "100011"].map(token =>
    optionMaster.getByCurrentInstrumentToken(token)), 1000);
  const indexQuote = await indexMarket.getQuote(index, 1000);
  const indexHistory = await indexMarket.getHistoricalCandles({ index, interval: "5minute",
    from: candles[0]!.timestamp, to: at });
  const analytics = buildRealMarketAnalytics({ ...assumptions, observedAt: at, index,
    indexQuote, indexHistory, optionQuotes, maxAgeMs: 1000 });
  assert.equal(analytics.available, true);
  return { analytics, calls };
}
test("KITE_REAL evidence stays KITE_REAL through LLM interpretation without broker writes", async () => {
  const { analytics, calls } = await realFixture();
  const { result, requests } = await run([primary(), verifier()], { analytics }, () => Date.parse(at));
  assert.equal(result.evidence.dataMode, "KITE_REAL");
  assert.equal(result.action, "CANDIDATE");
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, ["/quote", "/quote", "/instruments/historical/256265/5minute"]);
});
test("already-stale issued KITE_REAL analytics cannot call the primary model", async () => {
  let now = Date.parse(at);
  const { analytics, calls } = await realFixture(() => now);
  now += 1001;
  const f = fake(primary());
  const result = await evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm }, f.transport, () => now);
  assert.equal(result.action, "HOLD");
  assert.equal(result.evidence.reason, "MARKET_DATA_NOT_FRESH");
  assert.equal(result.evidence.primary.status, "NOT_RUN");
  assert.equal(f.requests.length, 0);
  assert.equal(calls.length, 3);
});
test("KITE_REAL evidence becoming stale during primary stops before verifier", async () => {
  let now = Date.parse(at);
  const { analytics, calls } = await realFixture(() => now);
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const f = fake(() => pending, verifier());
  const decision = evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm }, f.transport, () => now);
  assert.equal(f.requests.length, 1);
  now += 1001;
  resolve(completion(primary()));
  const result = await decision;
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "MARKET_DATA_NOT_FRESH");
  assert.equal(f.requests.length, 1); assert.equal(calls.length, 3);
});
test("KITE_REAL evidence becoming stale during verifier cannot produce a candidate", async () => {
  let now = Date.parse(at);
  const { analytics, calls } = await realFixture(() => now);
  let resolve!: (value: LLMCompletion) => void;
  const pending = new Promise<LLMCompletion>(r => { resolve = r; });
  const f = fake(primary(), () => pending);
  const decision = evaluateWithPhase5LLM({ analytics, evaluatedAt: at, expiry: "2026-10-06",
    strategyConfig: quality, llmConfig: llm }, f.transport, () => now);
  for (let n = 0; n < 4 && f.requests.length < 2; n++) await Promise.resolve();
  assert.equal(f.requests.length, 2);
  now += 1001;
  resolve(completion(verifier()));
  const result = await decision;
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "MARKET_DATA_NOT_FRESH");
  assert.equal(result.evidence.finalProposal.direction, "HOLD"); assert.equal(calls.length, 3);
});
test("KITE_REAL evidence expiring during final evaluation cannot escape as a candidate", async () => {
  const { analytics } = await realFixture();
  let checks = 0;
  const { result, requests } = await run([primary(), verifier()], { analytics }, () => {
    checks++;
    return Date.parse(at) + (checks >= 4 ? 1001 : 0);
  });
  assert.equal(requests.length, 2);
  assert.equal(result.action, "HOLD");
  assert.equal(result.evidence.reason, "MARKET_DATA_NOT_FRESH");
  assert.equal(result.evidence.finalProposal.direction, "HOLD");
});
test("KITE_REAL freshness accepts exactly maxAge and rejects one millisecond beyond", async () => {
  const { analytics } = await realFixture();
  const boundary = await run([primary("BULLISH", 0.7)], { analytics }, () => Date.parse(at) + 1000);
  assert.equal(boundary.result.action, "CANDIDATE");
  assert.equal(boundary.requests.length, 1);
  const stale = await run([primary("BULLISH", 0.7)], { analytics }, () => Date.parse(at) + 1001);
  assert.equal(stale.result.action, "HOLD"); assert.equal(stale.requests.length, 0);
});
test("future KITE_REAL evidence relative to the trusted clock cannot invoke the model", async () => {
  const { analytics } = await realFixture();
  const { result, requests } = await run([primary()], { analytics }, () => Date.parse(at) - 1);
  assert.equal(result.action, "HOLD"); assert.equal(result.evidence.reason, "MARKET_DATA_NOT_FRESH");
  assert.equal(requests.length, 0);
});
test("MOCK replay ignores wall-clock advancement", async () => {
  const analytics = buildMockMarketAnalytics(await mockInput());
  const original = await run([primary("BULLISH", 0.7)], { analytics }, () => Date.parse(at));
  const later = await run([primary("BULLISH", 0.7)], { analytics }, () => Date.parse(at) + 365 * 86_400_000);
  assert.deepEqual(later.result, original.result);
});
