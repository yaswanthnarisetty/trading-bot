"use client";

import { useEffect, useRef, useState } from "react";
import {
  getActiveSession, getDefaultPaperConfig, getPaperDashboard, getSession,
  startSession, stopSession, type DurablePaperDecision, type DurablePaperPosition,
  type PaperDashboard, type PaperDefaultSummary, type PaperEntryReadiness, type SessionStartResponse,
} from "../../../lib/api";
import { discoverPaperSession, pollPaperSession, retainPaperSession, stopPaperSession } from "../../../lib/paperSessionControl";
import { PaperGreeksPanel, PaperIVPanel, PaperSupportResistancePanel, PaperIndicatorsPanel } from "../../../components/dashboard/PaperAnalyticsPanels";

type ControlState = "READY" | "STARTING" | "RUNNING" | "BLOCKED" | "STOPPING" | "STOPPED" | "CRASHED";
type SelectedSession = SessionStartResponse;
const selectionKey = "paper-dashboard-selection-v2";

type EntryDisplayStatus = "READY" | "WAITING" | "UNAVAILABLE";
function entryStatusOf(session: Partial<PaperEntryReadiness> | null): EntryDisplayStatus {
  if (session?.entryStatus === "READY" && session.entryReady === true) return "READY";
  if (session?.entryStatus === "WAITING" && session.entryReady === false) return "WAITING";
  return "UNAVAILABLE";
}
function runningMessage(session: SelectedSession): string {
  const status = entryStatusOf(session);
  if (status === "UNAVAILABLE") return "PAPER session running; entry readiness unavailable. Refresh after the backend provides current readiness.";
  return status === "READY" ? "PAPER session running; entry prerequisites currently ready."
    : `PAPER session running; entry waiting: ${session.entryBlockingReason ?? "READINESS_REQUIRED"}`;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "PAPER_PROFILE_TIMEOUT — The backend did not return the NIFTY profile. Retry after checking the backend connection.";
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "SESSION_UNAVAILABLE";
  const help: Record<string, string> = {
    PAPER_ACCOUNT_REQUIRED: "An eligible PAPER account is required.",
    PAPER_ACCOUNT_AMBIGUOUS: "Multiple PAPER accounts exist; configure an explicit backend account mapping.",
    DEFAULT_PAPER_CONFIG_INVALID: "The server-owned NIFTY default does not match the approved profile.",
    EXIT_CONFIG_REQUIRED: "The server-owned LONG_OPTION exit policy is missing or invalid.",
    KITE_SESSION_REQUIRED: "Connect Kite in Settings.",
    DATA_MODE_REQUIRED: "The server requires KITE_REAL market data.",
    KITE_STREAM_UNAVAILABLE: "Kite's live market-data connection is unavailable. Entry will retry automatically.",
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

function PrimarySignal({ decision, asset, currentSession, riskLimitMinor }: {
  decision: DurablePaperDecision | undefined; asset: string; currentSession: boolean; riskLimitMinor: number | null;
}) {
  const confidence = decision?.confidence === null || decision?.confidence === undefined ? null : Math.round(decision.confidence * 100);
  const tone = !decision ? "text-white/50" : decision.outcome === "HOLD" || decision.outcome === "REJECTED"
    ? "text-[#FFB300]" : decision.outcome === "ENTRY" ? "text-[#00C853]" : "text-white/75";
  const signalLabel = !decision ? "AWAITING SIGNAL" : decision.direction !== "UNAVAILABLE" ? decision.direction
    : decision.outcome === "HOLD" ? "HOLD" : decision.outcome;
  return <div className="space-y-3" aria-label="Primary strategy signal">
    <section className={`${panel} p-5 sm:p-6`} aria-labelledby="paper-signal-title">
      <div className="flex items-start justify-between gap-3">
        <div><h2 id="paper-signal-title" className={label}>Strategy</h2>
          <div className={`mt-2 text-3xl font-bold tracking-tight ${decision ? tone : "text-white/50"}`}>{signalLabel}</div>
          <div className={`mt-1 font-mono text-sm font-semibold tracking-widest ${decision ? tone : "text-white/35"}`}>{decision?.outcome ?? "NO EVALUATION"}</div>
        </div>
        <div className="text-right"><div className={label}>Asset</div><div className="mt-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1 font-mono font-bold">{asset}</div></div>
      </div>
      <div className="mt-5 flex items-center justify-between"><span className={label}>Final decision confidence</span><span className={`font-mono font-bold ${confidence === null ? "text-white/35" : tone}`}>{confidence === null ? "—" : `${confidence}%`}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={confidence === null ? "Final decision confidence unavailable" : `${confidence}% final decision confidence`}>
        {confidence !== null && <div className={`h-full rounded-full ${decision?.outcome === "HOLD" || decision?.outcome === "REJECTED"
          ? "bg-[#FFB300]" : decision?.outcome === "ENTRY" ? "bg-[#00C853]" : "bg-white/50"}`} style={{ width: `${confidence}%` }} />}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {decision?.family && <span className="badge badge-hold">{decision.family.replace(/_/g, " ")}</span>}
        {decision?.strategyKind && <span className="badge badge-muted">{decision.strategyKind.replace(/_/g, " ")}</span>}
        {decision?.blockingReason && <span className="badge badge-hold">BLOCKED</span>}
      </div>
      {decision?.selectedOption && <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.035] p-3 text-xs text-white/65">
        <p className={label}>Proposed PAPER option · 1 lot</p>
        <p className="mt-1 break-all font-mono font-semibold text-white/85">{decision.selectedOption.contractKey}</p>
        <p className="mt-1">{decision.selectedOption.type} · Strike {(decision.selectedOption.strikeMinor / 100).toLocaleString("en-IN")} · Expiry {decision.selectedOption.expiry}
          {decision.selectedOption.spotMinor !== null ? ` · NIFTY ${(decision.selectedOption.spotMinor / 100).toLocaleString("en-IN")} at evaluation` : ""}</p>
        <p className="mt-1">Ask at evaluation {money(decision.selectedOption.premiumMinor)} × {decision.selectedOption.quantityUnits} units = {money(decision.selectedOption.lotRiskMinor)} indicative premium</p>
        {riskLimitMinor !== null && <p className="mt-1">Current per-trade PAPER limit: {money(riskLimitMinor)}</p>}
        <p className="mt-1 text-white/40">{decision.outcome === "ENTRY"
          ? "The filled entry price and committed risk appear in Positions and Account Risk."
          : "Proposal only; a filled PAPER position appears in Positions."}</p>
      </div>}
      {decision?.blockingReason && <div className="mt-4 rounded-lg border border-[#FFB300]/20 bg-[#FFB300]/[0.06] px-3 py-2 text-xs text-[#FFB300]">
        <p className="font-mono">{decision.blockingReason}</p>
        {decision.blockingReason === "RISK_PER_TRADE_EXCEEDED" && decision.selectedOption && riskLimitMinor !== null
          && <p className="mt-1 text-white/65">{decision.selectedOption.lotRiskMinor > riskLimitMinor
            ? `This lot needs ${money(decision.selectedOption.lotRiskMinor)}, above the current ${money(riskLimitMinor)} per-trade limit.`
            : `This earlier decision used the per-trade limit in force at its evaluation. The current limit is ${money(riskLimitMinor)}; the next cycle will reassess the option.`} No PAPER order was placed.</p>}
        {decision.blockingReason === "MARKET_DATA_NOT_FRESH" && <p className="mt-1 text-white/55">A required Kite candle or option quote aged out before the decision finished. The NIFTY spot tile updates separately and cannot authorize an option entry. No PAPER order was placed.</p>}
        {decision.blockingReason === "MARKET_EVIDENCE_EXPIRED" && <p className="mt-1 text-white/55">The option quote expired before entry could be authorized. This recorded decision cannot be traded later; the next cycle checks a new qualified quote. No PAPER order was placed.</p>}
        {decision.blockingReason === "QUOTE_MOVED_BEYOND_LIMIT" && <p className="mt-1 text-white/55">The current option ask rose above this decision&apos;s approved limit. The bot will not chase a higher price; a later cycle may evaluate a new limit and risk amount. No PAPER order was placed.</p>}
        {decision.blockingReason === "SCHEMA_REJECTED" && <p className="mt-1 text-white/55">The AI reply did not meet the required response format. This cycle safely held with no PAPER order; the next cycle will request a new analysis.</p>}
      </div>}
      {decision?.outcome === "HOLD" && decision.confidence === 0 && decision.blockingReason && <p className="text-xs text-white/45">
        This cycle ended in a blocked HOLD, so its final confidence is 0%. The entry minimum above is a configuration threshold, not this cycle&apos;s signal.
      </p>}
      {decision?.primary?.status === "COMPLETED" && decision.primary.direction && decision.primary.confidence !== null && <p className="text-xs text-white/55">
        AI view: {decision.primary.direction} · {Math.round(decision.primary.confidence * 100)}% confidence. This view alone cannot authorize a PAPER entry.
      </p>}
      {!decision && <p className="mt-4 text-sm text-white/40">The next durable PAPER decision will appear here, including HOLD.</p>}
      <p className="mt-4 text-xs text-white/35">{decision ? `Evaluated ${time(decision.evaluatedAt)} · ${currentSession ? "current session" : "previous session"} · durable SignalLog` : "No decision recorded for this account"}</p>
    </section>
    <section className={`${panel} p-4 sm:p-5`} aria-label="Signal reasoning">
      <h2 className={label}>{decision?.blockingReason && decision.rationale ? "AI reasoning · entry blocked" : "Reasoning"}</h2>
      <p className="mt-3 text-sm leading-relaxed text-white/75">{decision?.rationale ?? decision?.reason ?? "Awaiting a recorded evaluation."}</p>
      {decision?.reason && decision.rationale && <p className="mt-3 rounded-lg bg-white/[0.035] px-3 py-2 font-mono text-xs text-white/45">{decision.reason}</p>}
    </section>
    <section className={`rounded-2xl border p-4 sm:p-5 ${decision?.verifier.verdict === "AGREE"
      ? "border-[#00C853]/20 bg-[#00C853]/[0.035]" : "border-white/[0.07] bg-white/[0.025]"}`} aria-label="AI verifier">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={label}>AI verifier</h2><span className={`badge ${decision?.verifier.verdict === "AGREE" ? "badge-buy" : "badge-muted"}`}>{decision?.verifier.verdict ?? decision?.verifier.status ?? "NOT RUN"}</span></div>
      <p className="mt-3 text-sm text-white/55">{decision?.verifier.reasonCode ?? "Verifier result will appear with a completed decision."}</p>
    </section>
  </div>;
}

function DurablePositions({ active, history, activeTruncated, historyTruncated, uncertain }: {
  active: DurablePaperPosition[]; history: DurablePaperPosition[]; activeTruncated: boolean; historyTruncated: boolean; uncertain: boolean;
}) {
  const [tab, setTab] = useState<"OPEN" | "HISTORY">("OPEN");
  const positions = tab === "OPEN" ? active : history;
  return <section className={panel} aria-labelledby="paper-positions-title">
    <PanelHeading id="paper-positions-title" title="Positions" aside="FILL-DERIVED LEDGER" />
    <div className="flex gap-1 border-b border-white/[0.06] px-3 py-2" aria-label="Position view">
      {(["OPEN", "HISTORY"] as const).map(view => <button key={view} type="button" aria-pressed={tab === view}
        onClick={() => setTab(view)} className={`rounded-lg border-b-2 px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors ${tab === view ? "border-[#00C853] bg-white/[0.07] text-white" : "border-transparent text-white/40 hover:bg-white/[0.035] hover:text-white/70"}`}>
        {view === "OPEN" ? `Active (${active.length})` : `History (${history.length})`}
      </button>)}
    </div>
    {positions.length === 0 ? <div className="flex min-h-40 flex-col justify-center px-4 py-6 text-center text-sm text-white/45">
      {uncertain && tab === "OPEN" ? "Exposure requires attention; the fill-backed view is incomplete."
        : tab === "OPEN" ? "No filled PAPER positions. Zero-fill pending entries are excluded." : "No proven terminal positions in this session view."}
    </div> : <div className="max-h-[560px] space-y-3 overflow-y-auto p-3">
      {positions.map(position => <article key={position.positionId} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 text-xs">
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
    <PanelHeading id="paper-decisions-title" title="Signal history" aside={`${decisions.length} recent decisions · durable SignalLog`} />
    {decisions.length === 0 ? <div className="flex min-h-40 flex-col justify-center px-4 text-center">
      <p className="text-sm text-white/55">Signals appear after the first evaluation.</p><p className="mt-1 text-xs text-white/35">HOLD and rejected decisions are retained.</p>
    </div> : <ol className="relative max-h-[560px] overflow-y-auto px-4 py-3">
      {decisions.map(decision => <li key={decision.cycleId} className="relative border-l border-white/10 pb-4 pl-4 last:pb-0">
        <span aria-hidden className={`absolute -left-[3px] top-1 h-[5px] w-[5px] rounded-full ${decision.outcome === "HOLD" ? "bg-[#FFB300]" : "bg-[#00C853]"}`} />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"><strong className={`font-semibold ${statusColor(decision.outcome)}`}>{decision.outcome}{decision.candidate ? " · CANDIDATE" : ""}</strong>
          <time className="font-mono text-white/35">{time(decision.evaluatedAt)}</time></div>
        <p className="mt-1 text-xs text-white/70">Final {decision.direction === "UNAVAILABLE" && decision.outcome === "HOLD" ? "HOLD" : decision.direction} · {decision.confidence === null ? "Confidence unavailable" : `${Math.round(decision.confidence * 100)}% decision confidence`}
          {decision.family ? ` · ${decision.family}` : ""}{decision.strategyKind ? ` · ${decision.strategyKind}` : ""}</p>
        {decision.selectedOption && <p className="mt-1 break-all text-xs text-white/55">Proposed {decision.selectedOption.contractKey} · 1 lot {money(decision.selectedOption.lotRiskMinor)}</p>}
        {decision.primary?.status === "COMPLETED" && decision.primary.direction && decision.primary.confidence !== null
          && <p className="mt-1 text-xs text-white/45">AI view: {decision.primary.direction} · {Math.round(decision.primary.confidence * 100)}% (analysis only)</p>}
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
      if (!live || !resolved) return;
      if (saved) {
        if (resolved && saved.accountId !== resolved.accountId) { setControl("BLOCKED"); setMessage("CONFIG_ACCOUNT_CHANGED"); return; }
        try {
          const exact = retainPaperSession(await getSession(saved.sessionId), saved.accountId, saved.sessionId);
          if (!live || exact.asset !== saved.asset) throw new Error("SESSION_IDENTITY_MISMATCH");
          setSelected(exact); setControl(exact.status); setMessage("Exact selected session restored.");
        } catch (error) { if (live) { setControl("BLOCKED"); setMessage(errorCode(error)); } }
        return;
      }
      try {
        const active = await discoverPaperSession(resolved.accountId, getActiveSession);
        if (!live) return;
        if (active) {
          // /active returns the stored session only; /:sessionId adds entry readiness.
          const exact = retainPaperSession(await getSession(active.sessionId), resolved.accountId, active.sessionId);
          if (!live) return;
          if (exact.asset !== "NIFTY") throw new Error("SESSION_ASSET_MISMATCH");
          saveSelected(exact); setSelected(exact); setControl(exact.status);
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
        setSelected(exact); setSnapshot(dashboard);
        setControl(exact.status); setMessage(exact.status === "RUNNING" ? runningMessage(exact) : `Session ${exact.status.toLowerCase()}; existing exposure remains visible.`);
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
      setMessage(runningMessage(exact));
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
  const visibleDecisions = snapshot?.recentDecisions ?? snapshot?.decisions ?? [];
  const latestDecision = visibleDecisions[0];
  const displayAnalytics = snapshot?.displayAnalytics ?? null;
  const entryStatus = entryStatusOf(selected);
  const readinessAction = selected?.status !== "RUNNING" ? "Start required" : entryStatus === "UNAVAILABLE" ? "Readiness status unavailable" : entryStatus === "READY" ? "Ready"
    : selected.readinessAction === "OPERATOR_ACTION" ? "Operator action required" : "Automatic retry on the 5-minute cycle";
  return <div className="mx-auto max-w-[1400px] space-y-4 text-white/85">
    <section className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-[#141414] to-[#0c0c0c] p-4 shadow-[0_4px_24px_rgba(0,0,0,0.4)]" aria-labelledby="paper-control-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 id="paper-control-title" className="text-lg font-semibold text-white">NSE PAPER dashboard</h1>
          <p className="mt-1 text-xs text-white/45">NIFTY strategy monitoring · durable PAPER ledger</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 font-mono text-[0.68rem] font-semibold ${control === "RUNNING" ? "bg-[#00C853]/10 text-[#00C853]" : control === "BLOCKED" || control === "CRASHED" ? "bg-[#FFB300]/10 text-[#FFB300]" : "bg-white/[0.06] text-white/60"}`}>{control}</span>
          {selected && <span className={`rounded-full px-2.5 py-1 font-mono text-[0.68rem] font-semibold ${entryStatus === "READY" ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FFB300]/10 text-[#FFB300]"}`}>PREREQUISITES {entryStatus}</span>}
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
        {!config && message !== "Loading server-owned PAPER configuration…" &&
          <button type="button" onClick={() => window.location.reload()}
            className="min-h-11 rounded-lg border border-white/20 px-4 text-xs font-semibold text-white/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00C853]">
            Retry profile
          </button>}
      </div>
      <p role="status" aria-live="polite" className={`mt-3 text-sm ${control === "BLOCKED" || control === "CRASHED" ? "text-[#FFB300]" : "text-white/65"}`}>{control === "RUNNING" && selected ? runningMessage(selected) : message}</p>
      {selected?.entryBlockingReason && <div className="mt-3 rounded-lg border border-[#FFB300]/20 bg-[#FFB300]/[0.06] px-3 py-2 text-xs text-[#FFB300]">
        Entry {entryStatus}: {errorCode(selected.entryBlockingReason)}
        {entryStatus === "WAITING" && snapshot?.session.blockingReason && snapshot.session.blockingReason !== selected.entryBlockingReason
          && <span className="ml-2 text-white/45">Last cycle: {snapshot.session.blockingReason}</span>}
      </div>}
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-white/[0.07] pt-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
        <div><div className={label}>Strategy</div>{family?.replace(/_/g, " ") ?? "Unavailable"}</div>
        <div><div className={label}>Data / execution</div>{snapshot?.session.dataMode ?? config?.dataMode ?? "Unavailable"} / {snapshot?.session.executionMode ?? config?.executionMode ?? "Unavailable"}</div>
        <div><div className={label}>Interval</div>{interval ? `${interval / 60000} min` : "Unavailable"}</div>
        <div><div className={label}>Entry window</div>{resolved ? `${minute(resolved.entryWindowStartMinuteIST)}–${minute(resolved.entryCutoffMinuteIST)} IST` : "Unavailable"}</div>
        <div><div className={label}>Minimum entry confidence</div>{resolved ? `${Math.round(resolved.minConfidence * 100)}%` : "Unavailable"}</div>
        <div><div className={label}>Delta band</div>{resolved?.longOptionSelection ? `${resolved.longOptionSelection.minAbsDelta.toFixed(2)}–${resolved.longOptionSelection.maxAbsDelta.toFixed(2)}` : "Unavailable"}</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[0.68rem] text-white/35">
        <span>Account: {snapshot?.session.accountId ?? config?.accountId ?? "Unavailable"}</span>
        <span className="break-all">Session: {selected?.sessionId ?? "Unavailable"}</span>
      </div>
    </section>

    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-xs" role="status">
      <div><span className="font-semibold text-white/75">Last qualified market view</span>
        <span className="ml-2 text-white/40">{displayAnalytics ? `KITE_REAL · ${time(displayAnalytics.evaluatedAt)} · NIFTY ${(displayAnalytics.spotMinor / 100).toLocaleString("en-IN")}`
          : control === "BLOCKED" && message.startsWith("Selected session unavailable") ? "Current read unavailable" : "No qualified KITE_REAL evaluation recorded yet"}</span></div>
      <span className="font-mono text-white/40">{displayAnalytics ? "RECORDED · READ ONLY" : "AWAITING DATA"}</span>
    </div>

    <section className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2" aria-label="Signal and analytics">
      <PrimarySignal decision={latestDecision} asset={snapshot?.session.asset ?? "NIFTY"} currentSession={latestDecision?.sessionId === selected?.sessionId}
        riskLimitMinor={snapshot?.risk?.maxRiskPerEntryMinor ?? null} />
      <div className="grid auto-rows-min gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <PaperGreeksPanel analytics={displayAnalytics} />
        <PaperIVPanel analytics={displayAnalytics} />
        <PaperSupportResistancePanel />
        <PaperIndicatorsPanel analytics={displayAnalytics} />
        {snapshot?.observation?.status === "AVAILABLE" && snapshot.observation.quote && <section className={`${panel} px-4 py-3 text-xs`} aria-label="Non-tradable market observation">
          <span className={label}>NIFTY spot observation</span>
          <p className="mt-1 font-mono text-white/75">{money(snapshot.observation.quote.priceMinor)} · {snapshot.observation.quote.freshness.state} · NON_TRADABLE</p>
          <p className="mt-1 text-white/40">KITE · Exchange {time(snapshot.observation.quote.brokerTimestamp)} · Fetched {time(snapshot.observation.quote.fetchedAt)}</p>
        </section>}
      </div>
    </section>

    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Durable history and positions">
      <SignalHistory decisions={visibleDecisions} />
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
          <div><dt className={muted}>Entry prerequisites</dt><dd className={statusColor(entryStatus)}>{entryStatus}</dd></div>
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
          <div><dt className={muted}>Per-trade limit</dt><dd>{money(snapshot?.risk?.maxRiskPerEntryMinor)}</dd></div>
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
