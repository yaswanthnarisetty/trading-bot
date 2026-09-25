# Phase 2C1: atomic PAPER ENTRY admission

`new RiskAdmissionService(connection, paperScope).authorizeEntry(intentId)` accepts
only a durable ENTRY identity. It has no broker dependency, dispatch, environment
configuration, timer or application-bootstrap integration. The caller explicitly
passes returned order IDs to the existing OrderManager. FillProcessor remains the
only source of executed quantities.

## Persisted prerequisites

The inspected execution account had risk counters and policy/epoch versions, but no
account-scoped risk ceilings. Legacy RiskGuard uses environment limits and session
rupee balances; those are not safe authority for this ledger. A narrow optional
`TradingAccount.entryRiskPolicy` now holds `policyVersion`, `maxRiskPerEntryMinor`,
`maxReservedRiskMinor`, and `maxPositionSlots`. All limits are positive safe integers;
money is INR paise. There are no defaults, legacy fallback, separate config store, or
configuration endpoint. Admission rejects an absent/invalid policy or a version that
does not match the account. Trusted provisioning supplies the policy through existing
transactional, versioned model writes; this slice does not enable an account.

An ENTRY intent must have an immutable `entryPlan` with kind BUY_OPTION_LIMIT_V1,
product INTRADAY, validUntil, and one qualified terms snapshot per target leg:
legId, contractKey, instrumentKind NSE_OPTION, optionType CALL/PUT, expiry,
qualificationRef, lotSizeUnits, tickSizeMinor and limitPriceMinor. Trusted planning
must persist qualified instrument terms; an LLM estimate or strategy name is not
qualification. This slice consumes that snapshot and checks positive price, tick/lot
alignment, contract identity, distinct legs and validity. It does not fetch instruments
or replace market data. Missing terms fail closed.

The caller must already have persisted the owned PENDING_ENTRY Position, with matching
zero-quantity legs, signal strategy/session ownership, no active close and consistent
integrity. Admission never creates a Position or Fill. Existing broker children without
this admission are not adopted or resized. Signal/intent/terms must be current, and the
account must be PAPER_READY with matching policy version. LIVE, LEGACY_PAPER, CLOSE and
RECOVERY are unsupported by this service.

## Requirement and supported shapes

For one or more independent BUY option legs, gross maximum premium outlay is exactly
`sum(quantityUnits * limitPriceMinor)`. Products and sums use BigInt; conversion rejects
overflow. Quantities are contract units, not lots. Prices are paise, not rupees or
option points. No average-price rounding, floating accumulation, or LLM max-loss input
is used. Target quantity, side and contract come from immutable intent targets.

All shapes containing SELL are rejected with UNSUPPORTED_RISK_SHAPE, including the
legacy bull-put and bear-call spreads: the new execution targets do not prove strike,
expiry, multiplier and hedge dependencies needed to safely admit those structures.
The legacy OptionsPosition has different, floating-point economics and belongs to
LEGACY_PAPER; it is not imported. Fees, taxes, financing and settlement exposures are
outside this gross-premium model. No naked-short notional approximation is allowed.

## Atomic transaction and conservation

One snapshot/majority Mongo transaction loads the entire owned chain and policy,
recomputes the requirement, verifies persisted risk/capacity, and performs account CAS
before authorizing anything. It charges existing reservedExposureMinor and
reservedMarginMinor by the same cash debit, charges one positionSlots unit, persists
one ENTRY_RISK reservation, transitions CREATED/RISK_PENDING to RISK_RESERVED, creates
one READY physical child per leg, updates only Position pending-order metadata, and
appends one RISK_RESERVED event with a RISK payload and account sequence.

The two account money counters describe the same retained debit in this slice and are
never added together when checking the risk ceiling. Each reservation's initial and
remaining margin/exposure equal its calculated premium; its positionSlots is one.
There is no hidden counter. Per-trade and aggregate ceilings and slots are checked
before writes; save failures roll back all state, children, versions and event sequence.
Rejections return typed reasons with no persistent financial or audit mutation.

The account write and all ordinary ledger saves use the existing CAS fence, preventing
write skew between competing intents. Existing unique (accountId, intentId) reserves
one economic hold; children use fixed slice `entry`, generation zero and the existing
unique physical-child index. No new indexes are needed. The mandatory write boundary
also proves each new ENTRY_RISK hold has matching account charges and current limits.
The initial submission claim requires its durable RISK_RESERVED admission event.

## Capacity, actual exposure, and uncertainty

2C1 retains the entire original premium and slot, even after partial/full fills,
UNKNOWN submission, restart, requested cancellation or completed close. ENTRY_RISK
cannot transition to RELEASED/CONSUMED, reduce its remaining amount or drop its slot
through supported model writes. This deliberately conservative behavior prevents
premature reuse while settlement is deferred. The immutable admission records the
economics fingerprint, Position, generation, policy version and execution epoch.

Capacity derives from these durable full holds, checked against account projections.
Executed exposure covered by the hold is counted once, not added again. Actual entry
Fill consideration greater than the hold blocks further admission. Nonzero committed
exposure counters, older untyped financial reservations, unheld executed/possibly sent
Positions, or inconsistent counters fail closed: their overlap cannot be safely
determined by 2C1. No existing exposure is zeroed, netted, migrated or guessed. This
means mixed legacy/new ledgers require later projection work before new admission.

## Replay and integration

Same-intent replay returns the original reservation and child IDs without writes,
after checking immutable economics, authorization bindings and capacity consistency.
Concurrent calls converge through transaction conflict retries and existing unique
constraints. Replay does not refresh expiry, epoch, policy, price or quantity; it is
not permission to resubmit. OrderManager still checks its current authorization and
commits the claim before its broker call. Admission never calls the broker.

Persisted ENTRY_RISK can authorize only its owned ENTRY, Position and exact leg
economics. CLOSE_QUANTITY retains its separate quantity-only contract. A CLOSE cannot
use ENTRY_RISK, and every initial PAPER ENTRY claim requires ENTRY_RISK, even when entryPlan is
absent. Untyped reservations and CLOSE_QUANTITY cannot authorize new ENTRY dispatch.
The claim also reconciles reserved account counters/slots to durable retained holds.
A legitimate ENTRY_RISK requires entryPlan; missing economics fail closed rather than
selecting legacy authorization. Already-claimed historical orders remain eligible for
owned broker evidence ingestion; submission does not migrate their authorization. The previously approved pre-dispatch versus post-dispatch boundary remains:
after a durable claim, confirmed broker evidence is not subjected to new risk admission.

## Explicit deferrals

2C2: richer exposure projections and pending-to-committed transfer, broader portfolio
limits, cross-position netting/accounting, supported defined-risk spread admission.

2C3: daily realized-loss gate, durable kill-switch policy, proven terminal release and
final settlement, operational halt behavior. Retained risk and slots are not released
automatically by 2C1, including after the existing CLOSE workflow completes.

No Kite/Delta/LIVE execution, reconciliation, cancellation/replacement, liquidation,
worker, SignalLoop/PaperTrade wiring, Redis, frontend work or historical fill migration.

Regression fixtures for pre-2C1 SELL/spread positions explicitly restore historical
durable claims in isolated test databases. They do not exercise or bypass new ENTRY
admission. OrderManager initial-dispatch tests use real RiskAdmissionService admission.
