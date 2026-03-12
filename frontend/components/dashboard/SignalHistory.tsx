import React, { useState } from "react";
import type { SignalPayload } from "@trading-bot/shared";

interface SignalHistoryProps {
  signals: SignalPayload[];
}

export function SignalHistory({
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
            const time = new Date(s.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const strategy =
              s.signal.strategy === "BULL_PUT_SPREAD"
                ? "BULL PUT"
                : s.signal.strategy === "BEAR_CALL_SPREAD"
                  ? "BEAR CALL"
                  : "HOLD";

            const dotColor =
              s.signal.strategy === "BULL_PUT_SPREAD"
                ? "#00C853"
                : s.signal.strategy === "BEAR_CALL_SPREAD"
                  ? "#FF1744"
                  : "#FFB300";

            const leftBorderColor =
              s.signal.strategy === "BULL_PUT_SPREAD"
                ? "rgba(0,200,83,0.4)"
                : s.signal.strategy === "BEAR_CALL_SPREAD"
                  ? "rgba(255,23,68,0.4)"
                  : "rgba(255,179,0,0.4)";

            const strategyBadge =
              s.signal.strategy === "BULL_PUT_SPREAD"
                ? "badge-buy"
                : s.signal.strategy === "BEAR_CALL_SPREAD"
                  ? "badge-sell"
                  : "badge-hold";

            const confidencePct = Math.round(s.signal.confidence * 100);
            const isExpanded = expandedIndex === index;

            return (
              <div
                key={s.timestamp + index}
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
                        className={`badge ${s.riskAction === "SUGGEST"
                            ? "badge-buy"
                            : "badge-sell"
                          }`}
                      >
                        {s.riskAction}
                      </span>
                      <span
                        className="font-mono text-[0.65rem]"
                        style={{ color: "rgba(255,255,255,0.3)" }}
                      >
                        RSI {s.indicators.rsi.toFixed(1)}
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
                        {s.signal.reasoning}
                      </div>
                      {s.signal.riskFlags.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1">
                          {s.signal.riskFlags.map((flag) => (
                            <span key={flag} className="badge badge-sell">
                              ⚠ {flag}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.greeksSnapshot && (
                        <div
                          className="mt-1 flex flex-wrap gap-2 font-mono text-[0.65rem]"
                          style={{ color: "rgba(255,255,255,0.35)" }}
                        >
                          <span>
                            Δ{" "}
                            <span
                              style={{
                                color:
                                  s.greeksSnapshot.delta >= 0
                                    ? "#00C853"
                                    : "#FF1744",
                              }}
                            >
                              {s.greeksSnapshot.delta.toFixed(3)}
                            </span>
                          </span>
                          <span>
                            Θ{" "}
                            <span style={{ color: "#FFB300" }}>
                              {s.greeksSnapshot.theta.toFixed(3)}
                            </span>
                          </span>
                          <span>V {s.greeksSnapshot.vega.toFixed(3)}</span>
                          <span>
                            IVR{" "}
                            <span className="text-[#e0e0e0]">
                              {s.greeksSnapshot.ivRank.toFixed(1)}
                            </span>
                          </span>
                        </div>
                      )}
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

export default SignalHistory;
