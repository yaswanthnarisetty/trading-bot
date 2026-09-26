# PAPER risk lifecycle (Phase 2C3)

These explicit services support the existing admitted BUY-only PAPER option ENTRY
and reducing CLOSE workflow. There is no scheduler, external broker, liquidation,
cancellation, recovery-order creation or SignalLoop/PaperTrade integration.

## Exact gross realized P&L

FillProcessor owns the financial transaction. For each admitted Position leg, the
existing gross entry notional and entry-filled units define weighted-average cost.
For cumulative closed units C, entry notional N and entry units Q, allocated cost is
floor(N * C / Q). A close Fill receives the difference between the cumulative cost
before and after its quantity. Gross proceeds minus that cost is signed realized P&L.
The last unit consumes the remaining paise; no cost disappears through repeated
average-price rounding. Products, accumulation and division use BigInt, then checked
safe-integer paise conversion. Fees/taxes and unrealized P&L are not included.

CLOSE fills are ordered canonically by execution timestamp, broker namespace and
broker trade key. This is weighted-average allocation, not FIFO/LIFO entry matching.
Late or out-of-order evidence recomputes the supported Position and account projection
from immutable owned Fills, including affected historical day buckets. Final economics
and per-day rounding allocation therefore do not depend on delivery order. Valid
owned evidence is never rejected merely for violating current risk policy.

Position/leg realizedPnlMinor and TradingAccount.realizedPnlMinor reuse existing
signed fields. The latter is the supported lifetime net realized total. The new
realizedPnlDays array retains signed totals by trading day; dailyRealizedPnlMinor is
the active dailyTradingDay's value. Neither risk settlement nor a date change erases
lifetime P&L, historical day buckets or Fill history. Existing unsupported/history
projection mismatches fail admission closed; no migration or counter repair is hidden
inside admission. No historical Fill is invented.

## Trading-day configuration and admission

Trusted account provisioning must explicitly persist riskTradingCalendar:
{ kind: "LOCAL_DATE_V1", timeZone: <IANA timezone> }. This immutable configuration
means calendar dates at local midnight, not an inferred exchange holiday/session
calendar. There is no implicit NSE, UTC or server-local timezone. Fill execution time
determines realized-P&L attribution; the service clock determines the current day.

New admission also requires entryRiskPolicy.maxDailyLossMinor, a positive safe integer
in paise. A signed daily total <= -maxDailyLossMinor rejects with
DAILY_LOSS_LIMIT_EXCEEDED. Winners offset losses for this net-realized policy. Missing
calendar/policy, regressing current day, unexplained ledger drift, unsupported risk,
and active kill all fail closed. Existing pending-plus-committed, per-entry and slot
limits remain enforced. Same-intent replay does not charge capacity again.

An otherwise successful new admission lazily advances dailyTradingDay in its own
transaction and records TRADING_DAY_ADVANCED. RiskControlService.advanceTradingDay()
provides explicit advancement even when admission is blocked. Fill processing can also
advance it transactionally. Late evidence updates its actual execution-day bucket,
without moving the active day backwards. Rollover leaves risk, slots and kill untouched.
A Fill for a previously dispatched account with no calendar still preserves financial
truth/lifetime P&L; daily-controlled admission remains blocked pending explicit qualified
configuration and any needed historical projection migration.

## Durable kill switch

RiskControlService(connection, scope, clock).setKillSwitch(commandId, enabled, reason)
atomically persists killSwitchEnabled, command/reason/time metadata and a typed audit.
The command identity yields an idempotent event ID; conflicting reuse rejects. Replay
of an old command does not undo a later command. A mandatory account write boundary
permits existing kill state/metadata changes only in this service's audited transaction.
New accounts begin inactive; active kill must be an audited command.

Kill blocks new ENTRY admission and initial ENTRY physical claims, including claims
for previously admitted READY children. It does not mutate admissionStatus, cancel
orders, clear at midnight, block CLOSE or censor post-dispatch evidence. No automatic
kill activation is added: policy breaches deterministically block new admission while
confirmed Fill truth continues to commit above configured ceilings.

## Terminal risk settlement

RiskSettlementService(connection, scope, clock).settleClosedPosition(positionId) is
explicit and brokerless. Position must already be CLOSED through the approved 2B5
workflow. Settlement reuses verifyCloseLedger and successfulClose/closeOrderFinality;
it does not resolve UNKNOWN or RECONCILIATION_REQUIRED knowledge.

Proof requires the completed generation's CLOSE intent, consumed CLOSE_QUANTITY
reservation, zero Fill-derived quantities/close holds, no active close pointer, every
relevant physical order conclusively FINAL and KNOWN, no unresolved RECOVERY intent,
matching closure Fill identities and the published close-completion audit events.
Qualified ENTRY children must all be represented. Apparent flatness is insufficient.

One transaction retains original admission/progress, marks ENTRY_RISK RELEASED with
write-once entrySettlement proof, releases exactly its pending risk, committed premium
and one owned slot, and writes ENTRY_RISK_SETTLED. Realized loss is unchanged. The
reservation cannot reactivate. Replays require the existing settlement event and perform
no writes; capacity readers require that event before disregarding released risk.
Concurrent Fill, admission, control and settlement writers contend on the existing
account CAS fence and use snapshot/majority transactions. No broker call is retried
inside these transactions.

## Conservative deferrals

Zero-fill REJECTED/NOT_SENT entries remain held: this service only accepts the complete
successful-CLOSED workflow; no new ABORTED/non-execution workflow is introduced.
Ambiguous submission, unsettled cancellation and executable partial-entry remainder
never release risk. An entry remainder must first become conclusively impossible under
the existing finality model, and the actual acquired units must close conclusively.

SELL/spreads, Kite/LIVE/Delta execution, reconciliation, exchange calendars, automatic
liquidation/cancellation, recovery orchestration, fees/taxes, workers and Redis remain
deferred. Existing legacy/untyped financial paths are not migrated into this ledger.
