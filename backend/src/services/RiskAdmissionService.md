# PAPER ENTRY admission and Fill-backed risk (Phases 2C1–2C2)

`RiskAdmissionService.authorizeEntry(intentId)` accepts only a durable ENTRY identity.
It has no broker dependency or dispatch. The caller explicitly submits returned child
IDs through OrderManager. FillProcessor remains the sole executed-quantity service.

## Admission prerequisites

TradingAccount must be PAPER_READY with an explicit durable `entryRiskPolicy`:
`policyVersion`, `maxRiskPerEntryMinor`, `maxReservedRiskMinor`, `maxPositionSlots`.
There are no default ceilings, environment fallbacks or configuration endpoints.
`maxReservedRiskMinor` now limits total ENTRY usage: pending plus committed risk.

An immutable ENTRY `entryPlan` supplies BUY_OPTION_LIMIT_V1, INTRADAY, validity and
qualified per-leg instrument terms (contract, option type, expiry, qualification
reference, lot/tick sizes and limit in paise). Trusted planning persists these terms;
LLM estimates are not authority. This service does not fetch instruments or market data.
Missing, stale, fractional, mismatched or unsupported economics fail closed.

A matching empty PENDING_ENTRY Position and canonical signal must already exist.
Admission creates neither Positions nor Fills. LIVE, LEGACY_PAPER, CLOSE, RECOVERY,
and every SELL-containing ENTRY are unsupported. Long-only multi-leg entries use
summed gross premium; no spread, margin, fee/tax or settlement approximation is added.

## Original authorization and mutable progress

Original worst-case premium is `sum(authorizedUnits * qualifiedLimitPriceMinor)`.
Products and sums use BigInt with checked safe-integer conversion, consistently with
fillAccounting. No floating-point accumulation or average-price rounding is used.

ENTRY_RISK keeps immutable initial margin/exposure and the admission fingerprint,
Position, generation, policy version and execution epoch. `entryProgress` stores, per
leg, `legId`, `transferredUnits` and actual `committedMinor`. Authorized quantity and
price remain in the immutable intent; remaining units are authorized minus transferred.

Every reservation save proves progress against immutable, owned Fill documents,
physical child identity and Position entry quantities/notional. Units cannot exceed
authorization, regress, migrate between legs or invent premium. The Fill ledger is the
source of truth, not a caller-provided progress object. The original admission event
and amounts are not rewritten by transfer.

## Account projection

- `reservedExposureMinor` and `reservedMarginMinor`: the same pending premium outlay,
  `sum((authorizedUnits - filledUnits) * limitPriceMinor)`. Never add these mirrors together.
- `committedExposureMinor`: actual gross BUY entry premium from immutable Fills.
- `positionSlots`: total retained slots, reserved plus committed.
- `committedPositionSlots`: retained slots with at least one proved ENTRY Fill.
- Reserved slots are exactly `positionSlots - committedPositionSlots`.

Example: 10 units authorized at 10,000 paise, then 4 filled at 9,000 paise, yields
60,000 pending plus 36,000 committed = 96,000 total risk. Only the filled four units
release their pending worst-case premium. A zero-premium Fill still commits a slot.

The first Fill transfers the existing slot to committed status; total slots remain
unchanged. Later fills and other legs do not consume another slot. Reservation
`positionSlots` stays one as the durable ownership of that total slot.

## Financial transaction and truth before limits

Admission uses one snapshot/majority Mongo transaction: load/prove the chain and ledger,
check per-entry/aggregate/slot limits, CAS-charge pending risk and one slot, persist the
ENTRY_RISK hold, transition the intent, create READY children and append RISK_RESERVED.
Failures roll back all effects including event sequence. Same-intent replay returns
existing IDs without changing economics, expiry, policy or capacity.

FillProcessor uses its existing financial transaction for Fill insertion, order state,
Position quantity/cost basis, reservation progress, account pending/committed counters,
slot transfer, and ENTRY_RISK_COMMITTED audit. Risk transfer is never eventual or a
second transaction. Exact duplicates produce no financial writes or duplicate events.
Account CAS fences serialize different fills, admission and other ledger writes.

The transfer event references its Fill and reservation, with quantity, released pending
premium, actual committed premium, resulting reservation totals and first-slot transfer.
A deterministic per-Fill event ID prevents duplicate transfer audits.

Current policy limits, readiness and authorization expiry are not Fill-ingestion gates.
Valid owned evidence above the authorized price is recorded at its actual premium,
even above configured limits. New admission then fails if current/per-entry or aggregate
usage exceeds policy. Safe-integer overflow and invalid ownership remain atomic errors;
they are not permission to round, fabricate or partially persist financial truth.

## Mandatory submission and projection verification

Every initial PAPER ENTRY claim requires owned ENTRY_RISK, matching economics and the
committed RISK_RESERVED event, regardless of optional metadata presence. Untyped and
CLOSE_QUANTITY reservations cannot authorize new ENTRY dispatch. Missing entryPlan
cannot select a legacy authorization path. OrderManager's broker call stays outside
Mongo transactions; no new submission path is added.

Before new admission or an initial claim, account counters are reconciled against
supported reservation progress, owned Fills and Positions. Unsupported legacy holds,
uncovered exposure or unexplained drift fail closed without repair. An unfilled 2C1
hold without entryProgress is compatible as zero transferred units. Previously filled
2C1 holds without matching transfer/account projections require explicit migration or
repair outside this slice; admission does not silently backfill them. Historical untyped
already-dispatched orders retain their existing evidence-processing path, but cannot
authorize new ENTRY submission or be treated as supported account capacity.

After a persisted physical claim, broker evidence uses the existing post-dispatch
validation path. It does not rerun initial admission or current policy limits.

## UNKNOWN, CLOSE and deferred settlement

UNKNOWN, SUBMITTING, cancellation requests and rejected/cancelled unfilled units retain
pending risk. Full entry execution reduces pending to zero solely from proved Fills;
ENTRY_RISK remains HELD with its original admission history.

CLOSE_QUANTITY remains a separate quantity-only reservation. CLOSE fills update Position
through the unchanged close logic; they do not consume ENTRY pending risk, reduce
committed ENTRY premium or release the retained slot. A fully CLOSED Position therefore
still occupies committed exposure and a slot until Phase 2C3 settlement.

Deferred: terminal/cancellation release, daily loss, durable kill-switch/operational
halt policy and recovery liquidation. SELL/spread admission also remains unsupported.
No Kite/Delta/LIVE execution, reconciliation worker, SignalLoop/PaperTrade wiring,
Redis, frontend changes or historical Fill fabrication is introduced.
