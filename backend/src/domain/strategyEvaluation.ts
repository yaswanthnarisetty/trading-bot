import type { AssetKey } from "../config/assets";
import { selectStrategyKind } from "../services/StrategySelector";
import type { InstrumentDefinition } from "../services/KiteInstrumentMasterService";
import { isMarketAnalyticsFresh, assertMarketAnalytics, type AnalyticsOutcome, type MarketAnalyticsSnapshot, type OptionAnalytics } from "./marketAnalytics";
import { analyticsEvidenceId } from "./analyticsEvidence";
import { freeze, marketTimestamp } from "./kiteMarketData";

export const STRATEGY_EVALUATOR_VERSION = "PHASE6A01_V1";

export type HoldReason = "INVALID_INPUT" | "REAL_DATA_REQUIRED" | "MARKET_DATA_NOT_FRESH"
  | "INSUFFICIENT_HISTORY" | "ANALYTICS_UNAVAILABLE" | "NO_DIRECTION" | "CONFIDENCE_TOO_LOW"
  | "ATR_GATE" | "RSI_GATE" | "VOLUME_GATE" | "OPENING_BLOCK" | "MARKET_CLOSED"
  | "STRATEGY_NOT_SUPPORTED" | "NO_QUALIFIED_CONTRACT" | "NO_QUALIFIED_HEDGE"
  | "INVALID_GREEKS" | "LIQUIDITY_GATE" | "CREDIT_GATE" | "DEBIT_GATE" | "NO_QUALIFIED_SHORT" | "DUPLICATE_CANDIDATE";
export interface DirectionalProposal {
  readonly direction: "BULLISH" | "BEARISH" | "HOLD";
  readonly confidence: number;
  readonly expiry: string;
  readonly preferredStrategy?: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "HOLD";
}
export type StrategyFamily = "LONG_OPTION" | "DEBIT_VERTICAL" | "CREDIT_VERTICAL";
export type StrategyKind = "LONG_CALL" | "LONG_PUT" | "BULL_CALL_DEBIT_SPREAD" | "BEAR_PUT_DEBIT_SPREAD"
  | "BULL_PUT_CREDIT_SPREAD" | "BEAR_CALL_CREDIT_SPREAD";
export interface LongOptionSelection {
  readonly minAbsDelta: number; readonly maxAbsDelta: number; readonly targetAbsDelta: number;
  readonly maxStrikeDistanceMinor: number;
}
export const DEFAULT_LONG_SELECTION: LongOptionSelection = Object.freeze({ minAbsDelta: 0.55,
  maxAbsDelta: 0.70, targetAbsDelta: 0.625, maxStrikeDistanceMinor: 100000 });
/** Supplied by caller; no env/account/portfolio fields belong to strategy quality. */
export interface StrategyQualityConfig {
  readonly version: string;
  /** Omitted only for approved credit-spread compatibility. */
  readonly strategyFamily?: StrategyFamily;
  readonly longOptionSelection?: LongOptionSelection;
  /** BUY strike offset towards ITM, rounded to the explicitly configured strike step. */
  readonly debitLongOffsetMinor?: number;
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
  readonly role: "SHORT" | "HEDGE" | "LONG";
  readonly side: "BUY" | "SELL";
  readonly quantityUnits: number;
  readonly instrument: InstrumentDefinition;
  readonly canonicalId: string;
  readonly priceMinor: number;
  readonly lotSizeUnits: number;
  readonly quoteTimestamp: string;
}
interface CandidateBase {
  readonly version: "TRADE_CANDIDATE_V2";
  readonly executionAuthority: "NONE";
  readonly underlying: AssetKey;
  readonly expiry: string;
  readonly direction: "BULLISH" | "BEARISH";
  readonly evaluatedAt: string;
  readonly dataMode: "KITE_REAL" | "MOCK";
  readonly source: "KITE" | "MOCK";
  readonly snapshotVersion: MarketAnalyticsSnapshot["version"];
  readonly optionMasterFingerprint: string;
  readonly indexMasterFingerprint: string | null;
  readonly configVersion: string;
  readonly evaluatorVersion: typeof STRATEGY_EVALUATOR_VERSION;
  readonly selectionConfig: StrategyQualityConfig;
  readonly analyticsEvidenceId: string;
  readonly confidence: number;
  readonly candidateKey: string;
  /** One qualified broker lot per leg. Account sizing is deliberately outside this evaluator. */
  readonly quantityUnits: number;
  readonly legs: readonly CandidateLeg[];
  readonly entryCashFlowPerUnitMinor: number;
  readonly maxLossPerUnitMinor: number;
  readonly maxProfitPerUnitMinor: number | null;
  readonly maxLossPerLotMinor: number;
  readonly maxProfitPerLotMinor: number | null;
}
export interface CreditCandidate extends CandidateBase {
  readonly strategyFamily: "CREDIT_VERTICAL";
  readonly strategyKind: "BULL_PUT_CREDIT_SPREAD" | "BEAR_CALL_CREDIT_SPREAD";
  readonly strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  readonly short: CandidateLeg; readonly hedge: CandidateLeg;
  readonly widthMinor: number; readonly creditPerUnitMinor: number; readonly creditPerLotMinor: number;
}
export interface DebitCandidate extends CandidateBase {
  readonly strategyFamily: "DEBIT_VERTICAL";
  readonly strategyKind: "BULL_CALL_DEBIT_SPREAD" | "BEAR_PUT_DEBIT_SPREAD";
  readonly strategy: "BULL_CALL_DEBIT_SPREAD" | "BEAR_PUT_DEBIT_SPREAD";
  readonly widthMinor: number; readonly debitPerUnitMinor: number; readonly debitPerLotMinor: number;
}
export interface LongCandidate extends CandidateBase {
  readonly strategyFamily: "LONG_OPTION";
  readonly strategyKind: "LONG_CALL" | "LONG_PUT";
  readonly strategy: "LONG_CALL" | "LONG_PUT";
  readonly widthMinor: null; readonly debitPerUnitMinor: number; readonly debitPerLotMinor: number;
  readonly maxProfitPerUnitMinor: null; readonly maxProfitPerLotMinor: null;
}
export type TradeCandidate = CreditCandidate | DebitCandidate | LongCandidate;
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
const issuedCandidates = new WeakMap<object, MarketAnalyticsSnapshot>();
export function assertIssuedTradeCandidate(value: unknown, now?: number): asserts value is TradeCandidate {
  if (!value || typeof value !== "object" || !issuedCandidates.has(value)) throw new Error("ISSUED_CANDIDATE_REQUIRED");
  if (now !== undefined && !isMarketAnalyticsFresh(issuedCandidates.get(value)!, now)) throw new Error("STALE_CANDIDATE");
}
const hold = (reason: HoldReason): StrategyEvaluationResult => freeze({ action: "HOLD", reason });
const integer = (n: number) => Number.isSafeInteger(n) && n > 0;
const finite = (n: number) => Number.isFinite(n);
export function validStrategyQualityConfig(c: StrategyQualityConfig): boolean {
  const delta = c.longOptionSelection === undefined ? DEFAULT_LONG_SELECTION : c.longOptionSelection;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)
    || Object.keys(delta).some(key => !["minAbsDelta", "maxAbsDelta", "targetAbsDelta", "maxStrikeDistanceMinor"].includes(key))) return false;
  return (c.strategyFamily === undefined || ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"].includes(c.strategyFamily))
    && !!delta && [delta.minAbsDelta, delta.maxAbsDelta, delta.targetAbsDelta].every(n => finite(n) && n > 0 && n <= 1)
    && delta.minAbsDelta <= delta.targetAbsDelta && delta.targetAbsDelta <= delta.maxAbsDelta
    && integer(delta.maxStrikeDistanceMinor)
    && (c.debitLongOffsetMinor === undefined || Number.isSafeInteger(c.debitLongOffsetMinor) && c.debitLongOffsetMinor >= 0)
    && typeof c.version === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(c.version)
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

export function resolvedStrategyConfig(c: StrategyQualityConfig): StrategyQualityConfig & { strategyFamily: StrategyFamily } {
  return freeze({ ...c, strategyFamily: c.strategyFamily ?? "CREDIT_VERTICAL",
    longOptionSelection: { ...(c.longOptionSelection ?? DEFAULT_LONG_SELECTION) }, debitLongOffsetMinor: c.debitLongOffsetMinor ?? 0 });
}
/** Shared exact economic queries; the returned numbers never establish instrument identity. */
export function verticalContractQueries(spot: number, direction: "BULLISH" | "BEARISH", c: StrategyQualityConfig) {
  const bull = direction === "BULLISH", credit = (c.strategyFamily ?? "CREDIT_VERTICAL") === "CREDIT_VERTICAL";
  const offset = credit ? c.shortOffsetMinor : c.debitLongOffsetMinor ?? 0;
  const first = Math.round((spot + (bull ? -offset : offset)) / c.strikeStepMinor) * c.strikeStepMinor;
  const second = first + (bull === credit ? -c.widthMinor : c.widthMinor);
  const type = (bull === credit ? "PE" : "CE") as "CE" | "PE";
  return [{ strike: first, type, side: credit ? "SELL" as const : "BUY" as const,
    role: credit ? "SHORT" as const : "LONG" as const },
  { strike: second, type, side: credit ? "BUY" as const : "SELL" as const,
    role: credit ? "HEDGE" as const : "SHORT" as const }] as const;
}
export function inLongSelectionUniverse(i: InstrumentDefinition, underlying: AssetKey, expiry: string,
  direction: "BULLISH" | "BEARISH", spot: number, c: StrategyQualityConfig): boolean {
  return i.underlying === underlying && i.expiry === expiry && i.instrumentType === (direction === "BULLISH" ? "CE" : "PE")
    && Math.abs(i.strikeMinor - spot) <= (c.longOptionSelection ?? DEFAULT_LONG_SELECTION).maxStrikeDistanceMinor;
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
  if (!proposal || !c || !validStrategyQualityConfig(c) || evaluatedAt !== snapshot.evaluatedAt
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
  // Keep approved directional DTE/regime policy; model preferences have no authority over configuration.
  const allowed = selectStrategyKind(proposal.direction, dte, values.regime);
  if (allowed === "HOLD" || dte < c.minDteDays) return hold("STRATEGY_NOT_SUPPORTED");
  const selectedConfig = resolvedStrategyConfig(c), family = selectedConfig.strategyFamily;
  const bull = proposal.direction === "BULLISH";
  let selected: Array<{ option: OptionAnalytics; side: "BUY" | "SELL"; role: CandidateLeg["role"] }>;
  if (family === "LONG_OPTION") {
    const delta = selectedConfig.longOptionSelection!;
    const universe = matching.filter(o => inLongSelectionUniverse(o.instrument, snapshot.underlying, proposal.expiry,
      proposal.direction as "BULLISH" | "BEARISH", snapshot.spotMinor, selectedConfig));
    const eligible = universe.filter(o => o.greeks.available && Math.abs(o.greeks.value.delta) >= delta.minAbsDelta
      && Math.abs(o.greeks.value.delta) <= delta.maxAbsDelta);
    if (!eligible.length) return hold(universe.some(o => !o.greeks.available) ? "INVALID_GREEKS" : "NO_QUALIFIED_CONTRACT");
    const liquidOptions = eligible.filter(o => liquid(o, c));
    if (!liquidOptions.length) return hold("LIQUIDITY_GATE");
    liquidOptions.sort((a, b) => {
      const distance = (o: OptionAnalytics) => o.greeks.available ? Math.abs(Math.abs(o.greeks.value.delta) - delta.targetAbsDelta) : Infinity;
      return distance(a) - distance(b) || (a.askMinor - a.bidMinor) - (b.askMinor - b.bidMinor)
        || (a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0);
    });
    selected = [{ option: liquidOptions[0]!, side: "BUY", role: "LONG" }];
  } else {
    const queries = verticalContractQueries(snapshot.spotMinor, proposal.direction, selectedConfig);
    if (queries.some(q => !integer(q.strike))) return hold("INVALID_INPUT");
    if (family === "CREDIT_VERTICAL" && (bull ? queries[0].strike >= snapshot.spotMinor : queries[0].strike <= snapshot.spotMinor))
      return hold("NO_QUALIFIED_CONTRACT");
    const first = findOption(snapshot, proposal.expiry, queries[0].strike, queries[0].type);
    if (!first) return hold("NO_QUALIFIED_CONTRACT");
    const second = findOption(snapshot, proposal.expiry, queries[1].strike, queries[1].type);
    if (!second) return hold(family === "CREDIT_VERTICAL" ? "NO_QUALIFIED_HEDGE" : "NO_QUALIFIED_SHORT");
    if (!first.greeks.available || !second.greeks.available) return hold("INVALID_GREEKS");
    if (!liquid(first, c) || !liquid(second, c)) return hold("LIQUIDITY_GATE");
    selected = [{ ...queries[0], option: first }, { ...queries[1], option: second }];
  }
  const lot = selected[0]!.option.instrument.lotSizeUnits;
  if (!integer(lot) || selected.some(l => l.option.instrument.lotSizeUnits !== lot)) return hold("INVALID_INPUT");
  const legs: CandidateLeg[] = selected.map(({ option: o, side, role }) => ({ role, side, quantityUnits: lot,
    instrument: o.instrument, canonicalId: o.canonicalId, priceMinor: side === "BUY" ? o.askMinor : o.bidMinor,
    lotSizeUnits: lot, quoteTimestamp: o.priceTimestamp }));
  const cash = legs.reduce((sum, leg) => sum + (leg.side === "SELL" ? 1n : -1n) * BigInt(leg.priceMinor), 0n);
  const width = family === "LONG_OPTION" ? null : BigInt(c.widthMinor);
  if (family === "CREDIT_VERTICAL" && (cash <= 0n || cash >= width! || cash < BigInt(c.minCreditMinor))) return hold("CREDIT_GATE");
  if (family !== "CREDIT_VERTICAL" && (-cash <= 0n || width !== null && -cash >= width)) return hold("DEBIT_GATE");
  const loss = family === "CREDIT_VERTICAL" ? width! - cash : -cash;
  const profit = family === "LONG_OPTION" ? null : family === "CREDIT_VERTICAL" ? cash : width! + cash;
  if ([cash, loss, loss * BigInt(lot), profit ?? 0n, (profit ?? 0n) * BigInt(lot), cash * BigInt(lot)]
    .some(v => v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))) return hold("INVALID_INPUT");
  const strategyKind: StrategyKind = family === "LONG_OPTION" ? bull ? "LONG_CALL" : "LONG_PUT"
    : family === "DEBIT_VERTICAL" ? bull ? "BULL_CALL_DEBIT_SPREAD" : "BEAR_PUT_DEBIT_SPREAD"
      : bull ? "BULL_PUT_CREDIT_SPREAD" : "BEAR_CALL_CREDIT_SPREAD";
  const strategy = family === "CREDIT_VERTICAL" ? bull ? "BULL_PUT_SPREAD" : "BEAR_CALL_SPREAD" : strategyKind;
  const key = `${snapshot.underlying}:${proposal.expiry}:${strategy}:${legs.map(l => l.canonicalId).join(":")}`;
  if (input.priorCandidateKeys?.includes(key)) return hold("DUPLICATE_CANDIDATE");
  const base: CandidateBase = { version: "TRADE_CANDIDATE_V2", executionAuthority: "NONE",
    underlying: snapshot.underlying, expiry: proposal.expiry, direction: proposal.direction, evaluatedAt,
    dataMode: snapshot.dataMode, source: snapshot.source, snapshotVersion: snapshot.version,
    optionMasterFingerprint: snapshot.optionMasterFingerprint, indexMasterFingerprint: snapshot.indexMasterFingerprint,
    configVersion: c.version, evaluatorVersion: STRATEGY_EVALUATOR_VERSION, selectionConfig: selectedConfig,
    analyticsEvidenceId: analyticsEvidenceId(snapshot), confidence: proposal.confidence, candidateKey: key,
    quantityUnits: lot, legs, entryCashFlowPerUnitMinor: Number(cash), maxLossPerUnitMinor: Number(loss),
    maxLossPerLotMinor: Number(loss * BigInt(lot)), maxProfitPerUnitMinor: profit === null ? null : Number(profit),
    maxProfitPerLotMinor: profit === null ? null : Number(profit * BigInt(lot)) };
  let candidate: TradeCandidate;
  if (family === "CREDIT_VERTICAL") candidate = { ...base, strategyFamily: family,
    strategyKind: bull ? "BULL_PUT_CREDIT_SPREAD" : "BEAR_CALL_CREDIT_SPREAD", strategy: bull ? "BULL_PUT_SPREAD" : "BEAR_CALL_SPREAD",
    short: legs[0]!, hedge: legs[1]!, widthMinor: c.widthMinor, creditPerUnitMinor: Number(cash), creditPerLotMinor: Number(cash * BigInt(lot)) };
  else if (family === "DEBIT_VERTICAL") candidate = { ...base, strategyFamily: family,
    strategyKind: bull ? "BULL_CALL_DEBIT_SPREAD" : "BEAR_PUT_DEBIT_SPREAD", strategy: bull ? "BULL_CALL_DEBIT_SPREAD" : "BEAR_PUT_DEBIT_SPREAD",
    widthMinor: c.widthMinor, debitPerUnitMinor: Number(-cash), debitPerLotMinor: Number(-cash * BigInt(lot)) };
  else candidate = { ...base, strategyFamily: family, strategyKind: bull ? "LONG_CALL" : "LONG_PUT", strategy: bull ? "LONG_CALL" : "LONG_PUT",
    widthMinor: null, debitPerUnitMinor: Number(-cash), debitPerLotMinor: Number(-cash * BigInt(lot)),
    maxProfitPerUnitMinor: null, maxProfitPerLotMinor: null };
  issuedCandidates.set(candidate, snapshot);
  return freeze({ action: "CANDIDATE", candidate });
}
