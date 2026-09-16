# Phase 2B2: isolated durable PAPER submission

`new OrderManager(connection, scope, paperAdapter).submit(orderId)` operates on one pre-existing authorized physical order. The manager is not wired into application bootstrap, an HTTP route, SignalLoop or PaperTrade. Only PAPER scope and PaperBrokerAdapter are accepted. Foundation/global execution readiness remains disabled.

## Preconditions and authorization

A separately provisioned PAPER account must explicitly have `admissionStatus: PAPER_READY`; DISABLED remains the default and PAPER_READY is invalid on other modes. The database must support snapshot transactions and have every required execution index. No authorization/admission service is supplied here.

An eligible order is READY/KNOWN/NONE with zero processed fills and no previous submission claim. It must have immutable `submissionAuthorization` containing reservationId, evidenceRef, product, reservedQuantityUnits, policyVersion, executionEpoch and expiresAt. The intent must be RISK_RESERVED or EXECUTING, with a current deadline; its same-chain reservation must retain holds and cover the instrument. Account, intent, reservation and authorization policy/epoch must agree. Chain relationships and financial evidence are verified by the mandatory write boundary.

This slice supports the existing BrokerOrder LIMIT/INR-paise fields only. `requestFingerprint` is the SHA-256 `submissionFingerprint()` of the canonical broker request excluding only the future claim ID. It binds persisted scope, order/intent/position/leg/instrument identity, side, quantity, limit price and product. No request economics are accepted by submit(). Existing records without this explicit authorization are not upgraded or automatically submitted.

## Transactions and the external boundary

The claim transaction re-reads the chain, saves immutable claim/request/fingerprint, moves READY to SUBMITTING, moves RISK_RESERVED intent to EXECUTING, allocates an account event sequence and appends SUBMISSION_CLAIMED. All writes use the mandatory boundary and document version CAS. The account fence serializes chain writes; event allocation reloads the account after those fences and increments nextEventSequence with versioned save. Event failure rolls back the entire transaction, including intent and sequence.

Only after withTransaction succeeds and its session ends does the manager invoke submitOrder once. Evidence queries also run outside transactions. Mongo may retry transaction callbacks, but those callbacks contain no adapter invocation. Losing claimants and all already-claimed orders return CURRENT without calling the broker. The immutable claim prevents a different worker/process from placing again.

A second transaction persists the normalized outcome and matching ORDER_SUBMITTED, ORDER_REJECTED or ORDER_OUTCOME_UNKNOWN event atomically. An uncertain claim commit sends nothing. An outcome persistence failure returns UNRESOLVED with the last confirmed claim state; it does not claim the returned snapshot is the latest database state. The durable possibly-sent order cannot be submitted again. A crash after claim commit, even before the broker call, deliberately leaves an unresolved SUBMITTING record. No timeout/retry/replacement/reconciliation worker is provided.

## Outcomes and deferred evidence

ACCEPTED unfilled OPEN records ACKNOWLEDGED; pending acknowledgement records SUBMITTED. Immediate partial/full evidence records SUBMITTED with RECONCILIATION_REQUIRED: financial filledUnits remains zero. REJECTED records the rejection and terminal physical phase without replacement or reservation release. AMBIGUOUS (including an adapter exception) stays SUBMITTING/UNKNOWN, retaining any discoverable order/trade evidence. Exception text and secrets are never copied into diagnostics.

`BrokerOrder.submissionOutcome` is a write-once, runtime-validated envelope containing the command receipt, available order observation, individual broker trades, evidenceComplete and pendingFillProcessing. The outcome audit event identifies this order/claim and receipt evidence. Reads that fail or return an incomplete trade set leave evidenceComplete false; available fill-bearing snapshots remain durable. The record is evidence, not a Fill ledger entry. No Position, reservation balance or P&L is changed. Observation versions are retained in the envelope; lastObservationVersion is not advanced until later observation consumption.

Phase 2B3 can read this envelope, verify owned broker trade identities, and ingest actual trades through its future idempotent FillProcessor and mandatory write boundary. It must then consume the retained snapshot through OrderStateMachine, restoring last snapshot identity together with its version. Missing trades require later broker evidence/reconciliation; aggregate filled quantity alone cannot manufacture Fill documents. This slice implements none of that processing and does not clear or overwrite retained evidence.
