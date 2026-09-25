# Phase 2B5: explicit successful PAPER close progression

`new CloseWorkflowService(connection, paperScope).advance(positionId)` evaluates an
existing active CLOSE workflow. It accepts no economics and has no broker dependency,
worker, cancellation, replacement, recovery or reconciliation dispatch.

## Dependency activation

Each protective-long child retains Phase 2B4's immutable dependency leg IDs and close
generation. Every dependency short leg must be flat in the owned Fill ledger and its
Position projection. Every order on those legs, including ENTRY and RECOVERY work,
must have supported terminal evidence. Partial short covering never releases a hedge.
UNKNOWN knowledge/cancellation, incomplete receipts, working or merely planned orders
block activation. Unrelated positions do not participate.

Eligibility additionally requires the current active intent/reservation/leg owner,
canonical dependency set, PAPER_READY admission and unexpired current authorization.
The transaction attaches write-once dependencyActivation identity/evidence, promotes
PLANNED to READY, and appends ORDER_READY. Account CAS fences and document versions
serialize concurrent calls; deterministic event IDs prevent duplicate audit records.
The mandatory save boundary rechecks dependency safety on promotion and the later
OrderManager submission claim, closing the gap if reopening work appears between them.
Actual later fills remain ingestible even if a previously dispatched workflow becomes
inconsistent. This operation never dispatches the newly READY child.

### Submission authorization versus execution evidence

The mandatory write boundary derives the validation purpose from the physical order's
persisted submission claim, not a caller flag or its current phase. Before a claim
exists, `validateCloseSubmissionAuthorization` proves current dependency safety for
PLANNED → READY and again for the initial READY → SUBMITTING claim. An incoming claim
does not bypass this check. The account CAS fence serializes these proofs with ledger
writes. OrderManager dispatches only after the claim transaction commits.

After that claim is persisted, broker evidence answers what happened to an already
possibly sent order. Current dependency admission is no longer a condition for saving
that evidence, including FillProcessor's first broker-ID attachment while the order
still reads SUBMITTING after lost outcome persistence. New ENTRY/RECOVERY work, UNKNOWN
knowledge, halted admission, expired policy or inconsistent integrity do not suppress
an otherwise valid owned fill.

All existing evidence checks remain: account/mode/chain and hold ownership, activation
identity, immutable submitted economics and broker identity, trade identity/conflicts,
quantity limits, cumulative monotonicity, versions/CAS and atomic financial events.
FillProcessor alone updates quantities and consumes holds. Evidence ingestion does not
clear UNKNOWN, resolve reopening orders, authorize resubmission or imply CLOSED.
Unresolved receipts/work remain blockers for finalization; existing position integrity
is preserved, including reconciliation required by a late opening fill.

## Evidence consumption, not broker reconciliation

Normal immediate PaperBroker fills leave RECONCILIATION_REQUIRED until their retained
receipt is incorporated. This service can confirm only a FILLED physical order whose
entire requested quantity exists in its owned Fill ledger, with a complete ACCEPTED
receipt and all retained trades incorporated. It records ORDER_FINALITY_CONFIRMED and
sets knowledge to KNOWN atomically. A partial accepted receipt followed by the rest of
the physical order's actual fills also qualifies; the full quantity cap is proved by
the ledger. It never resolves UNKNOWN, incomplete/ambiguous submissions or late fills
after cancellation/rejection. No broker evidence is fetched or invented.

Supported terminal remainders require KNOWN and complete owned rejection/cancellation
evidence matching processed fills. Unclaimed NOT_SENT with no broker ID/outcome and no
fills is also conclusively non-fillable. Everything else remains unresolved.

## Successful terminal transaction

Finalization requires all Position legs flat, zero close holds, consistent integrity,
all relevant orders conclusively terminal and KNOWN, all close children fully FILLED,
and the active intent's per-leg targets exactly achieved by its actual fills. The same
snapshot/majority transaction sets the intent COMPLETED, quantity reservation CONSUMED,
Position CLOSED, activeCloseIntentId null and potentiallyExecutingOrderCount zero.
It appends INTENT_COMPLETED, RESERVATION_CONSUMED and POSITION_CLOSED with actual Fill
references. State, events and account sequences roll back together on any failure.
Monetary budgets are untouched. Position quantities and cost basis remain exclusively
FillProcessor projections.

Exhausted closeHoldIntentId values remain as historical ownership references. They are
terminally finalized by their COMPLETED intent and CLOSED Position, not cleared or
reassigned. An active or uncertain workflow retains its reservation and ownership.
No historical records are deleted. Repeated CLOSED calls resolve the completed close
generation and return the same terminal result without writes. Concurrent activation
and finalization retry through the existing transaction conflict machinery.

## Explicit caller sequence

1. CloseIntentService.requestClose creates short READY / hedge PLANNED children.
2. OrderManager.submit sends the short through the PAPER adapter.
3. FillProcessor incorporates short fills.
4. CloseWorkflowService.advance returns newly READY hedge IDs when proven safe.
5. OrderManager and FillProcessor execute/incorporate the hedge close.
6. CloseWorkflowService.advance finalizes only after all evidence is complete.

Failed, expired, halted, inconsistent or uncertain workflows may remain blocked. This
slice does not release reservations on timeout, retry rejected closes, alter dependency
quantities or start RiskGuard 2.0. Phase 2B4's positive-price and deferred tick-metadata
policy remains unchanged.
