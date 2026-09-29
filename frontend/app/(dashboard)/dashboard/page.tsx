"use client";

import React, { useEffect, useRef, useState } from "react";
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
  getActiveSession, getSession,
  getAssets,
  getPositions,
  getSignalHistory,
  startSession, getPaperSessionOptions, recoverPaperSession, type PaperSessionOption,
  stopSession,
  type Asset,
  type SignalLog,
} from "../../../lib/api";

import { discoverPaperSession, pollPaperSession, retainPaperSession, stopPaperSession } from "../../../lib/paperSessionControl";
const selectionKey = "paper-dashboard-selection-v1";

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

  const [paperOptions, setPaperOptions] = useState<PaperSessionOption[]>([]);
  const [selectedConfig, setSelectedConfig] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const [cycleStatus, setCycleStatus] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [isLoadingSession, setIsLoadingSession] = useState(false);

  const selectionVersion = useRef(0);

  useEffect(() => {
    const version = ++selectionVersion.current;
    async function bootstrap() {
      try {
        const [assetList, options] = await Promise.all([getAssets(), getPaperSessionOptions()]);
        if (version !== selectionVersion.current) return;
        setAssets(assetList); setPaperOptions(options);
        const saved = JSON.parse(sessionStorage.getItem(selectionKey) ?? "null");
        const chosen = options.find(c => c.configId === saved?.configId);
        let active = null;
        if (chosen) {
          setSelectedConfig(chosen.configId); setSelectedAsset(chosen.asset);
          active = saved?.sessionId
            ? await pollPaperSession({ sessionId: saved.sessionId, accountId: chosen.accountId, status: "UNKNOWN" }, getSession)
            : await discoverPaperSession(chosen.accountId, getActiveSession);
          if (version !== selectionVersion.current) return;
        }
        if (!chosen && !selectedAsset && assetList.length > 0) {
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
        if (version === selectionVersion.current) setSessionMessage("Selected session unavailable. No other account session was selected.");
      }
    }
    void bootstrap();
    return () => { selectionVersion.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.session.id || !state.session.accountId || state.session.status !== "RUNNING") return;
    let live = true; const version = selectionVersion.current;
    const selected = { sessionId: state.session.id, accountId: state.session.accountId, status: state.session.status };
    const refresh = async () => { try {
      const current = await pollPaperSession(selected, getSession);
      if (live && version === selectionVersion.current) {
        dispatch({ type: "SESSION_SYNCED", payload: current });
        setCycleStatus(`${current.strategyFamily ?? ""} · ${current.dataMode} · ${current.status} · ${current.lastCycleOutcome ?? "WAITING"} · ${current.blockingReason ?? ""}`);
        if (current.status !== "RUNNING") disconnect();
      }
    } catch { if (live && version === selectionVersion.current) { dispatch({ type: "SESSION_UNAVAILABLE" }); disconnect(); setCycleStatus("Selected session unavailable; no alternate session selected"); } } };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { live = false; clearInterval(timer); };
  }, [state.session.id, state.session.accountId, state.session.status, dispatch, disconnect]);

  async function selectConfiguration(configId: string): Promise<void> {
    const version = ++selectionVersion.current;
    setSelectedConfig(configId); disconnect(); dispatch({ type: "RESET" }); setCycleStatus("");
    sessionStorage.setItem(selectionKey, JSON.stringify({ configId }));
    const chosen = paperOptions.find(c => c.configId === configId);
    if (!chosen) return;
    setIsLoadingSession(true);
    try {
      const active = await discoverPaperSession(chosen.accountId, getActiveSession);
      if (version !== selectionVersion.current) return;
      if (active) {
        sessionStorage.setItem(selectionKey, JSON.stringify({ configId, sessionId: active.sessionId }));
        dispatch({ type: "SESSION_SYNCED", payload: active }); connect(active.sessionId);
      }
    } catch { if (version === selectionVersion.current) setSessionMessage("Account session discovery unavailable"); }
    finally { if (version === selectionVersion.current) setIsLoadingSession(false); }
  }

  async function handleStart(): Promise<void> {
    if (!selectedAsset || state.session.status === "RUNNING") return;
    selectionVersion.current++;
    setIsLoadingSession(true);
    try {
      const configuration = paperOptions.find(c => c.configId === selectedConfig && c.asset === selectedAsset);
      if (!configuration) throw new Error("Select an explicitly configured PAPER strategy.");
      const session = retainPaperSession(await startSession(configuration), configuration.accountId);
      sessionStorage.setItem(selectionKey, JSON.stringify({ configId: configuration.configId, sessionId: session.sessionId }));
      setSessionMessage("PAPER entry evaluation started. Durable exit monitoring runs independently when configured.");
      dispatch({ type: "SESSION_SYNCED", payload: session });
      connect(session.sessionId);
    } catch (error) {
      setSessionMessage(error instanceof Error ? error.message : "Session start blocked");
    } finally {
      setIsLoadingSession(false);
    }
  }

  async function handleStop(): Promise<void> {
    if (!state.session.id || state.session.status !== "RUNNING") return;
    setIsLoadingSession(true);
    try {
      await stopPaperSession({ sessionId: state.session.id, accountId: state.session.accountId ?? undefined,
        executionMode: "PAPER", status: state.session.status }, stopSession);
      selectionVersion.current++;
      dispatch({ type: "SESSION_STOPPED" });
      disconnect();
      setSessionMessage("Evaluation stopped. Existing positions remain open; reservations are retained.");
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

      <p role="status" className="text-sm text-amber-300">{sessionMessage || "PAPER entries and independent durable exit monitoring. Stop prevents new entries; it does not imply flatness."} Legacy financial panels below do not represent the durable ledger. {cycleStatus}</p>
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
              disabled={isRunning || isLoadingSession}
              value={selectedAsset}
              onChange={(e) => { setSelectedAsset(e.target.value); void selectConfiguration(""); }}
            >
              {assets.map((asset) => (
                <option key={asset.key} value={asset.key}>
                  {asset.key}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="ui-label" htmlFor="paper-configuration">PAPER strategy configuration</label>
            <select id="paper-configuration" className="rounded-lg min-h-11 px-3 py-2 bg-neutral-900 text-sm"
              disabled={isRunning || isLoadingSession} value={selectedConfig} onChange={e => { void selectConfiguration(e.target.value); }}>
              <option value="">Select configuration</option>
              {paperOptions.filter(c => c.asset === selectedAsset).map(c => <option key={c.configId} value={c.configId}>
                {c.strategyFamily} · {c.dataMode} · {c.accountId}
              </option>)}
            </select>
          </div>
          <button type="button" className="min-h-11 px-3 text-sm underline" disabled={isLoadingSession || isRunning || !selectedConfig}
            onClick={async () => { setIsLoadingSession(true); try {
              const r = await recoverPaperSession(selectedConfig); setSessionMessage(`Recovery: ${r.status}. Start remains a separate action.`);
            } catch(e) { setSessionMessage(e instanceof Error ? e.message : "Recovery blocked"); } finally { setIsLoadingSession(false); } }}>
            Check recovery (read-only broker)
          </button>
          {/* Start/Stop button */}
          <div className="flex flex-col gap-1">
            <span className="ui-label">Session</span>
            <button
              type="button"
              onClick={isRunning ? handleStop : handleStart}
              disabled={
                isLoadingSession || ((!selectedAsset || !selectedConfig) && !isRunning)
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
