# Kite read-only broker evidence — Phase 3A

`KiteReadOnlyAdapter` takes an injected `KiteReadSession`. It exposes `getOrders`,
`getTrades`, `getPositions`, `getFunds` and `getSnapshot`. It has no execution or
Mongo dependency and is not wired into a route, bootstrap, worker or SignalLoop.
No call in this slice creates reconciliation decisions or enables LIVE execution.

## Official contract checked 2026-09-26

Primary references: [orders and trades](https://kite.trade/docs/connect/v3/orders/),
[positions](https://kite.trade/docs/connect/v3/portfolio/),
[profile and funds](https://kite.trade/docs/connect/v3/user/),
[response format and IST timestamps](https://kite.trade/docs/connect/v3/response-structure/),
[instruments](https://kite.trade/docs/connect/v3/market-quotes/), and
[errors](https://kite.trade/docs/connect/v3/exceptions/).

Orders and trades are current-day books, not complete historical ledgers. Order
COMPLETE is a status report; only individual trade records describe executions.
The adapter never manufactures trades from cumulative order quantities.

## Authentication and ownership

`createKiteReadSession(expectedBrokerAccountId)` in the existing KiteService reuses
its Axios client, version header and supported token handling. It captures one
credential pair, checks `/user/profile.user_id`, and returns only allowlisted GET
access to `/orders`, `/trades`, `/portfolio/positions` and `/user/margins`. Recreate
the session after token refresh. Missing credentials fail; legacy synthetic market
data fallbacks and token-validity caches are not used. Tests inject fake transport
and headers. Errors exclude arbitrary bodies, messages, config and headers.

The account is the broker user ID, not an internal PAPER/LIVE account. Optional
`account_id` rows must match it. `placed_by` may identify a dealer and is not used
as account ownership. Production session provenance depends on that authenticated
profile binding; arbitrary caller-supplied rows are not a production data source.

## Orders and native identities

Native string `order_id`, nullable `exchange_order_id`, nullable `parent_order_id`,
instrument, side, product, order type, validity, variety, quantities and prices are
retained. OPEN maps to WORKING or PARTIALLY_FILLED; TRIGGER PENDING stays distinct;
COMPLETE/CANCELLED/REJECTED retain their meanings. Documented intermediate states
map to PENDING. Unrecognized statuses remain UNKNOWN with UNKNOWN_BROKER_STATUS
issues and the original status. No unknown status implies non-execution.

REST supplies no documented monotonic order observation version. `brokerStatusVersion`
is null, `statusSource` is REST_SNAPSHOT, and available exchange update timestamps
are preserved. No synthetic sequence can be used for ledger event ordering.

Reported pending and cancelled quantities are independent: documentation examples
can report both for the same cancelled remainder. Missing pending quantity becomes
requested minus filled with DERIVED_UNFILLED_NOT_EXECUTABLE provenance. Neither this
value nor status alone proves executable remainder or closure finality.

## Trades, decimals and timestamps

`trade_id` is exchange-generated. The official contract does not establish global,
per-account, per-order or cross-day uniqueness guarantees. Native IDs are retained
verbatim. The conservative `KITE_READ_V1` trade key is SHA-256 of the JSON tuple:
namespace, broker account, exchange, IST fill date, native order ID, native trade ID.
That date comes from `fill_timestamp`, never retrieval time. It is a local calendar
date, not a new exchange-session calendar. Economics and nullable exchange order ID
do not affect the key; conflicting economics remain discoverable under one identity.
Duplicate keys within a response fail the endpoint closed instead of merging rows.
This is an explicit conservative namespace, not a new broker uniqueness guarantee.

The trade examples use `quantity`; the attribute table calls it `filled`. This
implementation requires the demonstrated `quantity` field and rejects a response
containing only `filled`, pending broker clarification. It never guesses a quantity.

Full REST timestamps are explicitly IST (UTC+05:30), parsed without process-local
timezone dependence and with calendar validation. Raw timestamps are retained. The
official trades example has a time-only `order_timestamp`; that is preserved with
null absolute time, without borrowing the execution date. Missing/malformed full
execution timestamps fail closed because the trade namespace depends on the date.

Broker money/price fields use decimal text of the parsed JSON numbers; no financial
sum or rounding is performed. This does not claim preservation of original JSON
number lexemes beyond the existing Axios parser's precision. Kite documents
sub-paise trade prices and funds with floating tails. `priceMinor` is available only
when exact safe integer paise can be derived using BigInt; otherwise it is null.
No unsupported price is rounded into a Fill. Phase 3B must handle price precision.

Trade side, quantity, native order/trade identity and exact paise (where possible)
align with BrokerTradeObservation concepts. Internal order/intent/position/leg IDs
and executionMode cannot be inferred. `ledgerMapping: UNMAPPED` makes this a separate
read contract; it cannot be passed directly to the PAPER FillProcessor. Existing
Fill indexes and deterministic PaperBrokerAdapter contracts remain unchanged.

## Positions, funds and instruments

Position `net` and `day` arrays remain separate; day is trading activity, not a
second portfolio to sum with net. Signed quantities, overnight quantities, multiplier,
average price and supplied broker P&L fields are preserved. They are snapshots, never
Fill evidence or the internal ledger's realized P&L. Flat rows remain visible.

Funds retain equity/commodity segments, enabled, net, available and utilised broker
field names. They do not update reservations, risk counters or admission limits.

Every instrument retains exchange, tradingsymbol and instrument token. Available
segment, expiry, strike and instrument type are retained; absent metadata is null.
No expiry is inferred from legacy symbol builders. Official guidance recommends
exchange + tradingsymbol rather than token alone, since derivative tokens can be
reused after expiry. These endpoint identities suffice for this read boundary;
historical qualification/catalog resolution belongs to later reconciliation. No
instrument CSV downloader, quote feed or market-data pipeline is added.

## Availability and provenance

Each result and normalized row carries KITE source/broker, brokerAccountId,
fetchedAt, endpoint and normalizationVersion. Broker timestamps are preserved where
provided; funds/position endpoints do not supply a snapshot timestamp to invent.
Results are deeply immutable and contain only allowlisted normalized fields.

UNAVAILABLE has a typed error and **no data field**. A successful empty response is
AVAILABLE with empty data. Authentication, rate limit, transport/network, broker and
invalid-response failures remain distinct. Any malformed critical row invalidates
the endpoint; valid sibling endpoints remain usable. There is no retry/fallback.

Snapshot COMPLETE means all four reads succeeded, including any UNKNOWN-status
issues. PARTIAL and UNAVAILABLE retain per-endpoint results. Reads are independent,
not an atomic broker cut; start, finish and endpoint retrieval times expose that
limitation. Completeness implies neither freshness, finality, reconciliation success
nor LIVE readiness. Phase 3B owns comparison, freshness policy, mapping and any
audited ledger mutation; all remain unimplemented here.
