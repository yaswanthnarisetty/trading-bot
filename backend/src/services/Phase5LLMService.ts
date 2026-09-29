import { z } from "zod";
import type { AnalyticsOutcome, MarketAnalyticsSnapshot } from "../domain/marketAnalytics";
import { assertMarketAnalytics, isMarketAnalyticsFresh } from "../domain/marketAnalytics";
import { analyticsEvidenceId } from "../domain/analyticsEvidence";
import { freeze, marketTimestamp } from "../domain/kiteMarketData";
import { evaluateStrategy, type DirectionalProposal, type StrategyEvaluationResult,
  type StrategyQualityConfig, type HoldReason } from "../domain/strategyEvaluation";

export const PRIMARY_PROMPT_VERSION = "PHASE5_PRIMARY_V1";
export const VERIFIER_PROMPT_VERSION = "PHASE5_VERIFIER_V1";
export const DECISION_VERSION = "PHASE5_LLM_DECISION_V1";
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/);
const confidence = z.number().finite().min(0).max(1);
const riskFlags = z.array(code).max(8);
const primarySchema = z.object({ direction: z.enum(["BULLISH", "BEARISH", "HOLD"]),
  confidence, reasonCode: code, rationale: z.string().min(1).max(300), riskFlags }).strict();
const verifierSchema = z.object({ verdict: z.enum(["AGREE", "DISAGREE", "HOLD"]),
  confidence, reasonCode: code, rationale: z.string().min(1).max(300), riskFlags }).strict();
const configSchema = z.object({ primaryModel: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  verifierModel: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  primaryPromptVersion: z.literal(PRIMARY_PROMPT_VERSION),
  verifierPromptVersion: z.literal(VERIFIER_PROMPT_VERSION),
  verifierConfidenceThreshold: confidence, timeoutMs: z.number().int().min(100).max(60_000),
  temperature: z.number().finite().min(0).max(2),
  maxOutputTokens: z.number().int().min(100).max(4096) }).strict();

export type LLMFailure = "MODEL_UNAVAILABLE" | "TIMEOUT" | "RATE_LIMITED" | "INVALID_RESPONSE" | "SCHEMA_REJECTED";
export interface Phase5LLMConfig extends z.infer<typeof configSchema> {}
export interface LLMCompletionRequest {
  readonly stage: "PRIMARY" | "VERIFIER";
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}
export interface LLMCompletion {
  readonly content: string | null;
  readonly model: string;
  readonly usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
  readonly latencyMs?: number;
}
export interface Phase5LLMTransport { complete(request: LLMCompletionRequest): Promise<LLMCompletion> }
type ParsedPrimary = z.infer<typeof primarySchema>;
type ParsedVerifier = z.infer<typeof verifierSchema>;
type Telemetry = Readonly<{ model: string; promptVersion: string;
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>; latencyMs?: number }>;
export type LLMPrimaryResult = Readonly<ParsedPrimary & Telemetry>;
export type LLMVerifierResult = Readonly<ParsedVerifier & Telemetry>;
export type PrimaryEvidence = Readonly<{ status: "COMPLETED"; result: LLMPrimaryResult } |
  { status: "FAILED"; reason: LLMFailure } | { status: "NOT_RUN"; reason: "ANALYTICS_UNAVAILABLE" | "INVALID_INPUT" | "MARKET_DATA_NOT_FRESH" }>;
export type VerifierEvidence = Readonly<{ status: "COMPLETED"; result: LLMVerifierResult } |
  { status: "FAILED"; reason: LLMFailure } |
  { status: "NOT_RUN"; reason: "PRIMARY_HOLD" | "BELOW_THRESHOLD" | "PRIMARY_FAILED" | "ANALYTICS_UNAVAILABLE" }>;
export type Phase5DecisionReason = "CANDIDATE" | "PRIMARY_HOLD" | "VERIFIER_REJECTED"
  | "ANALYTICS_UNAVAILABLE" | LLMFailure | HoldReason;
export interface Phase5DecisionEvidence {
  readonly version: typeof DECISION_VERSION;
  readonly evaluatedAt: string;
  readonly analyticsEvidenceId: string | null;
  readonly dataMode: "KITE_REAL" | "MOCK" | null;
  readonly underlying: string | null;
  readonly primary: PrimaryEvidence;
  readonly verifier: VerifierEvidence;
  readonly finalProposal: DirectionalProposal;
  readonly strategyResult: StrategyEvaluationResult;
  readonly primaryModel: string;
  readonly verifierModel: string;
  readonly primaryPromptVersion: string;
  readonly verifierPromptVersion: string;
  readonly strategyConfigVersion: string;
  readonly reason: Phase5DecisionReason;
}
export type Phase5Decision = Readonly<{ action: "HOLD" | "CANDIDATE"; evidence: Phase5DecisionEvidence }>;
export interface Phase5AnalysisInput {
  readonly analytics: AnalyticsOutcome;
  readonly evaluatedAt: string;
  /** Chosen by the caller from qualified availability, never by the model. */
  readonly expiry: string;
  readonly strategyConfig: StrategyQualityConfig;
  readonly llmConfig: Phase5LLMConfig;
  readonly priorCandidateKeys?: readonly string[];
}

const primarySystem = `NSE index options analyst. Prompt ${PRIMARY_PROMPT_VERSION}.
Interpret only the supplied, precomputed market summary. Its indicator and Greek numbers are authoritative.
Do not compute RSI, EMA, ATR, IV, Greeks, option prices, spreads, or sizing.
Return one directional view: BULLISH, BEARISH, or HOLD. You have no execution authority.
Do not select an executable contract, expiry, strike, token, quantity, account, or order.
Return only JSON with exactly: direction, confidence (0..1), reasonCode, rationale (at most 300 characters), riskFlags (at most 8 short codes).`;
const verifierSystem = `NSE directional signal verifier. Prompt ${VERIFIER_PROMPT_VERSION}.
Use the same authoritative precomputed analytics and the primary view. Assess direction and stated risk only.
Do not calculate indicators, Greeks, prices, spreads, or sizing. Do not choose contracts or orders.
Return only JSON with exactly: verdict (AGREE, DISAGREE, or HOLD), confidence (0..1), reasonCode, rationale (at most 300 characters), riskFlags (at most 8 short codes).
AGREE confirms the primary direction; DISAGREE or HOLD vetoes it. You cannot introduce a new direction.`;

/** Bounded, stable, non-secret summary. Raw candles, option chains and instrument tokens stay local. */
function promptContext(snapshot: MarketAnalyticsSnapshot, expiry: string, evidenceId: string) {
  const options = [...snapshot.options].filter(option => option.instrument.expiry === expiry)
    .sort((a, b) => Math.abs(a.instrument.strikeMinor - snapshot.spotMinor)
      - Math.abs(b.instrument.strikeMinor - snapshot.spotMinor)
      || (a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0))
    .slice(0, 4).map(option => ({ type: option.instrument.instrumentType,
      strikeMinor: option.instrument.strikeMinor,
      greeks: option.greeks.available ? { iv: option.greeks.value.impliedVolatility,
        delta: option.greeks.value.delta, thetaPerDay: option.greeks.value.thetaPerDay }
        : { unavailable: option.greeks.reason } }));
  return { version: "PHASE5_PROMPT_CONTEXT_V1", evidenceId, dataMode: snapshot.dataMode,
    underlying: snapshot.underlying, evaluatedAt: snapshot.evaluatedAt, requestedExpiry: expiry,
    spotMinor: snapshot.spotMinor, spotTimestamp: snapshot.spotTimestamp,
    candleInterval: snapshot.candleInterval, indicatorRange: snapshot.indicators.range,
    indicators: snapshot.indicators.values, optionGreeksSummary: options };
}

function failure(error: unknown): LLMFailure {
  if (!error || typeof error !== "object") return "MODEL_UNAVAILABLE";
  const e = error as { code?: unknown; status?: unknown; name?: unknown };
  if (e.status === 429 || e.code === "RATE_LIMITED") return "RATE_LIMITED";
  if (e.name === "AbortError" || e.name === "TimeoutError" || e.code === "TIMEOUT" || e.code === "ETIMEDOUT") return "TIMEOUT";
  return "MODEL_UNAVAILABLE";
}
/** Scan JSON object keys before JSON.parse discards duplicate members. */
function hasDuplicateMembers(text: string): boolean {
  let at = 0, duplicate = false;
  const space = () => { while (/\s/.test(text[at] ?? "" ) && at < text.length) at++; };
  const quoted = (): string => {
    const start = at++;
    if (text[start] !== '"') throw new SyntaxError("JSON string expected");
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") { at++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, at));
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const value = (): void => {
    space();
    if (text[at] === "{") {
      at++; space();
      const keys = new Set<string>();
      if (text[at] === "}") { at++; return; }
      while (at < text.length) {
        space(); const key = quoted();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        space(); if (text[at++] !== ":") throw new SyntaxError("JSON colon expected");
        value(); space();
        const separator = text[at++];
        if (separator === "}") return;
        if (separator !== ",") throw new SyntaxError("JSON object separator expected");
      }
      throw new SyntaxError("Unterminated JSON object");
    }
    if (text[at] === "[") {
      at++; space();
      if (text[at] === "]") { at++; return; }
      while (at < text.length) {
        value(); space();
        const separator = text[at++];
        if (separator === "]") return;
        if (separator !== ",") throw new SyntaxError("JSON array separator expected");
      }
      throw new SyntaxError("Unterminated JSON array");
    }
    if (text[at] === '"') { quoted(); return; }
    const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!scalar) throw new SyntaxError("JSON value expected");
    at += scalar[0].length;
  };
  value(); space();
  if (at !== text.length) throw new SyntaxError("Trailing JSON content");
  return duplicate;
}
async function complete<T>(transport: Phase5LLMTransport, request: Omit<LLMCompletionRequest, "signal">,
  timeoutMs: number, schema: z.ZodType<T>, promptVersion: string): Promise<Readonly<{ ok: true; value: T & Telemetry } |
  { ok: false; reason: LLMFailure }>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      transport.complete({ ...request, signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject({ code: "TIMEOUT" });
      }, timeoutMs); }),
    ]);
    if (typeof response.content !== "string" || !response.content.trim()) return { ok: false, reason: "INVALID_RESPONSE" };
    let raw: unknown;
    try {
      if (hasDuplicateMembers(response.content)) return { ok: false, reason: "SCHEMA_REJECTED" };
      raw = JSON.parse(response.content);
    }
    catch { return { ok: false, reason: "INVALID_RESPONSE" }; }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || typeof response.model !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(response.model))
      return { ok: false, reason: "SCHEMA_REJECTED" };
    const usage = response.usage && Number.isSafeInteger(response.usage.inputTokens) && response.usage.inputTokens >= 0
      && Number.isSafeInteger(response.usage.outputTokens) && response.usage.outputTokens >= 0
      ? response.usage : undefined;
    const latencyMs = response.latencyMs !== undefined && Number.isFinite(response.latencyMs)
      && response.latencyMs >= 0 ? response.latencyMs : undefined;
    return { ok: true, value: freeze({ ...parsed.data, model: response.model, promptVersion,
      ...(usage ? { usage } : {}), ...(latencyMs === undefined ? {} : { latencyMs }) }) as T & Telemetry };
  } catch (error) { return { ok: false, reason: failure(error) }; }
  finally { if (timer) clearTimeout(timer); }
}

/** LLM interpretation ends at the existing deterministic Phase 5B evaluator. */
export async function evaluateWithPhase5LLM(input: Phase5AnalysisInput,
  transport: Phase5LLMTransport, clock: () => number = Date.now): Promise<Phase5Decision> {
  const analytics = input.analytics;
  const expiry = input.expiry, rawEvaluatedAt = input.evaluatedAt;
  const strategyConfig = input.strategyConfig ? freeze({ ...input.strategyConfig }) : input.strategyConfig;
  const priorCandidateKeys = input.priorCandidateKeys ? freeze([...input.priorCandidateKeys]) : undefined;
  const parsedConfig = configSchema.safeParse(input.llmConfig);
  const c = parsedConfig.success ? freeze(parsedConfig.data) : null;
  const holdProposal: DirectionalProposal = { direction: "HOLD", confidence: 0, expiry };
  let proposal: DirectionalProposal = holdProposal;
  let primary: PrimaryEvidence = { status: "NOT_RUN", reason: "INVALID_INPUT" };
  let verifier: VerifierEvidence = { status: "NOT_RUN", reason: "ANALYTICS_UNAVAILABLE" };
  let reason: Phase5DecisionReason | "PROCEED" = "INVALID_INPUT";
  let snapshot: MarketAnalyticsSnapshot | null = null, evidenceId: string | null = null;
  let capturedAnalytics: AnalyticsOutcome = analytics;
  let evaluatedAt = rawEvaluatedAt;
  const fresh = () => {
    try { return snapshot !== null && isMarketAnalyticsFresh(snapshot, clock()); }
    catch { return false; }
  };
  const finish = (): Phase5Decision => {
    if (proposal.direction !== "HOLD" && snapshot?.dataMode === "KITE_REAL" && !fresh()) {
      proposal = holdProposal;
      reason = "MARKET_DATA_NOT_FRESH";
    }
    let strategyResult = evaluateStrategy({ analytics: capturedAnalytics, proposal,
      config: strategyConfig, evaluatedAt, priorCandidateKeys });
    if (strategyResult.action === "CANDIDATE" && snapshot?.dataMode === "KITE_REAL" && !fresh()) {
      proposal = holdProposal;
      reason = "MARKET_DATA_NOT_FRESH";
      strategyResult = evaluateStrategy({ analytics: capturedAnalytics, proposal, config: strategyConfig,
        evaluatedAt, priorCandidateKeys });
    }
    const decisionReason: Phase5DecisionReason = strategyResult.action === "CANDIDATE" ? "CANDIDATE"
      : reason === "PROCEED" ? strategyResult.reason : reason;
    return freeze({ action: strategyResult.action, evidence: {
      version: DECISION_VERSION, evaluatedAt, analyticsEvidenceId: evidenceId,
      dataMode: snapshot?.dataMode ?? null, underlying: snapshot?.underlying ?? null,
      primary, verifier, finalProposal: proposal, strategyResult,
      primaryModel: c?.primaryModel ?? "", verifierModel: c?.verifierModel ?? "",
      primaryPromptVersion: PRIMARY_PROMPT_VERSION, verifierPromptVersion: VERIFIER_PROMPT_VERSION,
      strategyConfigVersion: strategyConfig?.version ?? "", reason: decisionReason,
    } });
  };
  if (!c || !strategyConfig || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return finish();
  try { evaluatedAt = marketTimestamp(rawEvaluatedAt); }
  catch { return finish(); }
  if (!analytics?.available) {
    primary = { status: "NOT_RUN", reason: "ANALYTICS_UNAVAILABLE" };
    return finish();
  }
  try {
    assertMarketAnalytics(analytics.snapshot);
    if (analytics.snapshot.evaluatedAt !== evaluatedAt) return finish();
    snapshot = analytics.snapshot;
    evidenceId = analyticsEvidenceId(snapshot);
    capturedAnalytics = freeze({ available: true, snapshot });
  } catch { return finish(); }
  if (snapshot.dataMode === "KITE_REAL" && !fresh()) {
    primary = { status: "NOT_RUN", reason: "MARKET_DATA_NOT_FRESH" };
    reason = "MARKET_DATA_NOT_FRESH";
    return finish();
  }
  const context = promptContext(snapshot, expiry, evidenceId);
  const first = await complete(transport, { stage: "PRIMARY", model: c.primaryModel,
    systemPrompt: primarySystem, userPrompt: JSON.stringify(context),
    temperature: c.temperature, maxOutputTokens: c.maxOutputTokens }, c.timeoutMs, primarySchema, c.primaryPromptVersion);
  if (!first.ok) {
    primary = { status: "FAILED", reason: first.reason };
    verifier = { status: "NOT_RUN", reason: "PRIMARY_FAILED" };
    reason = first.reason;
    return finish();
  }
  primary = { status: "COMPLETED", result: first.value };
  proposal = { direction: first.value.direction, confidence: first.value.confidence, expiry };
  if (snapshot.dataMode === "KITE_REAL" && !fresh()) {
    proposal = holdProposal;
    verifier = { status: "NOT_RUN", reason: "ANALYTICS_UNAVAILABLE" };
    reason = "MARKET_DATA_NOT_FRESH";
    return finish();
  }
  if (proposal.direction === "HOLD") {
    verifier = { status: "NOT_RUN", reason: "PRIMARY_HOLD" };
    reason = "PRIMARY_HOLD";
    return finish();
  }
  if (proposal.confidence < c.verifierConfidenceThreshold) {
    verifier = { status: "NOT_RUN", reason: "BELOW_THRESHOLD" };
    reason = "PROCEED";
    return finish();
  }
  const second = await complete(transport, { stage: "VERIFIER", model: c.verifierModel,
    systemPrompt: verifierSystem,
    userPrompt: JSON.stringify({ ...context, primary: {
      direction: first.value.direction, confidence: first.value.confidence,
      reasonCode: first.value.reasonCode, riskFlags: first.value.riskFlags } }),
    temperature: c.temperature, maxOutputTokens: c.maxOutputTokens }, c.timeoutMs, verifierSchema, c.verifierPromptVersion);
  if (!second.ok) {
    verifier = { status: "FAILED", reason: second.reason };
    proposal = holdProposal;
    reason = second.reason;
    return finish();
  }
  verifier = { status: "COMPLETED", result: second.value };
  if (second.value.verdict !== "AGREE") {
    proposal = holdProposal;
    reason = "VERIFIER_REJECTED";
    return finish();
  }
  proposal = { direction: first.value.direction,
    confidence: Math.min(first.value.confidence, second.value.confidence), expiry };
  reason = "PROCEED";
  return finish();
}
