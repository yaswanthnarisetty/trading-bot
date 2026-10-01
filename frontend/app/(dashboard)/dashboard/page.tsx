"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "SESSION_UNAVAILABLE";
  const help: Record<string, string> = {
    PAPER_ACCOUNT_REQUIRED: "An eligible PAPER account is required.",
    PAPER_ACCOUNT_AMBIGUOUS: "Multiple PAPER accounts exist; configure an explicit backend account mapping.",
    DEFAULT_PAPER_CONFIG_INVALID: "The server-owned NIFTY default does not match the approved profile.",
    EXIT_CONFIG_REQUIRED: "The server-owned LONG_OPTION exit policy is missing or invalid.",
    KITE_SESSION_REQUIRED: "Connect Kite in Settings.",
    DATA_MODE_REQUIRED: "The server requires KITE_REAL market data.",
    SESSION_STOPPED: "Start monitoring to establish a current session; entry readiness will be checked again.",
    MONTHLY_METADATA_REQUIRED: "Current monthly-expiry metadata is missing, invalid or outside verified coverage.",
    RECOVERY_REQUIRED: "Current-host recovery proof is required.",
    RECONCILIATION_NOT_MATCHED: "Broker reconciliation did not match; entry remains blocked.",
    RECONCILIATION_INCOMPLETE: "Broker reconciliation evidence is incomplete.",
    RECONCILIATION_DISCREPANCY: "Reconciliation found a discrepancy; new entry remains blocked.",
    RECONCILIATION_UNAVAILABLE: "Reconciliation evidence is unavailable; preparation retries on the normal cycle.",
    CALENDAR_NOT_READY: "The date is outside the verified NSE calendar coverage.",
    CALENDAR_AUTHORITY_CONFLICT: "Configured calendar evidence conflicts with the backend NSE calendar.",
    GREEKS_CONFIG_REQUIRED: "The Greeks rate assumption is incomplete or outside verified coverage.",
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
const panel = "min-w-0 overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]";
const label = "ui-label text-[0.68rem]";
const muted = "text-white/45";
const statusColor = (value: string) => value === "READY" || value === "MATCHED" || value === "ACTIVE" || value === "OPEN"
  ? "text-[#00C853]" : value === "WAITING" || value === "HOLD" || value === "CRASHED" || value === "ATTENTION"
    ? "text-[#FFB300]" : "text-white/65";

function PanelHeading({ title, aside, id }: { title: string; aside?: string; id?: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
    <h2 id={id} className={label}>{title}</h2>{aside && <span className="font-mono text-[0.68rem] text-white/35">{aside}</span>}
  </div>;
}

function PrimarySignal({ decision, asset }: { decision: DurablePaperDecision | undefined; asset: string }) {
  return <section className={`${panel} min-h-[240px]`} aria-labelledby="paper-signal-title">
    <PanelHeading id="paper-signal-title" title="Primary signal" aside={decision ? time(decision.evaluatedAt) : "DURABLE SIGNALLOG"} />
    {!decision ? <div className="flex min-h-[190px] flex-col items-center justify-center px-5 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-white/15 font-mono text-xl text-white/30">◎</div>
      <p className="text-sm font-medium text-white/65">Awaiting the first qualified evaluation</p>
      <p className="mt-1 text-xs text-white/35">HOLD and blocked decisions will appear here too.</p>
    </div> : <div className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className={label}>{asset} · {decision.family?.replace(/_/g, " ") ?? "Family unavailable"}</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{decision.direction}</strong>
            <span className={`font-mono text-sm font-semibold ${statusColor(decision.outcome)}`}>{decision.outcome}</span>
          </div>
          <p className="mt-1 text-xs text-white/45">{decision.strategyKind?.replace(/_/g, " ") ?? "No strategy candidate"}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-right">
          <div className={label}>Confidence</div>
          <div className="font-mono text-xl font-semibold text-white">{decision.confidence === null ? "Unavailable" : `${Math.round(decision.confidence * 100)}%`}</div>
        </div>
      </div>
      <div className="grid gap-3 border-t border-white/[0.07] pt-4 text-xs sm:grid-cols-2">
        <div><span className={label}>Verifier</span><p className="mt-1 text-white/75">{decision.verifier.verdict ?? decision.verifier.status}</p></div>
        <div><span className={label}>Decision</span><p className="mt-1 text-white/75">{decision.outcome === "ENTRY" ? "Admitted · entry filled" : decision.outcome === "REJECTED" ? "Rejected" : decision.outcome === "ATTENTION" ? "Needs attention" : decision.candidate ? "Candidate" : decision.outcome === "HOLD" ? "Hold" : decision.outcome}</p></div>
      </div>
      {decision.rationale && <p className="text-sm leading-relaxed text-white/70">{decision.rationale}</p>}
      <p className="text-xs text-white/45">{decision.blockingReason ? <span className="text-[#FFB300]">Blocked: {decision.blockingReason}</span> : decision.reason ?? "No additional reason recorded"}</p>
    </div>}
  </section>;
}

function AnalyticsCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className={panel}><PanelHeading title={title} /><div className="px-4 py-4 text-sm text-white/50">{children}</div></section>;
}

function DurablePositions({ active, history, activeTruncated, historyTruncated, uncertain }: {
  active: DurablePaperPosition[]; history: DurablePaperPosition[]; activeTruncated: boolean; historyTruncated: boolean; uncertain: boolean;
}) {
  const [tab, setTab] = useState<"OPEN" | "HISTORY">("OPEN");
  const positions = tab === "OPEN" ? active : history;
  return <section className={panel} aria-labelledby="paper-positions-title">
    <PanelHeading id="paper-positions-title" title="Positions" aside="FILL-DERIVED LEDGER" />
    <div className="flex gap-1 border-b border-white/[0.06] px-4 pt-3" aria-label="Position view">
      {(["OPEN", "HISTORY"] as const).map(view => <button key={view} type="button" aria-pressed={tab === view}
        onClick={() => setTab(view)} className={`border-b-2 px-3 pb-2 text-xs font-semibold tracking-wide transition-colors ${tab === view ? "border-[#00C853] text-white" : "border-transparent text-white/40 hover:text-white/70"}`}>
        {view === "OPEN" ? `Active (${active.length})` : `History (${history.length})`}
      </button>)}
    </div>
    {positions.length === 0 ? <div className="flex min-h-40 flex-col justify-center px-4 py-6 text-center text-sm text-white/45">
      {uncertain && tab === "OPEN" ? "Exposure requires attention; the fill-backed view is incomplete."
        : tab === "OPEN" ? "No filled PAPER positions. Zero-fill pending entries are excluded." : "No proven terminal positions in this session view."}
    </div> : <div className="max-h-[560px] divide-y divide-white/[0.06] overflow-y-auto">
      {positions.map(position => <article key={position.positionId} className="px-4 py-3 text-xs">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><p className="font-semibold text-white/85">{position.strategyKind?.replace(/_/g, " ") ?? "Strategy unavailable"}</p>
            <p className="mt-0.5 text-white/45">{position.family ?? "Unknown family"} · {position.underlying ?? "Underlying unavailable"} · {time(position.openedAt)}</p></div>
          <span className={`font-mono font-semibold ${position.attention ? "text-[#FFB300]" : position.lifecycle === "CLOSED" ? "text-white/65" : "text-[#00C853]"}`}>
            {position.lifecycle}{position.attention ? " · ATTENTION" : ""}</span>
        </div>
        <div className="mt-3 space-y-1.5 font-mono">{position.legs.map(leg => <div key={leg.legId} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
          <span className="min-w-0 break-all text-white/75">{leg.entrySide} {leg.contractKey}</span>
          <span className="text-white/50">Filled {leg.filledUnits} · Open {leg.openUnits} · Entry {leg.entryNotionalMinor === null ? "Unavailable" : `${money(leg.entryNotionalMinor / leg.filledUnits)} / unit`}</span>
        </div>)}</div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-white/50"><span>Close: {position.closeState}</span><span>Exit: {position.exitMonitorStatus}</span>
          <span>Realized P&amp;L: {money(position.realizedPnlMinor)}</span></div>
        {(position.unknownOrder || position.stranded || position.exitAttentionReason || position.exitReason) && <p className="mt-2 text-[#FFB300]">
          {[position.unknownOrder && "UNKNOWN order truth", position.stranded && "Stranded long", position.exitAttentionReason, position.exitReason && `Trigger: ${position.exitReason}`].filter(Boolean).join(" · ")}
        </p>}
      </article>)}
    </div>}
    {activeTruncated && tab === "OPEN" && <p role="alert" className="border-t border-white/[0.06] px-4 py-3 text-xs text-[#FFB300]">Active exposure exceeds the safety bound. This view is incomplete.</p>}
    {historyTruncated && tab === "HISTORY" && <p className="border-t border-white/[0.06] px-4 py-3 text-xs text-[#FFB300]">Showing up to 200 terminal positions.</p>}
  </section>;
}

function SignalHistory({ decisions }: { decisions: DurablePaperDecision[] }) {
  return <section className={panel} aria-labelledby="paper-decisions-title">
    <PanelHeading id="paper-decisions-title" title="Signal history" aside={`${decisions.length} decisions · durable SignalLog`} />
    {decisions.length === 0 ? <div className="flex min-h-40 flex-col justify-center px-4 text-center">
      <p className="text-sm text-white/55">Signals appear after the first evaluation.</p><p className="mt-1 text-xs text-white/35">HOLD and rejected decisions are retained.</p>
    </div> : <ol className="relative max-h-[560px] overflow-y-auto px-4 py-3">
      {decisions.map(decision => <li key={decision.cycleId} className="relative border-l border-white/10 pb-4 pl-4 last:pb-0">
        <span aria-hidden className={`absolute -left-[3px] top-1 h-[5px] w-[5px] rounded-full ${decision.outcome === "HOLD" ? "bg-[#FFB300]" : "bg-[#00C853]"}`} />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"><strong className={`font-semibold ${statusColor(decision.outcome)}`}>{decision.outcome}{decision.candidate ? " · CANDIDATE" : ""}</strong>
          <time className="font-mono text-white/35">{time(decision.evaluatedAt)}</time></div>
        <p className="mt-1 text-xs text-white/70">{decision.direction} · {decision.confidence === null ? "Confidence unavailable" : `${Math.round(decision.confidence * 100)}% confidence`}
          {decision.family ? ` · ${decision.family}` : ""}{decision.strategyKind ? ` · ${decision.strategyKind}` : ""}</p>
        <p className="mt-1 text-xs text-white/45">{decision.blockingReason ?? decision.reason ?? "No reason recorded"} · Verifier: {decision.verifier.verdict ?? decision.verifier.status}</p>
        {decision.rationale && <p className="mt-1 text-xs text-white/55">{decision.rationale}</p>}
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
        setControl(exact.status); setMessage(exact.status === "RUNNING" ? exact.entryReady ? "PAPER session running; entry prerequisites currently ready." : `PAPER session running; entry waiting: ${exact.entryBlockingReason ?? "READINESS_REQUIRED"}` : `Session ${exact.status.toLowerCase()}; existing exposure remains visible.`);
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
      setMessage(exact.entryReady ? "NIFTY PAPER session running; entry prerequisites currently ready." : `NIFTY PAPER session running; entry waiting: ${exact.entryBlockingReason ?? "READINESS_REQUIRED"}`);
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
  const operations = selected?.operationalDefaults ?? config?.operationalDefaults;
  const family = snapshot?.session.strategyFamily ?? config?.strategyFamily;
  const interval = snapshot?.session.intervalMs ?? config?.intervalMs;
  const latestDecision = snapshot?.decisions[0];
  const analyticsWaiting = snapshot?.decisions.length ? "Qualified numeric values are not exposed by this read model." : "Awaiting first qualified evaluation.";
  const readinessAction = selected?.status !== "RUNNING" ? "Start required" : selected.entryReady ? "Ready"
    : selected.readinessAction === "OPERATOR_ACTION" ? "Operator action required" : "Automatic retry on the 5-minute cycle";
  return <div className="mx-auto max-w-[1400px] space-y-4 text-white/85">
    <section className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-[#141414] to-[#0c0c0c] p-4 shadow-[0_4px_24px_rgba(0,0,0,0.4)]" aria-labelledby="paper-control-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 id="paper-control-title" className="text-lg font-semibold text-white">NSE PAPER dashboard</h1>
          <p className="mt-1 text-xs text-white/45">NIFTY strategy monitoring · durable PAPER ledger</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 font-mono text-[0.68rem] font-semibold ${control === "RUNNING" ? "bg-[#00C853]/10 text-[#00C853]" : control === "BLOCKED" || control === "CRASHED" ? "bg-[#FFB300]/10 text-[#FFB300]" : "bg-white/[0.06] text-white/60"}`}>{control}</span>
          {selected && <span className={`rounded-full px-2.5 py-1 font-mono text-[0.68rem] font-semibold ${selected.entryReady ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FFB300]/10 text-[#FFB300]"}`}>ENTRY {selected.entryStatus}</span>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-white/50">NSE asset
          <select aria-label="NSE asset" value="NIFTY" disabled className="min-h-11 rounded-lg border border-white/10 bg-white/[0.05] px-3 font-mono text-sm text-white"><option>NIFTY</option></select>
        </label>
        <button type="button" onClick={control === "RUNNING" ? handleStop : handleStart}
          disabled={busy.current || control === "STARTING" || control === "STOPPING" || (control !== "RUNNING" && !config)}
          className={`min-h-11 rounded-lg px-6 text-xs font-bold uppercase tracking-widest transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${control === "RUNNING" ? "bg-[#FF1744] text-white focus-visible:outline-[#FF1744]" : "bg-[#00C853] text-black focus-visible:outline-[#00C853]"}`}>
          {control === "STARTING" ? "STARTING…" : control === "STOPPING" ? "STOPPING…" : control === "RUNNING" ? "STOP" : "START"}
        </button>
        <div className="pb-1 text-xs text-white/45">{config ? `${config.strategyFamily.replace(/_/g, " ")} · ${config.dataMode} · ${config.executionMode} · ${config.intervalMs / 60000} min` : "Default profile unavailable"}</div>
      </div>
      <p role="status" aria-live="polite" className={`mt-3 text-sm ${control === "BLOCKED" || control === "CRASHED" ? "text-[#FFB300]" : "text-white/65"}`}>{control === "RUNNING" && selected ? `PAPER session running; entry ${selected.entryStatus.toLowerCase()}.` : message}</p>
      {selected?.entryBlockingReason && <div className="mt-3 rounded-lg border border-[#FFB300]/20 bg-[#FFB300]/[0.06] px-3 py-2 text-xs text-[#FFB300]">
        Entry {selected.entryStatus}: {errorCode(selected.entryBlockingReason)}
        {selected.entryStatus === "WAITING" && snapshot?.session.blockingReason && snapshot.session.blockingReason !== selected.entryBlockingReason
          && <span className="ml-2 text-white/45">Last cycle: {snapshot.session.blockingReason}</span>}
      </div>}
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-white/[0.07] pt-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
        <div><div className={label}>Strategy</div>{family?.replace(/_/g, " ") ?? "Unavailable"}</div>
        <div><div className={label}>Data / execution</div>{snapshot?.session.dataMode ?? config?.dataMode ?? "Unavailable"} / {snapshot?.session.executionMode ?? config?.executionMode ?? "Unavailable"}</div>
        <div><div className={label}>Interval</div>{interval ? `${interval / 60000} min` : "Unavailable"}</div>
        <div><div className={label}>Entry window</div>{resolved ? `${minute(resolved.entryWindowStartMinuteIST)}–${minute(resolved.entryCutoffMinuteIST)} IST` : "Unavailable"}</div>
        <div><div className={label}>Confidence</div>{resolved ? `${Math.round(resolved.minConfidence * 100)}%` : "Unavailable"}</div>
        <div><div className={label}>Delta band</div>{resolved?.longOptionSelection ? `${resolved.longOptionSelection.minAbsDelta.toFixed(2)}–${resolved.longOptionSelection.maxAbsDelta.toFixed(2)}` : "Unavailable"}</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[0.68rem] text-white/35">
        <span>Account: {snapshot?.session.accountId ?? config?.accountId ?? "Unavailable"}</span>
        <span className="break-all">Session: {selected?.sessionId ?? "Unavailable"}</span>
      </div>
    </section>

    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Signal and analytics">
      <PrimarySignal decision={latestDecision} asset={snapshot?.session.asset ?? "NIFTY"} />
      <div className="grid auto-rows-min gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <AnalyticsCard title="Greeks">
          {analyticsWaiting}
        </AnalyticsCard>
        <AnalyticsCard title="Implied volatility">
          <p>{analyticsWaiting}</p><p className="mt-1 text-xs text-white/35">IV rank is unavailable without qualified analytics.</p>
        </AnalyticsCard>
        <AnalyticsCard title="Support / resistance">
          {snapshot?.decisions.length ? "No qualified support or resistance values in the current read model." : "Awaiting qualified evaluation."}
        </AnalyticsCard>
        <AnalyticsCard title="Indicators">
          <p className="mb-3 text-xs">{analyticsWaiting}</p>
          <div className="grid grid-cols-2 gap-x-5 gap-y-2 font-mono text-xs sm:grid-cols-3 lg:grid-cols-5">
            {["RSI", "EMA alignment", "ATR", "Volume ratio", "Market regime"].map(item => <div key={item}>
              <div className="text-white/35">{item}</div><div className="mt-0.5 text-white/55">Unavailable</div>
            </div>)}
          </div>
        </AnalyticsCard>
        {snapshot?.observation?.status === "AVAILABLE" && snapshot.observation.quote && <section className={`${panel} px-4 py-3 text-xs`} aria-label="Non-tradable market observation">
          <span className={label}>NIFTY spot observation</span>
          <p className="mt-1 font-mono text-white/75">{money(snapshot.observation.quote.priceMinor)} · {snapshot.observation.quote.freshness.state} · NON_TRADABLE</p>
          <p className="mt-1 text-white/40">KITE · Exchange {time(snapshot.observation.quote.brokerTimestamp)} · Fetched {time(snapshot.observation.quote.fetchedAt)}</p>
        </section>}
      </div>
    </section>

    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Durable history and positions">
      <SignalHistory decisions={snapshot?.decisions ?? []} />
      <div className="space-y-3">
        {snapshot?.attentionWorkflows.map(workflow => <p role="alert" key={workflow.positionId} className="rounded-lg border border-[#FFB300]/20 bg-[#FFB300]/[0.06] px-3 py-2 text-xs text-[#FFB300]">{workflow.positionId}: {workflow.reason}</p>)}
        <DurablePositions active={snapshot?.activePositions ?? []} history={snapshot?.historyPositions ?? []}
          activeTruncated={snapshot?.activeTruncated ?? false} historyTruncated={snapshot?.positionsTruncated ?? false}
          uncertain={Boolean(snapshot?.activeTruncated || snapshot?.attentionWorkflows.length)} />
      </div>
    </section>

    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Read-only operational status">
      <div className={panel}><PanelHeading title="Session and exit monitor" aside="READ ONLY" />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-4 text-xs sm:grid-cols-4">
          <div><dt className={muted}>Session</dt><dd className={statusColor(snapshot?.session.status ?? control)}>{snapshot?.session.status ?? control}</dd></div>
          <div><dt className={muted}>Entry</dt><dd className={statusColor(selected?.entryStatus ?? "WAITING")}>{selected?.entryStatus ?? "WAITING"}</dd></div>
          <div><dt className={muted}>Calendar</dt><dd>{selected?.calendar?.status ?? "UNAVAILABLE"} {selected?.calendar?.localDate ?? ""}</dd></div>
          <div><dt className={muted}>Exit monitor</dt><dd className={statusColor(snapshot?.exits.status ?? "UNAVAILABLE")}>{snapshot?.exits.status ?? "Unavailable"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Entry reason</dt><dd className="break-words">{selected?.entryBlockingReason ?? "None reported"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Readiness action</dt><dd>{readinessAction}</dd></div>
          <div className="col-span-2"><dt className={muted}>Calendar version / source</dt><dd className="break-all font-mono text-[0.68rem]">{selected?.calendar?.version ?? "Unavailable"} · {selected?.calendar?.sourceReference ?? "Unavailable"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Last readiness try</dt><dd>{time(selected?.lastReadinessAttemptAt ?? null)}</dd></div>
          <div className="col-span-2"><dt className={muted}>Greeks rate assumption</dt><dd className="break-words">{operations?.greeks.value
            ? `${(operations.greeks.value.riskFreeRate * 100).toFixed(2)}% annual · ${operations.greeks.value.source === "BACKEND_FIXED_MODEL_ASSUMPTION_NOT_LIVE_RATE" ? "Fixed model assumption" : "Server configuration"}`
            : operations?.greeks.reason ?? "Unavailable"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Next qualified monthly expiry</dt><dd>{operations?.monthlyExpiry.value?.upcoming[0] ?? operations?.monthlyExpiry.reason ?? "Unavailable"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Exit policy for new captures</dt><dd>{operations?.exitPolicy.value
            ? `${operations.exitPolicy.value.takeProfitBps / 100}% profit / ${operations.exitPolicy.value.stopLossBps / 100}% loss · ${operations.exitPolicy.value.maxHoldingMs / 60000} min · ${Math.floor(operations.exitPolicy.value.eodMinuteIST / 60)}:${String(operations.exitPolicy.value.eodMinuteIST % 60).padStart(2, "0")} IST`
            : operations?.exitPolicy.reason ?? "Unavailable"}</dd></div>
          <div><dt className={muted}>Last cycle</dt><dd>{time(snapshot?.session.lastCycleAt ?? null)}</dd></div>
          <div><dt className={muted}>Cycle outcome</dt><dd>{snapshot?.session.lastCycleOutcome ?? "Waiting"}</dd></div>
          <div className="col-span-2"><dt className={muted}>Cycle reason / entry block</dt><dd className="break-words">{snapshot?.session.blockingReason ?? "None reported"}</dd></div>
          <div><dt className={muted}>Close in progress</dt><dd>{snapshot?.exits.closeInProgress ?? "Unavailable"}</dd></div>
          <div><dt className={muted}>Attention</dt><dd>{snapshot?.exits.attentionCount ?? "Unavailable"}</dd></div>
        </dl>
      </div>
      <div className={panel}><PanelHeading title="Account risk" aside="READ ONLY" />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-4 text-xs sm:grid-cols-4">
          <div><dt className={muted}>Pending risk</dt><dd>{money(snapshot?.risk?.pendingRiskMinor)}</dd></div>
          <div><dt className={muted}>Committed risk</dt><dd>{money(snapshot?.risk?.committedRiskMinor)}</dd></div>
          <div><dt className={muted}>Available capacity</dt><dd>{money(snapshot?.risk?.availableCapacityMinor)}</dd></div>
          <div><dt className={muted}>Slots reserved / committed</dt><dd>{snapshot?.risk ? `${snapshot.risk.reservedSlots ?? "Unavailable"} / ${snapshot.risk.committedSlots ?? "Unavailable"}` : "Unavailable"}</dd></div>
          <div><dt className={muted}>Realized P&amp;L ({snapshot?.risk?.dailyTradingDay ?? "stored day"})</dt><dd>{money(snapshot?.risk?.dailyRealizedPnlMinor)}</dd></div>
          <div><dt className={muted}>Kill switch</dt><dd>{snapshot?.risk ? snapshot.risk.killSwitchEnabled ? "ACTIVE" : "OFF" : "Unavailable"}</dd></div>
          <div><dt className={muted}>Recovery</dt><dd className={statusColor(snapshot?.risk?.recoveryStatus ?? "UNAVAILABLE")}>{snapshot?.risk?.recoveryStatus ?? "Unavailable"}</dd></div>
          <div><dt className={muted}>Reconciliation</dt><dd className={statusColor(snapshot?.risk?.reconciliationStatus ?? "UNAVAILABLE")}>{snapshot?.risk?.reconciliationStatus ?? "Unavailable"}</dd></div>
        </dl>
      </div>
    </section>
  </div>;
}
