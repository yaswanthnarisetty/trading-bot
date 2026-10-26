"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCookie } from "cookies-next";
import BtcPositionsTable from "../../../components/btc/BtcPositionsTable";
import BtcSignalHistory from "../../../components/btc/BtcSignalHistory";
import { formatElapsed } from "../../../hooks/useSessionTimer";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface CryptoSession {
  sessionId: string;
  asset: string;
  capital: number;
  startTime: string;
  status: "RUNNING" | "STOPPED";
}

interface CryptoPosition {
  positionId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  entryTimestamp: string;
  stopLoss: number;
  takeProfit: number;
  realizedPnL: number | null;
  unrealizedPnL: number | null;
  status: "OPEN" | "CLOSED";
  exitReason: string | null;
}

interface DeltaStatus {
  connected: boolean;
  dataMode: "DEMO" | "MOCK" | "UNAVAILABLE";
  message: string;
  executionEnabled: boolean;
  accountEquity: number | null;
  openPositionCount: number | null;
  activeOrderCount: number | null;
  autoTrading?: { configured: boolean; enabled: boolean; paused: boolean;
    state: string; reason: string | null; checkedAt: string | null };
}

interface DemoPreview {
  auto?: { configured: boolean; enabled: boolean; paused: boolean;
    state: string; reason: string | null; checkedAt: string | null;
    clientOrderId: string | null };
  daily?: { completedDay: string | null; side: "LONG" | "SHORT" | null;
    reason: string | null; plan: null | { eligible: false; reason: string; riskBudgetUsd: number;
      minimumContractLossUsd: number | null } | { eligible: true; side: "LONG" | "SHORT";
      contractCount: number; stopReferenceUsd: number; takeProfitReferenceUsd: number;
      estimatedLossAtStopUsd: number; riskBudgetUsd: number } };
  product: { id: number; contractValueBtc: number; tickSize: number };
  signal: null | { side: "LONG" | "SHORT" | "HOLD"; confidence: number; reason: string; atr: number };
  signalError: string | null;
  priceError: string | null;
  book: null | { bidUsd: number; askUsd: number; bidSizeContracts: number;
    askSizeContracts: number; spreadBps: number; exchangeTimeMs: number };
  bookError: string | null;
  plan: null | { eligible: false; reason: string; minimumContractLossUsd: number | null } |
    { eligible: true; contractCount: number; side: "LONG" | "SHORT"; entryReferenceUsd: number;
      stopReferenceUsd: number; takeProfitReferenceUsd: number; estimatedLossAtStopUsd: number;
      riskBudgetUsd: number; notionalUsd: number };
  legacyOpenCount: number;
  legacyUnquarantinedCount: number;
  legacyRecordState: "NONE" | "UNVERIFIED_LOCAL_ONLY" | "QUARANTINED_UNVERIFIED";
  exposure: { sizeContracts: number; entryPriceUsd: number | null; activeOrders: Array<{ id: string }> };
  activeIntent: null | { clientOrderId: string; status: string; attentionReason: string | null };
  latestDemoTrade: null | { clientOrderId: string; side: "LONG" | "SHORT"; sizeContracts: number;
    entryPriceUsd: number; exitPriceUsd: number | null; realizedPnlUsd: number;
    entryOrderId: string; exitOrderId: string; closedAt: string };
  latestDailyTrade: DemoPreview["latestDemoTrade"];
  blockers: string[];
}

function authHeader() {
  const token = getCookie("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function BtcPage() {
  const [session, setSession] = useState<CryptoSession | null>(null);
  const [positions, setPositions] = useState<CryptoPosition[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [deltaStatus, setDeltaStatus] = useState<DeltaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DemoPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [autoActionBusy, setAutoActionBusy] = useState(false);
  const [autoActionError, setAutoActionError] = useState<string | null>(null);

  const toggleAutoPause = async () => {
    const paused = deltaStatus?.autoTrading?.paused === true;
    setAutoActionBusy(true);
    setAutoActionError(null);
    try {
      const response = await fetch(`${API}/api/crypto/demo-auto/${paused ? "resume" : "pause"}`, {
        method: "POST", headers: authHeader() as any,
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body?.code ?? "Demo auto control failed");
      }
      await Promise.all([fetchDeltaStatus(), fetchPreview()]);
    } catch (error) {
      setAutoActionError(error instanceof Error ? error.message : "Demo auto control failed");
    } finally { setAutoActionBusy(false); }
  };

  const fetchPreview = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/crypto/preview`, { headers: authHeader() as any });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.code ?? `Preview failed (${res.status})`);
      setPreview(data);
      setPreviewError(null);
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof Error ? error.message : "Preview unavailable");
    }
  }, []);

  const fetchDeltaStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/crypto/status`, { headers: authHeader() as any });
      if (!res.ok) throw new Error(`Delta account check failed (${res.status})`);
      setDeltaStatus(await res.json());
      setStatusError(null);
    } catch (error) {
      setDeltaStatus(null);
      setStatusError(error instanceof Error ? error.message : "Delta account check failed");
    }
  }, []);

  // ── Session Timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (session?.status !== "RUNNING" || !session.startTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [session?.startTime, session?.status]);

  const elapsedLabel = session?.startTime
    ? formatElapsed((now - Date.parse(session.startTime)) / 1000)
    : formatElapsed(0);

  // ── Fetch active session on mount ─────────────────────────────────────────
  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/crypto/session/active`, {
        headers: authHeader() as any,
      });
      if (!res.ok) throw new Error(`BTC session check failed (${res.status})`);
      const data = await res.json();
      setSession(data?.sessionId ? data : null);
    } catch (error) { setSession(null); setStatusError(error instanceof Error ? error.message : "BTC session check failed"); }
  }, []);

  // ── Fetch open positions for active session ───────────────────────────────
  const fetchPositions = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API}/api/crypto/positions/${sessionId}/open`, {
        headers: authHeader() as any,
      });
      const data = await res.json();
      setPositions(Array.isArray(data) ? data : []);
    } catch { /* non-blocking */ }
  }, []);

  // ── Fetch current BTC price ───────────────────────────────────────────────
  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/crypto/price`, {
        headers: authHeader() as any,
      });
      if (!res.ok) throw new Error(`BTC price unavailable (${res.status})`);
      const data = await res.json();
      setPrice(Number.isFinite(data.price) ? data.price : null);
    } catch { setPrice(null); }
  }, []);

  // ── Fetch persisted signal history for a session ──────────────────────────
  const fetchSignals = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API}/api/crypto/signals/${sessionId}?limit=20`, {
        headers: authHeader() as any,
      });
      const data = await res.json();
      const rows: any[] = Array.isArray(data.signals) ? data.signals : [];
      // Convert DB docs to the same shape the WebSocket handler produces
      setSignals(
        rows.map((s) => ({
          ...s,
          _tsDisplay: new Date(s.timestamp).toLocaleTimeString(),
        }))
      );
    } catch { /* non-blocking */ }
  }, []);

  // ── Initialise ────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      setLoading(true);
      await fetchSession();
      await fetchDeltaStatus();
      await fetchPrice();
      await fetchPreview();
      setLoading(false);
    })();
  }, [fetchSession, fetchDeltaStatus, fetchPrice, fetchPreview]);

  useEffect(() => {
    const interval = setInterval(() => { void fetchDeltaStatus(); void fetchPrice(); }, 30_000);
    return () => clearInterval(interval);
  }, [fetchDeltaStatus, fetchPrice]);

  useEffect(() => {
    const interval = setInterval(() => { void fetchPreview(); }, 60_000);
    return () => clearInterval(interval);
  }, [fetchPreview]);

  // ── Load persisted signal history once session is known ───────────────────
  useEffect(() => {
    if (session?.sessionId) {
      void fetchSignals(session.sessionId);
    }
  }, [session?.sessionId, fetchSignals]);

  // ── Poll positions + price every 10 s when session is active ─────────────
  useEffect(() => {
    if (!session?.sessionId) return;
    void fetchPositions(session.sessionId);

    const interval = setInterval(() => {
      void fetchPositions(session.sessionId);
      void fetchPrice();
    }, 10_000);

    return () => clearInterval(interval);
  }, [session?.sessionId, fetchPositions, fetchPrice]);

  // ── Session actions ───────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!deltaStatus?.executionEnabled) return;
    try {
      const res = await fetch(`${API}/api/crypto/session/start`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `BTC start failed (${res.status})`);
      setSession(data);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "BTC start failed");
    }
  };

  const handleStop = async () => {
    if (!deltaStatus?.executionEnabled) return;
    try {
      const res = await fetch(`${API}/api/crypto/session/stop`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      if (!res.ok) throw new Error(`BTC stop failed (${res.status})`);
      setSession((s) => (s ? { ...s, status: "STOPPED" } : null));
      setPositions([]);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "BTC stop failed");
    }
  };

  const handleManualClose = async (positionId: string) => {
    if (!deltaStatus?.executionEnabled) return;
    try {
      const res = await fetch(`${API}/api/crypto/positions/${positionId}/close`, {
        method: "PATCH",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      if (!res.ok) throw new Error(`BTC close failed (${res.status})`);
      if (session?.sessionId) void fetchPositions(session.sessionId);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "BTC close failed");
    }
  };

  const reconnectWs = useCallback(() => {
    if (!session?.sessionId) return;
    
    // Read the token from cookies
    const token = getCookie("token") ?? "";
    const wsUrl =
      (process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000") +
      `?sessionId=${session.sessionId}&token=${token}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Re-fetch signals from DB on every WS open so any signal that fired
      // during the connection window (before this socket was ready) isn't lost.
      void fetchSignals(session.sessionId);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === "POSITION_OPENED" || msg.type === "POSITION_CLOSED") {
          void fetchPositions(session.sessionId);
        }
        if (msg.type === "POSITION_UPDATE") {
          setPositions((prev) =>
            prev.map((p) =>
              p.positionId === msg.payload.positionId
                ? { ...p, unrealizedPnL: msg.payload.currentPnL }
                : p
            )
          );
          setPrice(msg.payload.currentLTP);
        }
        if (msg.type === "SIGNAL") {
          setSignals((prev) => {
            const incoming = { ...msg.payload, _tsDisplay: new Date().toLocaleTimeString() };
            // Deduplicate by timestamp — avoids double-entry when the DB fetch
            // and the live WebSocket event both arrive for the same signal
            const ts = msg.payload.timestamp as string | undefined;
            if (ts && prev.some((s: any) => s.timestamp === ts)) return prev;
            return [incoming, ...prev].slice(0, 20);
          });
        }
      } catch {
        /* ignore malformed */
      }
    };

    return () => {
      ws.close();
    };
  }, [session?.sessionId, fetchPositions, fetchSignals]);

  // ── WS for real-time position + signal updates ────────────────────────────
  useEffect(() => {
    const cleanup = reconnectWs();
    return () => {
      if (cleanup) cleanup();
    };
  }, [reconnectWs]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span style={{ color: "rgba(255,255,255,0.4)" }} className="text-sm">
          Loading BTC Engine…
        </span>
      </div>
    );
  }

  const isRunning = session?.status === "RUNNING";
  const blockerLabels: Record<string, string> = {
    DELTA_EXECUTION_DISABLED: "Old intraday entry loop is paused",
    STRATEGY_NOT_VALIDATED: "No BTC strategy passed cost-aware validation",
    ORDER_BOOK_UNAVAILABLE_OR_ILLIQUID: "The live order book is stale, wide, or too thin",
    BOOK_MARK_DIVERGENCE: "The live order book and mark price disagree",
    BROKER_LIVE_SMOKE_NOT_VERIFIED: "Protected order flow still needs a Delta Demo smoke test",
    BROKER_INTENT_ACTIVE_OR_NEEDS_ATTENTION: "A broker order is active or needs reconciliation",
    LEGACY_POSITION_LEDGER_UNRECONCILED: "Old local positions need reconciliation",
    NO_TRADE_SIGNAL: "The strategy says wait",
    LOW_SIGNAL_CONFIDENCE: "Signal confidence is below the entry minimum",
    EXCHANGE_EXPOSURE_OR_ORDER_PRESENT: "Exchange already has exposure or an open order",
    MINIMUM_CONTRACT_EXCEEDS_RISK_OR_NOTIONAL_CAP: "One contract exceeds the risk limit",
    SIGNAL_DATA_UNAVAILABLE: "Complete fresh candles are unavailable",
    MARKET_PRICE_UNAVAILABLE: "Fresh BTC price is unavailable",
  };

  return (
    <div className="space-y-4">
      {/* Indicator warmup status bar */}
      <div
        className="rounded-xl px-4 py-2 flex items-center gap-3 font-sans text-xs"
        style={{
          background: "rgba(255,255,255,0.025)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <span>⚡</span>
        <span style={{ color: "#FFB300" }} className="font-semibold">
          Delta Exchange
        </span>
        <span className="font-mono text-[#e0e0e0]">
          Perpetual Futures
        </span>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>
          24/7 market · daily Demo trial
        </span>
      </div>

      <div role="status" className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/75">
        <span className="font-semibold text-white">Delta Demo: </span>
        {statusError ?? deltaStatus?.message ?? "Checking account…"}
        {deltaStatus?.connected && <span className="ml-3">Equity ${deltaStatus.accountEquity?.toFixed(2)} · Exchange positions {deltaStatus.openPositionCount} · Open orders {deltaStatus.activeOrderCount}</span>}
        <div className="mt-1 text-amber-400">{deltaStatus?.autoTrading?.enabled
          ? "Daily-rule automatic Demo trial is on. Orders require a completed daily breakout and all risk checks. This experimental strategy has not passed historical validation."
          : deltaStatus?.autoTrading?.paused ? "New Demo entries are paused. Protected exits and reconciliation continue."
            : "Daily-rule automatic Demo trial is off."}</div>
        {deltaStatus?.autoTrading?.configured && <button type="button" onClick={() => void toggleAutoPause()}
          disabled={autoActionBusy} className="mt-2 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-50">
          {autoActionBusy ? "Updating…" : deltaStatus.autoTrading.paused ? "Resume new Demo entries" : "Pause new Demo entries"}
        </button>}
        {autoActionError && <p className="mt-1 text-rose-400">{autoActionError}</p>}
      </div>

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
          <div className="flex flex-col gap-1">
            <span className="ui-label">Asset</span>
            <div
              className="rounded-lg px-3 py-2 text-xs font-mono font-bold uppercase transition-colors"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#ff9800",
              }}
            >
              BTCUSD
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ui-label">Session</span>
            <button
              type="button"
              onClick={isRunning ? handleStop : handleStart}
              disabled={!deltaStatus?.executionEnabled}
              className="rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all disabled:cursor-not-allowed"
              style={{
                background: isRunning
                  ? "linear-gradient(135deg, #FF1744, #ff4569)"
                  : deltaStatus?.executionEnabled ? "linear-gradient(135deg, #00C853, #00e676)" : "rgba(255,179,0,0.12)",
                color: deltaStatus?.executionEnabled || isRunning ? "#000" : "#FFB300",
                border: deltaStatus?.executionEnabled || isRunning ? "none" : "1px solid rgba(255,179,0,0.25)",
                boxShadow: isRunning
                  ? "0 0 16px rgba(255,23,68,0.35)"
                  : deltaStatus?.executionEnabled ? "0 0 16px rgba(0,200,83,0.35)" : "none",
              }}
            >
              {isRunning ? "■ Stop" : deltaStatus?.executionEnabled ? "▶ Start" : "Old loop off"}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <span className="ui-label">Elapsed</span>
              <div className="flex items-center gap-1.5">
                {isRunning && (
                  <span className="h-1.5 w-1.5 animate-status-pulse rounded-full bg-[#00C853]" />
                )}
                <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                  {elapsedLabel}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Capital</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                {deltaStatus?.accountEquity === null || deltaStatus?.accountEquity === undefined ? "—" : `$${deltaStatus.accountEquity.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Mode</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                {deltaStatus?.autoTrading?.enabled ? "DEMO · DAILY AUTO" : "DEMO · MONITOR"}
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
                {signals.length}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">LTP</span>
              <span className="font-mono text-sm font-semibold" style={{ color: "#00C853" }}>
                ${price?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}
              </span>
            </div>
          </div>
        </div>

        {session?.sessionId && (
          <div
            className="font-mono text-[0.62rem]"
            style={{ color: "rgba(255,255,255,0.2)" }}
          >
            Session: {session.sessionId}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#101010] p-4 text-sm text-white/75">
        <h2 className="font-semibold uppercase tracking-wider text-white">Daily Demo auto trading</h2>
        <p className="mt-2">{preview?.auto?.enabled ? "Enabled for Delta Demo only" : "Disabled"} · {preview?.auto?.state ?? "Checking"}{preview?.auto?.reason ? ` · ${preview.auto.reason}` : ""}</p>
        <p className="mt-1">Completed UTC day: {preview?.daily?.completedDay ?? "unavailable"} · Setup: {preview?.daily?.side ?? "none"}</p>
        {preview?.daily?.plan?.eligible ? <p className="mt-1">Plan: {preview.daily.plan.contractCount} contract{preview.daily.plan.contractCount === 1 ? "" : "s"} · stop ${preview.daily.plan.stopReferenceUsd.toFixed(1)} · target ${preview.daily.plan.takeProfitReferenceUsd.toFixed(1)} · estimated stop loss ${preview.daily.plan.estimatedLossAtStopUsd.toFixed(2)} / ${preview.daily.plan.riskBudgetUsd.toFixed(2)} budget</p>
          : <p className="mt-1 text-amber-400">{preview?.daily?.reason === "BTC_DAILY_NO_CLEAN_SETUP" ? "No daily breakout setup today." : preview?.daily?.reason ?? "Waiting for daily evidence."}{preview?.daily?.plan && !preview.daily.plan.eligible && preview.daily.plan.minimumContractLossUsd !== null ? ` One-contract estimated loss: $${preview.daily.plan.minimumContractLossUsd.toFixed(2)}.` : ""}</p>}
        <p className="mt-1 text-white/45">One new entry near the UTC daily open, 0.5% estimated risk, 1× notional, prior-day stop, 2R target, three-loss cooldown. The historical study did not validate profitability.</p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#101010] p-4 text-sm text-white/75">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold uppercase tracking-wider text-white">Old intraday research preview</h2>
          <span className="text-amber-400">Read only</span>
        </div>
        {previewError ? <p>Preview blocked: {previewError}</p> : !preview ? <p>Checking complete BTC candles and account risk…</p> : <>
          <p>Signal: {preview.signal ? <><strong>{preview.signal.side}</strong> · {(preview.signal.confidence * 100).toFixed(0)}% · {preview.signal.reason}</> : `Unavailable${preview.signalError ? ` (${preview.signalError})` : ""}`}</p>
          {preview.priceError && <p className="mt-1">Price check: {preview.priceError}</p>}
          {preview.book ? <p className="mt-1">Live BTC spread: {preview.book.spreadBps.toFixed(2)} bp · bid ${preview.book.bidUsd.toFixed(1)} · ask ${preview.book.askUsd.toFixed(1)} · near-price depth {preview.book.bidSizeContracts}/{preview.book.askSizeContracts} contracts</p>
            : preview.bookError && <p className="mt-1">Order book: {preview.bookError}</p>}
          {preview.plan?.eligible ? <p className="mt-2">Proposed {preview.plan.side}: {preview.plan.contractCount} BTCUSD contract{preview.plan.contractCount === 1 ? "" : "s"} · entry reference ${preview.plan.entryReferenceUsd.toFixed(1)} · stop reference ${preview.plan.stopReferenceUsd.toFixed(1)} · target reference ${preview.plan.takeProfitReferenceUsd.toFixed(1)} · estimated loss at stop ${preview.plan.estimatedLossAtStopUsd.toFixed(2)} / ${preview.plan.riskBudgetUsd.toFixed(2)} budget</p>
            : <p className="mt-2">{preview.plan && !preview.plan.eligible ? `No eligible contract size: ${preview.plan.reason}.` : "No trade planned for the current signal."}</p>}
          <p className="mt-2 text-amber-400">Waiting on: {preview.blockers.map(code => blockerLabels[code] ?? code).join(" · ")}</p>
          <p className="mt-1">Exchange BTC exposure: {preview.exposure.sizeContracts} contracts · {preview.exposure.activeOrders.length} active BTC orders.</p>
          {preview.activeIntent && <p className="mt-1 text-amber-300">Order {preview.activeIntent.clientOrderId}: {preview.activeIntent.status}{preview.activeIntent.attentionReason ? ` · ${preview.activeIntent.attentionReason}` : ""}</p>}
          {preview.legacyOpenCount > 0 && <p className="mt-1">{preview.legacyOpenCount} old local “open” records are unverified by Delta{preview.legacyRecordState === "QUARANTINED_UNVERIFIED" ? " and quarantined from trading decisions" : "; reconciliation is pending"}. They are not confirmed live trades.</p>}
        </>}
      </section>

      {preview?.latestDemoTrade && <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-sm text-white/80">
        <h2 className="font-semibold uppercase tracking-wider text-emerald-400">Verified Delta Demo trade</h2>
        <p className="mt-2">Broker test · {preview.latestDemoTrade.side} {preview.latestDemoTrade.sizeContracts} BTCUSD contract · entry ${preview.latestDemoTrade.entryPriceUsd.toFixed(1)} · exit {preview.latestDemoTrade.exitPriceUsd === null ? "confirmed by fill" : `$${preview.latestDemoTrade.exitPriceUsd.toFixed(1)}`} · net P&amp;L ${preview.latestDemoTrade.realizedPnlUsd.toFixed(2)}</p>
        <p className="mt-1 font-mono text-xs text-white/50">Entry order {preview.latestDemoTrade.entryOrderId} · close order {preview.latestDemoTrade.exitOrderId} · closed {new Date(preview.latestDemoTrade.closedAt).toLocaleString()}</p>
      </section>}

      {preview?.latestDailyTrade && <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 text-sm text-white/80">
        <h2 className="font-semibold uppercase tracking-wider text-emerald-400">Latest automatic Delta Demo trade</h2>
        <p className="mt-2">{preview.latestDailyTrade.side} {preview.latestDailyTrade.sizeContracts} BTCUSD contract{preview.latestDailyTrade.sizeContracts === 1 ? "" : "s"} · entry ${preview.latestDailyTrade.entryPriceUsd.toFixed(1)} · exit ${preview.latestDailyTrade.exitPriceUsd?.toFixed(1) ?? "—"} · net P&amp;L ${preview.latestDailyTrade.realizedPnlUsd.toFixed(2)}</p>
        <p className="mt-1 font-mono text-xs text-white/50">Entry order {preview.latestDailyTrade.entryOrderId} · exit order {preview.latestDailyTrade.exitOrderId} · closed {new Date(preview.latestDailyTrade.closedAt).toLocaleString()}</p>
      </section>}

      {/* Signal history + positions */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BtcSignalHistory signals={signals} isRunning={isRunning} />
        {preview && preview.exposure.sizeContracts !== 0 ? <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-200">
          Delta reports an open BTC position of {preview.exposure.sizeContracts} contracts. Inspect its broker orders and protection before taking any action; old local position records are not authoritative.
        </div> : <BtcPositionsTable
          positions={positions}
          currentPrice={price}
          paperCapital={deltaStatus?.accountEquity ?? 0}
          onClose={handleManualClose}
        />}
      </section>
    </div>
  );
}
