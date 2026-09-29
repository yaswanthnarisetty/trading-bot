import { createHash } from "node:crypto";
import { z } from "zod";
import type { AssetKey } from "../config/assets";
import { assertQualifiedInstrument, type InstrumentDefinition, type KiteInstrumentMaster } from "../services/KiteInstrumentMasterService";
import { assertQualifiedIndex, type QualifiedIndex } from "../services/KiteIndexDataService";
import { freeze, marketTimestamp } from "./kiteMarketData";
import { computeValidatedIndicators, type AnalyticsCandle } from "./validatedIndicators";
import { buildMockMarketAnalytics, type AnalyticsOutcome } from "./marketAnalytics";
import { analyticsEvidenceId } from "./analyticsEvidence";
import { evaluateStrategy, validStrategyQualityConfig, type StrategyQualityConfig,
  type DirectionalProposal } from "./strategyEvaluation";

export const REPLAY_VERSION = "NSE_HISTORICAL_REPLAY_V1";
export const PROPOSAL_VERSION = "EMA_ALIGNMENT_V1";
export const intervalMinutes = { minute: 1, "3minute": 3, "5minute": 5, "10minute": 10,
  "15minute": 15, "30minute": 30, "60minute": 60 } as const;
export type ReplayInterval = keyof typeof intervalMinutes;
export class BacktestError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const rejectReplay = (code: string): never => { throw new BacktestError(code); };
const timestamp = z.string().transform((value, ctx) => {
  try { return marketTimestamp(value); } catch { ctx.addIssue({ code: "custom", message: "Explicit timezone required" }); return z.NEVER; }
});
const hundredths = (value: number) => Number.isSafeInteger(Math.round(value * 100))
  && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
const qualityKeys = new Set(["version", "minConfidence", "maxAtrPoints", "minVolumeRatio", "bullishRsiMax",
  "bearishRsiMin", "openingBlockMinutes", "minDteDays", "strikeStepMinor", "widthMinor", "shortOffsetMinor",
  "minDepthUnits", "maxBidAskSpreadMinor", "minCreditMinor"]);
const requestSchema = z.object({
  asset: z.enum(["NIFTY", "BANKNIFTY", "FINNIFTY"]), from: timestamp, to: timestamp,
  interval: z.enum(["minute", "3minute", "5minute", "10minute", "15minute", "30minute", "60minute"]).default("5minute"),
  initialCapital: z.number().finite().min(1).max(1_000_000_000).refine(hundredths).default(200_000),
  riskPerTradePct: z.number().finite().min(0.01).max(10).refine(hundredths).default(4),
  targetProfitPct: z.number().finite().min(0.01).max(1).refine(hundredths).default(0.5),
  stopLossPct: z.number().finite().min(0.01).max(1).refine(hundredths).default(0.5),
  maxHoldingBars: z.number().int().min(1).max(500).default(12),
  maxPositions: z.number().int().min(1).max(10).default(3),
  maxDailyTrades: z.number().int().min(1).max(100).default(3),
  entryCutoffMinute: z.number().int().min(570).max(920).default(900),
  eodCloseMinute: z.number().int().min(570).max(930).default(925),
  slippageMinorPerLeg: z.number().int().min(0).max(1000).default(150),
  directionalStopMult: z.number().finite().min(0.1).max(10).nullable().default(null),
  directionalStopMinBars: z.number().int().min(0).max(500).default(0),
  strategyConfig: z.custom<StrategyQualityConfig>(v => !!v && validStrategyQualityConfig(v as StrategyQualityConfig)
    && Object.keys(v).every(key => qualityKeys.has(key))).optional(),
}).strict().refine(v => Date.parse(v.from) < Date.parse(v.to)
  && Date.parse(v.to) - Date.parse(v.from) <= 90 * 86_400_000
  && v.entryCutoffMinute <= v.eodCloseMinute);
export type BacktestRunParams = z.input<typeof requestSchema>;
export type ReplayConfig = Omit<z.output<typeof requestSchema>, "strategyConfig"> & { strategyConfig: StrategyQualityConfig };
export function normalizeBacktestParams(input: unknown): ReplayConfig {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new BacktestError("INVALID_BACKTEST_CONFIG");
  const p = parsed.data;
  const width = p.asset === "BANKNIFTY" ? 20000 : p.asset === "FINNIFTY" ? 5000 : 10000;
  return freeze({ ...p, strategyConfig: { ...(p.strategyConfig ?? {
    version: "BACKTEST_QUALITY_V1", minConfidence: 0.65, maxAtrPoints: 70, minVolumeRatio: 0,
    bullishRsiMax: 70, bearishRsiMin: 30, openingBlockMinutes: 15, minDteDays: 3,
    strikeStepMinor: p.asset === "BANKNIFTY" ? 10000 : 5000, widthMinor: width,
    shortOffsetMinor: width, minDepthUnits: 1, maxBidAskSpreadMinor: 1000, minCreditMinor: 2500,
  }) } });
}
export function istSession(time: number) {
  const date = new Date(time + 19_800_000);
  return { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay(),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}
/** Trusted provider only; no HTTP request accepts an archive, token, URL or filesystem path. */
export interface HistoricalReplayDataset {
  readonly version: "HISTORICAL_DATASET_V1";
  readonly source: "FIXTURE" | "KITE_ARCHIVE";
  readonly sourceReference: string;
  readonly dataVersion: string;
  readonly asset: AssetKey;
  readonly interval: ReplayInterval;
  /** An explicitly archived snapshot, imported with its ORIGINAL acquisition time. Never today's master. */
  readonly master: KiteInstrumentMaster;
  readonly index: QualifiedIndex;
  readonly candles: readonly AnalyticsCandle[];
  readonly optionQuotes: readonly HistoricalOptionQuote[];
  readonly riskFreeRate: number;
  readonly riskFreeRateVersion: string;
  /** Trusted archive coverage, independent of the candles returned. Expected starts omit documented non-trading periods. */
  readonly coverage: HistoricalReplayCoverage;
}
export interface HistoricalReplayCoverage {
  readonly version: "HISTORICAL_COVERAGE_V1";
  readonly coveredFrom: string;
  readonly coveredTo: string;
  readonly expectedCandleStarts: readonly string[];
  /** The archived master represents the complete qualified option universe for its snapshot. */
  readonly optionUniverseComplete: boolean;
}
export interface HistoricalOptionQuote {
  readonly timestamp: string;
  readonly availableAt: string;
  readonly canonicalId: string;
  readonly instrumentToken: string;
  readonly masterFingerprint: string;
  readonly bidMinor: number;
  readonly askMinor: number;
  readonly bidQuantity: number;
  readonly askQuantity: number;
  readonly lastPriceMinor: number;
}
export interface HistoricalReplayProvider {
  load(request: Readonly<{ asset: AssetKey; from: string; to: string; interval: ReplayInterval }>): Promise<HistoricalReplayDataset>;
}
export interface PreparedReplay {
  readonly data: HistoricalReplayDataset;
  readonly fingerprint: string;
  readonly durationMs: number;
  readonly quotesAt: (at: string) => readonly HistoricalOptionQuote[];
  readonly missingCandleCoverage: number;
  readonly truncatedCoverage: boolean;
  readonly expectedBarIndex: (at: string) => number;
  readonly earliestKnownExpiry: (at: string) => string | undefined;
  readonly qualifiedOption: (expiry: string, strikeMinor: number, type: "CE" | "PE") => InstrumentDefinition | undefined;
}
const id = (value: string) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
export function prepareReplay(input: HistoricalReplayDataset, config: ReplayConfig): PreparedReplay {
  if (!input || input.version !== "HISTORICAL_DATASET_V1" || !["FIXTURE", "KITE_ARCHIVE"].includes(input.source)
    || input.asset !== config.asset || input.interval !== config.interval || !id(input.dataVersion)
    || typeof input.sourceReference !== "string" || !input.sourceReference.trim() || input.sourceReference.length > 500
    || !Number.isFinite(input.riskFreeRate) || Math.abs(input.riskFreeRate) >= 1 || !id(input.riskFreeRateVersion)
    || !Array.isArray(input.candles) || !input.candles.length || input.candles.length > 5000
    || !Array.isArray(input.optionQuotes) || input.optionQuotes.length > 100000) rejectReplay("INVALID_HISTORICAL_DATASET");
  const durationMs = intervalMinutes[input.interval] * 60_000;
  const candles = input.candles.map(c => ({ ...c, timestamp: marketTimestamp(c.timestamp) }));
  const validation = computeValidatedIndicators({ candles, interval: input.interval,
    evaluatedAt: new Date(Math.max(...candles.map(c => Date.parse(c.timestamp))) + durationMs).toISOString() });
  if (!validation.available && validation.reason !== "INSUFFICIENT_HISTORY") rejectReplay(validation.reason);
  for (const candle of candles) {
    const time = Date.parse(candle.timestamp), session = istSession(time);
    if (session.weekday === 0 || session.weekday === 6 || session.minute < 555
      || session.minute + durationMs / 60000 > 930 || time % 60000 !== 0
      || (session.minute - 555) % intervalMinutes[input.interval] !== 0) rejectReplay("CANDLE_OUTSIDE_NSE_SESSION");
  }
  const coverage = input.coverage;
  if (!coverage || coverage.version !== "HISTORICAL_COVERAGE_V1"
    || typeof coverage.optionUniverseComplete !== "boolean"
    || !Array.isArray(coverage.expectedCandleStarts) || coverage.expectedCandleStarts.length > 5000)
    rejectReplay("HISTORICAL_COVERAGE_REQUIRED");
  const coveredFrom = Date.parse(marketTimestamp(coverage.coveredFrom));
  const coveredTo = Date.parse(marketTimestamp(coverage.coveredTo));
  if (coveredFrom >= coveredTo || coveredFrom > Date.parse(candles[0]!.timestamp)
    || coveredTo < Date.parse(candles[candles.length - 1]!.timestamp) + durationMs)
    rejectReplay("INVALID_HISTORICAL_COVERAGE");
  const expected = new Map<string, number>();
  let previousExpected = -Infinity;
  for (const raw of coverage.expectedCandleStarts) {
    const start = marketTimestamp(raw), time = Date.parse(start), session = istSession(time);
    if (start !== raw || time <= previousExpected || time < coveredFrom || time + durationMs > coveredTo
      || time % 60000 !== 0 || session.weekday === 0 || session.weekday === 6
      || session.minute < 555 || session.minute + durationMs / 60000 > 930
      || (session.minute - 555) % intervalMinutes[input.interval] !== 0)
      rejectReplay("INVALID_HISTORICAL_COVERAGE");
    expected.set(start, expected.size);
    previousExpected = time;
  }
  const observed = new Set(candles.map(c => c.timestamp));
  if (candles.some(c => !expected.has(c.timestamp))) rejectReplay("UNDECLARED_HISTORICAL_CANDLE");
  const missingCandleCoverage = [...expected.keys()].filter(start => {
    const end = Date.parse(start) + durationMs;
    return end <= Date.parse(config.to) && !observed.has(start);
  }).length;
  const truncatedCoverage = coveredFrom > Date.parse(config.from) || coveredTo < Date.parse(config.to);
  if (!input.master || input.master.instruments.length > 10000) rejectReplay("HISTORICAL_MASTER_REQUIRED");
  assertQualifiedIndex(input.index);
  const acquired = Date.parse(marketTimestamp(input.master.provenance.retrievedAt));
  if (input.index.underlying !== config.asset || input.index.provenance.sourceFingerprint !== input.master.provenance.sourceFingerprint
    || Date.parse(input.index.provenance.retrievedAt) > Date.parse(candles[0]!.timestamp)
    || acquired > Date.parse(candles[0]!.timestamp)) rejectReplay("HISTORICAL_MASTER_NOT_KNOWN");
  const knownOptions = new Map<string, InstrumentDefinition>();
  for (const instrument of input.master.instruments) {
    assertQualifiedInstrument(instrument);
    if (instrument.provenance.sourceFingerprint !== input.master.provenance.sourceFingerprint
      || instrument.provenance.retrievedAt !== input.master.provenance.retrievedAt) rejectReplay("MIXED_HISTORICAL_MASTER");
    if (instrument.underlying === config.asset)
      knownOptions.set(`${instrument.expiry}:${instrument.strikeMinor}:${instrument.instrumentType}`, instrument);
  }
  const knownExpiries = input.master.listExpiries(config.asset);
  const byTime = new Map<string, HistoricalOptionQuote[]>(), unique = new Set<string>();
  const optionQuotes = input.optionQuotes.map(raw => {
    const quote = { ...raw, timestamp: marketTimestamp(raw.timestamp), availableAt: marketTimestamp(raw.availableAt) };
    const i = input.master.getInstrumentByCanonicalId(quote.canonicalId);
    assertQualifiedInstrument(i);
    if (i.canonicalId !== quote.canonicalId || i.underlying !== config.asset || quote.instrumentToken !== i.instrumentToken
      || i.provenance.sourceFingerprint !== input.master.provenance.sourceFingerprint
      || quote.masterFingerprint !== i.provenance.sourceFingerprint || acquired > Date.parse(quote.timestamp)
      || Date.parse(quote.availableAt) < Date.parse(quote.timestamp)
      || istSession(Date.parse(quote.timestamp)).date > i.expiry
      || ![quote.bidMinor, quote.askMinor, quote.lastPriceMinor].every(n => Number.isSafeInteger(n) && n > 0)
      || quote.bidMinor > quote.askMinor
      || ![quote.bidQuantity, quote.askQuantity].every(n => Number.isSafeInteger(n) && n >= 0)) rejectReplay("INVALID_HISTORICAL_OPTION_EVIDENCE");
    const key = `${quote.timestamp}:${quote.canonicalId}`;
    if (unique.has(key)) rejectReplay("DUPLICATE_HISTORICAL_OPTION_EVIDENCE");
    unique.add(key);
    const group = byTime.get(quote.timestamp) ?? [];
    group.push(quote); if (group.length > 64) rejectReplay("HISTORICAL_OPTION_LIMIT");
    byTime.set(quote.timestamp, group);
    return quote;
  }).sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1
    : a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0);
  const data = freeze({ ...input, candles, optionQuotes });
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: data.version, source: data.source,
    sourceReference: data.sourceReference, dataVersion: data.dataVersion, asset: data.asset, interval: data.interval,
    master: data.master.provenance, index: data.index, coverage: data.coverage,
    candles, optionQuotes, rate: data.riskFreeRate, rateVersion: data.riskFreeRateVersion })).digest("hex");
  return Object.freeze({ data, fingerprint, durationMs,
    missingCandleCoverage, truncatedCoverage,
    expectedBarIndex: (at: string) => {
      const start = new Date(Date.parse(at) - durationMs).toISOString();
      const index = expected.get(start);
      if (index === undefined) return rejectReplay("UNDECLARED_HISTORICAL_CANDLE");
      return index;
    },
    earliestKnownExpiry: (at: string) => knownExpiries.find(d => Date.parse(`${d}T10:00:00.000Z`) > Date.parse(at)),
    qualifiedOption: (expiry: string, strikeMinor: number, type: "CE" | "PE") =>
      knownOptions.get(`${expiry}:${strikeMinor}:${type}`),
    quotesAt: (at: string) => Object.freeze((byTime.get(at) ?? []).filter(q => q.availableAt <= at)) });
}
export interface ReplayProposal { readonly direction: "BULLISH" | "BEARISH" | "HOLD"; readonly confidence: number; readonly reason: string }
export interface ReplayProposalSource {
  readonly version: string;
  propose(input: Readonly<{ evaluatedAt: string; emaAlignment: string }>): ReplayProposal;
}
export type ReplayEvidenceIssue = "MISSING_REQUIRED_OPTION_OBSERVATION" | "INCOMPLETE_CONTRACT_UNIVERSE"
  | "UNAVAILABLE_REQUIRED_ANALYTICS";
/** Evidence classification only. Phase 5B remains the sole strategy authority. */
function classifyReplayEvidence(replay: PreparedReplay, analytics: AnalyticsOutcome,
  proposal: DirectionalProposal, result: ReturnType<typeof evaluateStrategy>, config: ReplayConfig,
  evaluatedAt: string): ReplayEvidenceIssue | null {
  if (!analytics.available) return analytics.reason === "INSUFFICIENT_HISTORY" ? null
    : analytics.reason === "ANALYTICS_UNAVAILABLE" ? "MISSING_REQUIRED_OPTION_OBSERVATION"
      : "UNAVAILABLE_REQUIRED_ANALYTICS";
  if (proposal.direction === "HOLD") return null;
  if (!replay.data.coverage.optionUniverseComplete) return "INCOMPLETE_CONTRACT_UNIVERSE";
  const snapshot = analytics.snapshot;
  const nearestMasterExpiry = replay.earliestKnownExpiry(evaluatedAt);
  if (nearestMasterExpiry && nearestMasterExpiry < proposal.expiry)
    return "MISSING_REQUIRED_OPTION_OBSERVATION";
  if (result.action !== "HOLD" || !["NO_QUALIFIED_CONTRACT", "NO_QUALIFIED_HEDGE", "INVALID_GREEKS"].includes(result.reason))
    return null;
  const bull = proposal.direction === "BULLISH", type = bull ? "PE" : "CE";
  const shortStrike = Math.round((snapshot.spotMinor + (bull ? -config.strategyConfig.shortOffsetMinor
    : config.strategyConfig.shortOffsetMinor)) / config.strategyConfig.strikeStepMinor) * config.strategyConfig.strikeStepMinor;
  const hedgeStrike = shortStrike + (bull ? -config.strategyConfig.widthMinor : config.strategyConfig.widthMinor);
  const required = [shortStrike, hedgeStrike].map(strike => replay.qualifiedOption(proposal.expiry, strike, type));
  const observed = new Set(replay.quotesAt(evaluatedAt).map(q => q.canonicalId));
  if (required.some(i => i && !observed.has(i.canonicalId))) return "MISSING_REQUIRED_OPTION_OBSERVATION";
  if (result.reason !== "INVALID_GREEKS") return null; // The complete master genuinely lacks a required contract.
  const requiredOptions = snapshot.options.filter(o => required.some(i => i?.canonicalId === o.canonicalId));
  const expiryAt = Date.parse(`${proposal.expiry}T10:00:00.000Z`);
  if (requiredOptions.some(o => !o.greeks.available && (o.greeks.reason !== "EXPIRED_OPTION"
    && !(o.greeks.reason === "IV_UNAVAILABLE" && expiryAt > Date.parse(evaluatedAt)
      && expiryAt - Date.parse(evaluatedAt) < 3_600_000)))) return "UNAVAILABLE_REQUIRED_ANALYTICS";
  return null;
}
export const deterministicReplayProposal: ReplayProposalSource = Object.freeze({ version: PROPOSAL_VERSION,
  propose: ({ emaAlignment }: { emaAlignment: string }): ReplayProposal => ({
    direction: emaAlignment === "bullish" ? "BULLISH" : emaAlignment === "bearish" ? "BEARISH" : "HOLD",
    confidence: emaAlignment === "bullish" || emaAlignment === "bearish" ? 0.8 : 0,
    reason: "EMA_ALIGNMENT", // Fixed research score, not a calibrated model probability.
  }) });
/** Only the completed prefix and contemporaneously available option observations cross this boundary. */
export function evaluateHistoricalBar(replay: PreparedReplay, barIndex: number, config: ReplayConfig,
  source: ReplayProposalSource = deterministicReplayProposal, priorCandidateKeys: readonly string[] = []) {
  const candle = replay.data.candles[barIndex];
  if (!candle) return rejectReplay("INVALID_REPLAY_INDEX");
  const evaluatedAt = new Date(Date.parse(candle.timestamp) + replay.durationMs).toISOString();
  const history = replay.data.candles.slice(0, barIndex + 1);
  const quotes = replay.quotesAt(evaluatedAt);
  const expiryAtByDate: Record<string, string> = {};
  const options = quotes.map(q => {
    const instrument = replay.data.master.getInstrumentByCanonicalId(q.canonicalId);
    expiryAtByDate[instrument.expiry] = `${instrument.expiry}T10:00:00.000Z`;
    return { instrument, bidMinor: q.bidMinor, askMinor: q.askMinor, bidQuantity: q.bidQuantity,
      askQuantity: q.askQuantity, optionPriceMinor: q.lastPriceMinor, priceTimestamp: q.timestamp };
  });
  const analytics: AnalyticsOutcome = !options.length ? freeze({ available: false, reason: "ANALYTICS_UNAVAILABLE" })
    : buildMockMarketAnalytics({ underlying: config.asset, evaluatedAt, spotMinor: candle.closeMinor,
      spotTimestamp: evaluatedAt, interval: config.interval, candles: history, options, expiryAtByDate,
      expiryAssumptionVersion: "NSE_CLOSE_1530_V1", riskFreeRate: replay.data.riskFreeRate,
      riskFreeRateVersion: replay.data.riskFreeRateVersion });
  const expiry = Object.keys(expiryAtByDate).sort().find(d => Date.parse(expiryAtByDate[d]!) > Date.parse(evaluatedAt))
    ?? istSession(Date.parse(evaluatedAt)).date;
  const view = analytics.available ? source.propose(freeze({ evaluatedAt, emaAlignment: analytics.snapshot.indicators.values.emaAlignment }))
    : { direction: "HOLD" as const, confidence: 0, reason: !options.length ? "HISTORICAL_OPTION_EVIDENCE_UNAVAILABLE" : analytics.reason };
  if (!["BULLISH", "BEARISH", "HOLD"].includes(view.direction) || !Number.isFinite(view.confidence)
    || view.confidence < 0 || view.confidence > 1 || !id(view.reason)) rejectReplay("INVALID_REPLAY_PROPOSAL");
  const proposal: DirectionalProposal = freeze({ direction: view.direction, confidence: view.confidence, expiry });
  const result = evaluateStrategy({ analytics, proposal, config: config.strategyConfig, evaluatedAt, priorCandidateKeys });
  return freeze({ evaluatedAt, analytics, proposal, proposalReason: view.reason,
    analyticsEvidenceId: analytics.available ? analyticsEvidenceId(analytics.snapshot) : null,
    result, evidenceIssue: classifyReplayEvidence(replay, analytics, proposal, result, config, evaluatedAt) });
}
