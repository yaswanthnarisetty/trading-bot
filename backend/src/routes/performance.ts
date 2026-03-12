import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { SignalLogModel } from "../models/SignalLog";
import { OptionsPositionModel } from "../models/OptionsPosition";
import { MonitoringSessionModel } from "../models/MonitoringSession";
import type { OptionsPosition } from "@trading-bot/shared";
import { authMiddleware } from "./auth.middleware";
const router = Router();

interface EquityPoint {
  timestamp: string;
  pnl: number;
}

interface RollingWinRatePoint {
  index: number;
  winRate: number;
}

interface StrategyDistribution {
  BULL_PUT_SPREAD: number;
  BEAR_CALL_SPREAD: number;
  HOLD: number;
}

interface ExitReasonCounts {
  TARGET_HIT: number;
  SL_HIT: number;
  TIME_EXIT: number;
  EOD_FORCED_CLOSE: number;
  SESSION_STOP: number;
  NEAR_EXPIRY: number;
  EOD_CLOSE: number;
}

interface ConfidenceAccuracyPoint {
  confidence: number;
  pnl: number;
  strategy: string;
}

interface StrategyStats {
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
}

interface DayStats {
  trades: number;
  winRate: number;
  avgPnL: number;
}

type VsBacktestVerdict =
  | "OUTPERFORMING"
  | "IN_LINE"
  | "UNDERPERFORMING"
  | "INSUFFICIENT_DATA";

// Backtest baseline: NIFTY Feb 2 – Mar 9 2026, lot=50, RSI(30/70)+slope(1) filters, ATR×3.0 dir-stop, slippage=1.5pts
// Note: +₹5,210 (old) was pre-slippage. With correct slippage model, best combo = -₹659 (RSI+slope only, opening+ATR disabled for pure optimization).
// Production run with full filters (opening=15min, ATR=70): -₹8,031 — backtest understates opening/ATR due to cascade artifact.
// The opening/ATR blocks are kept for live risk management; this backtest period is not sufficient for strategy validation.
const BACKTEST_WIN_RATE     = 51.2;  // 21W/20L/41 trades (RSI 30/70 + slope 1 filters, opening+ATR disabled)
const BACKTEST_EXPECTANCY   = -16;   // avg P&L per trade (₹) — borderline viable, requires more data
const BACKTEST_BASELINE_PNL = -659;  // net P&L over period (₹) — best filter combo with slippage model
const BACKTEST_MAX_DD       = 4891;  // max drawdown (₹)
const BACKTEST_TRADES       = 41;
const BACKTEST_PERIOD       = "Feb 2 - Mar 9 2026";

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

function computeProfitFactor(trades: OptionsPosition[]): number {
  const grossWins   = trades.reduce((s, t) => s + Math.max(0, t.realizedPnL ?? 0), 0);
  const grossLosses = trades.reduce((s, t) => s + Math.abs(Math.min(0, t.realizedPnL ?? 0)), 0);
  return grossLosses === 0 ? (grossWins > 0 ? Infinity : 0) : grossWins / grossLosses;
}
signal

function computeExpectancy(trades: OptionsPosition[]): number {
  if (trades.length === 0) return 0;
  const wins   = trades.filter((t) => (t.realizedPnL ?? 0) > 0);
  const losses = trades.filter((t) => (t.realizedPnL ?? 0) <= 0);
  const winRate  = wins.length / trades.length;
  const lossRate = losses.length / trades.length;
  const avgWin  = wins.length   === 0 ? 0 : wins.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / wins.length;
  const avgLoss = losses.length === 0 ? 0 : Math.abs(losses.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / losses.length);
  return parseFloat(((winRate * avgWin) - (lossRate * avgLoss)).toFixed(2));
}

function computeMaxConsecutiveLosses(trades: OptionsPosition[]): number {
  let max = 0;
  let streak = 0;
  for (const t of trades) {
    if ((t.realizedPnL ?? 0) < 0) {
      streak++;
      if (streak > max) max = streak;
    } else {
      streak = 0;
    }
  }
  return max;
}

function buildByStrategy(trades: OptionsPosition[]): Record<string, StrategyStats> {
  const result: Record<string, StrategyStats> = {
    BULL_PUT_SPREAD: { trades: 0, wins: 0, pnl: 0, winRate: 0 },
    BEAR_CALL_SPREAD: { trades: 0, wins: 0, pnl: 0, winRate: 0 },
  };
  for (const t of trades) {
    const key = t.strategy;
    if (!(key in result)) continue;
    result[key]!.trades++;
    result[key]!.pnl += t.realizedPnL ?? 0;
    if ((t.realizedPnL ?? 0) > 0) result[key]!.wins++;
  }
  for (const s of Object.values(result)) {
    s.winRate = s.trades === 0 ? 0 : parseFloat(((s.wins / s.trades) * 100).toFixed(1));
    s.pnl     = parseFloat(s.pnl.toFixed(2));
  }
  return result;
}

function buildByDayOfWeek(trades: OptionsPosition[]): Record<string, DayStats> {
  const buckets: Record<string, { pnlSum: number; count: number; wins: number }> = {};

  for (const t of trades) {
    // Convert entryTimestamp to IST day (IST = UTC+5:30)
    const utcMs   = new Date(t.entryTimestamp).getTime();
    const istMs   = utcMs + 5.5 * 60 * 60 * 1000;
    const dayName = DAY_NAMES[new Date(istMs).getUTCDay()]!;
    if (!buckets[dayName]) buckets[dayName] = { pnlSum: 0, count: 0, wins: 0 };
    buckets[dayName]!.pnlSum += t.realizedPnL ?? 0;
    buckets[dayName]!.count++;
    if ((t.realizedPnL ?? 0) > 0) buckets[dayName]!.wins++;
  }

  const result: Record<string, DayStats> = {};
  for (const [day, b] of Object.entries(buckets)) {
    result[day] = {
      trades:  b.count,
      winRate: b.count === 0 ? 0 : parseFloat(((b.wins / b.count) * 100).toFixed(1)),
      avgPnL:  b.count === 0 ? 0 : parseFloat((b.pnlSum / b.count).toFixed(2)),
    };
  }
  return result;
}

function buildVsBacktest(
  totalTrades: number,
  winRate: number,
  expectancy: number
): {
  backtestWinRate: number;
  liveWinRate: number;
  backtestExpectancy: number;
  liveExpectancy: number;
  backtestBaselinePnL: number;
  backtestMaxDD: number;
  backtestTrades: number;
  backtestPeriod: string;
  verdict: VsBacktestVerdict;
} {
  let verdict: VsBacktestVerdict = "INSUFFICIENT_DATA";
  if (totalTrades >= 10) {
    if (winRate >= BACKTEST_WIN_RATE) verdict = "OUTPERFORMING";
    else if (winRate >= BACKTEST_WIN_RATE * 0.85) verdict = "IN_LINE";
    else verdict = "UNDERPERFORMING";
  }
  return {
    backtestWinRate:     BACKTEST_WIN_RATE,
    liveWinRate:         parseFloat(winRate.toFixed(1)),
    backtestExpectancy:  BACKTEST_EXPECTANCY,
    liveExpectancy:      expectancy,
    backtestBaselinePnL: BACKTEST_BASELINE_PNL,
    backtestMaxDD:       BACKTEST_MAX_DD,
    backtestTrades:      BACKTEST_TRADES,
    backtestPeriod:      BACKTEST_PERIOD,
    verdict,
  };
}

function buildEquityCurve(trades: OptionsPosition[]): EquityPoint[] {
  const points: EquityPoint[] = [];
  let cumulative = 0;
  for (const trade of trades) {
    cumulative += trade.realizedPnL ?? 0;
    points.push({
      timestamp: trade.exitTimestamp ?? trade.entryTimestamp,
      pnl: cumulative,
    });
  }
  return points;
}

function buildRollingWinRate(trades: OptionsPosition[]): RollingWinRatePoint[] {
  const windowSize = 20;
  const points: RollingWinRatePoint[] = [];
  for (let i = 0; i < trades.length; i += 1) {
    const start = Math.max(0, i - windowSize + 1);
    const window = trades.slice(start, i + 1);
    const wins = window.filter((t) => (t.realizedPnL ?? 0) > 0).length;
    const winRate = window.length === 0 ? 0 : (wins / window.length) * 100;
    points.push({ index: i, winRate });
  }
  return points;
}

function computeMaxDrawdown(trades: OptionsPosition[]): number {
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const trade of trades) {
    cumulative += trade.realizedPnL ?? 0;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function computeAvgHoldingMinutes(trades: OptionsPosition[]): number {
  const times = trades
    .filter((t) => t.entryTimestamp && t.exitTimestamp)
    .map(
      (t) =>
        (new Date(t.exitTimestamp!).getTime() -
          new Date(t.entryTimestamp).getTime()) /
        60_000
    );
  if (times.length === 0) return 0;
  return times.reduce((a, b) => a + b, 0) / times.length;
}

function buildExitReasonCounts(trades: OptionsPosition[]): ExitReasonCounts {
  const counts: ExitReasonCounts = {
    TARGET_HIT: 0,
    SL_HIT: 0,
    TIME_EXIT: 0,
    EOD_FORCED_CLOSE: 0,
    SESSION_STOP: 0,
    NEAR_EXPIRY: 0,
    EOD_CLOSE: 0,
  };
  for (const trade of trades) {
    const r = trade.exitReason;
    if (r && r in counts) {
      (counts as unknown as Record<string, number>)[r] += 1;
    }
  }
  return counts;
}

async function buildStrategyDistribution(
  sessionId: string
): Promise<StrategyDistribution> {
  const logs = await SignalLogModel.find({ sessionId }).exec();
  const distribution: StrategyDistribution = {
    BULL_PUT_SPREAD: 0,
    BEAR_CALL_SPREAD: 0,
    HOLD: 0,
  };
  for (const log of logs) {
    const strategy = log.signal.strategy;
    if (strategy in distribution) {
      (distribution as unknown as Record<string, number>)[strategy] += 1;
    }
  }
  return distribution;
}

async function buildConfidenceAccuracy(
  sessionId: string,
  trades: OptionsPosition[]
): Promise<ConfidenceAccuracyPoint[]> {
  const logs = await SignalLogModel.find({ sessionId })
    .sort({ timestamp: 1 })
    .exec();
  const points: ConfidenceAccuracyPoint[] = [];
  for (const trade of trades) {
    const entryTime = new Date(trade.entryTimestamp);
    const candidate = [...logs]
      .filter((l) => l.timestamp <= entryTime)
      .pop();
    if (!candidate) continue;
    points.push({
      confidence: candidate.signal.confidence,
      pnl: trade.realizedPnL ?? 0,
      strategy: candidate.signal.strategy,
    });
  }
  return points;
}

/**
 * GET /api/performance/summary — cross-session aggregated stats.
 * Optional query params: from, to (ISO date strings).
 */
async function handleGetSummary(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { from, to } = req.query;
    const dateFilter: Record<string, unknown> = {};
    if (from || to) {
      dateFilter["exitTimestamp"] = {
        ...(from ? { $gte: String(from) } : {}),
        ...(to ? { $lte: String(to) } : {}),
      };
    }

    const allPositions = await OptionsPositionModel.find({
      status: { $ne: "OPEN" },
      ...dateFilter,
    }).exec();

    const closedTrades = allPositions
      .map((p) => p.toObject() as OptionsPosition)
      .sort((a, b) =>
        (a.exitTimestamp ?? a.entryTimestamp).localeCompare(
          b.exitTimestamp ?? b.entryTimestamp
        )
      );

    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter((t) => (t.realizedPnL ?? 0) > 0).length;
    const netPnL = closedTrades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const winRate = totalTrades === 0 ? 0 : (wins / totalTrades) * 100;
    const avgPnL = totalTrades === 0 ? 0 : netPnL / totalTrades;
    const maxDrawdown = computeMaxDrawdown(closedTrades);
    const avgHoldingMinutes = computeAvgHoldingMinutes(closedTrades);
    const exitReasons = buildExitReasonCounts(closedTrades);

    const sessionCount = await MonitoringSessionModel.countDocuments().exec();

    res.json({
      sessionCount,
      totalTrades,
      winRate,
      netPnL,
      avgPnL,
      maxDrawdown,
      avgHoldingMinutes,
      exitReasons,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/performance/all — per-session analytics for all sessions at once.
 * Optional query params: from, to (ISO date strings for trade filtering).
 */
async function handleGetAllSessionsPerformance(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { from, to } = req.query;

    const dateFilter: Record<string, unknown> = {};
    if (from || to) {
      dateFilter["exitTimestamp"] = {
        ...(from ? { $gte: String(from) } : {}),
        ...(to ? { $lte: String(to) } : {}),
      };
    }

    const [signals, positions] = await Promise.all([
      SignalLogModel.find().exec(),
      OptionsPositionModel.find({
        status: { $ne: "OPEN" },
        ...dateFilter,
      }).exec(),
    ]);

    const closedTrades = positions
      .map(p => p.toObject() as OptionsPosition)
      .sort((a, b) =>
        (a.exitTimestamp ?? a.entryTimestamp)
          .localeCompare(b.exitTimestamp ?? b.entryTimestamp)
      );

    const totalSignals = signals.length;
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter(t => (t.realizedPnL ?? 0) > 0).length;
    const losses = closedTrades.filter(t => (t.realizedPnL ?? 0) < 0).length;
    const netPnL = closedTrades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const winRate = totalTrades === 0 ? 0 : (wins / totalTrades) * 100;
    const avgPnL = totalTrades === 0 ? 0 : netPnL / totalTrades;

    const maxDrawdown = computeMaxDrawdown(closedTrades);
    const avgHoldingMinutes = computeAvgHoldingMinutes(closedTrades);
    const profitFactor = computeProfitFactor(closedTrades);
    const expectancy = computeExpectancy(closedTrades);
    const maxConsecutiveLosses = computeMaxConsecutiveLosses(closedTrades);

    const byStrategy = buildByStrategy(closedTrades);
    const byDayOfWeek = buildByDayOfWeek(closedTrades);
    const exitReasons = buildExitReasonCounts(closedTrades);

    const equityCurve = buildEquityCurve(closedTrades);
    const rollingWinRate = buildRollingWinRate(closedTrades);

    const sortedByPnl = [...closedTrades].sort(
      (a, b) => (a.realizedPnL ?? 0) - (b.realizedPnL ?? 0)
    );

    const worstTrade = sortedByPnl[0] ?? null;
    const bestTrade = sortedByPnl[sortedByPnl.length - 1] ?? null;

    const recentTrades = [...closedTrades].reverse().slice(0, 20);

    res.json({
      totalSignals,
      totalTrades,
      wins,
      losses,
      winRate,
      netPnL,
      avgPnL,
      maxDrawdown,
      avgHoldingMinutes,
      profitFactor,
      expectancy,
      maxConsecutiveLosses,
      byStrategy,
      byDayOfWeek,
      exitReasons,
      equityCurve,
      rollingWinRate,
      bestTrade,
      worstTrade,
      recentTrades,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/performance/:sessionId — per-session analytics.
 * Optional query params: from, to (ISO date strings for trade filtering).
 */
async function handleGetPerformanceForSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionId } = req.params;
    const { from, to } = req.query;

    const positionFilter: Record<string, unknown> = { sessionId };
    if (from || to) {
      positionFilter["exitTimestamp"] = {
        ...(from ? { $gte: String(from) } : {}),
        ...(to ? { $lte: String(to) } : {}),
      };
    }

    const [signals, positions] = await Promise.all([
      SignalLogModel.find({ sessionId }).exec(),
      OptionsPositionModel.find(positionFilter).exec(),
    ]);

    const closedTrades = positions
      .filter((p) => p.status !== "OPEN")
      .map((p) => p.toObject() as OptionsPosition)
      .sort((a, b) =>
        (a.exitTimestamp ?? a.entryTimestamp).localeCompare(
          b.exitTimestamp ?? b.entryTimestamp
        )
      );

    const totalSignals = signals.length;
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter((t) => (t.realizedPnL ?? 0) > 0).length;
    const losses = closedTrades.filter((t) => (t.realizedPnL ?? 0) < 0).length;
    const netPnL = closedTrades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const winRate = totalTrades === 0 ? 0 : (wins / totalTrades) * 100;
    const avgPnL = totalTrades === 0 ? 0 : netPnL / totalTrades;
    const maxDrawdown = computeMaxDrawdown(closedTrades);
    const avgHoldingMinutes = computeAvgHoldingMinutes(closedTrades);
    const exitReasons = buildExitReasonCounts(closedTrades);
    const profitFactor = computeProfitFactor(closedTrades);
    const expectancy   = computeExpectancy(closedTrades);
    const maxConsecutiveLosses = computeMaxConsecutiveLosses(closedTrades);
    const byStrategy   = buildByStrategy(closedTrades);
    const byDayOfWeek  = buildByDayOfWeek(closedTrades);
    const vsBacktest   = buildVsBacktest(totalTrades, winRate, expectancy);

    const equityCurve = buildEquityCurve(closedTrades);
    const rollingWinRate = buildRollingWinRate(closedTrades);
    const strategyDistribution = await buildStrategyDistribution(sessionId);
    const confidenceAccuracy = await buildConfidenceAccuracy(sessionId, closedTrades);

    const sortedByPnl = [...closedTrades].sort(
      (a, b) => (a.realizedPnL ?? 0) - (b.realizedPnL ?? 0)
    );
    const worstTrade = sortedByPnl.length > 0 ? sortedByPnl[0]! : null;
    const bestTrade =
      sortedByPnl.length > 0 ? sortedByPnl[sortedByPnl.length - 1]! : null;

    // Last 20 trades for the recent trades table (most recent first)
    const recentTrades = [...closedTrades].reverse().slice(0, 20);

    // Premium source breakdown across all closed trades
    const premiumSourceCounts = closedTrades.reduce(
      (acc, t) => {
        const src = (t as OptionsPosition & { premiumSource?: string }).premiumSource ?? "BLACK_SCHOLES";
        acc[src] = (acc[src] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    res.json({
      totalSignals,
      totalTrades,
      wins,
      losses,
      winRate,
      netPnL,
      avgPnL,
      maxDrawdown,
      avgHoldingMinutes,
      profitFactor,
      expectancy,
      maxConsecutiveLosses,
      byStrategy,
      byDayOfWeek,
      vsBacktest,
      exitReasons,
      equityCurve,
      rollingWinRate,
      strategyDistribution,
      confidenceAccuracy,
      premiumSourceCounts,
      bestTrade,
      worstTrade,
      recentTrades,
    });
  } catch (error) {
    next(error);
  }
}

// summary must come before /:sessionId so Express doesn't match "summary" as a sessionId
router.get("/summary", authMiddleware, handleGetSummary);
router.get("/all", authMiddleware, handleGetAllSessionsPerformance);
router.get("/:sessionId", authMiddleware, handleGetPerformanceForSession);

export default router;
