import { createHash } from "node:crypto";
import type { AssetKey } from "../config/assets";
import { freeze, marketTimestamp } from "../domain/kiteMarketData";
import { STRATEGY_EVALUATOR_VERSION, type TradeCandidate, type StrategyFamily, type StrategyKind } from "../domain/strategyEvaluation";
import { BacktestError, deterministicReplayProposal, evaluateHistoricalBar, istSession,
  normalizeBacktestParams, prepareReplay, REPLAY_VERSION, type BacktestRunParams,
  type HistoricalReplayProvider, type HistoricalOptionQuote, type ReplayProposalSource } from "../domain/historicalReplay";
export { BacktestError, normalizeBacktestParams } from "../domain/historicalReplay";
export type { BacktestRunParams } from "../domain/historicalReplay";

export const SLIPPAGE_MODEL_VERSION = "ADVERSE_FIXED_PAISE_PER_LEG_V1";
export interface BacktestTrade {
  tradeId: string; strategy: TradeCandidate["strategy"]; strategyFamily: StrategyFamily; strategyKind: StrategyKind;
  legs: Array<{ side: "BUY" | "SELL"; canonicalId: string; instrumentToken: string; strike: number;
    quantityUnits: number; entryFillMinor: number; exitFillMinor: number }>;
  capitalReserved: number; entryDebit: number | null;
  entryTimestamp: string; exitTimestamp: string; entrySpot: number; exitSpot: number;
  barsHeld: number; lots: number; quantityUnits: number; optionType: "CALL" | "PUT";
  sellStrike: number | null; buyStrike: number; width: number | null;
  /** Rupees per contract unit (legacy field, now explicit). */
  credit: number | null; breakeven: number; maxProfit: number | null; maxLoss: number; pnl: number;
  grossPnL: number; slippageCost: number; pnlMinor: number;
  exitReason: "TARGET_HIT" | "STOP_HIT" | "DIRECTIONAL_STOP" | "TIME_EXIT" | "EOD_CLOSE" | "END_OF_DATA";
  entryEvidenceId: string; shortCanonicalId?: string; hedgeCanonicalId?: string; masterFingerprint: string;
  shortInstrumentToken?: string; hedgeInstrumentToken?: string;
  entryShortFillMinor?: number; entryHedgeFillMinor?: number; exitShortFillMinor?: number; exitHedgeFillMinor?: number;
}
export type BacktestBlockReasons = Record<string, number>;
export interface BacktestDecision {
  evaluatedAt: string; direction: "BULLISH" | "BEARISH" | "HOLD"; confidence: number;
  proposalReason: string; analyticsEvidenceId: string | null;
  strategyAction: "CANDIDATE" | "HOLD"; strategyReason: string;
  simulationReason: string | null; strategyFamily: StrategyFamily; strategyKind: StrategyKind | null;
}
export interface BacktestResult {
  provider: "FIXTURE" | "KITE_ARCHIVE"; asset: AssetKey; interval: string; from: string; to: string;
  strategyFamily: StrategyFamily; peakCapitalReserved: number;
  dataMode: "HISTORICAL_REPLAY"; executionAuthority: "NONE"; status: "COMPLETE" | "INCOMPLETE";
  dataPoints: number; initialCapital: number; finalCapital: number; netPnL: number; grossPnL: number;
  slippageCost: number; totalSignals: number; totalBlocked: number; totalTraded: number;
  blockReasons: BacktestBlockReasons; strategyReasons: Record<string, number>;
  totalTrades: number; wins: number; losses: number; winRate: number; avgPnLPerTrade: number;
  averageWinner: number; averageLoser: number; profitFactor: number | null; expectancy: number;
  maxDrawdown: number; equityCurve: Array<{ timestamp: string; equity: number }>;
  trades: BacktestTrade[]; decisions: BacktestDecision[]; strikesAdjustedForSR: 0;
  missingExitObservations: number;
  missingEntryObservations: number;
  completeness: { version: "REPLAY_COMPLETENESS_V1"; missingCandleCoverage: number;
    truncatedCoverage: boolean; missingRequiredOptionObservations: number;
    unavailableRequiredAnalytics: number; incompleteContractUniverse: number };
  unresolvedPositions: Array<{ tradeId: string; entryTimestamp: string; reason: "MISSING_EXIT_EVIDENCE" }>;
  metadata: { runId: string; runTimestamp: string; replayVersion: string; strategyEvaluatorVersion: string;
    analyticsVersion: string; indicatorVersion: string; greeksVersion: string; proposalSourceVersion: string;
    slippageModelVersion: string; fillModelVersion: string; dataVersion: string; dataFingerprint: string;
    masterFingerprint: string; sourceReference: string; config: ReturnType<typeof normalizeBacktestParams>;
    underlyingCanonicalId: string; underlyingInstrumentToken: string; masterAcquiredAt: string;
    monetaryUnit: "INR"; accountingUnit: "PAISE"; pnlBasis: "AFTER_SLIPPAGE_EXCLUDING_BROKERAGE_AND_TAX";
    drawdownBasis: "REALIZED_EQUITY"; historicalIdentity: "TRUSTED_PROVIDER_ARCHIVE" | "FIXTURE_ONLY" };
}
interface SimPosition {
  id: string; candidate: TradeCandidate; entryIndex: number; entrySpotMinor: number; lots: number;
  units: bigint; entryCashFlowMinor: bigint; reserveMinor: bigint; entryAtr: number;
  maxLossMinor: bigint; maxProfitMinor: bigint | null; entryFillsMinor: number[]; evidenceId: string;
}
const safe = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new BacktestError("SIMULATION_MONEY_OVERFLOW");
  return Number(value);
};
const rupees = (value: bigint) => safe(value) / 100;
const count = (record: Record<string, number>, reason: string) => { record[reason] = (record[reason] ?? 0) + 1; };
const aliases: Record<string, string> = { CONFIDENCE_TOO_LOW: "low_confidence", ATR_GATE: "high_volatility_atr",
  RSI_GATE: "rsi_exhausted", OPENING_BLOCK: "opening_volatility", VOLUME_GATE: "low_volume", CREDIT_GATE: "insufficient_credit" };

/** In-memory research accounting only. Never calls a production execution or financial persistence service. */
export async function runHistoricalBacktest(params: BacktestRunParams, dependencies: {
  provider?: HistoricalReplayProvider; proposalSource?: ReplayProposalSource; runTimestamp?: string;
} = {}): Promise<BacktestResult> {
  const config = normalizeBacktestParams(params);
  if (!dependencies.provider) throw new BacktestError("HISTORICAL_OPTION_ARCHIVE_NOT_CONFIGURED", 503);
  const source = dependencies.proposalSource ?? deterministicReplayProposal;
  const proposalSource = Object.freeze({ version: source.version, propose: source.propose.bind(source) });
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(proposalSource.version)) throw new BacktestError("INVALID_PROPOSAL_VERSION");
  const runTimestamp = marketTimestamp(dependencies.runTimestamp ?? new Date().toISOString()); // Metadata only.
  const raw = await dependencies.provider.load(freeze({ asset: config.asset, from: config.from, to: config.to, interval: config.interval }));
  const replay = prepareReplay(raw, config);
  const from = Date.parse(config.from), to = Date.parse(config.to);
  const indexes = replay.data.candles.map((c, i) => ({ i, end: Date.parse(c.timestamp) + replay.durationMs }))
    .filter(c => c.end >= from && c.end <= to);
  if (!indexes.length) throw new BacktestError("NO_HISTORICAL_BARS_IN_RANGE");
  let equity = BigInt(Math.round(config.initialCapital * 100)), peak = equity, drawdown = 0n;
  let totalSignals = 0, totalBlocked = 0, totalTraded = 0;
  let peakCapitalReserved = 0n;
  let missingExitObservations = 0, missingEntryObservations = 0;
  let missingRequiredOptionObservations = 0, unavailableRequiredAnalytics = 0, incompleteContractUniverse = 0;
  const trades: BacktestTrade[] = [], decisions: BacktestDecision[] = [];
  const equityCurve = [{ timestamp: config.from, equity: rupees(equity) }];
  const blockReasons: Record<string, number> = { duplicate_strategy: 0, same_direction_open: 0,
    max_positions: 0, daily_limit: 0, low_confidence: 0, time_restriction: 0 };
  const strategyReasons: Record<string, number> = {}, daily = new Map<string, number>();
  const openedToday = new Set<string>();
  let open: SimPosition[] = [];
  const slip = BigInt(config.slippageMinorPerLeg);
  const close = (pos: SimPosition, quotes: readonly HistoricalOptionQuote[], spot: number, at: string,
    forced?: BacktestTrade["exitReason"]): boolean => {
    const c = pos.candidate;
    const observations = c.legs.map(leg => quotes.find(q => q.canonicalId === leg.canonicalId));
    if (observations.some((q, i) => !q || BigInt(c.legs[i]!.side === "BUY" ? q.bidQuantity : q.askQuantity) < pos.units
      || c.legs[i]!.side === "BUY" && BigInt(q.bidMinor) < slip)) { missingExitObservations++; return false; }
    const rawExitCash = observations.reduce((sum, q, i) => sum + (c.legs[i]!.side === "BUY"
      ? BigInt(q!.bidMinor) : -BigInt(q!.askMinor)), 0n);
    // Debit liquidation is signed executable cash flow, not the expiration payoff.
    // Overlapping books may require an additional debit to close valid quoted legs.
    if (c.strategyFamily === "CREDIT_VERTICAL"
      && (rawExitCash > 0n || rawExitCash < -BigInt(c.widthMinor))) { missingExitObservations++; return false; }
    const exitCash = rawExitCash - BigInt(c.legs.length) * slip;
    const pnl = (pos.entryCashFlowMinor + exitCash) * pos.units;
    const exitFills = observations.map((q, i) => safe(c.legs[i]!.side === "BUY" ? BigInt(q!.bidMinor) - slip : BigInt(q!.askMinor) + slip));
    const held = replay.expectedBarIndex(at) - pos.entryIndex;
    let reason = forced;
    const stopBase = c.strategyFamily === "CREDIT_VERTICAL" ? pos.reserveMinor : pos.maxLossMinor;
    const stopFraction = c.strategyFamily === "LONG_OPTION" ? config.stopLossPctOfPremium : config.stopLossPct;
    const targetBase = c.strategyFamily === "LONG_OPTION" ? pos.maxLossMinor : pos.maxProfitMinor!;
    const targetFraction = c.strategyFamily === "LONG_OPTION" ? config.takeProfitPctOfPremium : config.targetProfitPct;
    if (!reason && pnl <= -(stopBase * BigInt(Math.round(stopFraction * 100))) / 100n) reason = "STOP_HIT";
    if (!reason && config.directionalStopMult !== null && held >= config.directionalStopMinBars) {
      const move = (spot - pos.entrySpotMinor) / 100 * (c.direction === "BULLISH" ? 1 : -1);
      if (move < -pos.entryAtr * config.directionalStopMult) reason = "DIRECTIONAL_STOP";
    }
    if (!reason && pnl >= targetBase * BigInt(Math.round(targetFraction * 100)) / 100n) reason = "TARGET_HIT";
    if (!reason && held >= config.maxHoldingBars) reason = "TIME_EXIT";
    if (!reason) return false;
    equity += pnl;
    // Realize valid debit closes even when execution loss exceeds the entry reserve.
    // Existing capacity checks reject subsequent entries when equity is exhausted.
    if (equity < 0n && c.strategyFamily !== "DEBIT_VERTICAL") throw new BacktestError("SIMULATION_CAPITAL_INVARIANT");
    const buyIndex = c.legs.findIndex(l => l.side === "BUY"), sellIndex = c.legs.findIndex(l => l.side === "SELL");
    const buy = c.legs[buyIndex]!, sell = c.legs[sellIndex];
    const premium = c.strategyFamily === "CREDIT_VERTICAL" ? pos.entryCashFlowMinor : -pos.entryCashFlowMinor;
    const breakStrike = c.strategyFamily === "CREDIT_VERTICAL" ? sell!.instrument.strikeMinor : buy.instrument.strikeMinor;
    trades.push({ tradeId: pos.id, strategy: c.strategy, strategyFamily: c.strategyFamily, strategyKind: c.strategyKind,
      entryTimestamp: c.evaluatedAt, exitTimestamp: at, entrySpot: pos.entrySpotMinor / 100, exitSpot: spot / 100,
      barsHeld: held, lots: pos.lots, quantityUnits: safe(pos.units), optionType: buy.instrument.instrumentType === "PE" ? "PUT" : "CALL",
      sellStrike: sell ? sell.instrument.strikeMinor / 100 : null, buyStrike: buy.instrument.strikeMinor / 100,
      width: c.widthMinor === null ? null : c.widthMinor / 100,
      credit: c.strategyFamily === "CREDIT_VERTICAL" ? rupees(premium) : null,
      entryDebit: c.strategyFamily === "CREDIT_VERTICAL" ? null : rupees(premium * pos.units),
      breakeven: breakStrike / 100 + (buy.instrument.instrumentType === "CE" ? 1 : -1) * rupees(premium),
      maxProfit: pos.maxProfitMinor === null ? null : rupees(pos.maxProfitMinor), maxLoss: rupees(pos.maxLossMinor),
      capitalReserved: rupees(pos.reserveMinor), pnl: rupees(pnl), pnlMinor: safe(pnl),
      grossPnL: rupees((BigInt(c.entryCashFlowPerUnitMinor) + rawExitCash) * pos.units),
      slippageCost: rupees(2n * BigInt(c.legs.length) * slip * pos.units), exitReason: reason,
      entryEvidenceId: pos.evidenceId, masterFingerprint: c.optionMasterFingerprint,
      legs: c.legs.map((leg, i) => ({ side: leg.side, canonicalId: leg.canonicalId, instrumentToken: leg.instrument.instrumentToken,
        strike: leg.instrument.strikeMinor / 100, quantityUnits: safe(pos.units), entryFillMinor: pos.entryFillsMinor[i]!, exitFillMinor: exitFills[i]! })),
      ...(c.strategyFamily === "CREDIT_VERTICAL" ? { shortCanonicalId: c.short.canonicalId, hedgeCanonicalId: c.hedge.canonicalId,
        shortInstrumentToken: c.short.instrument.instrumentToken, hedgeInstrumentToken: c.hedge.instrument.instrumentToken,
        entryShortFillMinor: pos.entryFillsMinor[0]!, entryHedgeFillMinor: pos.entryFillsMinor[1]!,
        exitShortFillMinor: exitFills[0]!, exitHedgeFillMinor: exitFills[1]! } : {}) });
    return true;
  };
  for (const { i, end } of indexes) {
    const candle = replay.data.candles[i]!, at = new Date(end).toISOString(), session = istSession(end);
    const quotes = replay.quotesAt(at);
    let exited = false;
    open = open.filter(pos => {
      const overdue = istSession(Date.parse(pos.candidate.evaluatedAt)).date < session.date || session.minute >= config.eodCloseMinute;
      const terminal = end + replay.durationMs > to;
      const done = close(pos, quotes, candle.closeMinor, at, overdue ? "EOD_CLOSE" : terminal ? "END_OF_DATA" : undefined);
      if (done) exited = true;
      return !done;
    });
    const evaluation = evaluateHistoricalBar(replay, i, config, proposalSource);
    if (evaluation.evidenceIssue) {
      missingEntryObservations++;
      if (evaluation.evidenceIssue === "MISSING_REQUIRED_OPTION_OBSERVATION") missingRequiredOptionObservations++;
      else if (evaluation.evidenceIssue === "UNAVAILABLE_REQUIRED_ANALYTICS") unavailableRequiredAnalytics++;
      else incompleteContractUniverse++;
    }
    const record: BacktestDecision = { evaluatedAt: at, direction: evaluation.proposal.direction,
      confidence: evaluation.proposal.confidence, proposalReason: evaluation.proposalReason,
      analyticsEvidenceId: evaluation.analyticsEvidenceId, strategyAction: evaluation.result.action,
      strategyReason: evaluation.result.action === "HOLD" ? evaluation.result.reason : "CANDIDATE", simulationReason: null,
      strategyFamily: config.strategyFamily, strategyKind: evaluation.result.action === "CANDIDATE" ? evaluation.result.candidate.strategyKind : null };
    decisions.push(record);
    if (evaluation.proposal.direction !== "HOLD") totalSignals++;
    if (evaluation.result.action === "HOLD") {
      count(strategyReasons, evaluation.result.reason);
      if (evaluation.proposal.direction !== "HOLD") { totalBlocked++; count(blockReasons, aliases[evaluation.result.reason] ?? evaluation.result.reason); }
    } else {
      const c = evaluation.result.candidate;
      let blocked: string | null = null;
      if (evaluation.evidenceIssue) blocked = "incomplete_historical_evidence";
      else if (exited) blocked = "same_bar_exit";
      else if (open.some(p => istSession(Date.parse(p.candidate.evaluatedAt)).date < session.date)) blocked = "unresolved_previous_session";
      else if (end + replay.durationMs > to || session.minute >= config.entryCutoffMinute) blocked = "time_restriction";
      else if (open.length >= config.maxPositions) blocked = "max_positions";
      else if ((daily.get(session.date) ?? 0) >= config.maxDailyTrades) blocked = "daily_limit";
      else if (openedToday.has(`${session.date}:${c.candidateKey}`)) blocked = "duplicate_strategy";
      else if (open.some(p => p.candidate.direction === c.direction)) blocked = "same_direction_open";
      const entryCash = BigInt(c.entryCashFlowPerUnitMinor) - BigInt(c.legs.length) * slip;
      const lotUnits = BigInt(c.quantityUnits);
      const lossPerUnit = c.strategyFamily === "CREDIT_VERTICAL" ? BigInt(c.widthMinor) - entryCash + 2n * slip : -entryCash;
      // Debit vertical closing costs need a simulation buffer; contractual max loss remains debit paid.
      const reservePerLot = (lossPerUnit + (c.strategyFamily === "DEBIT_VERTICAL" ? 2n * slip : 0n)) * lotUnits;
      const used = open.reduce((sum, pos) => sum + pos.reserveMinor, 0n);
      const available = equity - used;
      const budget = equity * BigInt(Math.round(config.riskPerTradePct * 100)) / 10000n;
      let lots = reservePerLot > 0n ? (budget < available ? budget : available) / reservePerLot : 0n;
      const observations = c.legs.map(leg => quotes.find(q => q.canonicalId === leg.canonicalId)!);
      const depthLots = observations.reduce((limit, q, i) => {
        const depth = BigInt(c.legs[i]!.side === "BUY" ? q.askQuantity : q.bidQuantity) / lotUnits;
        return depth < limit ? depth : limit;
      }, lots);
      lots = depthLots;
      const entryFills = c.legs.map(leg => safe(BigInt(leg.priceMinor) + (leg.side === "BUY" ? slip : -slip)));
      if (!blocked && (entryFills.some(price => price <= 0) || c.strategyFamily === "CREDIT_VERTICAL" && entryCash <= 0n
        || c.strategyFamily === "DEBIT_VERTICAL" && -entryCash >= BigInt(c.widthMinor))) blocked = "simulation_cost_rejection";
      if (!blocked && lots < 1n) blocked = "insufficient_simulated_capacity";
      if (blocked) { record.simulationReason = blocked; totalBlocked++; count(blockReasons, blocked); }
      else {
        const units = lots * lotUnits;
        const profitPerUnit = c.strategyFamily === "LONG_OPTION" ? null : c.strategyFamily === "CREDIT_VERTICAL" ? entryCash : BigInt(c.widthMinor) + entryCash;
        open.push({ id: `bt-${config.asset}-${at}-${totalTraded + 1}`, candidate: c, entryIndex: replay.expectedBarIndex(at),
          entrySpotMinor: candle.closeMinor, lots: safe(lots), units, entryCashFlowMinor: entryCash,
          reserveMinor: reservePerLot * lots, maxLossMinor: lossPerUnit * units,
          maxProfitMinor: profitPerUnit === null ? null : profitPerUnit * units,
          entryAtr: evaluation.analytics.available ? evaluation.analytics.snapshot.indicators.values.atr! : 0,
          entryFillsMinor: entryFills, evidenceId: c.analyticsEvidenceId });
        if (used + reservePerLot * lots > peakCapitalReserved) peakCapitalReserved = used + reservePerLot * lots;
        totalTraded++; daily.set(session.date, (daily.get(session.date) ?? 0) + 1);
        openedToday.add(`${session.date}:${c.candidateKey}`); record.simulationReason = "OPENED";
      }
    }
    if (equity > peak) peak = equity;
    if (peak - equity > drawdown) drawdown = peak - equity;
    equityCurve.push({ timestamp: at, equity: rupees(equity) });
  }
  const gain = trades.filter(t => t.pnlMinor > 0).reduce((n, t) => n + BigInt(t.pnlMinor), 0n);
  const loss = -trades.filter(t => t.pnlMinor < 0).reduce((n, t) => n + BigInt(t.pnlMinor), 0n);
  const wins = trades.filter(t => t.pnlMinor > 0).length, losses = trades.filter(t => t.pnlMinor < 0).length;
  const netPnL = rupees(equity - BigInt(Math.round(config.initialCapital * 100)));
  const slippage = trades.reduce((n, t) => n + 2n * BigInt(t.legs.length) * slip * BigInt(t.quantityUnits), 0n);
  const runId = createHash("sha256").update(JSON.stringify({ replay: REPLAY_VERSION, strategy: STRATEGY_EVALUATOR_VERSION,
    source: proposalSource.version, data: replay.fingerprint, config })).digest("hex");
  return freeze({ provider: replay.data.source, asset: config.asset, strategyFamily: config.strategyFamily,
    peakCapitalReserved: rupees(peakCapitalReserved), interval: config.interval, from: config.from, to: config.to,
    dataMode: "HISTORICAL_REPLAY", executionAuthority: "NONE",
    status: open.length || missingExitObservations || missingEntryObservations || replay.missingCandleCoverage
      || replay.truncatedCoverage ? "INCOMPLETE" : "COMPLETE",
    dataPoints: indexes.length, initialCapital: config.initialCapital, finalCapital: rupees(equity), netPnL,
    grossPnL: rupees(gain - loss + slippage), slippageCost: rupees(slippage), totalSignals, totalBlocked, totalTraded,
    blockReasons, strategyReasons, totalTrades: trades.length, wins, losses, winRate: trades.length ? wins / trades.length * 100 : 0,
    avgPnLPerTrade: trades.length ? netPnL / trades.length : 0, averageWinner: wins ? rupees(gain) / wins : 0,
    averageLoser: losses ? -rupees(loss) / losses : 0, profitFactor: loss ? safe(gain) / safe(loss) : null,
    expectancy: trades.length ? netPnL / trades.length : 0, maxDrawdown: rupees(drawdown), equityCurve, trades, decisions,
    strikesAdjustedForSR: 0, missingExitObservations, missingEntryObservations,
    completeness: { version: "REPLAY_COMPLETENESS_V1", missingCandleCoverage: replay.missingCandleCoverage,
      truncatedCoverage: replay.truncatedCoverage, missingRequiredOptionObservations,
      unavailableRequiredAnalytics, incompleteContractUniverse },
    unresolvedPositions: open.map(p => ({ tradeId: p.id,
      entryTimestamp: p.candidate.evaluatedAt, reason: "MISSING_EXIT_EVIDENCE" })),
    metadata: { runId, runTimestamp, replayVersion: REPLAY_VERSION, strategyEvaluatorVersion: STRATEGY_EVALUATOR_VERSION,
      analyticsVersion: "MARKET_ANALYTICS_V1", indicatorVersion: "INDICATORS_V1", greeksVersion: "QUALIFIED_BSM_IV_V1",
      proposalSourceVersion: proposalSource.version, slippageModelVersion: SLIPPAGE_MODEL_VERSION,
      fillModelVersion: "CONTEMPORANEOUS_QUOTE_CLOSE_ONLY_V1", dataVersion: replay.data.dataVersion,
      dataFingerprint: replay.fingerprint, masterFingerprint: replay.data.master.provenance.sourceFingerprint,
      underlyingCanonicalId: replay.data.index.canonicalId, underlyingInstrumentToken: replay.data.index.instrumentToken,
      masterAcquiredAt: replay.data.master.provenance.retrievedAt,
      sourceReference: replay.data.sourceReference, config, monetaryUnit: "INR", accountingUnit: "PAISE",
      pnlBasis: "AFTER_SLIPPAGE_EXCLUDING_BROKERAGE_AND_TAX", drawdownBasis: "REALIZED_EQUITY",
      historicalIdentity: replay.data.source === "FIXTURE" ? "FIXTURE_ONLY" : "TRUSTED_PROVIDER_ARCHIVE" } });
}
export function getDefaultBacktestParams(asset: AssetKey, input: Partial<BacktestRunParams>): ReturnType<typeof normalizeBacktestParams> {
  return normalizeBacktestParams({ ...input, asset }); // Dates are required; no wall-clock defaults in replay.
}
