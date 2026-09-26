# Phase 3B: explicit read-only Kite reconciliation

`new ReconciliationService(connection, paperScope).reconcileAccount(accountId, snapshot)`
compares immutable `KiteReadOnlyAdapter.getSnapshot()` evidence without calling a broker.
There is no bootstrap, route, timer, recovery loop or execution adapter.

## Explicit PAPER reference-only scope

Trusted provisioning may attach this configuration once, after provisioning reconciliation
indexes:

```ts
{ kind: "PAPER_KITE_SHADOW_V1", scope: "REFERENCE_ONLY", brokerAccountId: "verified-account" }
```

The account and its executions remain PAPER. Kite supplies independent read-only reference
evidence; it is not the venue for PaperBroker orders. `BROKER_BACKED_EXECUTION` and LIVE
configuration are rejected. There is no default that silently chooses broker-backed behavior.
Accounts without reconciliation configuration keep Phase 2 behavior and index requirements.

MATCHED means required endpoint reads succeeded, account identity/time checks passed, and
all explicitly linked/owned reference evidence is consistent. It does **not** mean every
PAPER execution exists at Kite or that the PAPER portfolio equals the brokerage account.
Unlinked PAPER orders, Fills and Positions require no Kite counterpart. Unlinked Kite orders,
trades and positions are outside the blocking scope, including unrelated manual activity.
Such evidence is ignored for execution comparison; it is not adopted or financially copied.
Endpoint availability remains mandatory even when no reference entities have been declared.

Comparison version 2 and `scope: REFERENCE_ONLY` are persisted in each report and required
by the admission proof check. Version-1 MATCHED records cannot authorize the corrected
scope. Old ambiguous configurations without an explicit scope fail validation; this pass
does not rewrite historical configuration, records or financial truth.

## Durable ownership and relevance

Reconciliation never creates `ReconciliationLink` records or guesses associations. Trusted
provisioning supplies an evidence reference and exact append-only one-to-one links:

- ORDER: internal order ID, native Kite order ID, exchange, IST order day, optional exchange
  order ID, exact exchange/symbol/token, Kite product and explicit internal product.
  The association includes child executions of this exact broker order/day/exchange and
  the corresponding internal order. Missing child Fill identity remains a discrepancy.
- FILL: existing internal Fill ID, parent ORDER link, native trade ID and Phase 3A trade key.
- An ORDER link may additionally declare
  `positionScope: ENTIRE_BROKER_NET_POSITION`. This explicitly opts in comparison of the
  entire broker net position for that exact exchange/symbol/token/product key. Expected
  exposure sums Fills of explicitly linked orders within the declared key. Without this
  declaration, an order/trade link does not claim the brokerage net-position aggregate.

Declaring an entire net-position key includes all brokerage exposure in that key. Do not
make that declaration for an aggregate containing unrelated holdings that cannot be
separated by exact ownership. Different instruments/tokens/products remain out of scope.
An exact order link does not implicitly make another order with the same symbol relevant.

Save middleware proves account/mode ownership, parent relationships, contract identity,
internal product and canonical keys. Unique indexes prevent duplicate ownership/reassignment.
These are deliberate reference attestations, not proof that simulated Fills were Kite trades.
No link provisioning route or automatic adoption is introduced.

## Strict comparisons within declared scope

All four endpoints are required for MATCHED, including funds availability. UNAVAILABLE
never becomes empty truth. Available findings remain recorded in an INCOMPLETE result.
Funds amounts never become risk capacity or exposure.

Linked orders compare identity, instrument/product/side, LIMIT price, requested quantity,
Fill-derived cumulative units and compatible status. Exchange order IDs are compared only
when both exist. Contradictory filled-plus-cancelled quantities are flagged. UNKNOWN and
unresolved linked execution cannot MATCH. Missing linked orders never become NOT_SENT.

Linked trades compare canonical/native identity, parent order, instrument/product, side,
integer units, exact decimal price versus integer paise and execution instant. Sub-paise
prices never round into a match. Missing/conflicting Fills are recorded, never ingested or
overwritten. Order cumulative fills are corroborated against child broker trades using
BigInt; cumulative status never creates execution identity.

Declared net-position comparisons use signed persisted Fill quantities, never requested
or acknowledged quantities. PAPER leg projections are independently validated against all
of their PAPER Fills, including unlinked ones, without turning unlinked Fills into Kite
exposure. Only the broker `net` view is compared; `day` is not added. Products/tokens never
silently net. Empty AVAILABLE positions mean flat; unavailable positions do not. Excess
exposure within a declared position scope is recorded regardless of risk-policy limits.

## Horizon and time

Kite documents [orders and trades as day-scoped](https://kite.trade/docs/connect/v3/orders/).
Same-IST-day absence of linked evidence can be reported as missing. Prior-day missing linked
orders/Fills yield HISTORICAL_EVIDENCE_UNAVAILABLE and INCOMPLETE, not non-execution proof.
Unlinked historical PAPER Fills do not impose a broker-history requirement.

Endpoint availability/errors, retrieval times, normalization/comparison versions, internal
fingerprint/account version and run timestamps are persisted. Prior-day, future, inverted
or regressing retrieval times block MATCHED. No intraday freshness SLA is invented.
Independent REST reads are not an atomic broker snapshot. A blocked account needs strictly
newer endpoint evidence to clear; older replay cannot replace newer blocking state with MATCHED.

Only frozen snapshots emitted by the Phase 3A adapter in this process are accepted. Arbitrary
JSON and mutable lookalikes reject. Credentials, raw responses and full snapshots are not
stored. Serialized evidence import/authentication remains deferred.

## Transactions, admission and idempotency

Append-only records use a deterministic key hashing account/mode, normalized snapshot,
persisted ledger/link/config state and comparison version 2. Reconciliation's own account
CAS/event counters are excluded. Identical replay returns the existing record without writes.
History remains; previous MATCHED replay cannot clear a newer discrepancy.

The transaction first saves the account through its optimistic version fence, then record
and event. Execution-chain writes contend on that account: a winning blocking reconciliation
forces stale admission to retry; a winning Fill forces reconciliation to retry comparison.
Every record identifies the internal state compared, without claiming perpetual synchronization.
Failed account/record/event saves roll back all effects.

Opted-in accounts require a version-2 REFERENCE_ONLY MATCHED record and its durable
RECONCILIATION_RESOLVED event for new ENTRY. Missing/incomplete/contradictory proof blocks.
RECONCILIATION_MISMATCH events retain the precise classification and typed reference.
The boundary also guards new ENTRY reservations and initial dispatch. Existing admission
replay remains idempotent but cannot bypass dispatch gating. CLOSE and already-dispatched
Fill ingestion keep their existing gates. Reconciliation changes only safety metadata,
account version and audit sequence; it does not repair financial state.

## Feature-scoped indexes and deployment

BASE contains the original 28 mandatory execution indexes. RECONCILIATION contains the
seven additional indexes; ALL contains 35. Default runtime execution readiness checks BASE.
The index CLI defaults to ALL for explicit administration and accepts a group:

```sh
npm run execution:indexes --workspace backend -- list BASE
npm run execution:indexes --workspace backend -- list RECONCILIATION
EXECUTION_MONGO_URI='<explicit database>' npm run execution:indexes --workspace backend -- provision RECONCILIATION
EXECUTION_MONGO_URI='<explicit database>' npm run execution:indexes --workspace backend -- verify ALL
```

Existing opted-out Phase 2 accounts continue with BASE alone, without reconciliation
collections or migration. Before enabling reconciliation, provision its seven indexes.
Enabled accounts, reconciliation-dependent writes/gates and ReconciliationService fail
closed without those indexes. ReconciliationService explicitly requires ALL. Direct record
and link saves also require reconciliation indexes. No automatic startup provisioning,
index dropping or constraint weakening is added.

## Deferred

Phase 3C: startup barriers, recovery orchestration, polling, archived history proof, UNKNOWN
resolution automation, Fill recovery, position/reservation repair and external-order adoption.
No Kite writes, LIVE execution, SELL entry, Redis or SignalLoop/PaperTrade integration.
