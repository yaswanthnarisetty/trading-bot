# Phase 2A verification and write boundary

The new ledger is disconnected from SignalLoopService and PaperTradeService. Execution readiness is always false. There is no Kite submitter, live worker, or broker reconciliation.

## Supported financial writes

Use validated Mongoose document `save({ session })` / `create()` with an active transaction from the same connection. Save middleware requires the execution indexes, repeats document validation even when `validateBeforeSave:false` was supplied, verifies every referenced ledger record in that transaction, and compares aggregate quantities/evidence IDs with the actual Fill collection. `insertMany`, bulk writes, query updates, replacements and deletes are rejected.

Each non-account save also updates the account's explicit version using CAS. This serializes competing chain writes and prevents snapshot write skew across different aggregates. It may cause loaded account documents to become stale; reload them before a subsequent versioned save. Keep all related writes inside the same transaction and propagate any failure so the transaction aborts. Broker calls must never enter these transactions.

Native driver/`Model.collection` writes can bypass Mongoose. They are not a supported financial write API. Production database credentials and administrative tooling must restrict these escape hatches; this foundation does not claim database-server validation or access control has been deployed.

Fill evidence carries account, mode, position, intent, internal order, leg and fill identity. Reducers use qualified order identities; persistence resolves the actual referenced records. `executionEvidenceRefs` are Fill IDs, not arbitrary descriptions. Closure references are nonblank finality references, supplemented by actual fill totals and a query rejecting unresolved orders. Never-opened entries use ABORTED, not CLOSED. Native broker identifier namespace semantics remain **Not verified from broker contract**.

Money is safe integer INR paise; quantities are safe integer contract units. Version fields and cumulative quantities are explicit. Atomic audit event allocation/coupling, full fill-processing orchestration, risk admission and recovery services remain deferred.

## Index administration

Normal application startup does not provision execution indexes. These commands do not load the application's `.env`:

```sh
npm run execution:indexes --workspace backend -- list
EXECUTION_MONGO_URI='<explicit database URI>' npm run execution:indexes --workspace backend -- verify
EXECUTION_MONGO_URI='<explicit database URI>' npm run execution:indexes --workspace backend -- provision
```

Provision only an intentionally selected database. Provisioning creates declared indexes and never drops/replaces conflicting indexes. Verification checks compound key order, uniqueness, partial filters, sparse settings, TTL and collation. Missing/conflicting indexes block supported financial saves. Runtime readiness reports connection, snapshot transaction capability and index verification separately; read-only probing does not claim write/commit behavior and never enables execution.

## Verification

```sh
npm run typecheck --workspace backend
npm run typecheck:tests --workspace backend
npm run test --workspace backend
npm run test:integration --workspace backend
npm run test:build --workspace backend
npm run build --workspace shared
git diff --check
```

Integration defaults to a temporary local `mongod` replica set bound to 127.0.0.1. It selects an unused port, creates a uniquely named `phase2a_test_*` database, runs actual Mongo tests, and removes that database and temporary server afterward. It needs `mongod` on PATH and permission to bind a local socket. Missing tests, a missing binary, or an unavailable transaction-capable primary fail the command; none are reported as a passing test run.

Alternatively set `EXECUTION_TEST_MONGO_URI` to a **dedicated replica-set/sharded test deployment**. The runner creates and drops its own uniquely named database there. Never use an application/production database URI. The runner never uses `MONGODB_URI`, never imports application bootstrap, and sends no broker requests. Integration validates only that selected test deployment, not production topology.

## Build and crypto safety

`npm start --workspace backend` runs a clean successful backend build before loading `dist/index.js`. The build removes stale artifacts first and removes partial output on failure. The build configuration includes Node ambient types explicitly and retains strict checking; the unchanged source-typecheck configuration can still report the two pre-existing unrelated D3 `ImageData` errors.

`test:build` rebuilds and calls the compiled rejection boundaries without launching the application. Delta order placement always throws. Direct crypto start, monitoring, signal execution, open, close and force-close functions also reject. Internal timer shutdown remains available. The router permits only known GET history/positions/signals/P&L/status/price reads; start, stop-with-close, manual close, unknown routes, and the legacy GET that restarts the engine are blocked.

Shared `dist` files are tracked by the existing repository and are the shared package's runtime/type entry points, so legitimate generated execution and compatibility changes remain tracked. No frontend build is needed for this correction pass.
