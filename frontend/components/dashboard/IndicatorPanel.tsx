import React from "react";
import type { IndicatorSnapshot } from "@trading-bot/shared";

interface IndicatorPanelProps {
  indicators: IndicatorSnapshot | null;
}

function WarmingUp({ need, have }: { need: number; have: number }): JSX.Element {
  return (
    <span style={{ color: "rgba(255,179,0,0.7)" }} className="font-sans text-[0.68rem]">
      Warming… ({have}/{need})
    </span>
  );
}

export function IndicatorPanel({
  indicators,
}: IndicatorPanelProps): JSX.Element {
  if (!indicators) {
    return (
      <div
        className="rounded-xl border p-4 text-sm font-sans"
        style={{
          borderColor: "rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)",
          color: "rgba(255,255,255,0.3)",
        }}
      >
        Indicators unavailable — awaiting tick data.
      </div>
    );
  }

  const rsi = indicators.rsi;
  const rsiColor =
    rsi < 30
      ? "#00C853"
      : rsi > 70
        ? "#FF1744"
        : "#e0e0e0";

  const rsiLabel =
    rsi < 30
      ? "OVERSOLD"
      : rsi > 70
        ? "OVERBOUGHT"
        : "NEUTRAL";

  const rsiBarPct = Math.max(0, Math.min(100, rsi));
  const rsiBarGradient =
    rsi < 30
      ? "linear-gradient(90deg, #00C853, #00e676)"
      : rsi > 70
        ? "linear-gradient(90deg, #FF1744, #ff4569)"
        : "linear-gradient(90deg, #888, #aaa)";

  const volColor =
    indicators.volumeRatio > 1.5 ? "#00C853" : "#e0e0e0";

  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;
  const atr = indicators.atr;
  const candleCount = indicators.candleCount ?? 0;

  const emaReady = ema20 !== null && ema50 !== null;
  const emaUp = emaReady ? ema20! > ema50! : false;
  const emaArrow = emaReady ? (emaUp ? "↑" : "↓") : "~";
  const emaColor = emaReady ? (emaUp ? "#00C853" : "#FF1744") : "#888";

  const alignmentClass =
    indicators.emaAlignment === "bullish"
      ? "badge-buy"
      : indicators.emaAlignment === "bearish"
        ? "badge-sell"
        : "badge-hold";

  const regimeIsInsufficient = indicators.regime === "INSUFFICIENT_DATA";
  const regimeClass = regimeIsInsufficient
    ? "badge-hold"
    : indicators.regime === "trending"
      ? "badge-buy"
      : indicators.regime === "volatile"
        ? "badge-hold"
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
        <span className="ui-label">Indicators</span>
        <span
          className="font-mono text-[0.65rem] tracking-widest"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          EMA / ATR / Vol
        </span>
      </div>

      {/* RSI — main feature */}
      <div
        className="mb-3 rounded-xl px-4 py-3"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="mb-1 flex items-end justify-between">
          <div>
            <div className="ui-label text-[0.6rem]">RSI(14)</div>
            <div
              className="font-mono text-3xl font-bold leading-none"
              style={{ color: rsiColor }}
            >
              {rsi.toFixed(1)}
            </div>
          </div>
          <span
            className="mb-1 font-mono text-xs font-semibold tracking-widest"
            style={{ color: rsiColor, opacity: 0.8 }}
          >
            {rsiLabel}
          </span>
        </div>
        <div
          className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <div
            className="absolute h-full rounded-full confidence-bar-fill"
            style={{
              width: `${rsiBarPct}%`,
              background: rsiBarGradient,
            }}
          />
          <div className="absolute top-0 h-full w-px bg-white/20" style={{ left: "30%" }} />
          <div className="absolute top-0 h-full w-px bg-white/20" style={{ left: "70%" }} />
        </div>
        <div
          className="mt-0.5 flex justify-between font-mono text-[0.58rem]"
          style={{ color: "rgba(255,255,255,0.25)" }}
        >
          <span>0</span>
          <span>30</span>
          <span>70</span>
          <span>100</span>
        </div>
      </div>

      {/* Other indicator grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-1">EMA 20 / 50</div>
          {emaReady ? (
            <div className="font-mono text-sm font-semibold">
              <span style={{ color: emaColor }}>{emaArrow}</span>{" "}
              <span className="text-[#e0e0e0]">{ema20!.toFixed(0)}</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}> / </span>
              <span className="text-[#e0e0e0]">{ema50!.toFixed(0)}</span>
            </div>
          ) : (
            <WarmingUp need={50} have={candleCount} />
          )}
        </div>
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-1">ATR(14)</div>
          {atr !== null ? (
            <div className="font-mono text-sm font-semibold text-[#e0e0e0]">
              {atr.toFixed(2)}
            </div>
          ) : (
            <WarmingUp need={14} have={candleCount} />
          )}
        </div>
        <div className="metric-tile">
          <div className="ui-label text-[0.6rem] mb-1">Volume Ratio</div>
          <div
            className="font-mono text-sm font-semibold"
            style={{ color: volColor }}
          >
            {indicators.volumeRatio.toFixed(2)}×
          </div>
        </div>
        <div className="metric-tile flex flex-col gap-1.5">
          <span className={`badge ${alignmentClass} self-start`}>
            {indicators.emaAlignment.toUpperCase()}
          </span>
          <span className={`badge ${regimeClass} self-start`}>
            {regimeIsInsufficient ? "WARMING UP" : indicators.regime.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}

export default IndicatorPanel;
