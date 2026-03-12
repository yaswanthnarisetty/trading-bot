import React, { useEffect, useState } from "react";
import type { OptionsPosition } from "@trading-bot/shared";
import { formatElapsed } from "../../hooks/useSessionTimer";

type TabKey = "OPEN" | "HISTORY";

interface PositionRealtime {
  currentPnL: number;
  currentLTP: number;
  lastUpdatedAt: number | null;
}

interface PositionsTableProps {
  positions: OptionsPosition[];
  positionRealtime: Record<string, PositionRealtime>;
  paperCapital: number;
}

const POSITION_MONITOR_INTERVAL_SECONDS = 5;

function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const prefix = value < 0 ? "-" : "";
  return `${prefix}₹${abs.toFixed(0)}`;
}

function formatStrategy(strategy: OptionsPosition["strategy"]): string {
  return strategy.replace(/_/g, " ");
}

function formatEntryTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function getCurrentDte(position: OptionsPosition, now: number): number {
  const expiry = position.legs[0]?.expiry;
  if (!expiry) {
    return position.entryDTE;
  }

  const expiryTs = Date.parse(expiry);
  if (!Number.isFinite(expiryTs)) {
    return position.entryDTE;
  }

  const diffDays = Math.ceil((expiryTs - now) / (24 * 60 * 60 * 1000));
  return Math.max(0, diffDays);
}

function getCountdown(lastUpdatedAt: number | null, now: number): number {
  if (lastUpdatedAt == null) {
    return POSITION_MONITOR_INTERVAL_SECONDS;
  }

  const elapsed = Math.floor((now - lastUpdatedAt) / 1000);
  const remaining =
    POSITION_MONITOR_INTERVAL_SECONDS - (elapsed % POSITION_MONITOR_INTERVAL_SECONDS);
  return remaining === POSITION_MONITOR_INTERVAL_SECONDS ? 0 : remaining;
}

function marginColor(pct: number): string {
  if (pct < 30) return "#00C853";
  if (pct < 50) return "#FFB300";
  return "#FF1744";
}

function PositionCard({
  position,
  realtime,
  now,
  paperCapital,
}: {
  position: OptionsPosition;
  realtime?: PositionRealtime;
  now: number;
  paperCapital: number;
}): JSX.Element {
  const currentPnL = realtime?.currentPnL ?? 0;
  const currentDte = getCurrentDte(position, now);
  const heldSeconds = (now - Date.parse(position.entryTimestamp)) / 1000;
  const countdown = getCountdown(realtime?.lastUpdatedAt ?? null, now);
  const pnlColor =
    currentPnL > 0 ? "#00C853" : currentPnL < 0 ? "#FF1744" : "#d0d0d0";
  const pnlArrow = currentPnL > 0 ? "↑" : currentPnL < 0 ? "↓" : "→";

  return (
    <div
      className="overflow-hidden rounded-2xl"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="font-sans text-sm font-bold tracking-wide text-[#e0e0e0]">
          {formatStrategy(position.strategy)}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[0.68rem] font-semibold uppercase tracking-wider"
            style={{ color: "rgba(255,255,255,0.45)" }}
          >
            Open
          </span>
          <span className="text-[#00C853]">🟢</span>
        </div>
      </div>

      <div
        className="space-y-2 border-b px-4 py-3 font-mono text-[0.8rem]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        {position.legs.map((leg, index) => {
          const actionColor = leg.action === "SELL" ? "#FF5252" : "#00C853";
          return (
            <div key={`${position.positionId}-leg-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span style={{ color: actionColor }} className="font-semibold">
                {leg.action}
              </span>
              <span className="text-[#e0e0e0]">
                {leg.strike.toFixed(0)} {leg.type === "CALL" ? "CALL" : "PUT"}
              </span>
              <span style={{ color: "rgba(255,255,255,0.55)" }}>
                @ ₹{leg.entryPremium.toFixed(2)}
              </span>
              <span style={{ color: "rgba(255,255,255,0.55)" }}>
                {leg.lots} lot
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="border-b px-4 py-3 font-mono text-[0.78rem]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>Credit</span>
            <span className="text-[#e0e0e0]">{formatCurrency(position.maxProfit)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>Max Loss</span>
            <span className="text-[#e0e0e0]">{formatCurrency(position.maxLoss)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>P&L</span>
            <span style={{ color: pnlColor }} className="font-semibold">
              {currentPnL >= 0 ? "+" : "-"}₹{Math.abs(currentPnL).toFixed(0)} {pnlArrow}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>DTE</span>
            <span className="text-[#e0e0e0]">{currentDte}d</span>
          </div>
          {position.requiredMargin != null && (
            <div className="col-span-2 flex justify-between gap-3">
              <span style={{ color: "rgba(255,255,255,0.45)" }}>Margin</span>
              <span className="font-semibold" style={{ color: marginColor((position.requiredMargin / paperCapital) * 100) }}>
                {formatCurrency(position.requiredMargin)}
                {" "}
                <span className="text-[0.72rem]" style={{ opacity: 0.75 }}>
                  ({((position.requiredMargin / paperCapital) * 100).toFixed(1)}%)
                </span>
              </span>
            </div>
          )}
        </div>
        <div className="mt-2 flex justify-between gap-3">
          <span style={{ color: "rgba(255,255,255,0.45)" }}>Entry Spot</span>
          <span className="text-[#e0e0e0]">{position.entrySpot.toFixed(0)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 font-mono text-[0.76rem] text-[#d0d0d0]">
        <span>Entered: {formatEntryTime(position.entryTimestamp)}</span>
        <span>Held: {formatElapsed(heldSeconds)}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>
          Next check in {countdown}s
        </span>
      </div>
    </div>
  );
}

export function PositionsTable({
  positions,
  positionRealtime,
  paperCapital,
}: PositionsTableProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>("OPEN");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const openPositions = positions.filter((p) => p.status === "OPEN");
  const historyPositions = positions.filter((p) => p.status !== "OPEN");

  function PnLValue({ value }: { value: number }): JSX.Element {
    const color =
      value > 0 ? "#00C853" : value < 0 ? "#FF1744" : "#888";
    const prefix = value > 0 ? "+" : "";
    return (
      <span className="font-mono font-semibold" style={{ color }}>
        {prefix}₹{value.toFixed(2)}
      </span>
    );
  }

  return (
    <div
      className="flex h-full flex-col rounded-2xl text-sm text-[#e0e0e0]"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <span className="ui-label">Positions</span>
        <div className="flex gap-1">
          {(["OPEN", "HISTORY"] as TabKey[]).map((tab) => {
            const isActive = activeTab === tab;
            const count =
              tab === "OPEN"
                ? openPositions.length
                : historyPositions.length;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className="relative rounded-lg px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider transition-all"
                style={{
                  color: isActive ? "#e0e0e0" : "rgba(255,255,255,0.35)",
                  background: isActive ? "rgba(255,255,255,0.07)" : "transparent",
                  borderBottom: isActive
                    ? "2px solid #00C853"
                    : "2px solid transparent",
                }}
              >
                {tab}
                {count > 0 && (
                  <span
                    className="ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[0.6rem]"
                    style={{
                      background: isActive
                        ? "rgba(0,200,83,0.2)"
                        : "rgba(255,255,255,0.07)",
                      color: isActive ? "#00C853" : "#888",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === "OPEN" ? (
          openPositions.length > 0 ? (
            <div className="space-y-3">
              {/* Margin utilization summary */}
              {(() => {
                const totalMargin = openPositions.reduce(
                  (sum, p) => sum + (p.requiredMargin ?? 0),
                  0
                );
                if (totalMargin === 0) return null;
                const utilisedPct = (totalMargin / paperCapital) * 100;
                const available = paperCapital - totalMargin;
                return (
                  <div
                    className="rounded-xl px-3 py-2.5 font-mono text-[0.75rem] grid grid-cols-3 gap-x-4"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    <div>
                      <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Margin In Use</div>
                      <div style={{ color: marginColor(utilisedPct) }} className="font-semibold">
                        {formatCurrency(totalMargin)}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Available</div>
                      <div className="text-[#e0e0e0] font-semibold">{formatCurrency(available)}</div>
                    </div>
                    <div>
                      <div style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>Utilization</div>
                      <div style={{ color: marginColor(utilisedPct) }} className="font-semibold">
                        {utilisedPct.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                );
              })()}
              {openPositions.map((position) => (
                <PositionCard
                  key={position.positionId}
                  position={position}
                  realtime={positionRealtime[position.positionId]}
                  now={now}
                  paperCapital={paperCapital}
                />
              ))}
            </div>
          ) : (
            <div
              className="px-4 py-8 text-center text-xs font-sans"
              style={{ color: "rgba(255,255,255,0.25)" }}
            >
              No open positions.
            </div>
          )
        ) : historyPositions.length > 0 ? (
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr
                style={{
                  background: "rgba(255,255,255,0.02)",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                {[
                  "Date/Time",
                  "Strategy",
                  "Credit",
                  "Max Loss",
                  "Final P&L",
                  "Exit Reason",
                  "DTE",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left"
                    style={{
                      fontSize: "0.62rem",
                      fontFamily: "inherit",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      fontWeight: 600,
                      color: "rgba(255,255,255,0.35)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {historyPositions.map((p) => {
                const pnl = p.realizedPnL ?? 0;
                const dateLabel = new Date(
                  p.exitTimestamp ?? p.entryTimestamp
                ).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                const pnlBorder =
                  pnl > 0
                    ? "rgba(0,200,83,0.25)"
                    : pnl < 0
                      ? "rgba(255,23,68,0.25)"
                      : "transparent";

                return (
                  <tr
                    key={p.positionId}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
                  >
                    <td
                      className="px-3 py-2.5 text-xs font-mono text-[#888]"
                      style={{ borderLeft: `3px solid ${pnlBorder}` }}
                    >
                      {dateLabel}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-sans text-[#e0e0e0]">
                      {formatStrategy(p.strategy)}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-mono text-[#e0e0e0]">
                      ₹{p.maxProfit.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-mono text-[#888]">
                      ₹{p.maxLoss.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <PnLValue value={pnl} />
                    </td>
                    <td className="px-3 py-2.5 text-xs font-sans text-[#888]">
                      {p.exitReason ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-mono text-[#888]">
                      {p.entryDTE}d
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div
            className="px-4 py-8 text-center text-xs font-sans"
            style={{ color: "rgba(255,255,255,0.25)" }}
          >
            No closed positions yet.
          </div>
        )}
      </div>
    </div>
  );
}

export default PositionsTable;
