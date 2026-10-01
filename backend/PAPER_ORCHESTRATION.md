# Phase 6A: NSE PAPER entry orchestration

Baseline: approved Phase 6A0.2 (`8dd891c`). This slice connects the existing
qualified data, analytics, LLM, strategy and financial services. It does not
implement production exits. Stopping evaluation never closes a position.

## Legacy audit

The complete SignalLoop, session routes, KiteService, LLMService, RiskGuardService,
PaperTradeService, PositionMonitorService, WebSocketService and session models
were inspected before the replacement.

- Reuse: explicit session start/stop, asset selection, five-minute cadence and
  read-only historical records.
- Replace: generated legacy chains, legacy indicator/Greeks/LLM orchestration,
  duplicated RiskGuard decisions, direct PaperTradeService entry and
  OptionsPosition as automatic financial truth.
- Defer: TP/SL/time/directional/EOD exits to Phase 6B; durable-ledger dashboard
  panels and performance presentation to Phase 6C.

SignalLoopService is an inert compatibility facade. Bootstrap and session routes
cannot start it or PositionMonitor. Legacy read routes remain available, but new
PAPER decision rows are excluded from the old signal renderer.

## Explicit operator setup

1. Use the existing transaction-capable Mongo deployment and provision/verify
   all approved execution indexes through `execution:indexes` (see
   `EXECUTION_FOUNDATION.md`). Application startup creates only the new
   nonfinancial history/session indexes; it does not silently provision the
   financial ledger or reset account state.
2. Select an existing, explicitly provisioned `PAPER:*` TradingAccount with
   broker PAPER, admissionStatus PAPER_READY, the approved entryRiskPolicy,
   policyVersion, trading-day settings and durable risk controls. This slice
   neither manufactures capital nor creates an account from browser input.
3. Opt that account into the approved PAPER_KITE_SHADOW_V1 reference-only
   reconciliation configuration. Automatic orchestration deliberately requires
   the current-host recovery barrier; the older isolated-service opt-out is not
   accepted as automatic session readiness.
4. Set `NSE_PAPER_CONFIG_FILE` to a server-owned JSON array of configurations.
   Do not put credentials in that file. Each object must contain:
   - `configId`, `accountId`, `executionMode: "PAPER"`, `asset` (NIFTY,
     BANKNIFTY or FINNIFTY), `dataMode: "KITE_REAL"`.
   - `strategyConfig`: the existing validated StrategyQualityConfig with an
     explicit LONG_OPTION, DEBIT_VERTICAL or CREDIT_VERTICAL family. No AUTO.
   - `intervalMs`: 300000–3600000 (default 300000).
   - `entryCutoffMinuteIST`: 570–915 (default 900, i.e. 15:00 IST).
   - `calendar: { version, sourceReference, openDates }`: operator-maintained,
     authoritative NSE open-date allow-list, at most 400 dates. Omitted dates
     and weekends are closed. No guessed holiday calendar is supplied.
   - `maxAgeMs`: 1000–60000 (default 30000).
   - `riskFreeRate`, `riskFreeRateVersion`: explicit existing Greeks assumptions.
5. Configure the existing Kite monthly-expiry metadata and Phase 5 LLM settings.
   Complete Kite authentication and choose KITE_REAL separately in Settings.
6. For the Phase 6C1 Dashboard default, provision exactly one NIFTY / LONG_OPTION /
   PAPER / KITE_REAL configuration with five-minute cadence, 09:30 IST opening
   block, 15:00 IST cutoff, the approved 65% confidence and 0.55–0.70 delta
   selection. The server validates the whole file using `capturePaperConfig`.
   The account mapping, authoritative market open-date allow-list and versioned
   risk-free-rate assumption must be explicitly supplied by the operator; the
   Dashboard never guesses them. Provision a matching validated LONG_OPTION
   `NSE_PAPER_EXIT_CONFIG_FILE` policy and the existing account risk policy too.
   Missing or ambiguous prerequisites block Start with a reason code.
7. Authenticate Kite and select KITE_REAL in Settings, then click Dashboard
   **Start**. The backend performs approved read-only broker recovery and
   reconciliation preparation before creating a new PAPER session. A genuine
   MATCHED proof is required; mismatch or incomplete evidence fails closed.
   Start never launches the backend process, which must already be running.

An unconfigured deployment returns an empty configuration list and cannot start.
The production provider does not implement MOCK; tests/development can explicitly
inject a MOCK provider into the independently constructed orchestrator. It is never
a fallback for KITE_REAL. No broker tokens or static option symbols are supplied
by session configuration.

Recovery retains the approved core's limitations. In particular a prior host left
RECOVERY_REQUIRED cannot be forcibly replaced by this route, and unlinked shadow
exposure cannot be fabricated into a matching Kite position. Such accounts remain
blocked for approved operational reconciliation. The route does not reset proofs.

## One captured evaluation

PaperEvaluationScheduler owns one timer per account, waits for a cycle to finish,
and schedules the next wakeup afterward. There is no catch-up queue. A per-account
in-process lock and durable unique cycle key protect overlapping callers.

The cycle key hashes account + underlying + canonical five-minute UTC bar start
(versioned NSE_PAPER_WINDOW_V1). These windows align with 09:15 IST and are host
 timezone independent. Session/config/family replacement cannot evade the same-bar
claim; changed configuration conflicts. A later bar is a separate decision.
Replay returns stored history, without repeating the LLM or broker submission.

One frozen session/config and LLM configuration feed the approved qualified index
and option services, real analytics assembler, Phase5LLMService and deterministic
evaluator. Opening-block logic stays in the evaluator. The explicit calendar and
entry cutoff additionally gate entry. Qualified master identity is checked again
after asynchronous LLM completion, and an expired decision window cannot enter.

HOLD persists only nonfinancial SignalLog history. It creates no StrategySignal,
OrderIntent, Position, reservation, order or fill. LLM/stale-data failures have no
financial authority. Decision evidence includes concise structured interpretations,
model/prompt metadata, analytics digest, family/economics and canonical cycle refs;
no raw prompt, credentials or hidden reasoning is persisted.

## Temporal authorization and qualification ownership

Classified entry plans retain `marketEvidenceExpiresAt` from the issued Phase 5
proof: the minimum of every fetched/exchange timestamp plus its allowed age,
and the finalized candle timestamp plus interval plus allowed age. MOCK stores
null explicitly and gains no real-data authority. Orchestrated plans also retain
`entryCutoffAt`, computed from the captured IST trading date and configured minute.
Both bounds are inclusive. The existing 60-second candidate deadline remains an
additional, stricter where applicable, authorization check.

New admission and each initial physical ENTRY claim check these immutable bounds
using the trusted service clock, including transaction retries. A rejected claim
leaves the admitted reservation and unclaimed child intact. Captured master
ownership is checked after adaptation, immediately before RiskAdmission, and by a
pure in-memory callback within new admission. Once admission succeeds, a later
master refresh cannot rewrite or invalidate admitted child economics.

These are authorization checks, never truth filters. Already-claimed outcomes,
UNKNOWN handling, retained/late fills and CLOSE do not acquire a freshness/cutoff
restriction. Pre-correction admitted plans remain readable for financial truth;
missing new proof cannot authorize a new classified claim.

## Durable progression and stop semantics

CandidateIntentAdapter alone issues the existing signal/intent/empty pending
Position and economic children. RiskAdmissionService alone reserves risk/slot.
OrderManager alone claims/submits physical orders, outside Mongo transactions.
The selected adapter is always an actual PaperBrokerAdapter. Its explicit runtime
simulation policy fills the admitted LIMIT quantity; those are SIMULATED_FILLs,
even when market input is KITE_REAL. This is not an exchange-fill guarantee.

FillProcessor consumes retained immutable receipts. Only fills create quantity and
exposure. An empty PENDING_ENTRY Position may exist before any fill; submission
success does not make it OPEN.

Vertical progression is BUY → confirmed fill ingestion → EntryProtectionService
→ fixed SELL eligibility → SELL submission → confirmed fill ingestion. Accepted or
partial BUY is not full protection. UNKNOWN retains its durable claim and never
gets an automatic resend. Partial/stranded/uncertain chains are ATTENTION and block
later cycles on that account until the existing chain is addressed.

Stop invalidates future evaluations and serializes against new adaptation,
admission and submission claims via the session fence in each financial
transaction. A claim committed before stop is already possibly sent; its outcome
and retained fills may still commit. Stop does not cancel, release risk, reset
quantity or block approved close/FillProcessor workflows.

Explicit `POST /api/session/:sessionId/progress/:cycleId` may consume retained
receipts after stop. Unclaimed entry submission additionally requires the original
active/current-host session and all existing financial gates. Replaying a cycle
itself never retries submission. Broker-instance memory is not durable recovery;
if a crash loses an unpersisted simulator receipt, the uncertain ledger stays
blocked instead of inventing a fill or resubmitting.

Bootstrap marks orphaned RUNNING sessions CRASHED/RECOVERY_REQUIRED and starts no
entry/exit timer. The approved recovery generation and MATCHED proof must be
re-established before an explicit new start.

## Status/API compatibility

Authenticated session endpoints expose configurations, explicit recovery/start,
stop, current session, history, per-session decisions and explicit progression.
Start returns the exact session/account/config retained by the dashboard. Polling
uses `GET /api/session/:sessionId`, and stop targets that same ID. Active discovery
requires an explicit configured `accountId`; there is no global first-active
fallback. Per-tab sessionStorage preserves the selected configuration and exact
session across reload. Stopped/crashed/not-found results never switch accounts.

Status includes mode, family, last cycle and blocking reason; individual-session
status also reports Kite connectivity, PaperBroker and deferred exits.

The Phase 6C1 Dashboard accepts only an asset in its Start request. The backend
resolves the validated NIFTY default, and the browser cannot choose family,
account, risk terms or a config record. The normal dashboard has no configuration
dropdown or separate recovery click. Exact session identity remains pinned across
poll, stop and reload. Its primary positions, decisions, exit status and risk
summary read the durable PAPER ledger; zero-fill pending shells are excluded.
Performance remains legacy pending Phase 6C2, and Backtest archive behavior is
unchanged. Existing exposure remains open when entry evaluation stops.

## Offline verification

`npm run test:smoke:paper --workspace backend` runs two explicit offline scenarios
(LONG_OPTION bullish and CREDIT_VERTICAL bullish) using synthetic qualified wire
fixtures, fake OpenAI responses, actual approved services and isolated real Mongo.
It prints fixture-local intent/order/position IDs and states. HTTP/fetch calls are
blocked. No app bootstrap or application .env is loaded by the integration runner.

The focused unit/integration tests cover qualification, stale data, session
lifecycle, durable dedup, competing callers, real fill-derived daily loss during
LLM evaluation, kill/capacity gates, stop transaction rollback, vertical partial
fills, UNKNOWN, retained truth, current-host recovery and post-dispatch failure.
Existing full regression suites remain required; mock broker/data transports do
not substitute for Mongo transaction and concurrency tests.
