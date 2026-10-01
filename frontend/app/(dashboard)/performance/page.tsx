"use client";

import React, { useEffect, useState } from "react";
import EquityCurve from "../../../components/performance/EquityCurve";
import WinRateChart from "../../../components/performance/WinRateChart";
import { useAppContext } from "../../../context/AppContext";
import {
  getPerformance,
  getAllPerformance,
  type PerformanceData,
  type VsBacktestVerdict,
} from "../../../lib/api";
import type { OptionsPosition } from "@trading-bot/shared";
import { getCookie } from "cookies-next";

interface SessionHistoryItem {
  sessionId: string;
  asset: string;
  startTime: string;
  status: "RUNNING" | "STOPPED";
  executionMode?: "LEGACY_PAPER" | "PAPER";
}

async function fetchSessionHistory(): Promise<SessionHistoryItem[]> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const token = getCookie("token");
  const response = await fetch(`${baseUrl}/api/session/history`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : "",
    },
    cache: "no-store",
  });
  const body = (await response.json()) as { sessions: SessionHistoryItem[] };
  return body.sessions.filter(session => session.executionMode !== "PAPER");
}

type DateRange = "today" | "week" | "month" | "all";

function getDateRange(range: DateRange): { from?: string; to?: string } {
  const now = new Date();
  if (range === "all") return {};
  const from = new Date(now);
  if (range === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (range === "week") {
    from.setDate(from.getDate() - 7);
  } else {
    from.setMonth(from.getMonth() - 1);
  }
  return { from: from.toISOString(), to: now.toISOString() };
}

interface KPICardProps {
  label: string;
  value: string;
  color?: string;
  subtitle?: string;
}

function KPICard({ label, value, color, subtitle }: KPICardProps): JSX.Element {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="ui-label mb-1">{label}</div>
      <div
        className="font-mono text-2xl font-bold leading-none"
        style={{ color: color ?? "#e0e0e0" }}
      >
        {value}
      </div>
      {subtitle && (
        <div
          className="mt-1 font-sans text-[0.68rem]"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null) return "—";
  return n.toFixed(decimals);
}

function pnlColor(n: number): string {
  return n >= 0 ? "#00C853" : "#FF1744";
}

function VerdictBanner({ vsBacktest }: { vsBacktest: PerformanceData["vsBacktest"] }): JSX.Element {
  const { verdict, liveWinRate, backtestWinRate, liveExpectancy } = vsBacktest;

  const config: Record<VsBacktestVerdict, { icon: string; text: string; bg: string; border: string; color: string }> = {
    INSUFFICIENT_DATA: {
      icon: "📊",
      text: `Insufficient data — need 10+ trades (have ${liveWinRate.toFixed(0)}% from available trades)`,
      bg: "rgba(100,100,100,0.06)", border: "rgba(150,150,150,0.15)", color: "#888",
    },
    OUTPERFORMING: {
      icon: "✅",
      text: `Performing IN LINE with backtest — Live ${liveWinRate.toFixed(1)}% vs backtest ${backtestWinRate}%`,
      bg: "rgba(0,200,83,0.06)", border: "rgba(0,200,83,0.2)", color: "#00C853",
    },
    IN_LINE: {
      icon: "⚠️",
      text: `Slightly below backtest — Live ${liveWinRate.toFixed(1)}% vs backtest ${backtestWinRate}% — monitor closely`,
      bg: "rgba(255,179,0,0.06)", border: "rgba(255,179,0,0.2)", color: "#FFB300",
    },
    UNDERPERFORMING: {
      icon: "🔴",
      text: `Underperforming backtest — Live ${liveWinRate.toFixed(1)}% vs backtest ${backtestWinRate}% — review needed`,
      bg: "rgba(255,23,68,0.06)", border: "rgba(255,23,68,0.2)", color: "#FF1744",
    },
  };

  const c = config[verdict];
  return (
    <div
      className="mt-3 rounded-xl px-4 py-3 text-sm font-sans"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
    >
      <span className="mr-2">{c.icon}</span>
      <span className="font-semibold">{c.text}</span>
      {verdict !== "INSUFFICIENT_DATA" && (
        <span className="ml-3 text-[0.7rem] opacity-60">
          Expectancy: ₹{liveExpectancy.toFixed(0)} / trade
        </span>
      )}
    </div>
  );
}

function DayOfWeekTable({ byDayOfWeek }: { byDayOfWeek: PerformanceData["byDayOfWeek"] }): JSX.Element {
  const ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const rows = ORDER.map((d) => ({ day: d, ...(byDayOfWeek[d] ?? { trades: 0, winRate: 0, avgPnL: 0 }) }));

  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
    >
      <div className="mb-3 ui-label">Day of Week Breakdown</div>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ color: "rgba(255,255,255,0.35)" }}>
            <th className="pb-2 text-left font-normal">Day</th>
            <th className="pb-2 text-right font-normal">Trades</th>
            <th className="pb-2 text-right font-normal">Win Rate</th>
            <th className="pb-2 text-right font-normal">Avg P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ day, trades, winRate, avgPnL }) => (
            <tr key={day} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
              <td className="py-1.5 text-[#d0d0d0]">{day}</td>
              <td className="py-1.5 text-right" style={{ color: trades === 0 ? "rgba(255,255,255,0.2)" : "#d0d0d0" }}>
                {trades}
              </td>
              <td className="py-1.5 text-right" style={{ color: trades === 0 ? "rgba(255,255,255,0.2)" : winRate >= 50 ? "#00C853" : "#FF1744" }}>
                {trades === 0 ? "—" : `${winRate.toFixed(0)}%`}
              </td>
              <td className="py-1.5 text-right font-semibold" style={{ color: trades === 0 ? "rgba(255,255,255,0.2)" : pnlColor(avgPnL) }}>
                {trades === 0 ? "—" : `${avgPnL >= 0 ? "+" : ""}₹${avgPnL.toFixed(0)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PerformancePage(): JSX.Element {
  const { state } = useAppContext();
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [allPerformances, setAllPerformances] = useState<PerformanceData[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>("all");

  useEffect(() => {
    async function bootstrap() {
      try {
        const history = await fetchSessionHistory();
        setSessions(history);
        const running = history.find((s) => s.status === "RUNNING");
        const mostRecent = history[0];
        const initialId =
          running?.sessionId ?? state.session.id ?? mostRecent?.sessionId ?? "";
        if (initialId) setSelectedSessionId(initialId);
      } catch (error) {
        console.error("Failed to load session history", error);
      }
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function loadPerformance() {
      if (!selectedSessionId) {
        setPerformance(null);
        return;
      }
      setIsLoading(true);
      if (selectedSessionId === "__ALL__") {
  setIsLoading(true);
  try {
    const { from, to } = getDateRange(dateRange);
    const data = await getAllPerformance();
    setPerformance(data);
  } catch (error) {
    console.error("Failed to load aggregated performance", error);
    setPerformance(null);
  } finally {
    setIsLoading(false);
  }
  return;
}
    }
    void loadPerformance();
  }, [selectedSessionId, dateRange]);

  const selectedSession = sessions.find(
    (s) => s.sessionId === selectedSessionId
  );

  const strategyDistribution =
    performance?.strategyDistribution ??
    ({ BULL_PUT_SPREAD: 0, BEAR_CALL_SPREAD: 0, HOLD: 0 } as PerformanceData["strategyDistribution"]);

  const totalStrategies =
    strategyDistribution.BULL_PUT_SPREAD +
    strategyDistribution.BEAR_CALL_SPREAD +
    strategyDistribution.HOLD || 1;

  const strategies = [
    {
      label: "BULL PUT",
      key: "BULL_PUT_SPREAD" as const,
      color: "#00C853",
      barBg: "rgba(0,200,83,0.2)",
    },
    {
      label: "BEAR CALL",
      key: "BEAR_CALL_SPREAD" as const,
      color: "#FF1744",
      barBg: "rgba(255,23,68,0.2)",
    },
    {
      label: "HOLD",
      key: "HOLD" as const,
      color: "#FFB300",
      barBg: "rgba(255,179,0,0.2)",
    },
  ];

  const exitReasonEntries = performance
    ? ([
        ["TARGET_HIT", "#00C853"],
        ["SL_HIT", "#FF1744"],
        ["TIME_EXIT", "#FFB300"],
        ["EOD_FORCED_CLOSE", "#888"],
        ["SESSION_STOP", "#888"],
        ["NEAR_EXPIRY", "#FF6B35"],
        ["EOD_CLOSE", "#888"],
      ] as [keyof PerformanceData["exitReasons"], string][])
    : [];
  const totalExits = performance
    ? Object.values(performance.exitReasons).reduce((a, b) => a + b, 0) || 1
    : 1;

  const dateRangeOptions: { label: string; value: DateRange }[] = [
    { label: "Today", value: "today" },
    { label: "This Week", value: "week" },
    { label: "This Month", value: "month" },
    { label: "All Time", value: "all" },
  ];

  return (
    <div className="space-y-4">
      <p role="note" className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
        LEGACY PERFORMANCE — these metrics use legacy paper records. Durable NSE PAPER ledger performance is deferred to Phase 6C2.
      </p>
      {/* Session selector + date range */}
      <section
        className="rounded-2xl p-4"
        style={{
          background:
            "linear-gradient(135deg, rgba(20,20,20,0.9) 0%, rgba(12,12,12,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="ui-label">Session</span>
            <select
              className="min-w-[240px] rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0] outline-none"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
            >
              <option value="">Select a session…</option>
              <option value="__ALL__">All sessions</option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.asset} · {new Date(s.startTime).toLocaleString()}
                  {s.status === "RUNNING" ? " ● LIVE" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Date range filter */}
          <div className="flex flex-col gap-1">
            <span className="ui-label">Date Range</span>
            <div className="flex gap-1">
              {dateRangeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDateRange(opt.value)}
                  className="rounded-lg px-3 py-2 text-xs font-mono transition-all"
                  style={{
                    background:
                      dateRange === opt.value
                        ? "rgba(255,255,255,0.12)"
                        : "rgba(255,255,255,0.04)",
                    border:
                      dateRange === opt.value
                        ? "1px solid rgba(255,255,255,0.25)"
                        : "1px solid rgba(255,255,255,0.08)",
                    color: dateRange === opt.value ? "#e0e0e0" : "rgba(255,255,255,0.4)",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {selectedSession && (
            <div className="flex items-center gap-3">
              <span
                className="badge"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  color: "#e0e0e0",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                {selectedSession.asset}
              </span>
              {selectedSession.status === "RUNNING" ? (
                <span className="badge badge-buy">● LIVE</span>
              ) : (
                <span className="badge badge-muted">STOPPED</span>
              )}
            </div>
          )}
        </div>

        {/* Row 1 — Key metrics */}
        {isLoading && (
          <div
            className="mt-4 text-xs font-sans"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            Loading analytics…
          </div>
        )}
        {performance && !isLoading && (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPICard
              label="Total Signals"
              value={String(performance.totalSignals)}
              subtitle="Ticks processed"
            />
            <KPICard
              label="Trades Taken"
              value={String(performance.totalTrades)}
              subtitle="Paper positions"
            />
            <KPICard
              label="Win Rate"
              value={`${performance.winRate.toFixed(1)}%`}
              color={
                performance.winRate >= 55
                  ? "#00C853"
                  : performance.winRate >= 50
                    ? "#FFB300"
                    : "#FF1744"
              }
              subtitle={
                performance.winRate >= 55
                  ? "Above target"
                  : performance.winRate >= 50
                    ? "Near breakeven"
                    : "Below breakeven"
              }
            />
            <KPICard
              label="Net P&L"
              value={`${performance.netPnL >= 0 ? "+" : ""}₹${performance.netPnL.toFixed(2)}`}
              color={pnlColor(performance.netPnL)}
              subtitle={performance.netPnL >= 0 ? "Profitable session" : "Net loss"}
            />
          </div>
        )}

        {/* Verdict banner — vs backtest comparison */}
        {performance && !isLoading && performance.vsBacktest && (
          <VerdictBanner vsBacktest={performance.vsBacktest} />
        )}

        {/* Row 4 — Additional trade stats */}
        {performance && !isLoading && (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPICard
              label="Avg P&L / Trade"
              value={`${performance.avgPnL >= 0 ? "+" : ""}₹${fmt(performance.avgPnL)}`}
              color={pnlColor(performance.avgPnL)}
            />
            <KPICard
              label="Max Drawdown"
              value={`₹${fmt(performance.maxDrawdown)}`}
              color="#FF1744"
              subtitle="Peak-to-trough loss"
            />
            <KPICard
              label="Avg Hold Time"
              value={`${fmt(performance.avgHoldingMinutes, 1)} min`}
              subtitle="Per closed trade"
            />
            <div className="grid grid-cols-1 gap-1.5">
              {performance.bestTrade && (
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: "rgba(0,200,83,0.05)",
                    border: "1px solid rgba(0,200,83,0.15)",
                  }}
                >
                  <div className="ui-label text-[0.6rem] mb-0.5">Best Trade</div>
                  <div className="font-mono text-sm font-bold" style={{ color: "#00C853" }}>
                    +₹{fmt(performance.bestTrade.realizedPnL)}
                  </div>
                  <div className="font-sans text-[0.62rem]" style={{ color: "rgba(255,255,255,0.3)" }}>
                    {performance.bestTrade.strategy?.replace("_", " ")}
                  </div>
                </div>
              )}
              {performance.worstTrade && (
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: "rgba(255,23,68,0.05)",
                    border: "1px solid rgba(255,23,68,0.15)",
                  }}
                >
                  <div className="ui-label text-[0.6rem] mb-0.5">Worst Trade</div>
                  <div className="font-mono text-sm font-bold" style={{ color: "#FF1744" }}>
                    ₹{fmt(performance.worstTrade.realizedPnL)}
                  </div>
                  <div className="font-sans text-[0.62rem]" style={{ color: "rgba(255,255,255,0.3)" }}>
                    {performance.worstTrade.strategy?.replace("_", " ")}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Row 5 — Risk metrics */}
        {performance && !isLoading && (
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPICard
              label="Profit Factor"
              value={performance.profitFactor === Infinity ? "∞" : fmt(performance.profitFactor)}
              color={performance.profitFactor >= 1.5 ? "#00C853" : performance.profitFactor >= 1 ? "#FFB300" : "#FF1744"}
              subtitle="Gross wins / gross losses"
            />
            <KPICard
              label="Expectancy"
              value={`${performance.expectancy >= 0 ? "+" : ""}₹${fmt(performance.expectancy, 0)}`}
              color={pnlColor(performance.expectancy)}
              subtitle="Avg ₹ per trade"
            />
            <KPICard
              label="Max Consec. Losses"
              value={String(performance.maxConsecutiveLosses)}
              color={performance.maxConsecutiveLosses >= 5 ? "#FF1744" : performance.maxConsecutiveLosses >= 3 ? "#FFB300" : "#e0e0e0"}
              subtitle="Worst losing streak"
            />
            <KPICard
              label="Premium Source"
              value={`${performance.premiumSourceCounts?.["KITE_LTP"] ?? 0} / ${performance.totalTrades}`}
              color={((performance.premiumSourceCounts?.["KITE_LTP"] ?? 0) / Math.max(1, performance.totalTrades)) >= 0.8 ? "#00C853" : "#FFB300"}
              subtitle="Trades using real Kite LTP"
            />
          </div>
        )}

        {!performance && !isLoading && (
          <div
            className="mt-4 text-xs font-sans"
            style={{ color: "rgba(255,255,255,0.25)" }}
          >
            Select a session to view performance analytics.
          </div>
        )}
      </section>

      {/* Row 2 — Equity curve */}
      {performance && <EquityCurve data={performance.equityCurve} />}

      {/* Row 3 — Charts */}
      {performance && (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <WinRateChart data={performance.rollingWinRate} />

          {/* Strategy distribution */}
          <div
            className="rounded-2xl p-4"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="ui-label">Strategy Distribution</span>
              <span
                className="font-mono text-[0.68rem]"
                style={{ color: "rgba(255,255,255,0.3)" }}
              >
                {totalStrategies} signals
              </span>
            </div>
            <div className="space-y-4">
              {strategies.map(({ label, key, color }) => {
                const count = strategyDistribution[key];
                const pct = ((count / totalStrategies) * 100).toFixed(1);
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span
                        className="font-sans text-[0.72rem] font-semibold uppercase tracking-wider"
                        style={{ color }}
                      >
                        {label}
                      </span>
                      <span className="font-mono text-xs text-[#e0e0e0]">
                        {count}{" "}
                        <span style={{ color: "rgba(255,255,255,0.4)" }}>({pct}%)</span>
                      </span>
                    </div>
                    <div
                      className="relative h-2.5 w-full overflow-hidden rounded-full"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${pct}%`,
                          background: color,
                          boxShadow: `0 0 8px ${color}55`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Exit reasons */}
          <div
            className="rounded-2xl p-4"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="ui-label">Exit Reasons</span>
              <span
                className="font-mono text-[0.68rem]"
                style={{ color: "rgba(255,255,255,0.3)" }}
              >
                {performance.totalTrades} trades
              </span>
            </div>
            <div className="space-y-3">
              {exitReasonEntries.map(([key, color]) => {
                const count = performance.exitReasons[key];
                const pct = ((count / totalExits) * 100).toFixed(1);
                return (
                  <div key={key}>
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className="font-sans text-[0.68rem] font-semibold uppercase tracking-wider"
                        style={{ color }}
                      >
                        {key.replace(/_/g, " ")}
                      </span>
                      <span className="font-mono text-xs text-[#e0e0e0]">
                        {count}{" "}
                        <span style={{ color: "rgba(255,255,255,0.4)" }}>({pct}%)</span>
                      </span>
                    </div>
                    <div
                      className="relative h-2 w-full overflow-hidden rounded-full"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Day of week breakdown + strategy breakdown side by side */}
      {performance && (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DayOfWeekTable byDayOfWeek={performance.byDayOfWeek} />

          {/* Per-strategy breakdown */}
          <div
            className="rounded-2xl p-4"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="mb-3 ui-label">Strategy Breakdown</div>
            {(["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"] as const).map((key) => {
              const s = performance.byStrategy[key];
              if (!s) return null;
              const color = key === "BULL_PUT_SPREAD" ? "#00C853" : "#FF1744";
              const label = key === "BULL_PUT_SPREAD" ? "BULL PUT" : "BEAR CALL";
              return (
                <div key={key} className="mb-3 rounded-lg px-3 py-2.5"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono text-[0.75rem] font-semibold" style={{ color }}>{label}</span>
                    <span className="font-mono text-[0.7rem]" style={{ color: "rgba(255,255,255,0.4)" }}>
                      {s.trades} trades
                    </span>
                  </div>
                  <div className="flex gap-4 text-[0.72rem] font-mono">
                    <span style={{ color: s.winRate >= 50 ? "#00C853" : "#FF1744" }}>
                      {s.winRate.toFixed(0)}% win
                    </span>
                    <span style={{ color: pnlColor(s.pnl) }}>
                      {s.pnl >= 0 ? "+" : ""}₹{s.pnl.toFixed(0)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent trades table */}
      {performance && performance.recentTrades.length > 0 && (
        <section
          className="rounded-2xl p-4"
          style={{
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="ui-label">Recent Trades</span>
            <span
              className="font-mono text-[0.68rem]"
              style={{ color: "rgba(255,255,255,0.3)" }}
            >
              Last {performance.recentTrades.length}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr style={{ color: "rgba(255,255,255,0.3)" }}>
                  <th className="pb-2 text-left font-normal">Strategy</th>
                  <th className="pb-2 text-left font-normal">Entry</th>
                  <th className="pb-2 text-left font-normal">Exit Reason</th>
                  <th className="pb-2 text-right font-normal">P&L</th>
                  <th className="pb-2 text-right font-normal">Hold (min)</th>
                  <th className="pb-2 text-right font-normal">Premium</th>
                </tr>
              </thead>
              <tbody>
                {performance.recentTrades.map((t) => {
                  const pnl = t.realizedPnL ?? 0;
                  const holdMin = t.entryTimestamp && t.exitTimestamp
                    ? ((new Date(t.exitTimestamp).getTime() - new Date(t.entryTimestamp).getTime()) / 60_000).toFixed(0)
                    : "—";
                  return (
                    <tr
                      key={t.positionId}
                      style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                    >
                      <td className="py-1.5 pr-3" style={{ color: t.strategy === "BULL_PUT_SPREAD" ? "#00C853" : "#FF1744" }}>
                        {t.strategy === "BULL_PUT_SPREAD" ? "BULL PUT" : "BEAR CALL"}
                      </td>
                      <td className="py-1.5 pr-3" style={{ color: "rgba(255,255,255,0.5)" }}>
                        {new Date(t.entryTimestamp).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}
                      </td>
                      <td className="py-1.5 pr-3" style={{ color: "rgba(255,255,255,0.5)" }}>
                        {t.exitReason?.replace(/_/g, " ") ?? "—"}
                      </td>
                      <td className="py-1.5 text-right font-bold" style={{ color: pnlColor(pnl) }}>
                        {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-right" style={{ color: "rgba(255,255,255,0.4)" }}>
                        {holdMin}
                      </td>
                      <td className="py-1.5 text-right">
                        {(t as OptionsPosition & { premiumSource?: string }).premiumSource === "KITE_LTP"
                          ? <span style={{ color: "#00C853" }} title="Real Kite LTP">●</span>
                          : <span style={{ color: "#FFB300" }} title="Black-Scholes estimate">●</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
