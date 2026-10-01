"use client";

import { useEffect, useRef, useState } from "react";
import {
  getActiveSession, getDefaultPaperConfig, getPaperDashboard, getSession,
  startSession, stopSession, type DurablePaperDecision, type DurablePaperPosition,
  type PaperDashboard, type PaperDefaultSummary, type SessionStartResponse,
} from "../../../lib/api";
import { discoverPaperSession, pollPaperSession, retainPaperSession, stopPaperSession } from "../../../lib/paperSessionControl";

type ControlState = "READY" | "STARTING" | "RUNNING" | "BLOCKED" | "STOPPING" | "STOPPED" | "CRASHED";
type SelectedSession = SessionStartResponse;
const selectionKey = "paper-dashboard-selection-v2";

function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "SESSION_UNAVAILABLE";
  const help: Record<string, string> = {
    DEFAULT_PAPER_CONFIG_REQUIRED: "Provision one server-owned NIFTY LONG_OPTION configuration.",
    DEFAULT_PAPER_CONFIG_INVALID: "The server-owned NIFTY default does not match the approved profile.",
    EXIT_CONFIG_REQUIRED: "Provision the matching server-owned LONG_OPTION exit policy.",
    KITE_SESSION_REQUIRED: "Connect Kite in Settings.",
    DATA_MODE_REQUIRED: "Select KITE_REAL in Settings.",
    MONTHLY_METADATA_REQUIRED: "Provision current qualified monthly-expiry metadata.",
    RECOVERY_REQUIRED: "Current-host recovery proof is required.",
    RECONCILIATION_NOT_MATCHED: "Broker reconciliation did not match; entry remains blocked.",
    RECONCILIATION_INCOMPLETE: "Broker reconciliation evidence is incomplete.",
    KILL_SWITCH_ACTIVE: "The account kill switch is active.",
    DAILY_LOSS_LIMIT_EXCEEDED: "The daily loss control blocks new entries.",
  };
  return help[code] ? `${code} — ${help[code]}` : code;
}
function readSaved(): { sessionId: string; accountId: string; asset: "NIFTY" } | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(selectionKey) ?? "null");
    if (value && typeof value === "object" && "sessionId" in value && "accountId" in value && "asset" in value
      && typeof value.sessionId === "string" && typeof value.accountId === "string" && value.asset === "NIFTY")
      return { sessionId: value.sessionId, accountId: value.accountId, asset: "NIFTY" };
  } catch { /* Corrupt tab selection must never discover an unrelated account. */ }
  return null;
}
function saveSelected(session: SelectedSession) {
  sessionStorage.setItem(selectionKey, JSON.stringify({ sessionId: session.sessionId, accountId: session.accountId, asset: "NIFTY" }));
}
function money(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? "Unavailable" : `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function time(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "—";
}
function minute(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
const panel = "rounded-2xl border border-white/10 bg-white/[0.025] p-4";
const label = "text-xs font-semibold uppercase tracking-widest text-white/45";

function DurablePositions({ positions, truncated }: { positions: DurablePaperPosition[]; truncated: boolean }) {
  return <section className={panel} aria-labelledby="paper-positions-title">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 id="paper-positions-title" className={label}>Durable positions</h2>
      <span className="text-xs text-white/45">Fill-derived ledger</span></div>
    {positions.length === 0 ? <p className="text-sm text-white/55">No filled PAPER positions for this account. Pending entries with zero fills are excluded.</p>
      : <div className="space-y-3">{positions.map(position => <article key={position.positionId} className="rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><div className="font-semibold text-white/90">{position.strategyKind?.replace(/_/g, " ") ?? "Strategy unavailable"}</div>
            <div className="text-xs text-white/50">{position.family ?? "Unknown family"} · {position.underlying ?? "Underlying unavailable"} · opened {time(position.openedAt)}</div></div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${position.attention ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"}`}>
            {position.lifecycle}{position.attention ? " · ATTENTION" : ""}</span>
        </div>
        <div className="mt-3 space-y-1.5">{position.legs.map(leg => <div key={leg.legId} className="flex flex-wrap justify-between gap-x-3 text-xs">
          <span className="font-mono text-white/80">{leg.entrySide} {leg.contractKey}</span>
          <span className="text-white/60">Filled {leg.filledUnits} units · Open {leg.openUnits} · Avg entry {leg.entryNotionalMinor === null ? "Unavailable" : money(leg.entryNotionalMinor / leg.filledUnits)} / unit</span>
        </div>)}</div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-white/10 pt-2 text-xs text-white/60">
          <span>Close: {position.closeState}</span><span>Exit monitor: {position.exitMonitorStatus}</span>
          <span>Realized P&amp;L: {money(position.realizedPnlMinor)}</span>
          {position.exitReason && <span>Trigger: {position.exitReason}</span>}
          {position.unknownOrder && <span className="text-amber-300">UNKNOWN order truth</span>}
          {position.stranded && <span className="text-amber-300">Stranded long</span>}
          {position.exitAttentionReason && position.exitMonitorStatus !== "MONITORING" && <span className="text-amber-300">{position.exitAttentionReason}</span>}
        </div>
      </article>)}</div>}
    {truncated && <p className="mt-3 text-xs text-amber-300">Showing the first 200 ledger positions. More history exists.</p>}
  </section>;
}

function Decisions({ decisions }: { decisions: DurablePaperDecision[] }) {
  return <section className={panel} aria-labelledby="paper-decisions-title">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 id="paper-decisions-title" className={label}>Decisions</h2>
      <span className="text-xs text-white/45">Durable SignalLog</span></div>
    {decisions.length === 0 ? <p className="text-sm text-white/55">No evaluation has completed for this session.</p>
      : <ol className="space-y-2">{decisions.map(decision => <li key={decision.cycleId} className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-white/90">{decision.outcome}{decision.candidate ? " · CANDIDATE" : ""}</span>
          <time className="text-white/45">{time(decision.evaluatedAt)}</time></div>
        <div className="mt-1 text-white/65">{decision.direction} · {decision.confidence === null ? "Confidence unavailable" : `${Math.round(decision.confidence * 100)}% confidence`}
          {decision.family ? ` · ${decision.family}` : ""}{decision.strategyKind ? ` · ${decision.strategyKind}` : ""}</div>
        <div className="mt-1 text-white/55">Reason: {decision.reason ?? "Unavailable"} · Verifier: {decision.verifier.verdict ?? decision.verifier.status}</div>
        {decision.rationale && <p className="mt-1 text-white/70">{decision.rationale}</p>}
        {decision.blockingReason && decision.outcome !== "HOLD" && <p className="mt-1 text-amber-300">Blocked: {decision.blockingReason}</p>}
      </li>)}</ol>}
  </section>;
}

export default function DashboardPage(): JSX.Element {
  const [config, setConfig] = useState<PaperDefaultSummary | null>(null);
  const [selected, setSelected] = useState<SelectedSession | null>(null);
  const [snapshot, setSnapshot] = useState<PaperDashboard | null>(null);
  const [control, setControl] = useState<ControlState>("BLOCKED");
  const [message, setMessage] = useState("Loading server-owned PAPER configuration…");
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const saved = readSaved();
      let resolved: PaperDefaultSummary | null = null;
      try { resolved = await getDefaultPaperConfig("NIFTY"); if (live) setConfig(resolved); }
      catch (error) { if (live) { setControl("BLOCKED"); setMessage(errorCode(error)); } }
      if (!live) return;
      if (saved) {
        if (resolved && saved.accountId !== resolved.accountId) { setControl("BLOCKED"); setMessage("CONFIG_ACCOUNT_CHANGED"); return; }
        try {
          const exact = retainPaperSession(await getSession(saved.sessionId), saved.accountId, saved.sessionId);
          if (!live || exact.asset !== saved.asset) throw new Error("SESSION_IDENTITY_MISMATCH");
          setSelected(exact as SelectedSession); setControl(exact.status); setMessage("Exact selected session restored.");
        } catch (error) { if (live) { setControl("BLOCKED"); setMessage(errorCode(error)); } }
        return;
      }
      if (!resolved) return;
      try {
        const active = await discoverPaperSession(resolved.accountId, getActiveSession);
        if (!live) return;
        if (active) {
          if (active.asset !== "NIFTY") throw new Error("SESSION_ASSET_MISMATCH");
          const exact = active as SelectedSession; saveSelected(exact); setSelected(exact); setControl(exact.status);
          setMessage("Account-scoped PAPER session restored.");
        } else { setControl("READY"); setMessage("Ready to prepare and start the NIFTY PAPER session."); }
      } catch (error) { if (live) { setControl("BLOCKED"); setMessage(errorCode(error)); } }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!selected?.sessionId || !selected.accountId) return;
    let live = true; const identity = { sessionId: selected.sessionId, accountId: selected.accountId, executionMode: "PAPER", status: selected.status };
    const refresh = async () => {
      try {
        const [exact, dashboard] = await Promise.all([pollPaperSession(identity, getSession), getPaperDashboard(identity.sessionId)]);
        if (!live || busy.current || dashboard.session.accountId !== identity.accountId || dashboard.session.sessionId !== identity.sessionId) return;
        setSelected(exact as SelectedSession); setSnapshot(dashboard);
        setControl(exact.status); setMessage(exact.status === "RUNNING" ? "PAPER entry scheduler and independent exit monitor are active." : `Session ${exact.status.toLowerCase()}; existing exposure remains visible.`);
      } catch (error) { if (live) { setControl("BLOCKED"); setMessage(`Selected session unavailable: ${errorCode(error)}`); } }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { live = false; clearInterval(timer); };
  }, [selected?.sessionId, selected?.accountId]);

  async function handleStart() {
    if (busy.current || !config || control === "RUNNING" || control === "STARTING" || control === "STOPPING") return;
    busy.current = true; setControl("STARTING"); setMessage("Checking Kite, recovery, reconciliation and qualified market readiness…");
    try {
      const exact = retainPaperSession(await startSession("NIFTY"), config.accountId);
      saveSelected(exact); setSnapshot(null); setSelected(exact); setControl("RUNNING");
      setMessage("NIFTY PAPER trading session started. The backend process was already running.");
    } catch (error) { setControl("BLOCKED"); setMessage(errorCode(error)); }
    finally { busy.current = false; }
  }
  async function handleStop() {
    if (busy.current || !selected || control !== "RUNNING") return;
    busy.current = true; setControl("STOPPING"); setMessage("Stopping entry evaluation for the exact selected session…");
    try {
      await stopPaperSession(selected, stopSession);
      setControl("STOPPED"); setSelected({ ...selected, status: "STOPPED" });
      setMessage("Entry evaluation stopped. Existing positions and independent exit monitoring continue.");
    } catch (error) { setControl("RUNNING"); setMessage(errorCode(error)); }
    finally { busy.current = false; }
  }

  const resolved = snapshot?.session.config ?? config;
  const family = snapshot?.session.strategyFamily ?? config?.strategyFamily;
  const interval = snapshot?.session.intervalMs ?? config?.intervalMs;
  return <div className="space-y-4 text-white/85">
    <section className={panel} aria-labelledby="paper-control-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div>
        <h1 id="paper-control-title" className="text-lg font-semibold text-white">NSE PAPER session</h1>
        <p className="mt-1 text-xs text-white/50">The backend service must already be running. Start begins its PAPER session and schedulers.</p>
      </div><span className={`rounded-full px-3 py-1 text-xs font-bold tracking-wider ${control === "RUNNING" ? "bg-emerald-400/15 text-emerald-300" : control === "BLOCKED" || control === "CRASHED" ? "bg-amber-400/15 text-amber-300" : "bg-white/10 text-white/70"}`}>
        {control}</span></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-white/60">NSE asset
          <select aria-label="NSE asset" value="NIFTY" disabled className="min-h-11 rounded-lg border border-white/15 bg-neutral-900 px-3 text-sm text-white"><option>NIFTY</option></select>
        </label>
        <button type="button" onClick={control === "RUNNING" ? handleStop : handleStart}
          disabled={busy.current || control === "STARTING" || control === "STOPPING" || (control !== "RUNNING" && !config)}
          className={`min-h-11 rounded-lg px-6 text-sm font-bold tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${control === "RUNNING" ? "bg-red-500 text-white focus-visible:outline-red-300" : "bg-emerald-500 text-black focus-visible:outline-emerald-300"}`}>
          {control === "STARTING" ? "STARTING…" : control === "STOPPING" ? "STOPPING…" : control === "RUNNING" ? "STOP" : "START"}
        </button>
        <span className="text-xs text-white/50">{config ? `${config.executionMode} execution · ${config.dataMode} evidence` : "Default profile unavailable"}</span>
      </div>
      <p role="status" aria-live="polite" className={`mt-3 text-sm ${control === "BLOCKED" || control === "CRASHED" ? "text-amber-300" : "text-white/65"}`}>{message}</p>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-white/10 pt-3 text-xs sm:grid-cols-4">
        <div><div className={label}>Strategy</div>{family?.replace(/_/g, " ") ?? "Unavailable"}</div>
        <div><div className={label}>Data / execution</div>{snapshot?.session.dataMode ?? config?.dataMode ?? "Unavailable"} / {snapshot?.session.executionMode ?? config?.executionMode ?? "Unavailable"}</div>
        <div><div className={label}>Interval</div>{interval ? `${interval / 60000} min` : "Unavailable"}</div>
        <div><div className={label}>Entry window</div>{resolved ? `${minute(resolved.entryWindowStartMinuteIST)}–${minute(resolved.entryCutoffMinuteIST)} IST` : "Unavailable"}</div>
        <div><div className={label}>Confidence</div>{resolved ? `${Math.round(resolved.minConfidence * 100)}%` : "Unavailable"}</div>
        <div><div className={label}>Delta band</div>{resolved?.longOptionSelection ? `${resolved.longOptionSelection.minAbsDelta.toFixed(2)}–${resolved.longOptionSelection.maxAbsDelta.toFixed(2)}` : "Unavailable"}</div>
        <div><div className={label}>Account</div><span className="font-mono break-all">{snapshot?.session.accountId ?? config?.accountId ?? "Unavailable"}</span></div>
        <div><div className={label}>Session ID</div><span className="font-mono break-all">{selected?.sessionId ?? "—"}</span></div>
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-2" aria-label="Operational status">
      <div className={panel}><h2 className={label}>Session and exit monitor</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <dt className="text-white/45">Session</dt><dd>{snapshot?.session.status ?? control}</dd>
          <dt className="text-white/45">Last cycle</dt><dd>{time(snapshot?.session.lastCycleAt ?? null)}</dd>
          <dt className="text-white/45">Cycle outcome</dt><dd>{snapshot?.session.lastCycleOutcome ?? "Waiting"}</dd>
          <dt className="text-white/45">Cycle reason / entry block</dt><dd>{snapshot?.session.blockingReason ?? "None reported"}</dd>
          <dt className="text-white/45">Exit monitor</dt><dd>{snapshot?.exits.status ?? "Unavailable"}</dd>
          <dt className="text-white/45">Close in progress</dt><dd>{snapshot?.exits.closeInProgress ?? "—"}</dd>
          <dt className="text-white/45">Attention</dt><dd>{snapshot?.exits.attentionCount ?? "—"}</dd>
        </dl></div>
      <div className={panel}><h2 className={label}>Account risk · read only</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <dt className="text-white/45">Pending risk</dt><dd>{money(snapshot?.risk?.pendingRiskMinor)}</dd>
          <dt className="text-white/45">Committed risk</dt><dd>{money(snapshot?.risk?.committedRiskMinor)}</dd>
          <dt className="text-white/45">Projected available capacity</dt><dd>{money(snapshot?.risk?.availableCapacityMinor)}</dd>
          <dt className="text-white/45">Slots reserved / committed</dt><dd>{snapshot?.risk ? `${snapshot.risk.reservedSlots ?? "—"} / ${snapshot.risk.committedSlots ?? "—"}` : "—"}</dd>
          <dt className="text-white/45">Realized P&amp;L ({snapshot?.risk?.dailyTradingDay ?? "stored day"})</dt><dd>{money(snapshot?.risk?.dailyRealizedPnlMinor)}</dd>
          <dt className="text-white/45">Kill switch</dt><dd>{snapshot?.risk ? snapshot.risk.killSwitchEnabled ? "ACTIVE" : "OFF" : "Unavailable"}</dd>
          <dt className="text-white/45">Recovery</dt><dd>{snapshot?.risk?.recoveryStatus ?? "Unavailable"}</dd>
          <dt className="text-white/45">Last reconciliation</dt><dd>{snapshot?.risk?.reconciliationStatus ?? "Unavailable"}</dd>
        </dl></div>
    </section>

    <section className="grid gap-4 lg:grid-cols-2"><Decisions decisions={snapshot?.decisions ?? []} />
      <DurablePositions positions={snapshot?.positions ?? []} truncated={snapshot?.positionsTruncated ?? false} /></section>
    <section className={panel}><h2 className={label}>Indicators, IV and Greeks</h2>
      <p className="mt-2 text-sm text-white/55">{snapshot?.decisions.length ? "Qualified decision provenance is retained; numeric analytics are unavailable in this read model." : "Unavailable until first qualified evaluation."}</p>
    </section>
  </div>;
}
