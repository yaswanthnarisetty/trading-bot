"use client";

import React, { useState, useEffect, useCallback } from "react";
import { getCookie } from "cookies-next";
import BtcPositionsTable from "../../../components/btc/BtcPositionsTable";
import BtcSignalHistory from "../../../components/btc/BtcSignalHistory";
import MockDataBanner from "../../../components/shared/MockDataBanner";
import ConnectionStatus from "../../../components/shared/ConnectionStatus";
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
  const [wsConnected, setWsConnected] = useState(false);

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
      const data = await res.json();
      setSession(data);
    } catch { /* non-blocking */ }
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
      const data = await res.json();
      setPrice(data.price ?? null);
    } catch { /* non-blocking */ }
  }, []);

  // ── Initialise ────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      setLoading(true);
      await fetchSession();
      await fetchPrice();
      setLoading(false);
    })();
  }, [fetchSession, fetchPrice]);

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
    try {
      const res = await fetch(`${API}/api/crypto/session/start`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      const data = await res.json();
      setSession(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleStop = async () => {
    try {
      await fetch(`${API}/api/crypto/session/stop`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      setSession((s) => (s ? { ...s, status: "STOPPED" } : null));
      setPositions([]);
    } catch (e) {
      console.error(e);
    }
  };

  const handleManualClose = async (positionId: string) => {
    try {
      await fetch(`${API}/api/crypto/positions/${positionId}/close`, {
        method: "PATCH",
        headers: { ...authHeader(), "Content-Type": "application/json" } as any,
      });
      if (session?.sessionId) void fetchPositions(session.sessionId);
    } catch (e) {
      console.error(e);
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

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);

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
          setSignals((prev) =>
            [{ ...msg.payload, _tsDisplay: new Date().toLocaleTimeString() }, ...prev].slice(0, 20)
          );
        }
      } catch {
        /* ignore malformed */
      }
    };

    return () => {
      ws.close();
    };
  }, [session?.sessionId, fetchPositions]);

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
          24/7 Trading Engine
        </span>
      </div>

      <ConnectionStatus onReconnect={reconnectWs} />

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
              {isRunning ? "■ Stop" : "▶ Start"}
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
                ${(session?.capital ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="ui-label">Mode</span>
              <span className="font-mono text-sm font-semibold text-[#e0e0e0]">
                PAPER
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
                ${price?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "—"}
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

      {/* Signal history + positions */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BtcSignalHistory signals={signals} />
        <BtcPositionsTable
          positions={positions}
          currentPrice={price}
          paperCapital={session?.capital ?? 0}
          onClose={handleManualClose}
        />
      </section>
    </div>
  );
}
