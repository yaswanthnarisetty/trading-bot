import OpenAI from "openai";
import {
  primarySignalSchema,
  verifierResultSchema,
  type PrimarySignal,
  type VerifierResult,
} from "@trading-bot/shared";
import type { PortfolioSummary, NewsSentiment } from "../types/trading";
import type { IndicatorSnapshot, GreeksSnapshot, ExpiryContext } from "@trading-bot/shared";
import {
  LLM_MODEL,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
  LLM_TIMEOUT_MS,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CAP_MORNING,
} from "../config/constants";
import type { SRContext } from "../utils/indicators";
import { logger } from "../utils/logger";
import { PRIMARY_PROMPT_VERSION, VERIFIER_PROMPT_VERSION,
  type Phase5LLMConfig, type Phase5LLMTransport } from "./Phase5LLMService";

const PRIMARY_ANALYST_SYSTEM_PROMPT = `You are a quantitative options trading analyst for Indian equity markets (NSE/BSE).
You specialize in NIFTY, BANKNIFTY, and FINNIFTY weekly options spreads.

You receive pre-computed technical indicators and options Greeks.
You NEVER compute math. You ONLY interpret the pre-computed values given to you.

STRATEGY RULES FOR MVP-1 (follow strictly, no exceptions):
1. Only two strategies are allowed: BULL_PUT_SPREAD or BEAR_CALL_SPREAD
2. If market direction is unclear → output strategy: "HOLD"
3. DTE rules are enforced by a SEPARATE risk system — do NOT recommend HOLD based on DTE alone.
   DTE=0 or DTE=1: you may note theta risk in riskFlags but do NOT force HOLD — decide on direction/IV.
   DTE=2+: ignore DTE entirely in your decision.
   Do NOT include "DTE < 3" as a keyFactor or riskFlag — DTE risk is handled externally.
4. If riskFlags contain "oc_unavailable" → reduce confidence by 0.15, consider HOLD
5. Credit spreads work in any IV environment — do not block based on IV alone

INDICATOR INTERPRETATION REFERENCE:
- RSI > 70: overbought pressure | RSI < 30: oversold pressure | 45-60: mild bullish
- emaAlignment "bullish" (ema20 > ema50): uptrend structure → favor BULL_PUT_SPREAD
- emaAlignment "bearish" (ema20 < ema50): downtrend structure → favor BEAR_CALL_SPREAD
- volumeRatio > 1.5: strong confirmation of move
- regime "trending": higher conviction on directional spreads
- regime "ranging": lower confidence, consider HOLD
- regime "volatile": reduce confidence by 0.1
- pcr > 1.2: put-heavy, market expects fall → favor BEAR_CALL_SPREAD
- pcr < 0.8: call-heavy, market expects rise → favor BULL_PUT_SPREAD
- ivRank > 70: premium is expensive, selling is attractive (good for spreads)
- ivRank < 30: premium is cheap, selling is less attractive but still valid
- expectedMoveUp/Down: if expected move is very large, widen your mental stops

Output ONLY valid JSON matching this exact schema. No markdown. No explanation outside JSON.

SUPPORT & RESISTANCE GUIDANCE:
Use S/R levels (when provided in SR_CONTEXT) for strike selection guidance.
Avoid recommending selling calls near resistance — a nearby resistance cap limits upside.
Avoid recommending selling puts near support — a nearby support floor limits downside.
A wide S/R range (rangeWidth > 300pts) signals room for the spread to expire worthless.
If isNearKeyLevel is true, lower your confidence — spot is too close to a pivot point.

{
  "direction": "BULLISH" or "BEARISH" or "NEUTRAL" or "HOLD",
  "strategy": "BULL_PUT_SPREAD" or "BEAR_CALL_SPREAD" or "HOLD",
  "strikeSelection": {
    "rationale": "why this strike — max 300 characters, must be under 300 characters",
    "preferredDelta": number between 0.15 and 0.45 — MUST be a number like 0.3, never null or omitted,
    "preferredDTE": number between 3 and 30 — MUST be a number like 7, never null or omitted
  },
  "ivContext": "selling_cheap" or "selling_fair" or "selling_expensive",
  "confidence": number between 0.10 and 1.0 — minimum is 0.10, never output 0.0 — even for HOLD use 0.10,
  "reasoning": "max 150 words plain English explanation",
  "keyFactors": ["factor1", "factor2", "factor3"],
  "riskFlags": ["flag1", "flag2"],
  "suggestedEntry": number or null,
  "suggestedSL": number or null,
  "suggestedTarget": number or null
}`;

const VERIFIER_SYSTEM_PROMPT = `You are a signal quality auditor for an Indian options trading system.
You receive a primary analyst signal and the context it was based on.
Your ONLY job is to evaluate signal quality — direction, confidence, and strategy fit.

CRITICAL ARCHITECTURE RULE:
DTE rules, time-of-day rules, and expiry restrictions are handled by a SEPARATE risk system.
Do NOT make HOLD decisions based on DTE or time.
Do NOT override a signal purely because DTE is low (1, 2, or 3).
Never output adjustedStrategy: "HOLD" based on DTE alone.

Evaluate ONLY these quality dimensions:
1. Does the direction (BULLISH/BEARISH) match the emaAlignment and RSI context?
   If not → overrule, flag "direction_mismatch"
2. Is the confidence level justified for this market regime?
   volatile regime → cap at 0.75
   ranging regime → cap at 0.65
   trending regime → allow up to 0.95
3. Is the strategy (BULL_PUT_SPREAD vs BEAR_CALL_SPREAD) correct for the direction?
   BULLISH direction → BULL_PUT_SPREAD
   BEARISH direction → BEAR_CALL_SPREAD
   If mismatch → overrule, flag "strategy_mismatch"
4. Are there obvious missing risk flags from the indicators?

If signal quality is sound → verified: true, overruled: false, same adjustedStrategy
If signal has quality issues → verified: false, overruled: true, corrected adjustedStrategy

OUTPUT RULES (follow exactly):
- adjustedConfidence must be between 0.10 and 1.0, never 0.0 — minimum is 0.10 even for HOLD
- auditNotes must be under 500 characters — plain English, concise
- Output ONLY valid JSON. No markdown. No explanation outside JSON.

{
  "verified": boolean,
  "adjustedStrategy": "BULL_PUT_SPREAD" or "BEAR_CALL_SPREAD" or "HOLD",
  "adjustedConfidence": number between 0.10 and 1.0,
  "auditNotes": "plain English quality audit, under 500 characters",
  "overruled": boolean,
  "additionalRiskFlags": ["flag1"]
}`;

let openaiClient: OpenAI | null = null;

/**
 * Lazily constructs or returns a cached OpenAI client when an API key is available.
 * This avoids crashing the process at startup when OPENAI_API_KEY is missing.
 *
 * @returns An OpenAI client instance or null if no API key is configured.
 */
function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Sanitizes raw LLM JSON output before Zod validation.
 * Truncates string fields that exceed schema limits and applies a confidence
 * floor so that neither primary analyst nor verifier can output 0.0 confidence.
 * This prevents Zod parse failures caused by over-length LLM strings.
 *
 * Mutates and returns the same object — only call on freshly parsed JSON.
 *
 * @param raw - The parsed but unvalidated LLM JSON output.
 * @returns The same object with truncated strings and floored confidence.
 */
function sanitizeLLMResponse(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;

  // Truncate strikeSelection.rationale (primary analyst only)
  const strike = obj.strikeSelection;
  if (typeof strike === "object" && strike !== null) {
    const s = strike as Record<string, unknown>;
    if (typeof s.rationale === "string" && s.rationale.length > 300) {
      s.rationale = s.rationale.slice(0, 300);
    }
  }

  // Truncate reasoning (primary analyst)
  if (typeof obj.reasoning === "string" && obj.reasoning.length > 500) {
    obj.reasoning = obj.reasoning.slice(0, 500);
  }

  // Truncate auditNotes (verifier)
  if (typeof obj.auditNotes === "string" && obj.auditNotes.length > 500) {
    obj.auditNotes = obj.auditNotes.slice(0, 500);
  }

  // Apply confidence floor before Zod parses it (primary analyst field)
  if (typeof obj.confidence === "number") {
    obj.confidence = Math.max(obj.confidence, CONFIDENCE_FLOOR);
  }

  // Apply confidence floor before Zod parses it (verifier field)
  if (typeof obj.adjustedConfidence === "number") {
    obj.adjustedConfidence = Math.max(obj.adjustedConfidence, CONFIDENCE_FLOOR);
  }

  return obj;
}

interface PrimaryAnalystContext {
  sessionId: string;
  asset: string;
  indicators: IndicatorSnapshot;
  greeks: GreeksSnapshot | null;
  expiryContext: ExpiryContext;
  newsSentiment: NewsSentiment;
  portfolio: PortfolioSummary;
  recentSignals: Array<{
    direction: PrimarySignal["direction"];
    strategy: PrimarySignal["strategy"];
    confidence: number;
    timestamp: string;
  }>;
  riskFlags: string[];
  /** S/R context for the current tick. Optional — omitted when not available. */
  srContext?: SRContext;
}

interface VerifierContext {
  indicators: IndicatorSnapshot;
  greeks: GreeksSnapshot | null;
  expiryContext: ExpiryContext;
  newsSentiment: NewsSentiment;
  portfolio: PortfolioSummary;
  riskFlags: string[];
}

/**
 * Calls the OpenAI chat completion API with a timeout guard.
 * This helper ensures that long-running LLM calls do not block the tick loop indefinitely.
 *
 * @param payload - Arguments to pass into the chat.completions.create call.
 * @returns The raw string content of the first choice, or null on timeout/failure.
 */
async function callOpenAIWithTimeout(payload: {
  systemPrompt: string;
  userContent: string;
}): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) {
    logger.warn("OPENAI_API_KEY not configured, skipping LLM call");
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const completion = await client.chat.completions.create(
      {
        model: LLM_MODEL,
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        messages: [
          { role: "system", content: payload.systemPrompt },
          { role: "user", content: payload.userContent },
        ],
      },
      { signal: controller.signal }
    );

    const content = completion.choices[0]?.message?.content ?? null;
    return content;
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: number }).status;
    logger.error("OpenAI API error", {
      message,
      status,
      type: isAbort ? "timeout_abort" : "api_error",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a safe HOLD signal used when LLM calls fail or parsing is impossible.
 * This function guarantees schema compliance and encodes the failure mode in risk flags.
 *
 * @param baseFlags - Risk flags explaining why the HOLD signal was generated.
 * @returns A PrimarySignal object representing a conservative HOLD decision.
 */
function buildHoldSignal(baseFlags: string[]): PrimarySignal {
  return primarySignalSchema.parse({
    direction: "HOLD",
    strategy: "HOLD",
    strikeSelection: {
      rationale: "LLM unavailable or output invalid; holding to avoid unsafe trades.",
      preferredDelta: 0.25,
      preferredDTE: 7,
    },
    ivContext: "selling_fair",
    confidence: CONFIDENCE_FLOOR,
    reasoning:
      "Signal generation failed or produced invalid output, so the system is defaulting to HOLD for safety.",
    keyFactors: ["llm_failure", "safety_hold"],
    riskFlags: baseFlags,
    suggestedEntry: null,
    suggestedSL: null,
    suggestedTarget: null,
  });
}

/**
 * Calls the primary analyst LLM to generate a trading signal.
 * The LLM only receives pre-computed indicators, Greeks, expiry, sentiment, and portfolio context.
 *
 * @param payload - Deterministic context for the analyst (no raw OHLCV data).
 * @returns A PrimarySignal validated against the shared Zod schema.
 */
export async function callPrimaryAnalyst(
  payload: PrimaryAnalystContext
): Promise<PrimarySignal> {
  try {
    // Build warmup status so LLM knows which indicators are not yet reliable
    const ind = payload.indicators;
    const candleCount = ind.candleCount ?? 0;
    const warmupNotes: string[] = [];
    if (ind.atr === null) warmupNotes.push(`ATR: warming up (need 14 candles, have ${candleCount})`);
    if (ind.ema20 === null) warmupNotes.push(`EMA20: warming up (need 20 candles, have ${candleCount})`);
    if (ind.ema50 === null) warmupNotes.push(`EMA50: warming up (need 50 candles, have ${candleCount})`);

    const userContent = JSON.stringify({
      sessionId: payload.sessionId,
      asset: payload.asset,
      indicators: payload.indicators,
      greeks: payload.greeks,
      expiryContext: payload.expiryContext,
      newsSentiment: payload.newsSentiment,
      portfolio: payload.portfolio,
      recentSignals: payload.recentSignals,
      riskFlags: payload.riskFlags,
      warmupStatus: warmupNotes.length > 0
        ? { ready: false, notes: warmupNotes }
        : { ready: true, notes: [] },
      SR_CONTEXT: payload.srContext
        ? {
            previousDayHigh:     payload.srContext.pdHigh,
            previousDayLow:      payload.srContext.pdLow,
            nearestResistance:   payload.srContext.nearestResistance,
            nearestSupport:      payload.srContext.nearestSupport,
            maxCallOIStrike:     payload.srContext.maxCallOIStrike,
            maxPutOIStrike:      payload.srContext.maxPutOIStrike,
            spotToResistance:    payload.srContext.spotToResistance,
            spotToSupport:       payload.srContext.spotToSupport,
            rangeWidth:          payload.srContext.rangeWidth,
            isNearKeyLevel:      payload.srContext.isNearKeyLevel,
          }
        : null,
    });

    const raw = await callOpenAIWithTimeout({
      systemPrompt: PRIMARY_ANALYST_SYSTEM_PROMPT,
      userContent,
    });

    if (!raw) {
      return buildHoldSignal(["llm_timeout"]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.error("Primary analyst JSON parse failed", {
        error,
        raw,
      });
      return buildHoldSignal(["parsing_error"]);
    }

    logger.debug("Primary analyst raw LLM output", { raw });

    // Sanitize before Zod: truncate over-length strings, apply confidence floor.
    // sanitizeLLMResponse mutates and returns the parsed object in-place.
    const signal = primarySignalSchema.parse(sanitizeLLMResponse(parsed));

    // Post-parse floor as belt-and-suspenders (sanitizeLLMResponse already applied it pre-parse)
    signal.confidence = Math.max(signal.confidence, CONFIDENCE_FLOOR);

    // Apply fallbacks for nullable fields the LLM sometimes omits or nulls out
    signal.strikeSelection.preferredDelta ??= 0.3;
    signal.strikeSelection.preferredDTE ??= 7;

    // Apply confidence caps based on context, then enforce floor
    const dte = payload.expiryContext.currentDTE;
    const marketOpenIST = new Date();
    // Approximate minutes since 09:15 IST using UTC+5:30 offset
    const istHour = (marketOpenIST.getUTCHours() + 5) % 24 + Math.floor((marketOpenIST.getUTCMinutes() + 30) / 60);
    const istMin = (marketOpenIST.getUTCMinutes() + 30) % 60;
    const minutesSinceOpen = (istHour - 9) * 60 + (istMin - 15);

    if (minutesSinceOpen >= 0 && minutesSinceOpen < 60) {
      signal.confidence = Math.min(signal.confidence, CONFIDENCE_CAP_MORNING);
    }
    signal.confidence = Math.max(signal.confidence, CONFIDENCE_FLOOR);

    return signal;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Primary analyst call failed", {
      message,
      // ZodError surfaces as message — log raw LLM output to diagnose schema mismatches
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    return buildHoldSignal(["api_error"]);
  }
}

/**
 * Calls the verifier LLM to audit and potentially adjust a primary signal.
 * On any failure, the system falls back to trusting the primary signal as-is.
 *
 * @param primarySignal - The already validated primary LLM signal.
 * @param context - Supporting non-price context used for the audit.
 * @returns A VerifierResult validated or a safe pass-through fallback.
 */
export async function callVerifier(
  primarySignal: PrimarySignal,
  context: VerifierContext
): Promise<VerifierResult> {
  try {
    const userContent = JSON.stringify({
      signal: primarySignal,
      context,
    });

    const raw = await callOpenAIWithTimeout({
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userContent,
    });

    if (!raw) {
      return verifierResultSchema.parse({
        verified: true,
        adjustedStrategy: primarySignal.strategy === "HOLD"
          ? "HOLD"
          : primarySignal.strategy,
        adjustedConfidence: Math.max(primarySignal.confidence, CONFIDENCE_FLOOR),
        auditNotes: "Verifier timeout or failure; trusting primary signal for MVP-1.",
        overruled: false,
        additionalRiskFlags: [],
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.error("Verifier JSON parse failed", { error, raw });
      return verifierResultSchema.parse({
        verified: true,
        adjustedStrategy: primarySignal.strategy === "HOLD"
          ? "HOLD"
          : primarySignal.strategy,
        adjustedConfidence: Math.max(primarySignal.confidence, CONFIDENCE_FLOOR),
        auditNotes: "Verifier parsing error; trusting primary signal.",
        overruled: false,
        additionalRiskFlags: ["verifier_parsing_error"],
      });
    }

    const result = verifierResultSchema.parse(sanitizeLLMResponse(parsed));

    // Floor only — no multipliers. LLM sets the adjusted confidence; we only ensure it never goes below minimum.
    result.adjustedConfidence = Math.max(result.adjustedConfidence, CONFIDENCE_FLOOR);

    return result;
  } catch (error) {
    logger.error("Verifier call failed", { error });
    return verifierResultSchema.parse({
      verified: true,
      adjustedStrategy: primarySignal.strategy === "HOLD"
        ? "HOLD"
        : primarySignal.strategy,
      adjustedConfidence: Math.max(primarySignal.confidence, CONFIDENCE_FLOOR),
      auditNotes: "Verifier API error; defaulting to primary signal.",
      overruled: false,
      additionalRiskFlags: ["verifier_api_error"],
    });
  }
}

/**
 * Determines whether the verifier should be invoked for a new signal.
 * Verifier runs when confidence is low or the strategy has changed from the last tick.
 *
 * @param signal - The freshly generated primary signal.
 * @param lastSignal - The last successful primary signal for the session, if any.
 * @returns True when verifier should be triggered, false to skip.
 */
export function shouldRunVerifier(
  signal: PrimarySignal,
  lastSignal: PrimarySignal | null | undefined
): boolean {
  if (!lastSignal) {
    return true;
  }
  if (signal.confidence < 0.75) {
    return true;
  }
  if (signal.strategy !== lastSignal.strategy) {
    return true;
  }
  return false;
}

/** Phase 5C keeps the deployed model setting while using a separate, strict analyst boundary. */
export function phase5LegacyCompatibleConfig(): Phase5LLMConfig {
  return { primaryModel: LLM_MODEL, verifierModel: LLM_MODEL,
    primaryPromptVersion: PRIMARY_PROMPT_VERSION, verifierPromptVersion: VERIFIER_PROMPT_VERSION,
    verifierConfidenceThreshold: 0.75, timeoutMs: LLM_TIMEOUT_MS,
    temperature: LLM_TEMPERATURE, maxOutputTokens: LLM_MAX_TOKENS };
}

/** Injected adapter around the existing lazy OpenAI client; never used by legacy SignalLoop. */
export function phase5OpenAITransport(): Phase5LLMTransport {
  return { async complete(request) {
    const client = getOpenAIClient();
    if (!client) throw { code: "MODEL_UNAVAILABLE" };
    const started = performance.now();
    const completion = await client.chat.completions.create({
      model: request.model, temperature: request.temperature, max_tokens: request.maxOutputTokens,
      messages: [{ role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt }],
    }, { signal: request.signal });
    return { content: completion.choices[0]?.message?.content ?? null, model: completion.model,
      latencyMs: performance.now() - started,
      ...(completion.usage ? { usage: { inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens } } : {}) };
  } };
}
