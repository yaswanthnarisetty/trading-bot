import React from "react";
import type { PrimarySignal } from "@trading-bot/shared";

type RiskAction = "SUGGEST" | "BLOCK";

interface LocalSpreadDetails {
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  sellStrike: number;
  buyStrike: number;
  credit: number;
  maxLoss: number;
  riskReward: number;
  asset: string;
  optionType: "CALL" | "PUT";
}

interface StrategyCardProps {
  signal: PrimarySignal | null;
  asset: string | null;
  riskAction: RiskAction;
  blockReason: string | null;
  spreadDetails?: LocalSpreadDetails | null;
}

/**
 * Decodes machine-readable block reasons into user-friendly status badges.
 * Handles both legacy generic reasons and the new structured dedup reasons.
 */
function BlockReasonBadge({ reason }: { reason: string }): JSX.Element {
  let icon = "✗";
  let label = reason;
  let bg = "rgba(255,179,0,0.07)";
  let border = "rgba(255,179,0,0.25)";
  let color = "#FFB300";

  if (reason.startsWith("duplicate_strategy:")) {
    const strategy = reason.split(":")[1] ?? "";
    const label_ = strategy === "BEAR_CALL_SPREAD" ? "Bear Call" : "Bull Put";
    icon = "⏳";
    label = `Waiting — ${label_} Spread already open`;
    bg = "rgba(255,179,0,0.07)";
    border = "rgba(255,179,0,0.25)";
    color = "#FFB300";
  } else if (reason.startsWith("same_direction_open:")) {
    const parts = reason.split(":");
    const direction = parts[1] ?? "";
    icon = "⏳";
    label = `Waiting — ${direction} position already active`;
  } else if (reason.startsWith("daily_limit:")) {
    const parts = reason.split(":");
    const count = parts[1] ?? "?";
    const max   = parts[2] ?? "?";
    icon = "🔒";
    label = `Daily limit reached (${count}/${max} trades today)`;
    bg = "rgba(100,100,100,0.08)";
    border = "rgba(150,150,150,0.2)";
    color = "#888";
  } else if (reason === "signal_is_hold") {
    icon = "—";
    label = "Signal is HOLD — no trade";
    color = "#888";
    bg = "rgba(100,100,100,0.06)";
    border = "rgba(150,150,150,0.15)";
  } else if (reason === "market_closed") {
    icon = "🕐";
    label = "Market closed";
    color = "#888";
    bg = "rgba(100,100,100,0.06)";
    border = "rgba(150,150,150,0.15)";
  }

  return (
    <div
      className="mb-3 rounded-lg px-3 py-2 text-xs font-sans"
      style={{ background: bg, border: `1px solid ${border}`, color }}
    >
      <span className="mr-1.5">{icon}</span>
      <span className="font-semibold">{label}</span>
    </div>
  );
}

export function StrategyCard({
  signal,
  asset,
  riskAction,
  blockReason,
  spreadDetails,
}: StrategyCardProps): JSX.Element {
  if (!signal) {
    return (
      <div className="rounded-xl border border-[#1e1e1e] bg-[#111111] p-6 text-sm font-sans text-[#888]">
        Waiting for first signal...
      </div>
    );
  }

  const directionLabel =
    signal.direction === "BULLISH"
      ? "▲ BULLISH"
      : signal.direction === "BEARISH"
        ? "▼ BEARISH"
        : signal.direction === "NEUTRAL"
          ? "— NEUTRAL"
          : "HOLD";

  const strategyLabel =
    signal.strategy === "BULL_PUT_SPREAD"
      ? "BULL PUT SPREAD"
      : signal.strategy === "BEAR_CALL_SPREAD"
        ? "BEAR CALL SPREAD"
        : "HOLD";

  const directionColor =
    signal.direction === "BULLISH"
      ? "#00C853"
      : signal.direction === "BEARISH"
        ? "#FF1744"
        : signal.direction === "HOLD"
          ? "#FFB300"
          : "#e0e0e0";

  const isBuy = signal.direction === "BULLISH";
  const isSell = signal.direction === "BEARISH";

  const borderColor =
    riskAction === "SUGGEST"
      ? isBuy
        ? "rgba(0,200,83,0.4)"
        : isSell
          ? "rgba(255,23,68,0.4)"
          : "rgba(255,179,0,0.4)"
      : "rgba(84,110,122,0.4)";

  const glowColor =
    riskAction === "SUGGEST"
      ? isBuy
        ? "rgba(0,200,83,0.12)"
        : isSell
          ? "rgba(255,23,68,0.12)"
          : "rgba(255,179,0,0.12)"
      : "transparent";

  const barGradient =
    isBuy
      ? "linear-gradient(90deg, #00C853, #00e676)"
      : isSell
        ? "linear-gradient(90deg, #FF1744, #ff4569)"
        : "linear-gradient(90deg, #FFB300, #ffc107)";

  const confidencePct = Math.round(signal.confidence * 100);
  const barWidth = `${Math.max(5, Math.min(100, confidencePct))}%`;

  const ivContextLabel =
    signal.ivContext === "selling_cheap"
      ? "SELLING CHEAP"
      : signal.ivContext === "selling_fair"
        ? "SELLING FAIR"
        : "SELLING EXPENSIVE";

  const ivContextClass =
    signal.ivContext === "selling_cheap"
      ? "badge-buy"
      : signal.ivContext === "selling_expensive"
        ? "badge-sell"
        : "badge-hold";

  return (
    <div
      className="animate-pulse-signal rounded-2xl p-5 shadow-card"
      style={{
        border: `1px solid ${borderColor}`,
        background: `linear-gradient(145deg, ${glowColor} 0%, #111111 60%)`,
        boxShadow: `0 0 24px ${glowColor}, 0 4px 24px rgba(0,0,0,0.5)`,
      }}
    >
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="ui-label mb-1.5">Strategy</div>
          <div
            className="text-2xl font-sans font-bold tracking-tight"
            style={{ color: directionColor }}
          >
            {strategyLabel}
          </div>
          <div
            className="mt-1 font-mono text-sm font-semibold tracking-widest"
            style={{ color: directionColor, opacity: 0.7 }}
          >
            {directionLabel}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="ui-label">Asset</div>
          <div
            className="rounded-lg px-3 py-1 font-mono text-sm font-semibold text-[#e0e0e0]"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
            }}
          >
            {asset ?? "—"}
          </div>
        </div>
      </div>

      {/* Confidence bar */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="ui-label">Confidence</span>
          <span
            className="font-mono text-sm font-bold"
            style={{ color: directionColor }}
          >
            {confidencePct}%
          </span>
        </div>
        <div
          className="relative h-2 w-full overflow-hidden rounded-full"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <div
            className="confidence-bar-fill absolute h-2 rounded-full"
            style={{
              width: barWidth,
              background: barGradient,
              boxShadow: `0 0 8px ${directionColor}88`,
            }}
          />
        </div>
      </div>

      {/* Badges row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`badge ${ivContextClass}`}>{ivContextLabel}</span>
        <span
          className={`badge ${riskAction === "SUGGEST" ? "badge-buy" : "badge-muted"
            }`}
        >
          {riskAction === "SUGGEST" ? "✓ Suggest" : "✗ Blocked"}
        </span>
      </div>

      {/* Block reason */}
      {riskAction === "BLOCK" && blockReason && (
        <BlockReasonBadge reason={blockReason} />
      )}

      {/* Spread details */}
      {spreadDetails && signal.strategy !== "HOLD" ? (
        <div
          className="mt-3 space-y-1.5 rounded-xl px-4 py-3"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="ui-label mb-2">Spread Details</div>
          <div className="font-mono text-[0.82rem] text-[#e0e0e0]">
            <span className="text-[#FF1744]">SELL</span>{" "}
            {spreadDetails.asset} {spreadDetails.sellStrike.toFixed(0)}{" "}
            {spreadDetails.optionType} @ ₹{spreadDetails.credit.toFixed(2)}
          </div>
          <div className="font-mono text-[0.82rem] text-[#e0e0e0]">
            <span className="text-[#00C853]">BUY</span>{" "}
            {spreadDetails.asset} {spreadDetails.buyStrike.toFixed(0)}{" "}
            {spreadDetails.optionType} @ ₹
            {(spreadDetails.credit - spreadDetails.maxLoss).toFixed(2)}
          </div>
          <div
            className="font-mono text-[0.75rem] pt-1 border-t"
            style={{
              borderColor: "rgba(255,255,255,0.07)",
              color: "#888",
            }}
          >
            Net Credit: ₹{spreadDetails.credit.toFixed(2)} · Max Loss: ₹
            {spreadDetails.maxLoss.toFixed(2)} · R/R: 1:
            {spreadDetails.riskReward.toFixed(2)}
          </div>
        </div>
      ) : (
        <div
          className="mt-3 text-[0.72rem] font-sans italic"
          style={{ color: "rgba(255,255,255,0.25)" }}
        >
          Spread details available when execution planning is active.
        </div>
      )}
    </div>
  );
}

export default StrategyCard;
