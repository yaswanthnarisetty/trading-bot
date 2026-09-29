# Phase 4B: read-only Kite market data and session flow

No trading consumer is wired. Execution remains PAPER/PaperBroker. Quotes and candles
are inputs for a later phase, not permission to submit an order. No financial Mongo
writes or market-data database/cache are introduced. HTTP first; no new timers/workers.

## Official semantics verified 2026-09-29

- [Kite authentication](https://kite.trade/docs/connect/v3/user/): login returns a
  short-lived request_token. POST /session/token exchanges it with SHA-256 of API key,
  request token and API secret. Credentials stay backend-only. The session expires at
  06:00 the following day and can be invalidated earlier. redirect_params round-trips
  a one-use login state. GET /user/profile verifies broker/account after exchange.
- [Quotes/instruments](https://kite.trade/docs/connect/v3/market-quotes/): full quotes
  accept 500 instruments; LTP/OHLC accept 1,000. Exact exchange:tradingsymbol keys map
  responses; unavailable keys are absent, not zero. Full quotes include exchange packet
  timestamp and last trade time. Quote OHLC.close is the previous trading day's close,
  so it must not be validated as though it were the current session's candle close.
- LTP/OHLC do not document timestamps. Missing timestamps remain null and freshness is
  UNAVAILABLE even after a successful HTTP fetch. FetchedAt never replaces exchange
  time. Full quote naive timestamps use explicit IST, matching the existing Phase 3
  REST interpretation and [Kite's Asia/Kolkata quote examples](https://kite.trade/forum/discussion/3841/quote-api-returns-old-data).
  The REST field table does not specify a timezone offset; this assumption is explicit.
  Unexpected formats reject. No host-local Date parsing or SDK date rewriting is used.
- [Historical documentation](https://kite.trade/docs/connect/v3/historical/): eight
  intervals minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, day. These
  match the existing backtest route; SignalLoop previously requested 5minute/day.
  Request times are explicit IST; response timestamps must carry an offset. Candles
  represent interval-open times, may include the still-forming current candle, and
  are not asserted to be final or suitable for strategy use. Consumers must check closure.
  continuous=0; oi=1. Continuous expired-contract data is documented for futures,
  not arbitrary expired options.
- [Current staff window guidance](https://kite.trade/forum/discussion/15886/number-of-years-of-historical-data):
  minute 30 days; 3/5/10minute 90; 15/30minute 180; 60minute 365; day 2,000.
  The main historical reference does not publish these window caps and older forum
  limits differ. We use conservative 29-day chunks for every interval, not a guessed
  maximum. Requests are bounded to 24 chunks (696 days), not unlimited downloads.
- [Error/rate documentation](https://kite.trade/docs/connect/v3/exceptions/): quote
  1 request/second, history 3/second, others 10/second. This process paces request
  starts for GETs at 1,000/350/100ms respectively. No automatic retries. Across multiple
  processes or other API clients these local limits are not an account-wide limiter.
  HTTP 401/403 or TokenException invalidate session; 429 is RATE_LIMITED; transport,
  broker and malformed-evidence failures remain distinct and sanitized.

## Session and Settings

Existing /api/kite endpoints and KiteService own the session. The transport has only
POST /session/token and allowlisted GETs. /api/kite/login requires existing app JWT
and mints one-use state (10-minute TTL). The browser navigates to Kite; registered
callback remains http://127.0.0.1:4000/kite/callback. The public callback validates
state/status/token, exchanges once, verifies profile against exchange user_id and
optional backend KITE_USER_ID, and pins the first verified account until restart.
Configure KITE_USER_ID to pin the intended account from the first login too.

The callback redirects only to http://localhost:3000/settings with a safe outcome/code;
no token/secret is returned, logged or written to .env. Callback replies use no-store
and no-referrer. Settings reloads status on mount/focus. Status revalidates the profile
when connected; key/token presence alone never means CONNECTED. A failed refresh
invalidates old connected state, including when an old token previously worked.
Sessions are in memory: restart requires login; KITE_ACCESS_TOKEN is not a source of
truth or automatic bootstrap credential. No username/password/OTP automation exists.
Deployment proxies must avoid logging callback query strings.

Manual /api/kite/refresh remains an authenticated development fallback. Settings
clears its request-token input before exchange. Normal use requires no copying.

MOCK is the default. Settings explicitly selects MOCK or KITE_REAL with
POST /api/kite/data-mode; MARKET_DATA_MODE=KITE_REAL can explicitly select it at boot.
Connecting never changes this choice. Mode changes are process-local. Settings shows
PAPER, PaperBroker, connection state and data mode separately. Historical stored LIVE
labels in old shared schemas are retained for compatibility, not emitted by this API.

Legacy KiteService strategy/backtest helpers cannot reach real Kite using hard-coded
tokens/generated symbols. They remain MOCK-only (legacy history requires a qualified
instrument and rejects). Selecting KITE_REAL fails these old helpers closed, rather
than silently creating synthetic data or wiring strategies. Existing backtest UI's
underlying-based real-data path is consequently unavailable until explicit future
integration. SignalLoop/PaperTrade/Greeks code is unchanged. Legacy monitoring-session start rejects
KITE_REAL before Mongo/loop work, and newly started MOCK sessions are labeled MOCK
regardless of configured credentials. No new automatic orders.

## Master dependency and identity

The approved Phase 4A calendar prerequisite remains: KITE_MONTHLY_EXPIRIES_FILE points
to a backend-only JSON array of QualifiedMonthlyExpiry records, each containing exact
underlying, expiry and sourceReference. Populate it from independently verified NSE
calendar/contract evidence, including holidays and every supported month in the dump.
Never derive that evidence from the CSV it is checking. Missing/malformed/conflicting
coverage prevents qualification; do not copy example dates into production blindly.

POST /api/kite/master/refresh explicitly fetches /instruments through the current
session and runs Phase 4A qualification. It invalidates an old active master before
refresh, including on failure. Concurrent refreshes share one operation. No automatic
archive/persistence is added. The active master must have been successfully retrieved
on today's IST date after 08:30 IST, with no future retrieval timestamp. Before that
cutoff, yesterday's mapping is not reused. This is a conservative application use
rule, not proof of dump generation time: the broker CSV lacks that timestamp.

Only the exact minted InstrumentDefinition object in the active snapshot may be used.
Canonical ID, exchange/symbol, token, economics, tick/lot and provenance are retained
on each result. Old objects reject even if a new snapshot reuses their token or has
identical CSV bytes. A response must match both requested exchange:symbol and token.
Current quotes/history reject expired options. No expired-option archive reader or
retained historical mapping resolution is implemented: unknown IDs/expired objects
fail HISTORICAL_INSTRUMENT_UNAVAILABLE. No reconstruction from today's token map.

## Normalization, freshness and historical merging

Normalized quotes/candles/result sets are deeply frozen, KITE/KITE_REAL, version 1.
Prices use checked decimal-to-BigInt-paise conversion, then safe integers. No rounding
or floating-point financial accumulation. For numeric JSON input, decimal text is of
the parsed number (as in Phase 3); original JSON number lexemes are not claimed.
Volume/OI/depth quantities are nonnegative safe integers. Missing optional values are
null. Quote close retains previous-close semantics. Historical candles enforce full
OHLC relationships and valid offset timestamps; impossible values reject unrepaired.

Freshness uses caller-supplied maxAgeMs, no strategy default. Both fetch age and exchange
packet age must be nonnegative and within the bound. Missing exchange time means
UNAVAILABLE; future timestamps or excessive age mean STALE. Last-trade timestamp is
preserved separately: a fresh packet does not assert that its last trade was recent.
There is no quote cache or cached fallback. Every failed fetch throws a typed error.
An earlier returned object's stored freshness is as-of evaluatedAt, never perpetual.
assertQualifiedRealMarketData rechecks its runtime minting proof, expected instrument,
current active master and age at consumption. Copies/JSON/MOCK/generated inputs reject.
Historical result sets are a distinct type and cannot masquerade as fresh quotes.

Historical chunks overlap at their exact boundary, are requested sequentially and
merged ascending. Equal duplicate timestamps collapse only for identical OHLCV/OI;
conflicts fail the whole operation. Out-of-request-range candles reject. Empty whole
results are HISTORICAL_DATA_UNAVAILABLE; empty individual chunks do not invent candles.
Every candle preserves its own fetch time, and the result includes requested/actual
range, interval, token, canonical instrument, master fingerprint/version and final
fetch time. No partial result is returned after any chunk failure.

## Manual smoke test — explicit invocation only

Automated tests inject all broker responses; no real Kite calls. The following is for
an operator to run manually after offline verification, never an automatic test script.

1. Configure backend KITE_API_KEY, KITE_API_SECRET and preferably KITE_USER_ID. Verify
   the registered callback above. Configure KITE_MONTHLY_EXPIRIES_FILE with independently
   checked Phase 4A metadata. Restart backend normally, keeping trading sessions stopped.
2. Sign into the application. Open Settings → OPEN KITE LOGIN, authenticate normally,
   return automatically to Settings. Confirm CONNECTED / PAPER / PaperBroker; then
   explicitly select KITE_REAL. Authentication alone must leave MOCK selected.
3. After 08:30 IST, invoke authenticated POST /api/kite/master/refresh. Confirm success
   and current retrievedLocalDate, masterVersion and fingerprint. If calendar evidence
   is incomplete, stop and correct the trusted evidence; do not bypass qualification.
4. GET /api/kite/instrument-search?symbol=NIFTY. Select one actual current, liquid option
   returned by this master, noting its full expiry/strike/type and canonicalId. Never
   enter a broker token manually. Use the application's existing JWT as usual, not a
   Kite access token, for all /api/kite requests below.
5. GET /api/kite/market-data/quote?canonicalId=<URL-encoded-ID>&kind=LTP&maxAgeMs=10000,
   then repeat with kind=QUOTE and kind=OHLC. Space requests at least one second apart.
   Verify lastPriceMinor (divide by 100 only for display), exact instrument identity,
   KITE/KITE_REAL, fetchedAt, master fingerprint and brokerTimestamp when supplied.
   Full quote should be FRESH only during active updates within this chosen 10s bound.
   LTP/OHLC normally report UNAVAILABLE freshness because they omit exchange time.
   Closed/illiquid market data can legitimately be STALE; never override the guard.
6. GET /api/kite/market-data/history?canonicalId=<ID>&interval=5minute&from=<offset-ISO>&to=<offset-ISO>
   for a small completed range today (e.g. 09:15–09:25 +05:30, once that time has passed).
   Verify ordered timestamps, exact prices/volume/OI, instrument, interval, requested
   and actual range, fetch times, KITE provenance and matching fingerprint.
7. Optional offline UI check: restart backend and confirm SESSION REQUIRED. Reconnect
   through the same login flow. No old env access token should claim CONNECTED.

All requests above are instrument/profile/market-data reads except the explicit session
token exchange. No order endpoint, monitoring-session start or execution action is part
of this procedure. Manual smoke test has not been executed by the agent.

Deferred: WebSockets, strategy/Greeks/signals, automatic PaperBroker execution, Kite
order writes/LIVE execution, SELL-entry enablement, expired-option archive resolution,
persistent market-data warehouse, distributed rate limiting, Redis and Phase 5.
