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

1. Use a transaction-capable Mongo deployment. Application startup ensures and
   verifies the approved `ALL` execution indexes (BASE plus RECONCILIATION)
   before touching the PAPER account. It uses the existing index definitions,
   never drops or replaces healthy indexes, and fails closed on conflicts or
   insufficient index permissions. `execution:indexes` remains available for
   explicit preflight/administration (see `EXECUTION_FOUNDATION.md`).
2. At startup, after BASE and RECONCILIATION execution-index verification,
   the backend ensures one canonical `PAPER:NSE` TradingAccount. Set `PAPER_CAPITAL`
   to a positive decimal rupee amount with at most two fractional digits, for
   example `200000` for ₹2,00,000. The bootstrap stores this as immutable integer
   `initialCapitalMinor` (20,000,000 paise). A missing/invalid capital or mismatch
   with an existing account fails startup. It never updates an existing account.
   Existing canonical accounts without this capital reference are reused
   unchanged; bootstrap does not backfill or reset them. Their capital reference
   remains unasserted until separately provisioned through an approved migration.
3. First creation without `NSE_PAPER_ACCOUNT_CONFIG_FILE` uses the operator-approved
   backend-owned `NSE_PAPER_POLICY_V3`: 20,000,000 paise capital,
   `policyVersion: 3`, per-entry risk 2,000,000 paise, aggregate reserved-risk
   capacity 2,400,000 paise, three position slots, daily loss 400,000 paise,
   and `LOCAL_DATE_V1` in `Asia/Kolkata`. `PAPER_CAPITAL` must parse exactly to
   20,000,000 paise; other amounts fail closed. The internal `brokerAccountRef`
   is `PAPER:NSE`. No Kite login is needed to create the account. Reference-only
   reconciliation is bound once to the verified backend Kite profile during
   recovery; absent authentication leaves ENTRY waiting.
   Existing V2 accounts require an explicit, audited idle-account upgrade; startup
   never silently rewrites persisted risk policy or an active reservation.

   An optional strict `NSE_PAPER_ACCOUNT_CONFIG_FILE` may still supply an explicit
   full policy and broker reference for advanced provisioning. It is an absolute
   path to a server-owned JSON object with exactly these fields:

   ```json
   {
     "brokerAccountId": "<verified Kite user ID>",
     "entryRiskPolicy": {
       "policyVersion": 1,
       "maxRiskPerEntryMinor": "<approved positive integer paise>",
       "maxReservedRiskMinor": "<approved positive integer paise>",
       "maxPositionSlots": "<approved positive integer>",
       "maxDailyLossMinor": "<approved positive integer paise>"
     },
     "riskTradingCalendar": { "kind": "LOCAL_DATE_V1", "timeZone": "<approved IANA timezone>" }
   }
   ```

   The placeholders above must be replaced with JSON numbers/strings of the
   documented types. No durable risk ceiling, Kite account ID or calendar is
   inferred from legacy/backtest defaults. The policy's aggregate and daily
   ceilings may not exceed configured capital; per-entry may not exceed aggregate.
   An invalid supplied file prevents creation; there is no partial merge with
   built-in policy. The new account is PAPER_READY for monitoring but has no
   READY recovery or MATCHED reconciliation state. The optional file supplies
   an explicit reference-only Kite identity; without it, only a profile-verified
   authenticated backend session can bind that identity later. Approved recovery
   and reconciliation still gate financial entry. Bootstrap performs no broker
   request and creates no order or fill.
4. Normal NIFTY monitoring needs no `NSE_PAPER_CONFIG_FILE`. The backend resolves
   only `PAPER:NSE`, never an arbitrary eligible account. Zero matches returns
   PAPER_ACCOUNT_REQUIRED; duplicates return PAPER_ACCOUNT_AMBIGUOUS. Account
   policy, kill and recovery states still gate ENTRY. The browser sends only
   `{ "asset": "NIFTY" }`. Start/Stop never creates or resets the account.
5. The built-in validated profile is NIFTY / LONG_OPTION / PAPER / KITE_REAL,
   five-minute cadence, 09:30–15:00 IST entries, 65% confidence and the approved
   0.55–0.70 delta band. `NIFTY_PAPER_QUALITY_V2` keeps the standard RSI 70
   bullish ceiling, with a narrow 70–80 exception for a LONG_CALL only when the
   primary view is at least 75% confident and completed NIFTY candles prove a
   trending bullish alignment: close above EMA20/EMA50, no three-bar bearish
   momentum, EMA20–EMA50 at least one ATR, ADX(14) at least 25, and +DI ahead
   of −DI by at least five points. Otherwise the original RSI gate holds.
   These thresholds are a PAPER strategy hypothesis, not a guaranteed trend or
   profitability claim. Fresh quotes, qualified contracts, risk admission,
   recovery and reconciliation remain mandatory. Capital and account risk policy
   remain separate from the operational profile.
   An optional `NSE_PAPER_CONFIG_FILE` remains a strict server-owned JSON array
   of complete PaperSessionConfig objects; the Dashboard NIFTY default must
   still map `PAPER:NSE`.
   Invalid/ambiguous overrides fail closed rather than falling back silently.
6. Covered market dates use the server-owned NSE F&O calendar below. No daily
   `openDates` file is required. The canonical NIFTY/LONG_OPTION profile now resolves
   backend version `NIFTY_PAPER_OPERATIONS_20261001_V1`: a fixed 6.5% annual,
   continuously compounded BSM rate (`NIFTY_FIXED_BSM_RATE_6_5_PERCENT_2026_V1`),
   ACT/365, zero dividend yield and expiry at 15:30 IST (`NSE_CLOSE_1530_V1`).
   This is a model policy assumption, not a live RBI/bond quote. The defaults are
   bounded to 2026 and must be reviewed/versioned with calendar updates.
   `NSE_PAPER_ENTRY_METADATA_FILE` remains an optional strict server-owned override
   containing a complete `riskFreeRate`/`riskFreeRateVersion` pair. Explicit files
   are re-read before evaluation; malformed/partial/unreadable files fail closed.
   A calendar override must exactly match the server authority. No risk/account,
   recovery or reconciliation state is inferred from these configuration defaults.
7. Monthly metadata defaults to independent [NSE/FAOP/68747](https://nsearchives.nseindia.com/content/circulars/FAOP68747.pdf)
   and [NIFTY contract specifications](https://www.nseindia.com/static/products-services/equity-derivatives-nifty50):
   last Tuesday, moved back over verified exchange holidays/weekends. Q4 2026 dates
   are October 27, November 23 and December 29. Qualification remains against the
   actual current Kite CSV. The default universe is NIFTY contracts within 2026;
   later contracts and other assets cannot become qualified using this evidence.
   Optional `KITE_MONTHLY_EXPIRIES_FILE` is a full explicit override; invalid files
   or missing per-contract evidence block qualification, never trigger fallback.
   The default `NIFTY_LONG_OPTION_EXITS_V1` applies only to PAPER:NSE/NIFTY/LONG_OPTION:
   50% actual premium profit/loss thresholds, one-hour maximum holding, 15:20 IST
   EOD attempt, 30-second quote age and 15-minute close authorization. A close
   uses a fresh Kite option quote at planning and claim time, with an at-most
   5% tick-aligned limit cushion; the current bid/ask must still make that limit
   executable. The PAPER simulator fills at the approved limit, so this cushion
   can make simulated exit P&L more conservative than the observed quote.
   These are the documented durable-exit terms, not legacy settings. `NSE_PAPER_EXIT_CONFIG_FILE`
   remains an optional full override, with no silent merge on empty/invalid files.
   Previously captured position policies remain immutable; CLOSE and retained fills
   keep their existing rules independently of entry readiness.
   Default/session status exposes validated assumptions, expiry provenance, upcoming
   dates, policy IDs and specific configuration errors. VALID configuration does not
   itself mean entry READY. No daily manual metadata files are required for NIFTY.
8. With the backend running, authenticate Kite and click
   Dashboard Start. A durable monitoring session becomes RUNNING even when
   market/entry prerequisites are unavailable. `entryReady`, `entryStatus` and
   `entryBlockingReason` are separate from session lifecycle. Start and each
   scheduler wakeup attempt approved preparation when applicable; only genuine
   audited recovery and MATCHED reconciliation proof can enable entry.
   Repeated Start retains the exact session and idempotent timer. Temporary
   readiness failures never stop/replace it. Persistence/config/mode/account
   identity failures remain fatal Start errors. Exits remain independent.

GET/status does not recover or reconcile an account and never mutates financial
records. It checks current readiness through the approved read-only market and
ledger paths. Closed-market observations retain the broker timestamp and exact
freshness, carry NON_TRADABLE presentation status, and supply no entry authority.
The dashboard does not compute stale Greeks using invented or incomplete inputs;
those remain UNAVAILABLE. Phase 5 strategy freshness is unchanged.
After a qualified KITE_REAL cycle, a bounded presentation-only projection of its
validated indicators and representative option Greeks/IV is retained with its
evaluation time. The dashboard can show the last such record across sessions
while markets are closed, clearly marked as recorded data. It never reuses that
projection for entry, recovery, reconciliation or risk. Prior cycles without a
projection cannot be backfilled. IV rank/percentile, PCR, max pain and support/
resistance stay unavailable until qualified sources for them exist. The recent
decision feed is account-scoped to PAPER/KITE_REAL and bounded to 30 cycles.

Active/nonterminal positions, held risk and UNKNOWN/unresolved exit workflows
are queried separately from terminal history. History is bounded at 200. The
active safety bound is 1000; overflow explicitly reports TRUNCATED/ATTENTION and
unknown counts instead of presenting zero exposure. No legacy records are joined.

Recovery retains the approved core's limitations. In particular a prior host left
RECOVERY_REQUIRED cannot be forcibly replaced by this route, and unlinked shadow
exposure cannot be fabricated into a matching Kite position. Such accounts remain
blocked for approved operational reconciliation. The route does not reset proofs.

## Automatic calendar and entry preparation

`NSE_FO_TRADING_CALENDAR_V1` / `NSE_FO_2026_20260930_V1` covers only
2026-01-01 through 2026-12-31 in Asia/Kolkata. Sources verified on 2026-09-30:

- [NSE/FAOP/71777 annual F&O trading holidays](https://nsearchives.nseindia.com/content/circulars/FAOP71777.pdf)
- [NSE/FAOP/72262 January 15 election holiday](https://nsearchives.nseindia.com/content/circulars/FAOP72262.pdf)
- [NSE/FAOP/72352 February 1 Budget session](https://nsearchives.nseindia.com/content/circulars/FAOP72352.pdf)

Ordinary covered weekdays excluding these official closures are OPEN. Weekends
are CLOSED_WEEKEND except explicit special sessions. February 1 uses the official
regular session hours. November 8 Muhurat is SPECIAL_SESSION but blocks entry:
its trading times are not qualified by these sources. Outside coverage returns
UNAVAILABLE / CALENDAR_NOT_READY. Later exchange amendments or a new year require
an explicitly verified calendar version update, not extrapolation. The legacy
2026 holiday helper shares this closure dataset; it is not entry authority.

Start persists the monitoring session independently of market date. A closed
market can remain RUNNING with the independent exit monitor active, while ENTRY
waits. On an eligible open date/window, Start and the existing five-minute
scheduler invoke `PaperEntryPreparationService` for that exact current-host
session. Concurrent callers share one preparation; completed attempts, including
failures, are throttled to the normal cadence. No extra retry timer is created.

Preparation verifies the authenticated backend Kite profile, binds the canonical
account's reference identity once if absent, invokes the existing durable recovery
generation workflow, reads the four approved broker evidence endpoints, and calls
the existing REFERENCE_ONLY reconciliation service. Only actual MATCHED evidence
may be passed to approved recovery completion. The core validates host/generation,
watermarks, ledger fingerprint and audit proof. A receipt on MonitoringSession
records the last attempt for presentation/throttling; it cannot authorize entry.
Every readiness result still checks current core recovery/reconciliation, policy,
kill/daily-loss, explicit Greeks/exit config, monthly qualification and market data.

DISCREPANCY and INCOMPLETE keep the same session WAITING without financial repair.
Kite disconnect/reconnect is retried on normal cadence in that same session.
Unrelated manual Kite activity and PAPER fills without explicit broker links keep
the approved reference-only ownership semantics. GET reads do not prepare or
write proofs. The dashboard exposes calendar provenance, last attempt and whether
operator action is required. Normal operation needs no recovery button. Restart
still invalidates process-local timers and requires the existing explicit Start
lifecycle; old-host proof never authorizes a new host. CLOSE and confirmed
post-dispatch fill processing are unaffected by ENTRY waiting.

## One captured evaluation

PaperEvaluationScheduler owns one timer per account. It starts readiness preparation
three minutes before the next five-minute broker boundary plus 45 seconds, and
refreshes recovery/reconciliation if the prior receipt would expire before that
target. The decision waits until 45 seconds after the boundary, then rechecks the active session,
receipt, account gates and all existing orchestration/admission gates. Slow
preparation skips the bar rather than using stale proof. A failed early
preparation is retried for the next bar, never in a same-bar rapid loop. There is no catch-up queue. A per-account
in-process lock and durable unique cycle key protect overlapping callers.

The cycle key hashes account + underlying + canonical five-minute UTC bar start
(versioned NSE_PAPER_WINDOW_V1). These windows align with 09:15 IST and are host
timezone independent. Session/config/family replacement cannot evade the same-bar
claim; changed configuration conflicts. A later bar is a separate decision.
Each cycle retains both the completed entry-config fingerprint for same-window
conflicts and the original monitoring-config fingerprint for the financial
session fence. Server-filled calendar and Greeks metadata cannot make an
otherwise current RUNNING session look stopped.
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
An ATTENTION entry whose every child is unclaimed, KNOWN, zero-fill and never
submitted, and whose mandatory market/deadline authorization has expired, cannot
be dispatched. Before another cycle, the orchestrator atomically proves this
chain, marks its children NOT_SENT and the intent/position ABORTED, then audits
release of its reservation and slot. Any uncertain or partly filled child keeps
its full hold and blocks new entry. Expiry alone never releases risk.

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
blocked instead of inventing a fill or resubmitting. An overdue close claim with
no retained outcome surfaces as `ORDER_OUTCOME_UNRESOLVED` in the exit monitor;
it requires explicit PAPER reconciliation before another close can be planned.

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

Live-data limitation observed on 2026-10-07: Kite's historical endpoint sometimes
returned the last completed NIFTY five-minute bar too late for the existing
freshness allowance. A durable cycle captured at 14:05:27 IST had an index bar
last finalized at 14:00:00; its proof expired about three seconds later, just as
the primary AI returned an 80% view. The resulting `MARKET_DATA_NOT_FRESH` HOLD
was correct and sent no PAPER order. [Kite's guidance](https://kite.trade/forum/discussion/14790/historical-api-is-giving-data-1-min-dealay-after-5min-candle-closing)
recommends building live-strategy candles from WebSocket market data.

The index service now subscribes read-only to the current qualified NIFTY index
token in Kite's timestamped full mode. It retains a five-minute bar only after an
uninterrupted subscription covers the entire interval, exchange ticks arrive
within 30 seconds of receipt, and first/last/intermediate tick gaps are bounded.
Only a contiguous completed stream suffix can bridge delayed broker history;
missing or partial bars still fail closed. A disconnect, changed session token,
or replaced master discards in-progress bars. Readiness reuses healthy intraday
masters so its five-minute checks do not reset the stream. The entry scheduler
wakes 45 seconds after broker bar boundaries without accumulating REST/AI execution drift.
That offset allows the newly completed Kite bar to arrive. If only the prior
bar is available, its original 30-second grace has elapsed and the cycle holds
without calling AI or placing an entry.
After a fresh connection, at least one full five-minute streamed bar must finish
before this source can bridge a delayed historical bar. Index quotes, option
quotes, candidate expiry, reconciliation, recovery and risk gates retain their
existing freshness and authority checks; the 30-second evidence age is unchanged.

The five-second timer belongs to the exit monitor; entry decisions run on the
five-minute completed-bar cadence. A freshly displayed, non-tradable NIFTY spot
observation does not refresh an option's exchange packet or last-trade time.
Entry freshness tracks the index plus the option summaries actually read by
the models and the contracts selected for a candidate. Unrelated, unused
strikes cannot expire a decision, while every consumed quote and candle still
faces a 30-second freshness limit through risk admission and the initial claim.
For a qualified KITE_REAL candidate, the orchestrator captures a second broker
snapshot after the AI and verifier finish. It deterministically rebuilds the
candidate only if the completed candle, indicators, masters, direction, contract
and lot remain the same and the spot has moved no more than half an ATR. The
durable decision records both the AI prompt's original analytics evidence ID
and the final candidate's refreshed evidence ID. The refreshed quote starts no
new grace period: its own exchange, trade and fetch timestamps must pass the
unchanged 30-second checks at admission. If remote ledger validation outlasts
that quote, final admission may obtain another evaluator-issued proof for the
same completed candle, selected contract, lot and immutable BUY limit. It must
pass the same 30-second freshness checks and cannot extend the original intent
deadline or entry cutoff. A changed or stale snapshot holds the cycle. Initial
preparation is scheduled within the three-minute
lead window so its five-minute readiness receipt cannot expire before the
first evaluation.
The KITE_REAL LONG_OPTION decision deadline allows at most two minutes from
evaluation and never crosses its five-minute decision window. This accommodates
remote risk admission and claim latency; every renewal still requires a fresh
30-second Kite quote on the same completed candle and contract.
For KITE_REAL LONG_OPTION PAPER entries, the immutable BUY limit is the
observed qualified ask with a 1% allowance, rounded up to the contract tick
(at most one extra tick from rounding).
The full limit times the lot size is charged against per-trade and aggregate
risk capacity before an order can be authorized. A refreshed ask must remain
at or below that limit; the allowance does not relax quote freshness,
contract identity, entry cutoff, recovery or reconciliation checks.
For the immediate initial claim, the orchestrator reuses the verified index
proofs from the same entry operation and skips retained-receipt processing for a
new READY, unclaimed child. A current admitted quote is used directly. If it
expires before the claim, the orchestrator obtains a new qualified Kite quote
and re-runs the deterministic strategy on the same completed candle, contract
and lot. The fresh option ask must not exceed the reserved immutable LIMIT. A
process-issued proof binds that quote to the original plan and is persisted
with the claim. The new evidence receives only its own 30-second lifetime and
cannot extend the immutable intent deadline or entry cutoff. If qualification
changes or the ask exceeds the limit, no claim or PAPER submission occurs.
Claims, risk writes and receipt ingestion retain their transaction,
reconciliation and broker-evidence checks.

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
