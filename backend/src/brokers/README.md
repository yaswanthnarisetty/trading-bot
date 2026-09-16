# Phase 2B1 broker boundary

`BrokerAdapter` exchanges immutable requests, command receipts and observations. It has only `submitOrder`, `cancelOrder`, `getOrder`, `getOrders`, and `getTrades`. There is no worker, ledger writer, risk admission, fill processor or application wiring. Phase 2A readiness remains disabled.

Requests describe one physical order. `orderId`, `intentId`, `positionId`, `legId`, `contractKey`, and `claimId` retain their ledger meanings (`claimId` is the existing submission claim ID). Product is an opaque broker-adapter value, not a Kite product assumption. Units are integer contracts; prices are integer INR paise. LIMIT requires a price and MARKET forbids it. Submission requests and returned evidence are copied and deeply frozen by PaperBrokerAdapter.

Command receipts distinguish ACCEPTED, REJECTED and AMBIGUOUS. Cancellation ACCEPTED means the request was accepted, never that cancellation completed. Order observations and individual trade observations are evidence only; neither changes a Position. Remaining units mean unfilled units even after cancellation.

## Deterministic paper scenarios

Construct an adapter bound to one PAPER account with an injected UTC-string clock, ID source and scenario function. Dependencies must themselves be deterministic. There are no defaults using time, randomness, timers or external state. The instance owns transient simulator state only; it is not durable across restarts.

A scenario chooses submission ACCEPTED/REJECTED/AMBIGUOUS, optional initial fills, optional delayed acknowledgement, cancellation ACCEPTED/REJECTED/AMBIGUOUS, and explicit ordered steps: FILL, ACKNOWLEDGE, CONFIRM_CANCEL. Call the paper-only `advance(lookup)` to apply one step. This control is deliberately absent from BrokerAdapter. Lookups never progress the scenario. A scripted fill after confirmed cancellation fails; a fill before cancellation completion is preserved, including a full fill winning the race. CONFIRM_CANCEL requires a previous cancellation request. Delayed acknowledgement remains PENDING_ACK until its explicit step.

For example, initial fills `[]` and FILL steps with 40, 25, 65 units produce cumulative quantities 0, 40, 65, 130 on a 130-unit request. Every fill gets a unique immutable broker trade key. Scripted overflow and limit-price violations fail before publishing an order. Invalid scenarios/dependencies throw programming errors; they are not simulated broker rejections or lost-response outcomes.

AMBIGUOUS submission internally accepts the order and may even fill it, while returning an ambiguous receipt. `getOrders(scope)` or capability-dependent `getOrder({ ...scope, orderId })` reveals it afterward. No automatic resubmission occurs. Cancellation ambiguity similarly retains the request for a later deterministic observation.

## Idempotency and capabilities

THIS IS A PAPER-BROKER GUARANTEE.
DO NOT ASSUME KITE HAS EQUIVALENT BROKER-SIDE IDEMPOTENCY.

For this instance and account, replaying a committed claim ID and normalized payload returns the original immutable receipt, even after later fills/cancellation. Conflicting payloads are rejected. A different claim cannot create a second broker order for the same internal order ID. Repeated accepted/ambiguous cancellation requests return their original receipt; inspect observations for current status.

Submission ownership follows UNSEEN → RESERVED → COMMITTED. Both canonical claim ID and physical order ID are reserved before scenario, ID-source or clock evaluation. Order and trade materialization stays unpublished until it succeeds. One synchronous mutation guard covers `submitOrder()`, `cancelOrder()` and `advance()` before validation or injected dependencies. Any nested mutation fails immediately with the local `BROKER_MUTATION_IN_PROGRESS` error, including calls made by diagnostic-evidence dependencies. It invokes no further dependencies, waits on no lock and performs no automatic retry. This local error is not a broker REJECTED/AMBIGUOUS receipt; the outer operation may still commit. All three operations stage changes until successful completion; cancellation and advancement clone the committed order before changing it. Callback reads remain usable and see only committed orders/trades, never staged fills, cancellation or versions. Dependency failure discards staged changes and releases the guard; generated IDs remain consumed.

If scenario/dependency evaluation throws, the staged order/trades are discarded and both identity reservations are released. An explicit later submission can retry. Generated IDs already consumed are not rewound/reused; deterministic dependencies and the same call sequence still produce the same outcomes. By contrast, an explicit scenario REJECTED receipt is committed and remains rejected on replay. There is no automatic transition from a reservation or programming error to acceptance.

Paper supports client correlation, claim idempotency, cancellation, internal/broker order lookup, order listing and trade lookup. Modification and streaming are unsupported. All Kite capabilities, correlation, cancellation semantics and order/trade identifier namespaces are **NOT VERIFIED FROM BROKER CONTRACT**. This slice contains no Kite adapter. Application safety must continue to rely on durable claims and future reconciliation, never on assuming paper guarantees apply to Kite.

## Observation compatibility with Phase 2A

`lastObservationVersion = 0` means the Phase 2A order has applied no broker observation. Paper initializes the broker observation at 1; each subsequent materialized change increases it. Repeated queries retain the same version. Initial fills may advance the version before the submission receipt returns, so a latest snapshot can skip intermediate versions. No arithmetic offset or timestamp-based translation is required when passing the version to the domain reducer.

The explicit mapping is PENDING_ACK → SUBMITTED, OPEN → ACKNOWLEDGED, and PARTIALLY_FILLED/FILLED/CANCELLED → their matching domain statuses. Consume owned trade evidence through APPLY_FILL before a snapshot reports increased cumulative fills. Only APPLY_FILL changes executed quantity; a snapshot must agree with that quantity. PARTIALLY_FILLED and FILLED snapshots can only confirm an already fill-derived matching phase. Terminal status cannot regress an order.

The small Phase 2A reducer extension retains `lastObservation` (broker phase, cumulative units and evidence reference) separately from its fill-derived current phase and `lastObservationVersion`. Exact same-version replay is a no-op, even when later fills changed the current phase/quantity. Changing status, units or the evidence reference under that same version returns DUPLICATE_CONFLICT. Older versions return OBSERVATION_REGRESSION. A newer version must agree with already ingested fills; missing fills return EVIDENCE_REQUIRED. Thus a partial/full snapshot records observation ordering without counting execution twice.

This identity is pure reducer state, not a new Mongo model field. A future reader must restore the last snapshot evidence with its version; replay with a version but missing snapshot identity fails closed with EVIDENCE_REQUIRED. No persistence reader/writer, fill processor or runtime mapper is introduced here. Tests exercise the real reducer with working, partial and full paper observations.

These are **PAPER BROKER GUARANTEES**. Broker-side idempotency, correlation identity, native observation sequences, trade-ID semantics, cancellation behavior and query retention are **NOT VERIFIED FROM KITE BROKER CONTRACT**. Paper retains its accepted orders (including terminal orders) and trades for the instance lifetime without query-driven expiry; it has no restart durability. A future Kite adapter must verify its own semantics rather than inheriting these guarantees.

## Identifier normalization

Supported identifiers are canonicalized using the shared identifier schema at every public boundary. Leading/trailing whitespace is trimmed for submission IDs, account IDs, internal/broker order IDs and broker namespaces, including lookup, trade filters, cancellation and `advance`. Lists use the same canonical account scope. A padded claim/order pair is the same economic identity as its canonical pair. Contradictory internal/broker IDs and cross-account/mode/namespace references still fail closed after normalization; enum values such as executionMode remain strict enums.

## Isolation and evidence

LIVE, LEGACY_PAPER and other-account requests are rejected. Cross-account/mode lookups and cancellation fail before touching state; namespace mismatches also fail. Nothing reads credentials, accesses Mongo, invokes broker endpoints or imports application services. No legacy paper positions are consumed.

Evidence carries opaque references, timestamps and allowlisted diagnostic codes. Arbitrary response bodies, exception messages and authorization headers are not accepted or copied into paper diagnostics. `rawEvidenceRef` is a contract slot for an opaque reference to separately sanitized evidence, not a place to put raw credentials, headers or URLs. A future live adapter must implement its own safe evidence capture.

Tests run through `npm run test --workspace backend`; no broker or Mongo is needed for these simulator tests. The unchanged Phase 2A integration suite separately verifies the real Mongo foundation. Phase 2B2 is outside this slice.
