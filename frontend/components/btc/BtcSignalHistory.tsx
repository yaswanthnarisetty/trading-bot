"use client";

import React, { useState, useEffect } from "react";

const TICK_INTERVAL_SEC = 60; // matches CRYPTO_TICK_INTERVAL_MS on the backend

interface CryptoSignal {
  asset: string;
  side: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  atr?: number;
  volumeRatio: number;
  reason: string;
  riskAction?: "SUGGEST" | "BLOCK";
  blockReason?: string;
  timestamp?: string;
  _tsDisplay?: string;
}

interface SignalHistoryProps {
  signals: CryptoSignal[];
  isRunning?: boolean;
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function BtcSignalHistory({
  signals,
  isRunning = false,
}: SignalHistoryProps): JSX.Element {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number>(TICK_INTERVAL_SEC);

  // Derive countdown from signals[0].timestamp (actual backend evaluation time).
  // This works correctly for both live WebSocket signals and DB-loaded history —
  // no need to track when signals arrived in state.
  useEffect(() => {
    if (!isRunning) {
      setRemaining(TICK_INTERVAL_SEC);
      return;
    }

    const compute = () => {
      const lastTs = signals[0]?.timestamp
        ? new Date(signals[0].timestamp).getTime()
        : null;

      if (!lastTs || isNaN(lastTs)) {
        // No signals yet — keep full interval showing
        setRemaining(TICK_INTERVAL_SEC);
        return;
      }

      const elapsed = Math.floor((Date.now() - lastTs) / 1000);
      setRemaining(Math.max(0, TICK_INTERVAL_SEC - elapsed));
    };

    compute(); // run immediately so there's no 1-second blank on mount
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [isRunning, signals]);

  const handleToggle = (index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  };

  if (signals.length === 0) {
    return (
      <div
        className="flex h-48 flex-col items-center justify-center rounded-2xl border text-center"
        style={{
          borderColor: "rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div className="mb-1 text-2xl" style={{ opacity: 0.3 }}>
          ⌛
        </div>
        <div className="ui-label text-[0.7rem]">Signal History</div>
        <div
          className="mt-1 text-xs font-sans"
          style={{ color: "rgba(255,255,255,0.25)" }}
        >
          {isRunning
            ? remaining === 0
              ? "First signal imminent…"
              : `First signal in ${formatCountdown(remaining)}`
            : "Signals appear here once the session starts"}
        </div>
      </div>
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
      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <span className="ui-label">Signal History</span>
        <div className="flex items-center gap-3">
          {isRunning && (
            <div className="flex items-center gap-1.5">
              {remaining === 0 ? (
                <span
                  className="h-1.5 w-1.5 animate-status-pulse rounded-full"
                  style={{ background: "#FFB300" }}
                />
              ) : remaining <= 5 ? (
                <span
                  className="h-1.5 w-1.5 animate-status-pulse rounded-full"
                  style={{ background: "#00C853" }}
                />
              ) : (
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "rgba(255,255,255,0.2)" }}
                />
              )}
              <span
                className="font-mono text-[0.68rem]"
                style={{
                  color: remaining === 0 ? "#FFB300" : remaining <= 5 ? "#00C853" : "rgba(255,255,255,0.35)",
                  transition: "color 0.3s",
                }}
              >
                {remaining === 0 ? "awaiting signal…" : `next ${formatCountdown(remaining)}`}
              </span>
            </div>
          )}
          <span
            className="font-mono text-[0.68rem]"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            {signals.length} signal{signals.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Timeline list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="relative flex flex-col gap-0">
          {/* Vertical timeline line */}
          <div
            className="absolute left-[22px] top-2 bottom-2 w-px"
            style={{ background: "rgba(255,255,255,0.06)" }}
          />

          {signals.map((s, index) => {
            const time = s._tsDisplay ?? "—";
            const isBlocked = s.riskAction === "BLOCK";
            const strategy = s.side === "LONG" ? "LONG" : s.side === "SHORT" ? "SHORT" : "HOLD";

            // Blocked signals use muted grey styling regardless of side
            const dotColor = isBlocked
              ? "rgba(255,255,255,0.25)"
              : s.side === "LONG"
                ? "#00C853"
                : s.side === "SHORT"
                  ? "#FF1744"
                  : "#FFB300";

            const leftBorderColor = isBlocked
              ? "rgba(255,255,255,0.12)"
              : s.side === "LONG"
                ? "rgba(0,200,83,0.4)"
                : s.side === "SHORT"
                  ? "rgba(255,23,68,0.4)"
                  : "rgba(255,179,0,0.4)";

            const strategyBadge =
              s.side === "LONG"
                ? "badge-buy"
                : s.side === "SHORT"
                  ? "badge-sell"
                  : "badge-hold";

            const confidencePct = Math.round(s.confidence * 100);
            const isExpanded = expandedIndex === index;

            // Decode blockReason into a human-readable label
            const blockLabel = s.blockReason
              ? s.blockReason.startsWith("HOLD:")
                ? "No alignment"
                : s.blockReason.startsWith("SAME_DIRECTION_OPEN:")
                  ? `${s.side} already open`
                  : s.blockReason.startsWith("MAX_POSITIONS:")
                    ? "Max positions reached"
                    : s.blockReason.startsWith("DAILY_LOSS_LIMIT:")
                      ? "Daily loss limit hit"
                      : s.blockReason.startsWith("LOW_CONFIDENCE:")
                        ? "Low confidence"
                        : s.blockReason
              : null;

            return (
              <div
                key={`${s._tsDisplay}-${index}`}
                className={`relative mb-2 pl-10 ${index === 0 ? "animate-slide-in" : ""}`}
              >
                {/* Timeline dot */}
                <div
                  className="absolute left-[17px] top-3.5 h-2.5 w-2.5 rounded-full border-2"
                  style={{
                    backgroundColor: dotColor,
                    borderColor: "#0a0a0a",
                    boxShadow: index === 0 && !isBlocked ? `0 0 8px ${dotColor}` : "none",
                  }}
                />

                {/* Card */}
                <div
                  className="overflow-hidden rounded-xl"
                  style={{
                    background:
                      index === 0
                        ? "rgba(255,255,255,0.04)"
                        : "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderLeft: `3px solid ${leftBorderColor}`,
                    opacity: isBlocked ? 0.72 : 1,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleToggle(index)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-white/5"
                  >
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span
                        className="font-mono text-[0.68rem]"
                        style={{ color: "rgba(255,255,255,0.4)" }}
                      >
                        {time}
                      </span>
                      <span className={`badge ${strategyBadge}`}>
                        {strategy}
                      </span>
                      {/* Risk action badge */}
                      {isBlocked ? (
                        <span
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase"
                          style={{
                            background: "rgba(255,87,34,0.15)",
                            color: "#FF5722",
                            border: "1px solid rgba(255,87,34,0.25)",
                          }}
                        >
                          ✗ Blocked
                        </span>
                      ) : s.riskAction === "SUGGEST" ? (
                        <span
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase"
                          style={{
                            background: "rgba(0,200,83,0.12)",
                            color: "#00C853",
                            border: "1px solid rgba(0,200,83,0.2)",
                          }}
                        >
                          ✓ Suggest
                        </span>
                      ) : null}
                      <span
                        className="font-mono text-xs font-bold"
                        style={{ color: isBlocked ? "rgba(255,255,255,0.3)" : dotColor }}
                      >
                        {confidencePct}%
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="font-mono text-[0.65rem]"
                        style={{ color: "rgba(255,255,255,0.3)" }}
                      >
                        RSI {s.rsi?.toFixed(1) ?? "—"}
                      </span>
                      <span
                        className="text-[0.65rem]"
                        style={{ color: "rgba(255,255,255,0.25)" }}
                      >
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div
                      className="border-t px-3 py-2.5 text-xs"
                      style={{ borderColor: "rgba(255,255,255,0.06)" }}
                    >
                      {/* Block reason banner */}
                      {isBlocked && blockLabel && (
                        <div
                          className="mb-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-sans text-[0.7rem]"
                          style={{
                            background: "rgba(255,87,34,0.08)",
                            border: "1px solid rgba(255,87,34,0.18)",
                            color: "#FF8A65",
                          }}
                        >
                          <span>⛔</span>
                          <span>{blockLabel}</span>
                        </div>
                      )}

                      <div
                        className="mb-2 font-sans leading-relaxed"
                        style={{ color: "rgba(255,255,255,0.65)" }}
                      >
                        {s.reason}
                      </div>

                      <div
                        className="mt-1 flex flex-wrap gap-2 font-mono text-[0.65rem]"
                        style={{ color: "rgba(255,255,255,0.35)" }}
                      >
                        <span>
                          EMA9{" "}
                          <span style={{ color: "#FFB300" }}>
                            {s.ema9?.toFixed(0)}
                          </span>
                        </span>
                        <span>
                          EMA21{" "}
                          <span style={{ color: "rgba(255,255,255,0.8)" }}>
                            {s.ema21?.toFixed(0)}
                          </span>
                        </span>
                        <span>
                          EMA50{" "}
                          <span style={{ color: "rgba(255,255,255,0.8)" }}>
                            {s.ema50?.toFixed(0)}
                          </span>
                        </span>
                        <span>
                          ATR{" "}
                          <span className="text-[#e0e0e0]">
                            {s.atr?.toFixed(0) ?? "—"}
                          </span>
                        </span>
                        <span>
                          VOL{" "}
                          <span className="text-[#e0e0e0]">
                            {s.volumeRatio?.toFixed(2)}x
                          </span>
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
