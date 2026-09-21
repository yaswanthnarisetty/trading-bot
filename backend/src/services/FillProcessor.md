# Phase 2B3 FillProcessor

Explicitly construct `FillProcessor(connection, paperScope)` and call `process(trade)`
or `processRetained(orderId)`. There is no worker, application wiring, adapter callback,
or broker dependency. Input is normalized PaperBrokerAdapter trade evidence, not a
broker snapshot. LIVE and legacy modes are rejected.

Each trade uses one snapshot/majority Mongo transaction: resolve account/order/intent/
position ownership, compare an existing broker trade identity, run the approved order
and position reducers, check exact accounting bounds, persist the immutable Fill,
save versioned order and position projections, and append FILL_RECEIVED and any
position lifecycle transition. The mandatory write boundary validates persisted
relationships and fill totals and fences the account. Event allocation reloads the
account after those fences. Mongo retries transient transaction conflicts with fresh
documents; it never retries external actions. No broker operation is performed.

Duplicate identity is `(accountId, broker, brokerNamespace, brokerTradeKey)` under the
existing unique index. Duplicate economics include all ownership fields, quantity,
price and execution timestamp. Transport receive time/evidence reference can change
on redelivery. Conflicts throw; identical replay does not save anything or allocate
another event sequence. Index absence, ownership mismatch, overfill, unsafe integer
arithmetic and save failures fail closed with no partial financial commit.

Each leg gains optional `entryNotionalMinor` and `netQuantityUnits`. They are optional
only for compatibility with pre-2B3 records; this processor writes both for every leg,
and the mandatory boundary rejects incorrect values or removing attached projections.
Entry notional is the lifetime sum of entry fill price in paise times contract units;
BigInt multiplication and accumulation precede checked conversion to safe integers.
The average entry price remains an exact rational (notional / entryFilledUnits).
BUY adds signed units; SELL subtracts them. These are actual quantities, so 65 of a
planned 130-unit hedge protects only 65 units. This service does not authorize or
submit any short order.

Position entry lifecycle follows actual fills through PARTIALLY_OPENED to OPEN.
Existing authorized exit-fill reduction remains supported without creating a close
intent/order, confirming CLOSED, allocating realized P&L, or settling reservations.
Gross entry consideration and immutable fills retain the data for future accounting.
Unknown/reconciliation-required knowledge is not cleared by fill processing. Fills
do not consume snapshots or advance lastObservationVersion; the existing observation
reducer and mandatory persistence boundary continue to prevent quantity regression.
A proven trade arriving before receipt persistence may bind an absent broker ID once,
inside the same transaction. No acknowledgement is required.

Retained submissionOutcome is immutable historical evidence; pendingFillProcessing
is its original receipt-time flag, not current processing status. Use retainedStatus:

- UNPROCESSED: retained trades exist, none has an identical committed Fill.
- PARTIAL: some retained trades have identical committed Fills, others do not.
- INCOMPLETE: all available retained trades are applied but the original evidence set
  was incomplete, or no outcome is retained. Missing trades are never synthesized.
- PROCESSED: every retained trade has an identical committed Fill and the retained
  evidence set was complete. This does not mean the physical order is fully filled,
  final, reconciled, or safe for risk release. A complete zero-trade receipt also qualifies.

processRetained uses process for each trade, stopping on first failure and returning
failedTradeKeys plus a fresh committed-ledger status and unprocessedTradeKeys. Earlier
trade commits remain valid. A caller may explicitly retry after addressing a failure;
replay applies only missing trades. There is no mutable batch-success flag or claim
that could acknowledge evidence before commit. The raw envelope remains discoverable.

Risk settlement is deferred: reservation documents, account financial balances and
realized P&L remain unchanged. Actual exposure is available as signed leg quantities
and entry notional, not substituted for margin or risk-engine exposure. Admission
HALTED/DISABLED, expired authorization, policy changes and a price limit breach do
not suppress proven fill truth. Quantity ownership/overfill and representation bounds
still reject invalid input as required. No new risk policy, halt, recovery, or
reconciliation mechanism is introduced.
