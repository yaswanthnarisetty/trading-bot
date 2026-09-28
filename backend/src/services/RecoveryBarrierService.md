# Phase 3C: host-bound durable startup recovery

Application/bootstrap construction creates one immutable `ExecutionHostContext` per
startup and explicitly passes it to every execution/recovery service. The factory defaults
to an opaque random UUID, not a timestamp or environment value. Explicit deterministic IDs
are for tests. Never reuse an ID from persisted state or accept one from a request payload.
Service constructors do not generate IDs. Recreated services in the same host reuse its
context; a restarted host creates a fresh context.

For enabled accounts, NEW ENTRY and initial ENTRY dispatch automatically fail closed when
the context is missing or differs from the durable recovery owner, even if `beginRecovery`
was omitted and Mongo still says READY. No asynchronous constructor or automatic startup
hook is needed to enforce this check. Explicit recovery restores readiness for the new
host; it remains the bootstrap's responsibility to run that sequence.

```ts
const host = createExecutionHostContext(); // Once in application/bootstrap construction.
const clock = () => new Date();
const recovery = new RecoveryBarrierService(connection, paperScope, clock, host);
const reconciliation = new ReconciliationService(connection, paperScope, clock, host);
const admission = new RiskAdmissionService(connection, paperScope, clock, host);
const orders = new OrderManager(connection, paperScope, paperBroker, clock, host);
await recovery.beginRecovery(accountId, startupCommandKey);
// Acquire all evidence outside Mongo transactions, after beginRecovery commits.
const snapshot = await kiteReadOnlyAdapter.getSnapshot();
const result = await reconciliation.reconcileAccount(accountId, snapshot);
if (result.report.classification === "MATCHED") {
  await recovery.completeRecovery(accountId, result.recordId);
}
```

## Durable authority

TradingAccount stores `recoveryState`: RECOVERY_REQUIRED or READY, a positive safe-integer
generation, startup ID, startup command, begin event and required-at time. READY also identifies its
completion record/event/time. Missing recovery state on an enabled account is blocking.
Factory-created contexts are frozen and validated; mutable/request-shaped lookalikes reject.
The transaction's session carries this construction-time identity to mandatory persistence
checks. That identity is not an in-memory readiness flag: the durable account, comparison
and audit proof remain necessary. There is no need for a separate RECOVERING state:
the barrier stays required while reads/comparison are in progress.

Recovery uses a separate generation because `executionEpoch` also fences already planned
CLOSE authorizations. Recovery does not change that epoch, admissionStatus, reservations,
positions, quantities or account risk. NEW ENTRY and initial READY-to-SUBMITTING ENTRY
claims require READY owned by the current host plus current-generation/current-host MATCHED
proof and its audit event. An
idempotent historical risk-admission receipt does not authorize a fresh broker claim.
CLOSE and evidence for possibly sent orders keep their existing financial invariants.

## Commands and proof

Begin commits state, account CAS/version and RECOVERY_REQUIRED event together. The event
is also the durable command receipt. Receipts are scoped to account, startup ID and command.
Replaying an old command within its current host returns the current state without advancing
it, even after later generations. A receipt from a host that no longer owns recovery cannot
reclaim it. Concurrent callers in one host using one key
commit one transition. A different command during RECOVERY_REQUIRED receives
RECOVERY_ALREADY_REQUIRED; it cannot reset the evidence floor. Once READY, a new host may
reuse the same command text and advances the generation exactly once. Event IDs use existing
globally unique indexes; no new indexes.

Reconciliation binds its immutable report and deterministic run identity to the current
recovery generation and startup ID. A different host cannot publish into that cycle.
Required snapshot acquisition must start strictly after the persisted
required-at time. Pre-startup evidence is recorded as INCOMPLETE, never relabelled as fresh.
Reconciliation itself does not clear recovery. Version-2 comparison semantics and PAPER
REFERENCE_ONLY ownership remain unchanged.

Completion requires the current account reconciliation record to be MATCHED, with matching
account/mode, broker account, configuration scope/kind/version, generation, current startup
ID and audit event. A pre-begin diagnostic MATCHED record cannot complete a later cycle.
It rejects regressing watermarks and re-reads exactly the comparison ledger to recompute
the config/ledger fingerprint. Both operations run inside the account-fenced transaction.
A Fill, link change or newer discrepancy that wins first invalidates stale completion.
Previous records remain append-only. Completion and RECOVERY_READY event commit together;
event/account failure rolls back the barrier, sequence and version. Repeated/concurrent
completion has one readiness event. A subsequent discrepancy still blocks ENTRY even if
the recovery state remains READY; recovery READY does not override current reconciliation.

The completed generation permits normal later PAPER ledger activity; its original ledger
fingerprint is a completion-time proof, not a demand to re-reconcile after each new ENTRY.
Admission continues to require a current matching reconciliation of that generation and host.

## Compatibility and exact restart guarantee

Opted-out accounts return OPTED_OUT without mutation and require only the original BASE
indexes. Reconciliation-enabled accounts require the seven reconciliation indexes as well.
Provision them before opt-in. Existing enabled accounts without recovery metadata fail
closed until explicit begin, fresh comparison and completion. Historical unbound READY
metadata and events remain readable but cannot authorize the current host; no migration is
performed. Missing/corrupted proof cannot be repaired by saving account metadata directly.

Tests use offline normalized Kite fixtures and real replica-set Mongo, including a second
Mongo connection and recreated service instances. The regression closes host A's connection,
constructs host B with a fresh identity without calling begin, and checks rejected admission
and zero PaperBroker submissions. B's own fresh recovery restores both operations. Same-host
service/connection recreation preserves readiness. This tests host lifecycle semantics across
client recreation, not an actual OS/process crash or automated startup wiring. Tests inject failures after
actual Mongo saves and synchronize competing transactions to exercise rollback/CAS.

No periodic reads, worker, scheduler, UNKNOWN resolution, Fill/Position/reservation repair,
external-order adoption, Kite writes, LIVE mode, Redis or Phase 4 market data is implemented.
