"use client";

import React, { useEffect, useState } from "react";
import {
  getKiteStatus,
  refreshKiteToken,
  beginKiteLogin,
  setKiteDataMode,
  type KiteStatus,
} from "../../../lib/api";


export default function SettingsPage(): JSX.Element {
  const [status, setStatus] = useState<KiteStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [requestToken, setRequestToken] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  async function loadStatus(): Promise<void> {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await getKiteStatus());
    } catch (e) {
      setStatus(null);
      setStatusError(
        e instanceof Error ? e.message : "Failed to load Kite status"
      );
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get("kite") === "error") setRefreshResult({ ok: false, text: "Kite login failed. Open Kite Login to try again." });
    if (params.has("kite")) window.history.replaceState(null, "", window.location.pathname);
    const refreshOnFocus = () => { void loadStatus(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);

  async function handleLogin(): Promise<void> {
    try { const { loginUrl } = await beginKiteLogin(); window.location.assign(loginUrl); }
    catch { setRefreshResult({ ok: false, text: "Unable to start Kite login." }); }
  }
  async function handleMode(dataMode: "MOCK" | "KITE_REAL"): Promise<void> {
    try { await setKiteDataMode(dataMode); await loadStatus(); }
    catch { setStatusError("Unable to change market-data mode."); }
  }

  async function handleRefresh(): Promise<void> {
    if (!requestToken.trim()) return;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const token = requestToken.trim();
      setRequestToken("");
      const result = await refreshKiteToken(token);
      if (result.success) {
        setRefreshResult({ ok: true, text: result.message ?? "Token refreshed successfully" });
        setRequestToken("");
        await loadStatus();
      } else {
        setRefreshResult({ ok: false, text: result.error ?? "Token refresh failed" });
      }
    } catch (e) {
      setRefreshResult({
        ok: false,
        text: e instanceof Error ? e.message : "Token refresh failed",
      });
    } finally {
      setRefreshing(false);
      await loadStatus();
    }
  }

  // ── Status section derived values ─────────────────────────────────────────
  const connected = status?.tokenValid ?? false;
  const badgeColor = connected ? "#00C853" : "#FF1744";
  const badgeBg = connected ? "rgba(0,200,83,0.1)" : "rgba(255,23,68,0.1)";
  const badgeBorder = connected ? "rgba(0,200,83,0.28)" : "rgba(255,23,68,0.28)";


  return (
    <div className="space-y-4">

      {/* ── Section 1: Kite Connection Status ─────────────────────────────── */}
      <section
        className="rounded-2xl p-5"
        style={{
          background:
            "linear-gradient(135deg, rgba(20,20,20,0.9) 0%, rgba(12,12,12,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="mb-3 ui-label">Kite Connection Status</div>

        {statusLoading && (
          <p className="text-[0.72rem] font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>
            Checking…
          </p>
        )}

        {statusError && (
          <div
            className="rounded-lg px-3 py-2 text-[0.72rem] font-mono"
            style={{
              background: "rgba(255,23,68,0.08)",
              border: "1px solid rgba(255,23,68,0.2)",
              color: "#FF1744",
            }}
          >
            {statusError}
          </div>
        )}

        {status && (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
            {/* Badge */}
            <div
              className="inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5"
              style={{ background: badgeBg, border: `1px solid ${badgeBorder}` }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: badgeColor, boxShadow: `0 0 6px ${badgeColor}` }}
              />
              <span
                className="text-[0.72rem] font-bold tracking-widest uppercase"
                style={{ color: badgeColor }}
              >
                {status.connectionStatus.replace(/_/g, " ")}
              </span>
            </div>

            {/* Details */}
            <div className="flex flex-col gap-1.5 text-[0.7rem] font-mono">
              <Row label="Trading phase" value="PAPER" />
              <Row label="Execution" value="PaperBroker" />
              <Row label="Data mode" value={status.dataMode}
                valueColor={status.dataMode === "KITE_REAL" ? "#00C853" : "#FFB300"} />
              <Row label="API key" value={status.apiKey} />
              <Row label="Token expiry" value={status.tokenExpiry} />
              <Row label="Status" value={status.message} />
              <label>Market data: <select aria-label="Market data mode" value={status.dataMode}
                onChange={e => void handleMode(e.target.value as "MOCK" | "KITE_REAL")}
                className="rounded bg-neutral-900 px-2 py-1">
                <option value="MOCK">MOCK</option><option value="KITE_REAL">KITE_REAL</option>
              </select></label>
            </div>
          </div>
        )}
      </section>

      {/* ── Section 2: Refresh Token ───────────────────────────────────────── */}
      <section
        className="rounded-2xl p-5"
        style={{
          background:
            "linear-gradient(135deg, rgba(20,20,20,0.9) 0%, rgba(12,12,12,0.95) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="mb-1 ui-label">Refresh Token</div>
        <div
          className="mb-5 text-[0.68rem] font-mono"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          Login to Zerodha; the backend connects your session and returns you here automatically.
        </div>

        {/* Step 1 */}
        <div className="mb-4">
          <StepLabel n={1} text="Open the Kite login page" />
          <div className="mt-2">
            {status?.loginAvailable ? (
              <button
                type="button"
                onClick={() => void handleLogin()}
                className="inline-block rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all"
                style={{
                  background: "linear-gradient(135deg, #1565C0, #1976D2)",
                  color: "#fff",
                  boxShadow: "0 0 16px rgba(21,101,192,0.4)",
                }}
              >
                Open Kite Login
              </button>
            ) : (
              <div>
                <button
                  type="button"
                  disabled
                  className="rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest opacity-40 cursor-not-allowed"
                  style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}
                >
                  Open Kite Login
                </button>
                <span
                  className="ml-3 text-[0.68rem] font-mono"
                  style={{ color: "#FF1744" }}
                >
                  Configure Kite authentication on the backend
                </span>
              </div>
            )}
          </div>
        </div>

        <p className="mb-4 text-xs text-neutral-400">After authentication, return to Settings automatically. Connecting does not change the selected data mode.</p>
        <details className="text-sm"><summary>Development fallback: manual request token</summary>
        {/* Step 3 + Refresh button */}
        <div className="mb-2">
          <StepLabel n={2} text="Paste a request_token only if using the development fallback" />
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="password"
              autoComplete="off"
              value={requestToken}
              onChange={(e) => setRequestToken(e.target.value)}
              placeholder="Paste request_token here…"
              className="flex-1 rounded-lg px-3 py-2 text-xs font-mono text-[#e0e0e0]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                outline: "none",
                minWidth: 0,
              }}
            />
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing || !requestToken.trim()}
              className="shrink-0 rounded-lg px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, #00C853, #00e676)",
                color: "#000",
                boxShadow: "0 0 16px rgba(0,200,83,0.35)",
                whiteSpace: "nowrap",
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh Token"}
            </button>
          </div>
        </div>

        </details>
        {refreshResult && (
          <div
            className="mt-3 rounded-lg px-3 py-2 text-[0.72rem] font-mono"
            style={{
              background: refreshResult.ok
                ? "rgba(0,200,83,0.08)"
                : "rgba(255,23,68,0.08)",
              border: `1px solid ${
                refreshResult.ok ? "rgba(0,200,83,0.25)" : "rgba(255,23,68,0.2)"
              }`,
              color: refreshResult.ok ? "#00C853" : "#FF1744",
            }}
          >
            {refreshResult.text}
          </div>
        )}
      </section>

      {/* ── Section 3: Current Config (read-only) ─────────────────────────── */}
      {status && (
        <section
          className="rounded-2xl p-4"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div className="mb-3 ui-label">Current Config</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <ConfigCard
              label="Trading Phase"
              value="PAPER"
            />
            <ConfigCard
              label="Paper Capital"
              value={`₹${status.config.paperCapital.toLocaleString("en-IN")}`}
            />
            <ConfigCard
              label="Min Confidence"
              value={`${(status.config.minConfidence * 100).toFixed(0)}%`}
            />
            <ConfigCard
              label="Max Positions"
              value={`${status.config.maxPositions}`}
            />
            <ConfigCard
              label="Data Mode"
              value={status.dataMode}
              color={status.dataMode === "KITE_REAL" ? "#00C853" : "#FFB300"}
            />
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepLabel(props: { n: number; text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span
        className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full text-[0.6rem] font-bold"
        style={{
          background: "rgba(0,200,83,0.15)",
          border: "1px solid rgba(0,200,83,0.3)",
          color: "#00C853",
        }}
      >
        {props.n}
      </span>
      <span
        className="text-[0.72rem] font-mono leading-5"
        style={{ color: "rgba(255,255,255,0.6)" }}
      >
        {props.text}
      </span>
    </div>
  );
}

function Row(props: {
  label: string;
  value: string;
  valueColor?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: "rgba(255,255,255,0.4)" }}>{props.label}:</span>
      <span style={{ color: props.valueColor ?? "rgba(255,255,255,0.75)", fontWeight: 600 }}>
        {props.value}
      </span>
    </div>
  );
}

function ConfigCard(props: {
  label: string;
  value: string;
  color?: string;
}): JSX.Element {
  return (
    <div
      className="rounded-xl p-3"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="ui-label mb-1">{props.label}</div>
      <div
        className="font-mono text-sm font-semibold"
        style={{ color: props.color ?? "#e0e0e0" }}
      >
        {props.value}
      </div>
    </div>
  );
}
