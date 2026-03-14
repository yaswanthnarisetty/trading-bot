"use client";

import React, { useState } from "react";

interface CryptoSignal {
  asset: string;
  side: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  volumeRatio: number;
  reason: string;
  timestamp?: string;
  _tsDisplay?: string;
}

interface SignalHistoryProps {
  signals: CryptoSignal[];
}

export default function BtcSignalHistory({
  signals,
}: SignalHistoryProps): JSX.Element {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

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
          Signals appear here once the session starts
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
        <span
          className="font-mono text-[0.68rem]"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          {signals.length} signal{signals.length !== 1 ? "s" : ""}
        </span>
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
            const strategy = s.side === "LONG" ? "LONG" : s.side === "SHORT" ? "SHORT" : "HOLD";

            const dotColor =
              s.side === "LONG"
                ? "#00C853"
                : s.side === "SHORT"
                  ? "#FF1744"
                  : "#FFB300";

            const leftBorderColor =
              s.side === "LONG"
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

            return (
              <div
                key={`${s._tsDisplay}-${index}`}
                className={`relative mb-2 pl-10 ${index === 0 ? "animate-slide-in" : ""
                  }`}
              >
                {/* Timeline dot */}
                <div
                  className="absolute left-[17px] top-3.5 h-2.5 w-2.5 rounded-full border-2"
                  style={{
                    backgroundColor: dotColor,
                    borderColor: "#0a0a0a",
                    boxShadow: index === 0 ? `0 0 8px ${dotColor}` : "none",
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
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleToggle(index)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-white/5"
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="font-mono text-[0.68rem]"
                        style={{ color: "rgba(255,255,255,0.4)" }}
                      >
                        {time}
                      </span>
                      <span className={`badge ${strategyBadge}`}>
                        {strategy}
                      </span>
                      <span
                        className="font-mono text-xs font-bold"
                        style={{ color: dotColor }}
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
                          <span style={{ color: "rgba(255,255,255,0.8)" }}>{s.ema50?.toFixed(0)}</span>
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
