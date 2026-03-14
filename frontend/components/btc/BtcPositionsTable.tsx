"use client";

import React, { useEffect, useState } from "react";
import { formatElapsed } from "../../hooks/useSessionTimer";

type TabKey = "OPEN" | "HISTORY";

interface CryptoPosition {
  positionId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  entryTimestamp: string;
  stopLoss: number;
  takeProfit: number;
  realizedPnL: number | null;
  unrealizedPnL: number | null;
  status: "OPEN" | "CLOSED";
  exitReason: string | null;
}

interface BtcPositionsTableProps {
  positions: CryptoPosition[];
  currentPrice: number | null;
  paperCapital: number;
  onClose: (positionId: string) => void;
}

function PnLValue({ value }: { value: number }): JSX.Element {
  const color = value > 0 ? "#00C853" : value < 0 ? "#FF1744" : "#888";
  const prefix = value > 0 ? "+" : "";
  return (
    <span className="font-mono font-semibold" style={{ color }}>
      {prefix}${value.toFixed(2)}
    </span>
  );
}

function BtcPositionCard({
  position,
  now,
  currentPrice,
  onClose,
}: {
  position: CryptoPosition;
  now: number;
  currentPrice: number | null;
  onClose: (positionId: string) => void;
}) {
  const currentPnL = position.unrealizedPnL ?? 0;
  const isLong = position.side === "LONG";
  const heldSeconds = (now - Date.parse(position.entryTimestamp)) / 1000;
  
  const pnlColor = currentPnL > 0 ? "#00C853" : currentPnL < 0 ? "#FF1744" : "#d0d0d0";
  const pnlArrow = currentPnL > 0 ? "↑" : currentPnL < 0 ? "↓" : "→";

  const actionColor = isLong ? "#00C853" : "#FF5252";

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
          BTCUSD PERP
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
        className="flex justify-between items-center border-b px-4 py-3 font-mono text-[0.8rem]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span style={{ color: actionColor }} className="font-semibold">
            {isLong ? "BUY" : "SELL"}
          </span>
          <span className="text-[#e0e0e0]">
            ${position.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span style={{ color: "rgba(255,255,255,0.55)" }}>
            {position.size.toFixed(5)} BTC
          </span>
        </div>
        <button
          onClick={() => onClose(position.positionId)}
          className="text-[10px] uppercase font-bold tracking-widest px-2 py-1 rounded"
          style={{
            background: "rgba(244,67,54,0.12)",
            border: "1px solid rgba(244,67,54,0.3)",
            color: "#ef5350",
          }}
        >
          Close
        </button>
      </div>

      <div
        className="border-b px-4 py-3 font-mono text-[0.78rem]"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>P&L</span>
            <span style={{ color: pnlColor }} className="font-semibold">
              {currentPnL >= 0 ? "+" : "-"}${Math.abs(currentPnL).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {pnlArrow}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,255,255,0.45)" }}>Current</span>
            <span className="text-[#e0e0e0]">
              {currentPrice ? `$${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,179,0,0.6)" }}>Take Profit</span>
            <span style={{ color: "#FFB300" }}>${position.takeProfit.toFixed(0)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span style={{ color: "rgba(255,82,82,0.6)" }}>Stop Loss</span>
            <span style={{ color: "#FF5252" }}>${position.stopLoss.toFixed(0)}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 font-mono text-[0.76rem] text-[#d0d0d0]">
        <span>
          Entered: {new Date(position.entryTimestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
        </span>
        <span>Held: {formatElapsed(heldSeconds)}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>
          Realtime updates active
        </span>
      </div>
    </div>
  );
}

export default function BtcPositionsTable({
  positions,
  currentPrice,
  paperCapital,
  onClose,
}: BtcPositionsTableProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>("OPEN");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const openPositions = positions.filter((p) => p.status === "OPEN");
  const historyPositions = positions.filter((p) => p.status !== "OPEN");

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
            const count = tab === "OPEN" ? openPositions.length : historyPositions.length;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className="relative rounded-lg px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider transition-all"
                style={{
                  color: isActive ? "#e0e0e0" : "rgba(255,255,255,0.35)",
                  background: isActive ? "rgba(255,255,255,0.07)" : "transparent",
                  borderBottom: isActive ? "2px solid #00C853" : "2px solid transparent",
                }}
              >
                {tab}
                {count > 0 && (
                  <span
                    className="ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[0.6rem]"
                    style={{
                      background: isActive ? "rgba(0,200,83,0.2)" : "rgba(255,255,255,0.07)",
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
              {openPositions.map((p) => (
                <BtcPositionCard
                  key={p.positionId}
                  position={p}
                  now={now}
                  currentPrice={currentPrice}
                  onClose={onClose}
                />
              ))}
            </div>
          ) : (
            <div
              className="px-4 py-8 text-center text-xs font-sans"
              style={{ color: "rgba(255,255,255,0.25)" }}
            >
              No open BTC positions.
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
                {["Date/Time", "Side", "Entry", "Exit", "Final P&L", "Reason"].map((h) => (
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
                const isLong = p.side === "LONG";
                const dateLabel = new Date(p.entryTimestamp).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                
                const pnlBorder = pnl > 0 ? "rgba(0,200,83,0.25)" : pnl < 0 ? "rgba(255,23,68,0.25)" : "transparent";

                return (
                  <tr key={p.positionId} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <td
                      className="px-3 py-2.5 text-xs font-mono text-[#888]"
                      style={{ borderLeft: `3px solid ${pnlBorder}` }}
                    >
                      {dateLabel}
                    </td>
                    <td
                      className="px-3 py-2.5 text-xs font-bold"
                      style={{ color: isLong ? "#00C853" : "#FF5252" }}
                    >
                      {p.side}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-mono text-[#e0e0e0]">
                      ${p.entryPrice.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-mono text-[#888]">
                      ${p.exitPrice?.toFixed(2) ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <PnLValue value={pnl} />
                    </td>
                    <td className="px-3 py-2.5 text-xs font-sans text-[#888]">
                      {p.exitReason ?? "—"}
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
            No closed BTC positions yet.
          </div>
        )}
      </div>
    </div>
  );
}
