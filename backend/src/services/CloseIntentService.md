# Phase 2B4: explicit PAPER close planning

`new CloseIntentService(connection, paperScope).requestClose(positionId, commandKey)`
accepts only identifiers. Account/mode are bound at construction; quantities,
instruments, sides and pricing come from persisted records. There is no route,
worker, timer, broker dependency or automatic submission.

## Persisted pricing prerequisite

Position.closePolicy is optional for existing-record compatibility but required for
a new non-flat close workflow. A trusted configuration writer must persist:

- kind: POSITION_LIMIT_V1
- policyVersion matching the TradingAccount policy version
- product and future expiresAt
- distinct legLimits containing a strictly positive limitPriceMinor in integer INR paise for each leg
  being closed

requestClose does not accept or configure this policy. Missing, expired, mismatched
or incomplete policy fails atomically. No quote lookup, entry-price fallback,
marketability guarantee, repricing, P&L heuristic or strategy pricing is introduced.
Each child snapshots a LIMIT request, product, quantity, limit price, policy/epoch,
expiry and fingerprint; later Position policy edits cannot change that child.

TICK QUALIFICATION DEFERRED UNTIL QUALIFIED INSTRUMENT METADATA IS AVAILABLE

The current execution records do not carry reliable tick-size metadata. No tick
size is inferred from an instrument name or invented by this planner.

## One transaction

The service resolves the account/Position and existing canonical command, reuses an
active close/recovery workflow, or derives current signed exposure from immutable
Fills and verifies the Position's entry/exit aggregates. For a new workflow it uses
the existing position reducer, increments closeGeneration, creates a CLOSE intent,
reserves each leg's actual remaining units under closeHeldUnits/closeHoldIntentId,
creates its authorization record and children, and appends INTENT_CREATED,
RISK_RESERVED (reason CLOSE_QUANTITY_RESERVED), and POSITION_CLOSE_REQUESTED.
Account CAS fences, optimistic versions, unique command/generation indexes and
snapshot/majority transaction retries serialize competing requests and fill writes.
All records and account event sequence increments commit or roll back together.
No external work occurs inside the retried callback.

The existing RiskReservation interface is retained with kind CLOSE_QUANTITY. Its
monetary fields and positionSlots are zero: the authorization is backed by actual
Position leg holds, not newly invented margin/exposure money. OrderManager's only
change permits this explicitly typed authorization instead of requiring a nonzero
monetary amount. The mandatory write boundary proves its CLOSE purpose, active
intent, generation, leg ownership, dependency set and bounded outstanding children.
Entry reservations retain their original nonzero-money eligibility requirement.
Account financial balances are untouched.

## Idempotency and holds

The first request's commandKey is canonical in OrderIntent. Later request UUIDs for
an active Position converge on activeCloseIntentId; they create no alias intents,
new holds, orders or duplicate events. Reusing a persisted canonical command for a
different Position is rejected. Restart, SUBMITTING, UNKNOWN, partial fills and
expired policy do not replace an active workflow. Unresolvable references fail
closed. An orphan hold without an active workflow is rejected rather than adopted
or released; an existing active workflow's holds are reused unchanged.

Available quantity is abs(fill-derived net units) minus closeHeldUnits. A new
workflow is only created with no conflicting existing holds. Long exposure closes
by SELL; short exposure closes by BUY. Only actual Fill-backed quantity is reserved.

## Unresolved ENTRY gate

Before creating a new workflow, or returning FLAT for a Position without an active
close, the same transaction verifies the canonical ENTRY intent, physical child
ownership (account, mode, position, leg, instrument, side), and each child's actual
Fill identities and incorporated quantity. Orders on any strategy leg count;
unrelated positions do not. PLANNED, READY, SUBMITTING, SUBMITTED, ACKNOWLEDGED and
PARTIALLY_FILLED children with remaining quantity block. UNKNOWN and
RECONCILIATION_REQUIRED also block remaining quantity, including terminal-looking
children. Phase labels alone are not proof of non-fillability.

A FILLED physical child whose entire requested quantity is incorporated in the
owned Fill ledger is nonblocking, even if snapshot reconciliation is pending.
Otherwise non-fillability requires KNOWN knowledge and one of:

- REJECTED with complete, owned retained rejection evidence, no fills or broker ID.
- CANCELLED/CONFIRMED with complete, owned retained cancellation/trade evidence
  matching processed fills and the physical broker identity.
- NOT_SENT with zero fills and no submission claim, broker ID or submission outcome
  (it never crossed the mandatory durable submission-claim boundary).

Claimed NOT_SENT children without durable non-send proof remain blocked. If the
current record cannot prove terminal completeness, later reconciliation must supply
appropriate evidence; this service never obtains broker evidence or cancels work.

The typed UnresolvedEntryExposureError has code UNRESOLVED_ENTRY_EXPOSURE and safe
position/order/intent/leg IDs, phase, knowledge and unresolvedQuantityUnits (requested
quantity minus incorporated fills; a conservative upper bound if finality is unknown).
Rejection writes no records, holds, events or account sequence increments. Successful
planning still contends on the existing account CAS fence with FillProcessor; a
concurrent fill either causes rejection from the old snapshot or planning from the
updated Fill-backed exposure after retry. No hypothetical future close units exist.

Existing active closes are resolved BEFORE this new-workflow gate. Later ENTRY
uncertainty never creates a replacement or resizes a hold. If later ENTRY fills
increase exposure, the existing FillProcessor marks Position integrity
RECONCILIATION_REQUIRED while retaining the same active close and hold. Recovery
of that inconsistency remains deferred.

## Conservative spread dependency

Every long-leg removal child durably depends on every authorized short entry leg,
including currently flat short legs that might still receive entry fills. These
children stay PLANNED. Only independent short-covering children (or a standalone
long close without short legs) can initially be READY, and only for PAPER_READY
accounts. Other admission states retain planned orders and holds.

This planner never activates dependent children. Phase 2B5's explicit
CloseWorkflowService.advance operation proves short finality and absence of reopening
orders before promotion; see CloseWorkflowService.md. The model and mandatory write
boundary require durable activation evidence. Submission, acknowledgement and fills
alone never automatically release or dispatch the protective hedge.

## Explicit handoff and finality

A caller explicitly invokes OrderManager.submit(readyOrderId), then
FillProcessor.processRetained(orderId) or process(trade). Existing submission claims,
fill deduplication, exact accounting, hold consumption and financial events are
reused without copying them. Partial fills leave the same workflow and remainder.
Uncertainty retains holds. No cancellation/rejection/timeout release is implemented.

Flat requests without an active close pass the ENTRY finality gate before returning
TERMINAL; unresolved reopening exposure fails closed. CLOSED requests return TERMINAL
without creating orders. For a flat Position
with an active workflow, the result retains its intent/reservation/order references;
TERMINAL means no further quantity is needed for this request, not that the existing
workflow is conclusively complete. Neither this service nor its handoff marks
CLOSED, clears uncertainty, completes the intent, or releases reservations. Existing
closure/finality invariants remain in force.
