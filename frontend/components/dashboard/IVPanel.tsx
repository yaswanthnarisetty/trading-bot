import React from "react";
import type { GreeksSnapshot } from "@trading-bot/shared";

interface IVPanelProps {
  greeksSnapshot: GreeksSnapshot | null;
}

export function IVPanel({ greeksSnapshot }: IVPanelProps): JSX.Element {
  if (!greeksSnapshot) {
    return (
      <div
        className="rounded-xl border p-4 text-sm font-sans"
        style={{
          borderColor: "rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)",
          color: "rgba(255,255,255,0.3)",
        }}
      >
        IV data unavailable — awaiting tick data.
      </div>
    );
  }

  const ivRank = greeksSnapshot.ivRank;
  const ivPercentile = greeksSnapshot.ivPercentile;

  // Position on the gradient bar
  const indicatorLeft = `${Math.max(0, Math.min(100, ivRank))}%`;

  // PCR color: bearish heavy >1.2 = red, bullish <0.8 = green
  const pcrColor =
    greeksSnapshot.pcr > 1.2
      ? "#FF1744"
      : greeksSnapshot.pcr < 0.8
        ? "#00C853"
        : "#e0e0e0";

  const ivRankLabel =
    ivRank < 30
      ? "Low IV — Cheap Options"
      : ivRank > 70
        ? "High IV — Expensive Options"
        : "Moderate IV";

  const ivTrendLabel =
    greeksSnapshot.ivTrend === "expanding"
      ? "↑ EXPANDING"
      : greeksSnapshot.ivTrend === "contracting"
        ? "↓ CONTRACTING"
        : "→ STABLE";

  const ivTrendColor =
    greeksSnapshot.ivTrend === "expanding"
      ? "#FF1744"
      : greeksSnapshot.ivTrend === "contracting"
        ? "#00C853"
        : "rgba(255,255,255,0.6)";

  const oiSkewLabel =
    greeksSnapshot.oiSkew === "calls_heavy"
      ? "CALLS HEAVY"
      : greeksSnapshot.oiSkew === "puts_heavy"
        ? "PUTS HEAVY"
        : "NEUTRAL";

  const oiSkewClass =
    greeksSnapshot.oiSkew === "calls_heavy"
      ? "badge-sell"
      : greeksSnapshot.oiSkew === "puts_heavy"
        ? "badge-buy"
        : "badge-muted";

  return (
    <div
      className="rounded-xl p-4 text-sm text-[#e0e0e0]"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="ui-label">IV & Option Chain</span>
        <span
          className="font-mono text-[0.65rem] tracking-widest"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          IVR / PCR / Max Pain
        </span>
      </div>

      {/* IV Rank gradient bar */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="ui-label text-[0.62rem]">IV Rank</span>
          <div className="flex items-center gap-2">
            <span
              className="font-sans text-[0.7rem]"
              style={{ color: "rgba(255,255,255,0.4)" }}
            >
              {ivRankLabel}
            </span>
            <span className="font-mono text-sm font-bold text-[#e0e0e0]">
              {ivRank.toFixed(1)}%
            </span>
          </div>
        </div>
        {/* Gradient bar: green→yellow→red always visible; white dot shows position */}
        <div className="relative h-3 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, #00C853 0%, #FFB300 50%, #FF1744 100%)",
              opacity: 0.5,
            }}
          />
          {/* Position indicator */}
          <div
            className="absolute top-0.5 h-2 w-2 -translate-x-1/2 rounded-full bg-white shadow-md"
            style={{
              left: indicatorLeft,
              boxShadow: "0 0 6px rgba(255,255,255,0.8)",
              transition: "left 0.5s ease",
            }}
          />
        </div>
        <div
          className="mt-0.5 flex justify-between font-mono text-[0.6rem]"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          <span>0 · Low</span>
          <span>50 · Mid</span>
          <span>100 · High</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-0.5">IV Percentile</div>
          <div className="font-mono text-base font-semibold text-[#e0e0e0]">
            {ivPercentile.toFixed(1)}%
          </div>
        </div>
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-0.5">PCR</div>
          <div
            className="font-mono text-base font-semibold"
            style={{ color: pcrColor }}
          >
            {greeksSnapshot.pcr.toFixed(2)}
          </div>
        </div>
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-0.5">Max Pain</div>
          <div className="font-mono text-base font-semibold text-[#e0e0e0]">
            {greeksSnapshot.maxPain.toFixed(0)}
          </div>
        </div>
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-0.5">IV Trend</div>
          <div
            className="font-mono text-sm font-semibold"
            style={{ color: ivTrendColor }}
          >
            {ivTrendLabel}
          </div>
        </div>
      </div>

      {/* Bottom row */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className={`badge ${oiSkewClass}`}>OI Skew: {oiSkewLabel}</span>
        <span
          className="font-mono text-[0.68rem]"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          Near: {(greeksSnapshot.nearWeekIV * 100).toFixed(1)}% · Next:{" "}
          {(greeksSnapshot.nextWeekIV * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

export default IVPanel;
