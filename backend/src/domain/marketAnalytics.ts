import type { AssetKey } from "../config/assets";
import { assertQualifiedInstrument, type InstrumentDefinition } from "../services/KiteInstrumentMasterService";
import { assertQualifiedRealMarketData, type MarketQuote, type HistoricalInterval } from "../services/KiteMarketDataService";
import { assertQualifiedRealIndexHistory, assertQualifiedRealIndexQuote,
  type IndexHistory, type IndexQuote, type QualifiedIndex } from "../services/KiteIndexDataService";
import { freeze, marketTimestamp } from "./kiteMarketData";
import { computeQualifiedGreeks, type GreeksOutcome } from "./qualifiedGreeks";
import { computeValidatedIndicators, type AnalyticsCandle, type ValidatedIndicators } from "./validatedIndicators";

export type AnalyticsFailure = "MARKET_DATA_NOT_FRESH" | "REAL_DATA_REQUIRED" | "INSUFFICIENT_HISTORY"
  | "ANALYTICS_UNAVAILABLE" | "INVALID_MARKET_EVIDENCE";
export interface OptionAnalytics {
  readonly instrument: InstrumentDefinition;
  readonly canonicalId: string;
  readonly bidMinor: number;
  readonly askMinor: number;
  readonly bidQuantity: number;
  readonly askQuantity: number;
  readonly priceTimestamp: string;
  readonly optionTradeTimestamp: string;
  readonly greeks: GreeksOutcome;
}
export interface MarketAnalyticsSnapshot {
  readonly version: "MARKET_ANALYTICS_V1";
  readonly underlying: AssetKey;
  readonly dataMode: "KITE_REAL" | "MOCK";
  readonly source: "KITE" | "MOCK";
  readonly evaluatedAt: string;
  readonly spotMinor: number;
  readonly spotTimestamp: string;
  readonly indexCanonicalId: string | null;
  readonly indexMasterFingerprint: string | null;
  readonly optionMasterFingerprint: string;
  readonly candleInterval: HistoricalInterval;
  readonly indicators: ValidatedIndicators;
  readonly options: readonly OptionAnalytics[];
}
export type AnalyticsOutcome = Readonly<{ available: true; snapshot: MarketAnalyticsSnapshot } |
  { available: false; reason: AnalyticsFailure }>;
export interface AnalyticsAssumptions {
  readonly evaluatedAt: string;
  readonly expiryAtByDate: Readonly<Record<string, string>>;
  readonly expiryAssumptionVersion: string;
  readonly riskFreeRate: number;
  readonly riskFreeRateVersion: string;
}
export interface RealAnalyticsInput extends AnalyticsAssumptions {
  /** Trusted wall-clock capture at the real snapshot assembly boundary. */
  readonly observedAt: string;
  readonly index: QualifiedIndex;
  readonly indexQuote: IndexQuote;
  readonly indexHistory: IndexHistory;
  readonly optionQuotes: readonly MarketQuote[];
  readonly maxAgeMs: number;
}
export interface MockOptionEvidence {
  readonly instrument: InstrumentDefinition;
  readonly bidMinor: number;
  readonly askMinor: number;
  readonly bidQuantity: number;
  readonly askQuantity: number;
  readonly optionPriceMinor: number;
  readonly priceTimestamp: string;
  readonly optionTradeTimestamp?: string;
}
export interface MockAnalyticsInput extends AnalyticsAssumptions {
  readonly underlying: AssetKey;
  readonly spotMinor: number;
  readonly spotTimestamp: string;
  readonly interval: HistoricalInterval;
  readonly candles: readonly AnalyticsCandle[];
  readonly options: readonly MockOptionEvidence[];
}
const issued = new WeakSet<object>();
export function assertMarketAnalytics(value: unknown): asserts value is MarketAnalyticsSnapshot {
  if (!value || typeof value !== "object" || !issued.has(value)) throw new Error("ANALYTICS_UNAVAILABLE");
}
const unavailable = (reason: AnalyticsFailure): AnalyticsOutcome => freeze({ available: false, reason });
const minor = (n: number) => Number.isSafeInteger(n) && n > 0;
const units = (n: number) => Number.isSafeInteger(n) && n >= 0;
const intervalMs: Record<HistoricalInterval, number> = { minute: 60_000, "3minute": 180_000,
  "5minute": 300_000, "10minute": 600_000, "15minute": 900_000, "30minute": 1_800_000,
  "60minute": 3_600_000, day: 86_400_000 };
const validTime = (s: string, limit: number): string | null => {
  try { const normalized = marketTimestamp(s); return Date.parse(normalized) <= limit ? normalized : null; }
  catch { return null; }
};
/** Freshness is inclusive at maxAgeMs and uses exchange evidence, never fetch time. */
const freshAt = (timestamp: string | null, evaluation: number, maxAgeMs: number): boolean => {
  if (!timestamp || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return false;
  const normalized = validTime(timestamp, evaluation);
  return normalized !== null && evaluation - Date.parse(normalized) <= maxAgeMs;
};

interface Assembly extends AnalyticsAssumptions {
  underlying: AssetKey; dataMode: "KITE_REAL" | "MOCK"; source: "KITE" | "MOCK";
  spotMinor: number; spotTimestamp: string; indexCanonicalId: string | null;
  indexMasterFingerprint: string | null; interval: HistoricalInterval; candles: readonly AnalyticsCandle[];
  options: readonly MockOptionEvidence[];
}
function assemble(input: Assembly): AnalyticsOutcome {
  const evaluation = validTime(input.evaluatedAt, Number.POSITIVE_INFINITY);
  if (!evaluation || !minor(input.spotMinor) || !input.options.length) return unavailable("INVALID_MARKET_EVIDENCE");
  const now = Date.parse(evaluation), spotTimestamp = validTime(input.spotTimestamp, now);
  if (!spotTimestamp || !((input.dataMode === "KITE_REAL" && input.source === "KITE")
    || (input.dataMode === "MOCK" && input.source === "MOCK"))) return unavailable("INVALID_MARKET_EVIDENCE");
  const indicators = computeValidatedIndicators({ candles: input.candles, interval: input.interval, evaluatedAt: evaluation });
  if (!indicators.available) return unavailable(indicators.reason === "INSUFFICIENT_HISTORY" ? "INSUFFICIENT_HISTORY" : "ANALYTICS_UNAVAILABLE");
  const ids = new Set<string>(), analyzed: OptionAnalytics[] = [];
  let fingerprint: string | null = null;
  for (const option of input.options) {
    try { assertQualifiedInstrument(option.instrument); } catch { return unavailable("INVALID_MARKET_EVIDENCE"); }
    const i = option.instrument;
    if (i.underlying !== input.underlying || ids.has(i.canonicalId) || !minor(option.bidMinor)
      || !minor(option.askMinor) || option.bidMinor > option.askMinor || !minor(option.optionPriceMinor)
      || !units(option.bidQuantity) || !units(option.askQuantity)) return unavailable("INVALID_MARKET_EVIDENCE");
    const timestamp = validTime(option.priceTimestamp, now);
    const tradeTimestamp = validTime(option.optionTradeTimestamp ?? option.priceTimestamp, now);
    if (!timestamp || !tradeTimestamp) return unavailable("INVALID_MARKET_EVIDENCE");
    if (fingerprint !== null && fingerprint !== i.provenance.sourceFingerprint) return unavailable("INVALID_MARKET_EVIDENCE");
    fingerprint = i.provenance.sourceFingerprint;
    if (input.dataMode === "KITE_REAL" && input.indexMasterFingerprint !== fingerprint)
      return unavailable("INVALID_MARKET_EVIDENCE");
    ids.add(i.canonicalId);
    const greeks = computeQualifiedGreeks({ instrument: i, spotMinor: input.spotMinor,
      optionPriceMinor: option.optionPriceMinor, valuationAt: evaluation, optionPriceTimestamp: tradeTimestamp,
      expiryAt: input.expiryAtByDate[i.expiry] ?? "", expiryAssumptionVersion: input.expiryAssumptionVersion,
      riskFreeRate: input.riskFreeRate, riskFreeRateVersion: input.riskFreeRateVersion,
      dataMode: input.dataMode, source: input.source, masterFingerprint: fingerprint });
    analyzed.push(freeze({ instrument: i, canonicalId: i.canonicalId, bidMinor: option.bidMinor,
      askMinor: option.askMinor, bidQuantity: option.bidQuantity, askQuantity: option.askQuantity,
      priceTimestamp: timestamp, optionTradeTimestamp: tradeTimestamp, greeks }));
  }
  const snapshot: MarketAnalyticsSnapshot = freeze({ version: "MARKET_ANALYTICS_V1", underlying: input.underlying,
    dataMode: input.dataMode, source: input.source, evaluatedAt: evaluation, spotMinor: input.spotMinor,
    spotTimestamp, indexCanonicalId: input.indexCanonicalId, indexMasterFingerprint: input.indexMasterFingerprint,
    optionMasterFingerprint: fingerprint!, candleInterval: input.interval, indicators: indicators.snapshot,
    options: analyzed });
  issued.add(snapshot);
  return freeze({ available: true, snapshot });
}

/** Real assembly accepts only service-issued, current, fresh broker evidence. */
export function buildRealMarketAnalytics(input: RealAnalyticsInput): AnalyticsOutcome {
  try {
    assertQualifiedRealIndexQuote(input.indexQuote, input.index, input.maxAgeMs);
    assertQualifiedRealIndexHistory(input.indexHistory, input.index);
    if (input.indexHistory.canonicalId !== input.index.canonicalId
      || input.indexQuote.canonicalId !== input.index.canonicalId
      || input.indexHistory.masterFingerprint !== input.indexQuote.masterFingerprint
      || input.indexHistory.masterFingerprint !== input.index.provenance.sourceFingerprint)
      return unavailable("INVALID_MARKET_EVIDENCE");
    const observedAt = validTime(input.observedAt, Number.POSITIVE_INFINITY);
    const evaluatedAt = validTime(input.evaluatedAt, Number.POSITIVE_INFINITY);
    if (!observedAt || !evaluatedAt) return unavailable("INVALID_MARKET_EVIDENCE");
    const evaluation = Date.parse(evaluatedAt);
    if (evaluation > Date.parse(observedAt)) return unavailable("INVALID_MARKET_EVIDENCE");
    if (Date.parse(input.indexQuote.fetchedAt) > evaluation || Date.parse(input.indexHistory.fetchedAt) > evaluation)
      return unavailable("INVALID_MARKET_EVIDENCE");
    if (!freshAt(input.indexQuote.brokerTimestamp, evaluation, input.maxAgeMs))
      return unavailable("MARKET_DATA_NOT_FRESH");
    const optionEvidence: MockOptionEvidence[] = [];
    for (const quote of input.optionQuotes) {
      assertQualifiedRealMarketData(quote, { instrument: quote.instrument, maxAgeMs: input.maxAgeMs });
      if (quote.kind !== "QUOTE" || quote.instrument.underlying !== input.index.underlying
        || quote.masterFingerprint !== input.index.provenance.sourceFingerprint
        || quote.brokerTimestamp === null || quote.lastTradeTimestamp === null
        || !quote.depth?.buy.length || !quote.depth.sell.length
        || Date.parse(quote.fetchedAt) > evaluation) return unavailable("INVALID_MARKET_EVIDENCE");
      if (!freshAt(quote.brokerTimestamp, evaluation, input.maxAgeMs)
        || !freshAt(quote.lastTradeTimestamp, evaluation, input.maxAgeMs))
        return unavailable("MARKET_DATA_NOT_FRESH");
      optionEvidence.push({ instrument: quote.instrument, bidMinor: quote.depth.buy[0]!.priceMinor,
        askMinor: quote.depth.sell[0]!.priceMinor, bidQuantity: quote.depth.buy[0]!.quantity,
        askQuantity: quote.depth.sell[0]!.quantity, optionPriceMinor: quote.lastPriceMinor,
        priceTimestamp: quote.brokerTimestamp, optionTradeTimestamp: quote.lastTradeTimestamp });
    }
    const assembled = assemble({ ...input, underlying: input.index.underlying, dataMode: "KITE_REAL", source: "KITE",
      spotMinor: input.indexQuote.priceMinor, spotTimestamp: input.indexQuote.brokerTimestamp!,
      indexCanonicalId: input.index.canonicalId, indexMasterFingerprint: input.index.provenance.sourceFingerprint,
      interval: input.indexHistory.interval, candles: input.indexHistory.candles, options: optionEvidence });
    if (assembled.available && evaluation - Date.parse(assembled.snapshot.indicators.lastFinalizedAt)
      > intervalMs[input.indexHistory.interval] + input.maxAgeMs) return unavailable("MARKET_DATA_NOT_FRESH");
    return assembled;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return unavailable(code === "STALE_MARKET_DATA" ? "MARKET_DATA_NOT_FRESH" : "REAL_DATA_REQUIRED");
  }
}

/** Explicit test/replay evidence. Its mode cannot be promoted to KITE_REAL. */
export function buildMockMarketAnalytics(input: MockAnalyticsInput): AnalyticsOutcome {
  return assemble({ ...input, dataMode: "MOCK", source: "MOCK", indexCanonicalId: null,
    indexMasterFingerprint: null, interval: input.interval, options: input.options });
}
