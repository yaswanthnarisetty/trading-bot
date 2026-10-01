# Phase 6B: durable NSE PAPER exits

Production boot initializes `paper_exit_states` / `paper_exit_decisions` unique
indexes and starts `PaperExitScheduler`. Entry start/stop has no control over it.
The default interval is 5 seconds; `NSE_PAPER_EXIT_INTERVAL_MS` permits 1–60
seconds. Four concurrent position evaluations are allowed. Per-process active
sets and 60-second Mongo leases prevent overlapping ownership; planning and
initial claim transactions fence the lease again. Errors are isolated, and a
rotating scan prevents a slow position starving every other position.

## Configuration

The canonical PAPER:NSE / NIFTY / LONG_OPTION profile uses backend-owned
`NIFTY_LONG_OPTION_EXITS_V1` with the thresholds below. Its optional `underlying`
constraint prevents applying it to another asset. Existing captured policies are
never replaced. Other accounts/families require explicit policies.

An optional `NSE_PAPER_EXIT_CONFIG_FILE` fully replaces defaults with a server-owned JSON array, for example:

```json
[{
  "version": "PAPER_EXIT_V1",
  "accountId": "PAPER:your-account",
  "executionMode": "PAPER",
  "dataMode": "KITE_REAL",
  "family": "LONG_OPTION",
  "takeProfitBps": 5000,
  "stopLossBps": 5000,
  "maxHoldingMs": 3600000,
  "eodMinuteIST": 920,
  "maxAgeMs": 30000,
  "authorizationMs": 900000,
  "directionalStop": "DEFERRED_NO_CAPTURED_BASIS"
}]
```

Provide one entry per account/family (LONG_OPTION, DEBIT_VERTICAL,
CREDIT_VERTICAL). This example means 50% actual premium TP/SL, one-hour holding,
and 15:20 IST EOD. These are also the versioned NIFTY default terms; they are not
inherited from legacy settings. Empty, invalid or unrelated override files cannot
silently activate the built-in policy. The policy is captured once when a position is
first monitored and cannot be silently replaced by later entry sessions or file
edits. Missing/invalid configuration blocks new planning/dispatch, but retained
fills and terminal settlement remain processable. Config can be attached later
to a position that had none. Changing an already captured policy is outside 6B.

## Evidence and economics

Only persisted fills establish quantities, entry cashflow and holding start.
Money is integer paise with BigInt accumulation. LONG_OPTION and DEBIT_VERTICAL
percentage thresholds use actual net debit; CREDIT_VERTICAL uses actual net
credit. A stranded long uses its actual debit. Invalid/nonpositive premium basis
disables percentage rules, not time/EOD. Exact vertical width is recorded;
executable liquidation includes bid/ask cost and is not artificially clipped to
expiry-payoff bounds. Actual entry risk remains governed by the approved bounded
spread model. Estimates never write realized P&L.

Each evaluation resolves stored canonical economic identity against the CURRENT
qualified Phase 4B master. Stored entry tokens are not reused. Quotes require
KITE_REAL issued provenance, fresh exchange/fetch timestamps, exact identity,
tick alignment and sufficient best-level depth. SELL uses bid; BUY uses ask.
Missing/stale/disconnected evidence blocks without mock fallback or fills.
Every new physical claim checks fresh close evidence again. Entry evidence
expiry is never close authorization.

Priority is STOP_LOSS, EOD_EXIT, DIRECTIONAL_STOP (deferred),
STRANDED_LONG_CLEANUP, TAKE_PROFIT, TIME_EXIT. Time starts at the earliest durable
entry fill, not process uptime. EOD is the configured IST cutoff on that fill's
IST date; overdue overnight exposure remains eligible. Directional/ATR stops
are explicitly deferred: the durable entry does not capture an approved ATR and
spot reference, and inventing one would be unsafe.

## Financial path and conservative limits

PaperExitMonitor → CloseIntentService → CloseWorkflowService → OrderManager →
PaperBroker → FillProcessor → proven CLOSED → RiskSettlementService.

The monitor persists only policy/audit/operational state and proves genuinely
unclaimed entry children NOT_SENT inside the account/order transaction fence.
It never changes position lifecycle, quantity or realized P&L directly.
One immutable close intent/hold/physical child set is reused across ticks and
restarts. Protective long dispatch requires confirmed short flatness AND final
related orders, never acceptance alone. Definitively rejected/never-sent short
entry uses final physical-order evidence for long-only cleanup; it never
fabricates a short fill. Possibly sent/partially filled entry orders remain
blocked until their approved finality requirements are satisfied.

UNKNOWN/partial closes retain risk and children. No automatic retry,
replacement, resizing, cancellation or simulator advancement is introduced.
Retained and late PaperBroker fills remain ingestible regardless of quote age,
entry stop, kill switch or entry deadline. UNKNOWN remains uncertain even if a
late full fill arrives; it cannot unlock hedge removal or settlement by itself.

Close LIMITs and their authorization deadline are immutable. New claims require
a current executable price compatible with the captured LIMIT. If prices move
against it or authorization expires, monitoring exposes attention and retains
risk; automatic repricing/replacement is not implemented. Quotes becoming valid
again can unblock only while the existing authorization remains valid. EOD is
an exit attempt, not a guarantee of flatness.

Restart scans durable positions; it does not auto-restart entry sessions or ask
an LLM. Existing account readiness rules still apply to new close dispatch. An
account with `admissionStatus = RECOVERING` blocks new claims until PAPER_READY;
the separate ENTRY recovery barrier does not itself block CLOSE. Retained truth
can still be processed. Paper orders are never expected to exist at Kite.
The simulator is process-local; receipts persisted before restart are consumed,
and lost/ambiguous dispatch receipts are never reconstructed as fills.

Kill switch and daily-loss gates block ENTRY, not CLOSE. Settlement requires
fill-derived flatness and all order finality; releases pending/committed risk and
one logical slot exactly once through the existing transaction service.

## Visibility and isolation

Authenticated `GET /api/session/exits/status?accountId=PAPER:...` exposes current
operational position state, reason and close intent link (up to 200). Append-only
`paper_exit_decisions` records configuration, actual fill references/basis,
quote provenance/prices, triggers, selected reason and close link. This is not a
performance API. Legacy dashboard financial panels remain legacy until 6C.

Legacy PositionMonitor.start throws LEGACY_POSITION_MONITOR_DISABLED. Legacy
PaperTradeService only knows its old collection; the durable monitor imports
neither. No LLM exit decision, Kite writes, LIVE, Delta, Redis or financial
backfill is introduced. All automated fixtures prohibit HTTP/HTTPS/fetch and use
an isolated real Mongo replica set, never application credentials.
