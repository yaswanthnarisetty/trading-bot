import React from "react";
import type { GreeksSnapshot } from "@trading-bot/shared";

interface GreeksPanelProps {
  greeksSnapshot: GreeksSnapshot | null;
}

/** Formats a greek value; substitutes "< 0.001" (or narrower) when the value rounds to zero. */
function formatGreek(value: number, decimals: number): string {
  const threshold = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < threshold) {
    return `< ${Math.pow(10, -decimals).toFixed(decimals)}`;
  }
  return value.toFixed(decimals);
}

function GreekTile({
  label,
  symbol,
  value,
  color,
  subtitle,
}: {
  label: string;
  symbol: string;
  value: string;
  color?: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <div className="metric-tile">
      <div className="mb-0.5 flex items-center gap-1">
        <span
          className="font-mono text-base"
          style={{ color: color ?? "#888" }}
        >
          {symbol}
        </span>
        <span className="ui-label text-[0.6rem]">{label}</span>
      </div>
      <div
        className="font-mono text-xl font-semibold"
        style={{ color: color ?? "#e0e0e0" }}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-0.5 text-[0.65rem] font-sans" style={{ color: "rgba(255,255,255,0.3)" }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

export function GreeksPanel({
  greeksSnapshot,
}: GreeksPanelProps): JSX.Element {
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
        Greeks unavailable — awaiting tick data.
      </div>
    );
  }

  const { delta, gamma, theta, vega, expectedMoveUp, expectedMoveDown } =
    greeksSnapshot;

  const deltaColor = delta >= 0 ? "#00C853" : "#FF1744";
  const avgMove = (expectedMoveUp - expectedMoveDown) / 2;

  // Expected move range bar: map [expectedMoveDown, expectedMoveUp] to [0,100]
  const midPct = 50; // center
  const totalRange = expectedMoveUp - expectedMoveDown;

  return (
    <div
      className="rounded-xl p-4 text-sm text-[#e0e0e0]"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="ui-label">Est. Greeks (Black-Scholes)</span>
          <div
            className="mt-0.5 font-sans text-[0.62rem]"
            style={{ color: "rgba(255,255,255,0.25)" }}
          >
            Approximated — not exchange data
          </div>
        </div>
        <span
          className="font-mono text-[0.65rem] tracking-widest"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          Δ · Γ · Θ · V
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <GreekTile
          label="Delta"
          symbol="Δ"
          value={formatGreek(delta, 3)}
          color={deltaColor}
          subtitle={delta >= 0 ? "Bullish exposure" : "Bearish exposure"}
        />
        <GreekTile
          label="Theta/day"
          symbol="Θ"
          value={formatGreek(theta, 3)}
          color="#FFB300"
          subtitle="Time decay"
        />
        <GreekTile
          label="Gamma"
          symbol="Γ"
          value={formatGreek(gamma, 5)}
          subtitle="Rate of Δ change"
        />
        <GreekTile
          label="Vega"
          symbol="V"
          value={formatGreek(vega, 3)}
          subtitle="IV sensitivity"
        />
      </div>

      {/* Expected move range bar */}
      <div
        className="mt-3 rounded-lg px-3 py-2.5"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="mb-1.5 flex items-center justify-between">
          <span className="ui-label text-[0.62rem]">Expected Move (1σ)</span>
          <span className="font-mono text-xs font-semibold text-[#e0e0e0]">
            ±{avgMove.toFixed(0)} pts
          </span>
        </div>
        <div
          className="relative h-2 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          {/* Range fill */}
          <div
            className="absolute h-full rounded-full"
            style={{
              left: "15%",
              right: "15%",
              background:
                "linear-gradient(90deg, rgba(255,23,68,0.4), rgba(255,179,0,0.4), rgba(0,200,83,0.4))",
            }}
          />
          {/* Center marker */}
          <div
            className="absolute top-0 h-full w-0.5 rounded-full bg-white/40"
            style={{ left: "calc(50% - 1px)" }}
          />
        </div>
        <div
          className="mt-1 flex justify-between font-mono text-[0.65rem]"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          <span>↓ {expectedMoveDown.toFixed(0)}</span>
          <span>{expectedMoveUp.toFixed(0)} ↑</span>
        </div>
      </div>
    </div>
  );
}

export default GreeksPanel;
