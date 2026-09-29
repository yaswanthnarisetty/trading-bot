"use client";

import React, { useEffect, useState } from "react";
import {
  getAssets,
  runBacktest,
  type Asset,
  type BacktestInterval,
  type BacktestResult,
} from "../../../lib/api";

const INTERVALS: BacktestInterval[] = [
  "minute",
  "3minute",
  "5minute",
  "10minute",
  "15minute",
  "30minute",
  "60minute",
];

function toInputDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function BacktestPage(): JSX.Element {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [asset, setAsset] = useState("NIFTY");
  const [interval, setInterval] = useState<BacktestInterval>("5minute");
  const [from, setFrom] = useState<string>(() =>
    toInputDateTimeValue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
  );
  const [to, setTo] = useState<string>(() => toInputDateTimeValue(new Date()));
  const [initialCapital, setInitialCapital] = useState("200000");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);
  const [attemptCount, setAttemptCount] = useState(0);
  const [backendReachable, setBackendReachable] = useState<boolean | null>(null);

  useEffect(() => {
    void getAssets()
      .then((list) => {
        setAssets(list);
        setBackendReachable(true);
        if (list.length > 0) {
          setAsset((prev) => prev || list[0]!.key);
        }
      })
      .catch((e) => {
        console.error("Failed to load assets", e);
        setBackendReachable(false);
      });
  }, []);

  async function handleRun(): Promise<void> {
    setIsLoading(true);
    setError(null);
    setAttemptCount((prev) => prev + 1);
    setLastAttemptAt(new Date().toLocaleTimeString());

    try {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (
        Number.isNaN(fromDate.getTime()) ||
        Number.isNaN(toDate.getTime())
      ) {
        throw new Error("Invalid from/to date. Re-select both date values.");
      }

      const data = await runBacktest({
        asset,
        interval,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        initialCapital: Number(initialCapital),
      });
      setResult(data);
      setBackendReachable(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Backtest failed";
      setError(message);
      setResult(null);
      if (
        message.toLowerCase().includes("failed to fetch") ||
        message.toLowerCase().includes("networkerror")
      ) {
        setBackendReachable(false);
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <section
        className="rounded-2xl p-4"
        style={{
          background:
            "linear-gradient(135deg, rgba(20,20,20,0.9) 0%, rgba(12,12,12,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="mb-1 ui-label">Historical Backtest</div>
        <div
          className="mb-3 text-[0.68rem] font-mono"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          Research replay requires a configured historical option archive. P&amp;L excludes brokerage and taxes.
        </div>
        <div
          className="mb-3 text-[0.7rem] font-mono"
          style={{
            color:
              backendReachable == null
                ? "rgba(255,255,255,0.45)"
                : backendReachable
                  ? "#00C853"
                  : "#FF1744",
          }}
        >
          Backend:{" "}
          {backendReachable == null
            ? "checking..."
            : backendReachable
              ? "reachable"
              : "unreachable"}{" "}
          ({process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"})
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="ui-label">Asset</span>
            <select
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              {(assets.length > 0
                ? assets
                : [{ key: "NIFTY" }, { key: "BANKNIFTY" }, { key: "FINNIFTY" }]
              ).map((a) => (
                <option key={a.key} value={a.key}>
                  {a.key}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="ui-label">Interval</span>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value as BacktestInterval)}
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              {INTERVALS.map((itv) => (
                <option key={itv} value={itv}>
                  {itv}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="ui-label">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="ui-label">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="ui-label">Initial Capital</span>
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(e.target.value)}
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={isLoading}
            className="rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #00C853, #00e676)",
              color: "#000",
              boxShadow: "0 0 16px rgba(0,200,83,0.35)",
            }}
          >
            {isLoading ? "Running..." : "Run Backtest"}
          </button>

          {error && (
            <span className="text-xs font-mono" style={{ color: "#ff4569" }}>
              {error}
            </span>
          )}
        </div>
        <div
          className="mt-2 text-[0.68rem] font-mono"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          Attempts: {attemptCount}
          {lastAttemptAt ? ` · Last click: ${lastAttemptAt}` : ""}
        </div>
      </section>

      {result && (
        <>
          {result.status === "INCOMPLETE" && (
            <p className="text-xs text-amber-400">Incomplete historical evidence. Results show realized P&amp;L only; unresolved positions are not treated as closed.</p>
          )}
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="P&L excluding charges"
              value={`${result.netPnL >= 0 ? "+" : ""}₹${result.netPnL.toFixed(2)}`}
              color={result.netPnL >= 0 ? "#00C853" : "#FF1744"}
            />
            <StatCard label="Provider" value={result.provider} />
            <StatCard
              label="Win Rate"
              value={`${result.winRate.toFixed(1)}%`}
              color={result.winRate >= 50 ? "#00C853" : "#FFB300"}
            />
            <StatCard label="Trades" value={`${result.totalTrades}`} />
            <StatCard
              label="Realized Drawdown"
              value={`₹${result.maxDrawdown.toFixed(2)}`}
              color="#FFB300"
            />
          </section>

          {/* Signal filter funnel */}
          <section
            className="rounded-2xl p-4"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="mb-3 ui-label">Signal Filter Funnel</div>
            <div className="mb-3 grid grid-cols-3 gap-3">
              <StatCard
                label="Signals Generated"
                value={`${result.totalSignals}`}
              />
              <StatCard
                label="Blocked"
                value={`${result.totalBlocked}`}
                color={result.totalBlocked > 0 ? "#FFB300" : "#888"}
              />
              <StatCard
                label="Traded"
                value={`${result.totalTraded}`}
                color="#00C853"
              />
            </div>
            {result.totalBlocked > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(
                  [
                    ["duplicate_strategy", "Duplicate Strategy"],
                    ["same_direction_open", "Same Direction"],
                    ["max_positions", "Max Positions"],
                    ["daily_limit", "Daily Limit"],
                    ["low_confidence", "Low Confidence"],
                    ["time_restriction", "Time Restricted"],
                  ] as const
                )
                  .filter(([key]) => result.blockReasons[key] > 0)
                  .map(([key, label]) => (
                    <div
                      key={key}
                      className="rounded-lg px-3 py-1.5 text-[0.72rem] font-mono"
                      style={{
                        background: "rgba(255,179,0,0.07)",
                        border: "1px solid rgba(255,179,0,0.2)",
                        color: "#FFB300",
                      }}
                    >
                      {label}: {result.blockReasons[key]}
                    </div>
                  ))}
              </div>
            )}
          </section>

          <section
            className="rounded-2xl p-4"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="mb-3 ui-label">Trades</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead>
                  <tr style={{ color: "rgba(255,255,255,0.5)" }}>
                    <th className="px-2 py-2 text-left">Entry</th>
                    <th className="px-2 py-2 text-left">Exit</th>
                    <th className="px-2 py-2 text-left">Strategy</th>
                    <th className="px-2 py-2 text-left">Option</th>
                    <th className="px-2 py-2 text-right">Entry Spot</th>
                    <th className="px-2 py-2 text-right">Exit Spot</th>
                    <th className="px-2 py-2 text-right">PnL</th>
                    <th className="px-2 py-2 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades
                    .slice()
                    .reverse()
                    .map((trade) => (
                      <tr
                        key={trade.tradeId}
                        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
                      >
                        <td className="px-2 py-2 font-mono text-[#d0d0d0]">
                          {new Date(trade.entryTimestamp).toLocaleString()}
                        </td>
                        <td className="px-2 py-2 font-mono text-[#d0d0d0]">
                          {new Date(trade.exitTimestamp).toLocaleString()}
                        </td>
                        <td className="px-2 py-2 font-mono text-[#d0d0d0]">
                          {trade.strategy}
                        </td>
                        <td className="px-2 py-2 font-mono text-[#d0d0d0]">
                          {trade.optionType} {trade.sellStrike.toFixed(0)}/
                          {trade.buyStrike.toFixed(0)} · {trade.lots} lot
                          {trade.lots > 1 ? "s" : ""}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[#d0d0d0]">
                          {trade.entrySpot.toFixed(2)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-[#d0d0d0]">
                          {trade.exitSpot.toFixed(2)}
                        </td>
                        <td
                          className="px-2 py-2 text-right font-mono"
                          style={{
                            color: trade.pnl >= 0 ? "#00C853" : "#FF1744",
                          }}
                        >
                          {trade.pnl >= 0 ? "+" : ""}₹{trade.pnl.toFixed(2)}
                        </td>
                        <td className="px-2 py-2 font-mono text-[#b0b0b0]">
                          {trade.exitReason}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard(props: {
  label: string;
  value: string;
  color?: string;
}): JSX.Element {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="ui-label mb-1">{props.label}</div>
      <div
        className="font-mono text-lg font-semibold"
        style={{ color: props.color ?? "#e0e0e0" }}
      >
        {props.value}
      </div>
    </div>
  );
}
