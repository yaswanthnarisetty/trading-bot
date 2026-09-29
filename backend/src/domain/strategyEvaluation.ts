import type { AssetKey } from "../config/assets";
import { selectStrategyKind } from "../services/StrategySelector";
import type { InstrumentDefinition } from "../services/KiteInstrumentMasterService";
import { assertMarketAnalytics, type AnalyticsOutcome, type MarketAnalyticsSnapshot, type OptionAnalytics } from "./marketAnalytics";
import { freeze, marketTimestamp } from "./kiteMarketData";

export type HoldReason = "INVALID_INPUT" | "REAL_DATA_REQUIRED" | "MARKET_DATA_NOT_FRESH"
  | "INSUFFICIENT_HISTORY" | "ANALYTICS_UNAVAILABLE" | "NO_DIRECTION" | "CONFIDENCE_TOO_LOW"
  | "ATR_GATE" | "RSI_GATE" | "VOLUME_GATE" | "OPENING_BLOCK" | "MARKET_CLOSED"
  | "STRATEGY_NOT_SUPPORTED" | "NO_QUALIFIED_CONTRACT" | "NO_QUALIFIED_HEDGE"
  | "INVALID_GREEKS" | "LIQUIDITY_GATE" | "CREDIT_GATE" | "DUPLICATE_CANDIDATE";
export interface DirectionalProposal {
  readonly direction: "BULLISH" | "BEARISH" | "HOLD";
  readonly confidence: number;
  readonly expiry: string;
  readonly preferredStrategy?: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "HOLD";
}
/** Supplied by caller; no env/account/portfolio fields belong to strategy quality. */
export interface StrategyQualityConfig {
  readonly version: string;
  readonly minConfidence: number;
  readonly maxAtrPoints: number;
  readonly minVolumeRatio: number;
  readonly bullishRsiMax: number;
  readonly bearishRsiMin: number;
  readonly openingBlockMinutes: number;
  readonly minDteDays: number;
  readonly strikeStepMinor: number;
  readonly widthMinor: number;
  readonly shortOffsetMinor: number;
  readonly minDepthUnits: number;
  readonly maxBidAskSpreadMinor: number;
  readonly minCreditMinor: number;
}
export interface CandidateLeg {
  readonly role: "SHORT" | "HEDGE";
  readonly instrument: InstrumentDefinition;
  readonly canonicalId: string;
  readonly priceMinor: number;
  readonly lotSizeUnits: number;
  readonly quoteTimestamp: string;
}
export interface TradeCandidate {
  readonly version: "TRADE_CANDIDATE_V1";
  readonly executionAuthority: "NONE";
  readonly underlying: AssetKey;
  readonly strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  readonly evaluatedAt: string;
  readonly dataMode: "KITE_REAL" | "MOCK";
  readonly source: "KITE" | "MOCK";
  readonly snapshotVersion: MarketAnalyticsSnapshot["version"];
  readonly optionMasterFingerprint: string;
  readonly indexMasterFingerprint: string | null;
  readonly configVersion: string;
  readonly confidence: number;
  readonly candidateKey: string;
  readonly short: CandidateLeg;
  readonly hedge: CandidateLeg;
  readonly widthMinor: number;
  readonly creditPerUnitMinor: number;
  readonly maxLossPerUnitMinor: number;
  readonly creditPerLotMinor: number;
  readonly maxLossPerLotMinor: number;
}
export type StrategyEvaluationResult = Readonly<{ action: "HOLD"; reason: HoldReason } |
  { action: "CANDIDATE"; candidate: TradeCandidate }>;
export interface StrategyEvaluationInput {
  readonly analytics: AnalyticsOutcome;
  readonly proposal: DirectionalProposal;
  readonly config: StrategyQualityConfig;
  readonly evaluatedAt: string;
  /** Logical duplicates in the current evaluation context only; durable admission is elsewhere. */
  readonly priorCandidateKeys?: readonly string[];
}
const hold = (reason: HoldReason): StrategyEvaluationResult => freeze({ action: "HOLD", reason });
const integer = (n: number) => Number.isSafeInteger(n) && n > 0;
const finite = (n: number) => Number.isFinite(n);
function validConfig(c: StrategyQualityConfig): boolean {
  return typeof c.version === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(c.version)
    && finite(c.minConfidence) && c.minConfidence >= 0 && c.minConfidence <= 1
    && finite(c.maxAtrPoints) && c.maxAtrPoints > 0 && finite(c.minVolumeRatio) && c.minVolumeRatio >= 0
    && finite(c.bullishRsiMax) && c.bullishRsiMax >= 0 && c.bullishRsiMax <= 100
    && finite(c.bearishRsiMin) && c.bearishRsiMin >= 0 && c.bearishRsiMin <= 100
    && Number.isSafeInteger(c.openingBlockMinutes) && c.openingBlockMinutes >= 0
    && Number.isSafeInteger(c.minDteDays) && c.minDteDays >= 0
    && integer(c.strikeStepMinor) && integer(c.widthMinor) && integer(c.shortOffsetMinor)
    && Number.isSafeInteger(c.minDepthUnits) && c.minDepthUnits >= 0
    && integer(c.maxBidAskSpreadMinor) && Number.isSafeInteger(c.minCreditMinor) && c.minCreditMinor >= 0;
}
function istMinutes(utcMs: number): { weekday: number; minute: number } {
  const date = new Date(utcMs + 19_800_000);
  return { weekday: date.getUTCDay(), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}
function findOption(snapshot: MarketAnalyticsSnapshot, expiry: string, strike: number, type: "CE" | "PE"): OptionAnalytics | undefined {
  return snapshot.options.find(o => o.instrument.expiry === expiry && o.instrument.strikeMinor === strike && o.instrument.instrumentType === type);
}
function liquid(option: OptionAnalytics, config: StrategyQualityConfig): boolean {
  return option.bidQuantity >= config.minDepthUnits && option.askQuantity >= config.minDepthUnits
    && option.askMinor >= option.bidMinor && option.askMinor - option.bidMinor <= config.maxBidAskSpreadMinor;
}

/** Pure, broker/DB-independent candidate selection. A candidate cannot submit an order. */
export function evaluateStrategy(input: StrategyEvaluationInput): StrategyEvaluationResult {
  if (!input.analytics?.available) {
    if (input.analytics?.reason === "MARKET_DATA_NOT_FRESH") return hold("MARKET_DATA_NOT_FRESH");
    if (input.analytics?.reason === "REAL_DATA_REQUIRED") return hold("REAL_DATA_REQUIRED");
    if (input.analytics?.reason === "INSUFFICIENT_HISTORY") return hold("INSUFFICIENT_HISTORY");
    return hold("ANALYTICS_UNAVAILABLE");
  }
  const snapshot = input.analytics.snapshot;
  try { assertMarketAnalytics(snapshot); } catch { return hold("ANALYTICS_UNAVAILABLE"); }
  let evaluatedAt: string;
  try { evaluatedAt = marketTimestamp(input.evaluatedAt); } catch { return hold("INVALID_INPUT"); }
  const proposal = input.proposal, c = input.config;
  if (!proposal || !c || !validConfig(c) || evaluatedAt !== snapshot.evaluatedAt
    || !finite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(proposal.expiry)) return hold("INVALID_INPUT");
  if (proposal.direction === "HOLD") return hold("NO_DIRECTION");
  if (proposal.direction !== "BULLISH" && proposal.direction !== "BEARISH") return hold("INVALID_INPUT");
  const time = Date.parse(evaluatedAt), ist = istMinutes(time);
  if (ist.weekday === 0 || ist.weekday === 6 || ist.minute < 555 || ist.minute >= 930) return hold("MARKET_CLOSED");
  if (ist.minute < 555 + c.openingBlockMinutes) return hold("OPENING_BLOCK");
  if (proposal.confidence < c.minConfidence) return hold("CONFIDENCE_TOO_LOW");
  const values = snapshot.indicators.values;
  if (values.atr === null || values.ema20 === null || values.ema50 === null || values.rsiSlope === null)
    return hold("ANALYTICS_UNAVAILABLE");
  if (values.atr > c.maxAtrPoints) return hold("ATR_GATE");
  if (values.volumeRatio < c.minVolumeRatio) return hold("VOLUME_GATE");
  if (proposal.direction === "BULLISH" && values.rsi > c.bullishRsiMax
    || proposal.direction === "BEARISH" && values.rsi < c.bearishRsiMin) return hold("RSI_GATE");
  const matching = snapshot.options.filter(o => o.instrument.expiry === proposal.expiry);
  if (!matching.length) return hold("NO_QUALIFIED_CONTRACT");
  const expiry = matching.find(o => o.greeks.available)?.greeks;
  if (!expiry?.available) return hold("INVALID_GREEKS");
  const dte = Math.ceil((Date.parse(expiry.value.expiryAt) - time) / 86_400_000);
  const strategy = selectStrategyKind(proposal.direction, dte, values.regime);
  if (strategy === "HOLD" || dte < c.minDteDays
    || (proposal.preferredStrategy && proposal.preferredStrategy !== strategy)) return hold("STRATEGY_NOT_SUPPORTED");
  const isBull = strategy === "BULL_PUT_SPREAD", type = isBull ? "PE" : "CE";
  const target = Math.round((snapshot.spotMinor + (isBull ? -c.shortOffsetMinor : c.shortOffsetMinor)) / c.strikeStepMinor)
    * c.strikeStepMinor;
  const hedgeStrike = target + (isBull ? -c.widthMinor : c.widthMinor);
  if (!integer(target) || !integer(hedgeStrike)) return hold("INVALID_INPUT");
  if (isBull ? target >= snapshot.spotMinor : target <= snapshot.spotMinor) return hold("NO_QUALIFIED_CONTRACT");
  const short = findOption(snapshot, proposal.expiry, target, type);
  if (!short) return hold("NO_QUALIFIED_CONTRACT");
  const hedge = findOption(snapshot, proposal.expiry, hedgeStrike, type);
  if (!hedge) return hold("NO_QUALIFIED_HEDGE");
  if (!short.greeks.available || !hedge.greeks.available) return hold("INVALID_GREEKS");
  if (!liquid(short, c) || !liquid(hedge, c)) return hold("LIQUIDITY_GATE");
  if (short.instrument.lotSizeUnits !== hedge.instrument.lotSizeUnits || !integer(short.instrument.lotSizeUnits))
    return hold("INVALID_INPUT");
  const width = BigInt(c.widthMinor), credit = BigInt(short.bidMinor) - BigInt(hedge.askMinor);
  if (credit <= 0n || credit >= width || credit < BigInt(c.minCreditMinor)) return hold("CREDIT_GATE");
  const loss = width - credit, lot = BigInt(short.instrument.lotSizeUnits);
  if ([credit, loss, credit * lot, loss * lot].some(value => value > BigInt(Number.MAX_SAFE_INTEGER))) return hold("INVALID_INPUT");
  const key = `${snapshot.underlying}:${proposal.expiry}:${strategy}:${short.canonicalId}:${hedge.canonicalId}`;
  if (input.priorCandidateKeys?.includes(key)) return hold("DUPLICATE_CANDIDATE");
  const candidate: TradeCandidate = freeze({ version: "TRADE_CANDIDATE_V1", executionAuthority: "NONE",
    underlying: snapshot.underlying, strategy, evaluatedAt, dataMode: snapshot.dataMode, source: snapshot.source,
    snapshotVersion: snapshot.version, optionMasterFingerprint: snapshot.optionMasterFingerprint,
    indexMasterFingerprint: snapshot.indexMasterFingerprint, configVersion: c.version, confidence: proposal.confidence,
    candidateKey: key,
    short: { role: "SHORT", instrument: short.instrument, canonicalId: short.canonicalId,
      priceMinor: short.bidMinor, lotSizeUnits: short.instrument.lotSizeUnits, quoteTimestamp: short.priceTimestamp },
    hedge: { role: "HEDGE", instrument: hedge.instrument, canonicalId: hedge.canonicalId,
      priceMinor: hedge.askMinor, lotSizeUnits: hedge.instrument.lotSizeUnits, quoteTimestamp: hedge.priceTimestamp },
    widthMinor: c.widthMinor, creditPerUnitMinor: Number(credit), maxLossPerUnitMinor: Number(loss),
    creditPerLotMinor: Number(credit * lot), maxLossPerLotMinor: Number(loss * lot) });
  return freeze({ action: "CANDIDATE", candidate });
}
