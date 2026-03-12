"use client";

import React from "react";

interface SRContextData {
  pdHigh: number | null;
  pdLow: number | null;
  pdClose: number | null;
  nearestResistance: number | null;
  nearestSupport: number | null;
  maxCallOIStrike: number | null;
  maxPutOIStrike: number | null;
  strongestResistance: number | null;
  strongestSupport: number | null;
  rangeWidth: number | null;
  spotToResistance: number | null;
  spotToSupport: number | null;
  isNearKeyLevel: boolean;
}

interface BreakoutResultData {
  state: "BULLISH_BREAKOUT" | "BEARISH_BREAKDOWN" | "NONE";
  breakLevel: number | null;
  breachSize: number | null;
  candlesSinceBreak: number | null;
}

interface SRPanelProps {
  srContext: SRContextData | null | undefined;
  breakoutResult?: BreakoutResultData | null;
}

function fmt(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(decimals);
}

/**
 * Displays Support & Resistance context for the current tick.
 * Color codes the range width:
 *   > 300 pts → green  (good for spreads)
 *   200–300   → yellow (caution)
 *   < 200     → red    (too tight, avoid)
 */
export default function SRPanel({ srContext, breakoutResult }: SRPanelProps): JSX.Element {
  const rangeWidth = srContext?.rangeWidth ?? null;

  const rangeColor =
    rangeWidth === null
      ? "rgba(255,255,255,0.3)"
      : rangeWidth > 100
      ? "#00C853"
      : rangeWidth >= 50
      ? "#FFB300"
      : "#FF1744";

  const rangeStatus =
    rangeWidth === null
      ? "No S/R data yet"
      : rangeWidth > 100
      ? "Wide range — good for spreads"
      : rangeWidth >= 50
      ? "Moderate range — trade with caution"
      : "Compressed range — avoid new entries";

  const rangeStatusIcon =
    rangeWidth === null ? "⏳" : rangeWidth > 100 ? "🟢" : rangeWidth >= 50 ? "🟡" : "🔴";

  return (
    <div
      className="rounded-xl px-4 py-3 text-xs"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="ui-label mb-2">Support &amp; Resistance</div>

      {srContext ? (
        <>
          {/* Primary S/R levels */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono mb-3">
            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.4)" }}>
                🔴 Resistance
              </span>
              <span style={{ color: "#FF4569" }}>
                {fmt(srContext.strongestResistance)}
                {srContext.spotToResistance !== null && (
                  <span style={{ color: "rgba(255,255,255,0.35)", marginLeft: 4 }}>
                    (+{fmt(srContext.spotToResistance)}pts)
                  </span>
                )}
              </span>
            </div>

            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.4)" }}>
                🟢 Support
              </span>
              <span style={{ color: "#00C853" }}>
                {fmt(srContext.strongestSupport)}
                {srContext.spotToSupport !== null && (
                  <span style={{ color: "rgba(255,255,255,0.35)", marginLeft: 4 }}>
                    (-{fmt(srContext.spotToSupport)}pts)
                  </span>
                )}
              </span>
            </div>

            <div className="flex justify-between col-span-2">
              <span style={{ color: "rgba(255,255,255,0.4)" }}>📊 Range</span>
              <span style={{ color: rangeColor, fontWeight: 600 }}>
                {rangeWidth !== null ? `${fmt(rangeWidth)}pts` : "—"}
              </span>
            </div>
          </div>

          {/* Secondary levels */}
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono pt-2 mb-2"
            style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
          >
            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.35)" }}>PDH</span>
              <span style={{ color: "rgba(255,255,255,0.55)" }}>
                {fmt(srContext.pdHigh)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.35)" }}>PDL</span>
              <span style={{ color: "rgba(255,255,255,0.55)" }}>
                {fmt(srContext.pdLow)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.35)" }}>
                Max Call OI
              </span>
              <span style={{ color: "rgba(255,100,100,0.75)" }}>
                {fmt(srContext.maxCallOIStrike)}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "rgba(255,255,255,0.35)" }}>
                Max Put OI
              </span>
              <span style={{ color: "rgba(100,200,100,0.75)" }}>
                {fmt(srContext.maxPutOIStrike)}
              </span>
            </div>
          </div>

          {/* Near key level badge */}
          {srContext.isNearKeyLevel && (
            <div
              className="mt-1 rounded px-2 py-1 text-center text-xs font-semibold"
              style={{ background: "rgba(255,183,0,0.12)", color: "#FFB300" }}
            >
              ⚠️ Near key S/R level — confidence reduced
            </div>
          )}

          {/* Range status */}
          <div
            className="mt-2 flex items-center gap-1.5 font-mono"
            style={{ color: rangeColor, fontSize: "0.65rem" }}
          >
            <span>{rangeStatusIcon}</span>
            <span>{rangeStatus}</span>
          </div>

          {/* Breakout badge */}
          {(() => {
            if (!breakoutResult || breakoutResult.state === "NONE") {
              return (
                <div
                  className="mt-2 flex items-center gap-1.5 font-mono"
                  style={{ color: "rgba(255,255,255,0.25)", fontSize: "0.65rem" }}
                >
                  <span>⚪</span>
                  <span>No active breakout</span>
                </div>
              );
            }
            const isBull = breakoutResult.state === "BULLISH_BREAKOUT";
            const color = isBull ? "#00C853" : "#FF1744";
            const icon = isBull ? "🟢" : "🔴";
            const label = isBull ? "Bullish breakout" : "Bearish breakdown";
            return (
              <div
                className="mt-2 rounded px-2 py-1 font-mono text-center text-xs font-semibold"
                style={{ background: isBull ? "rgba(0,200,83,0.10)" : "rgba(255,23,68,0.10)", color }}
              >
                {icon} {label}
                {breakoutResult.breakLevel !== null && (
                  <span style={{ opacity: 0.7 }}>
                    {" "}@ {breakoutResult.breakLevel.toFixed(0)}
                  </span>
                )}
                {breakoutResult.breachSize !== null && (
                  <span style={{ opacity: 0.55 }}>
                    {" "}+{breakoutResult.breachSize.toFixed(0)}pts
                  </span>
                )}
                {breakoutResult.candlesSinceBreak !== null && (
                  <span style={{ opacity: 0.45 }}>
                    {" "}({breakoutResult.candlesSinceBreak} bar{breakoutResult.candlesSinceBreak !== 1 ? "s" : ""} ago)
                  </span>
                )}
              </div>
            );
          })()}
        </>
      ) : (
        <div style={{ color: "rgba(255,255,255,0.25)" }}>
          S/R context appears after first live tick.
        </div>
      )}
    </div>
  );
}
