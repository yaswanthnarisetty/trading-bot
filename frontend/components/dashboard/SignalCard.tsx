import React from "react";
import type { SignalPayload, VerifierResult } from "@trading-bot/shared";
import type { ExpiryContext } from "@trading-bot/shared";
import StrategyCard from "./StrategyCard";

interface SignalCardProps {
  signal: SignalPayload | null;
  verifierResult: VerifierResult | null;
  expiryContext: ExpiryContext | null;
}

export function SignalCard({
  signal,
  verifierResult,
  expiryContext,
}: SignalCardProps): JSX.Element {
  if (!signal) {
    return (
      <div
        className="flex h-40 items-center justify-center rounded-2xl border border-dashed text-sm font-sans"
        style={{
          borderColor: "rgba(255,255,255,0.1)",
          color: "rgba(255,255,255,0.3)",
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div className="text-center">
          <div className="mb-1 text-2xl">◎</div>
          <div>Awaiting signals — start a session</div>
        </div>
      </div>
    );
  }

  const { signal: primarySignal, riskAction, blockReason, asset } = signal;

  const riskFlags = primarySignal.riskFlags ?? [];
  const keyFactors = primarySignal.keyFactors ?? [];

  const dte = expiryContext?.currentDTE ?? null;
  const thetaRisk = expiryContext?.thetaRisk ?? "low";

  const thetaColor =
    thetaRisk === "high"
      ? "#FF1744"
      : thetaRisk === "medium"
        ? "#FFB300"
        : "#888";

  const expirySummary =
    expiryContext != null
      ? `DTE ${expiryContext.currentDTE} · Expiry Week: ${expiryContext.isExpiryWeek ? "Yes" : "No"
      } · Theta Risk: ${thetaRisk.toUpperCase()}`
      : "Expiry context unavailable";

  const isVerified = verifierResult && !verifierResult.overruled;
  const isOverruled = verifierResult && verifierResult.overruled;

  const adjustedConfidence =
    verifierResult?.adjustedConfidence ?? primarySignal.confidence;

  return (
    <div className="space-y-3 text-sm text-[#e0e0e0]">
      <StrategyCard
        signal={primarySignal}
        asset={asset}
        riskAction={riskAction}
        blockReason={blockReason}
      />

      {/* Reasoning block */}
      <div
        className="rounded-xl p-4"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div className="mb-2.5 flex items-center justify-between">
          <span className="ui-label">Reasoning</span>
          {dte != null && (
            <span
              className="font-mono text-xs font-semibold"
              style={{ color: thetaColor }}
            >
              DTE {dte} · Θ {thetaRisk.toUpperCase()}
            </span>
          )}
        </div>
        <p className="mb-3 text-sm font-sans leading-relaxed text-[#d0d0d0]">
          {primarySignal.reasoning}
        </p>

        {/* Key factors */}
        {keyFactors.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {keyFactors.map((factor) => (
              <span key={factor} className="badge badge-muted">
                {factor}
              </span>
            ))}
          </div>
        )}

        {/* Risk flags */}
        {riskFlags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {riskFlags.map((flag) => (
              <span key={flag} className="badge badge-sell">
                ⚠ {flag}
              </span>
            ))}
          </div>
        )}

        {/* Expiry summary */}
        <div
          className="mt-3 rounded-lg px-3 py-1.5 font-mono text-[0.72rem]"
          style={{
            background: "rgba(255,255,255,0.03)",
            color: "rgba(255,255,255,0.4)",
          }}
        >
          {expirySummary}
        </div>
      </div>

      {/* Verifier block */}
      {verifierResult && (
        <div
          className="rounded-xl p-4"
          style={{
            background: isVerified
              ? "rgba(0,200,83,0.04)"
              : "rgba(255,179,0,0.04)",
            border: `1px solid ${isVerified
                ? "rgba(0,200,83,0.2)"
                : "rgba(255,179,0,0.2)"
              }`,
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="ui-label">AI Verifier</span>
            <span
              className={`badge ${isVerified ? "badge-buy" : "badge-hold"
                }`}
            >
              {isVerified ? "✓ Verified" : "⚠ Overruled"}
            </span>
          </div>
          <div
            className="mb-1.5 font-sans text-xs"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            Adjusted Confidence:{" "}
            <span
              className="font-mono font-bold"
              style={{
                color:
                  adjustedConfidence >= 0.65
                    ? "#00C853"
                    : adjustedConfidence >= 0.40
                      ? "#FFB300"
                      : adjustedConfidence >= 0.15
                        ? "#FF9800"
                        : "#FF1744",
              }}
            >
              {(adjustedConfidence * 100).toFixed(1)}%
              {adjustedConfidence >= 0.65
                ? " (High)"
                : adjustedConfidence >= 0.40
                  ? " (Medium)"
                  : adjustedConfidence >= 0.15
                    ? " (Low)"
                    : " (Very Low)"}
            </span>
          </div>
          <p className="text-xs font-sans leading-relaxed text-[#c0c0c0]">
            {verifierResult.auditNotes}
          </p>
          {verifierResult.additionalRiskFlags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {verifierResult.additionalRiskFlags.map((flag) => (
                <span key={flag} className="badge badge-hold">
                  ⚠ {flag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SignalCard;
