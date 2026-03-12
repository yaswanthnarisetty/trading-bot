"use client";

import React, { useEffect, useState } from "react";
import MockDataBanner from "../../../components/shared/MockDataBanner";
import ConnectionStatus from "../../../components/shared/ConnectionStatus";
import SignalCard from "../../../components/dashboard/SignalCard";
import IndicatorPanel from "../../../components/dashboard/IndicatorPanel";
import IVPanel from "../../../components/dashboard/IVPanel";
import GreeksPanel from "../../../components/dashboard/GreeksPanel";
import SRPanel from "../../../components/dashboard/SRPanel";
import SignalHistory from "../../../components/dashboard/SignalHistory";
import PositionsTable from "../../../components/dashboard/PositionsTable";
import { useAppContext } from "../../../context/AppContext";
import { useWebSocket } from "../../../hooks/useWebSocket";
import { useSessionTimer } from "../../../hooks/useSessionTimer";
import {
  getActiveSession,
  getAssets,
  getPositions,
  getSignalHistory,
  startSession,
  stopSession,
  type Asset,
  type SignalLog,
} from "../../../lib/api";

function signalLogToPayload(
  log: SignalLog,
  paperPnL: number,
  openPositions: number
) {
  return {
    sessionId: log.sessionId,
    asset: log.asset,
    ltp: log.ltp ?? 0,
    signal: log.signal,
    verifierResult: log.verifierResult,
    riskAction: log.riskAction,
    blockReason: log.blockReason,
    indicators: log.indicators,
    greeksSnapshot: log.greeksSnapshot,
    expiryContext: log.expiryContext,
    paperPnL,
    openPositions,
    dataMode: log.dataMode,
    timestamp: Date.parse(log.timestamp),
  };
}

export default function DashboardPage(): JSX.Element {
  const { state, dispatch } = useAppContext();
  const { connect, disconnect } = useWebSocket();
  const elapsedLabel = useSessionTimer();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [isLoadingSession, setIsLoadingSession] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const [assetList, active] = await Promise.all([
          getAssets(),
          getActiveSession(),
        ]);
        setAssets(assetList);
        if (!selectedAsset && assetList.length > 0) {
          setSelectedAsset(assetList[0]!.key);
        }
        if (active) {
          dispatch({ type: "SESSION_SYNCED", payload: active });
          setSelectedAsset(active.asset);
        }
        if (active && active.status === "RUNNING") {
          connect(active.sessionId);
          const [positionsPage, signalPage] = await Promise.all([
            getPositions(active.sessionId, "ALL", 50, 0),
            getSignalHistory(active.sessionId, 10, 0),
          ]);
          dispatch({
            type: "POSITIONS_SYNCED",
            payload: positionsPage.positions,
          });
          dispatch({
            type: "SIGNALS_SYNCED",
            payload: signalPage.signals.map((log) =>
              signalLogToPayload(
                log,
                active.paperPnL,
                positionsPage.positions.filter((p) => p.status === "OPEN").length
              )
            ),
          });
        }
      } catch (error) {
        console.error("Failed to bootstrap dashboard", error);
      }
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStart(): Promise<void> {
    if (!selectedAsset || state.session.status === "RUNNING") return;
    setIsLoadingSession(true);
    try {
      await startSession(selectedAsset);
      const session = await getActiveSession();
      if (!session) {
        throw new Error("Session started but active session was not returned");
      }
      dispatch({
        type: "SESSION_STARTED",
        payload: {
          sessionId: session.sessionId,
          asset: session.asset,
          paperCapital: session.paperCapital,
          dataMode: session.dataMode,
          startTime: session.startTime,
        },
      });
      connect(session.sessionId);
    } catch (error) {
      console.error("Failed to start session", error);
    } finally {
      setIsLoadingSession(false);
    }
  }

  async function handleStop(): Promise<void> {
    if (!state.session.id || state.session.status !== "RUNNING") return;
    setIsLoadingSession(true);
    try {
      await stopSession(state.session.id);
      dispatch({ type: "SESSION_STOPPED" });
      disconnect();
    } catch (error) {
      console.error("Failed to stop session", error);
    } finally {
      setIsLoadingSession(false);
    }
  }

  const isRunning = state.session.status === "RUNNING";
  const ticksCount = state.session.totalSignals;
  const currentSignal = state.currentSignal;

  // Warmup status derived from candleCount in the latest indicator snapshot
  const candleCount = state.indicators?.candleCount ?? null;
  const warmupStatus = (() => {
    if (candleCount === null) return null;
    if (candleCount < 14) return { icon: "🔴", label: "Warming up — limited signals", color: "#FF1744" };
    if (candleCount < 20) return { icon: "🟡", label: "ATR ready — EMA warming up", color: "#FFB300" };
    if (candleCount < 50) return { icon: "🟡", label: "EMA20 ready — EMA50 warming up", color: "#FFB300" };
    return { icon: "🟢", label: "All indicators ready", color: "#00C853" };
  })();

  return (
    <div className="space-y-4">
      <MockDataBanner />

      {/* Indicator warmup status bar */}
      {warmupStatus && (
        <div
          className="rounded-xl px-4 py-2 flex items-center gap-3 font-sans text-xs"
          style={{
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <span>{warmupStatus.icon}</span>
          <span style={{ color: warmupStatus.color }} className="font-semibold">
            Data quality:
          </span>
          <span className="font-mono" style={{ color: warmupStatus.color }}>
            {candleCount}/50 candles
          </span>
          <span style={{ color: "rgba(255,255,255,0.4)" }}>
            {warmupStatus.label}
          </span>
        </div>
      )}

      <ConnectionStatus
        onReconnect={() => {
          if (state.session.id) connect(state.session.id);
        }}
      />

      {/* Session Control Toolbar */}
      <section
        className="rounded-2xl p-4"
        style={{
          background:
            "linear-gradient(135deg, rgba(20,20,20,0.9) 0%, rgba(12,12,12,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="mb-3 flex flex-wrap items-end gap-4">
          {/* Asset selector */}
          <div className="flex flex-col gap-1">
            <span className="ui-label">Asset</span>
            <select
              className="rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0] outline-none transition-colors focus:ring-1 focus:ring-white/20"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
              disabled={isRunning}
              value={selectedAsset}
              onChange={(e) => setSelectedAsset(e.target.value)}
            >
              {assets.map((asset) => (
                <option key={asset.key} value={asset.key}>
                  {asset.key}
                </option>
              ))}
            </select>
          </div>

          {/* Start/Stop button */}
          <div className="flex flex-col gap-1">
            <span className="ui-label">Session</span>
            <button
              type="button"
              onClick={isRunning ? handleStop : handleStart}
              disabled={
                isLoadingSession || (!selectedAsset && !isRunning)
              }
              className="rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
              style={{
                background: isRunning
                  ? "linear-gradient(135deg, #FF1744, #ff4569)"
                  : "linear-gradient(135deg, #00C853, #00e676)",
                color: "#000",
                boxShadow: isRunning
                  ? "0 0 16px rgba(255,23,68,0.35)"
                  : "0 0 16px rgba(0,200,83,0.35)",
              }}
            >
              {isLoadingSession ? "…" : isRunning ? "■ Stop" : "▶ Start"}
            </button>
          </div>

          {/* Status indicators */}
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <span className="ui-label">Elapsed</span>
              <div className="flex items-center gap-1.5">
                {isRunning && (
                  <span
                    className="h-1.5 w-1.5 animate-status-pulse rounded-full bg-[#00C853]"
                  />
                )}
                <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                  {elapsedLabel}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Capital</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                ₹{state.session.paperCapital.toLocaleString("en-IN")}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Mode</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                {state.session.dataMode ?? "—"}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Signals</span>
              <span
                className="inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-sm font-bold"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  color: "#e0e0e0",
                }}
              >
                {ticksCount}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Candle Interval</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                5min
              </span>
            </div>

            {state.session.ticksSkipped > 0 && (
              <div className="flex flex-col gap-1">
                <span className="ui-label">Skipped</span>
                <span className="badge badge-hold">
                  {state.session.ticksSkipped}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Session ID pill */}
        {state.session.id && (
          <div
            className="font-mono text-[0.62rem]"
            style={{ color: "rgba(255,255,255,0.2)" }}
          >
            Session: {state.session.id}
          </div>
        )}
      </section>

      {/* Main data panels */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <SignalCard
            signal={currentSignal}
            verifierResult={currentSignal?.verifierResult ?? null}
            expiryContext={currentSignal?.expiryContext ?? null}
          />
        </div>
        <div className="space-y-3">
          <GreeksPanel greeksSnapshot={state.greeksSnapshot} />
          <IVPanel greeksSnapshot={state.greeksSnapshot} />
          <SRPanel
            srContext={state.srContext as Parameters<typeof SRPanel>[0]["srContext"]}
            breakoutResult={state.breakoutResult as Parameters<typeof SRPanel>[0]["breakoutResult"]}
          />
          <IndicatorPanel indicators={state.indicators} />

          {/* Expiry context inline panel */}
          <div
            className="rounded-xl px-4 py-3 text-xs"
            style={{
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <div className="ui-label mb-2">Expiry Context</div>
            {state.expiryContext ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono">
                <div className="flex justify-between">
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>DTE</span>
                  <span className="text-[#e0e0e0]">
                    {state.expiryContext.currentDTE}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    Next DTE
                  </span>
                  <span className="text-[#e0e0e0]">
                    {state.expiryContext.nextExpiryDTE}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    Nearest
                  </span>
                  <span className="text-[#e0e0e0]">
                    {state.expiryContext.nearestExpiry}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    Expiry Week
                  </span>
                  <span
                    style={{
                      color: state.expiryContext.isExpiryWeek
                        ? "#FFB300"
                        : "#888",
                    }}
                  >
                    {state.expiryContext.isExpiryWeek ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between col-span-2">
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    Theta Risk
                  </span>
                  <span
                    className="font-semibold"
                    style={{
                      color:
                        state.expiryContext.thetaRisk === "high"
                          ? "#FF1744"
                          : state.expiryContext.thetaRisk === "medium"
                            ? "#FFB300"
                            : "#888",
                    }}
                  >
                    {state.expiryContext.thetaRisk.toUpperCase()}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ color: "rgba(255,255,255,0.25)" }}>
                Expiry context appears after first tick.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Signal history + positions */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SignalHistory signals={state.signalHistory} />
        <PositionsTable
          positions={state.positions}
          positionRealtime={state.positionRealtime}
          paperCapital={state.session.paperCapital}
        />
      </section>
    </div>
  );
}
