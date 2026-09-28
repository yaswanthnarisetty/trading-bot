# Phase 4A: exact Kite NFO instrument qualification

This service imports a master through an injected read-only provider and returns an
immutable, explicitly selected snapshot. No execution or strategy consumer is wired.
The repository previously had no InstrumentDefinition or durable market-data model.
Its existing generated option chain and symbol builder remain legacy-only consumers.

## Broker authority checked 2026-09-28

[Official instrument documentation](https://kite.trade/docs/connect/v3/market-quotes/#instruments)
specifies CSV columns `instrument_token`, `exchange_token`, `tradingsymbol`, `name`,
`last_price`, `expiry`, `strike`, `tick_size`, `lot_size`, `instrument_type`, `segment`,
and `exchange`. It describes a daily gzipped dump, suggests daily retrieval near 08:30,
warns that its price is not real-time, and recommends exchange plus trading symbol
instead of token-only storage because derivative tokens can be reused after expiry.

[Official historical documentation](https://kite.trade/docs/connect/v3/historical/#continuous-data)
states that the master lists live contracts; expired token mappings require previously
saved masters. Its continuous-history mechanism concerns NFO/MCX futures, not an
expired-option recovery guarantee. This service cannot discover unavailable expired
contracts or promise that historical option prices can be retrieved.

The main field reference describes `name` for equity and does not promise a universal
derivative-underlying ID. Our narrow product policy therefore requires exact NFO names
NIFTY, BANKNIFTY or FINNIFTY, consistent with existing `config/assets.ts`. It does not
infer the corresponding NSE spot symbol. In particular BANKNIFTY is not the NSE symbol
NIFTY BANK. Unknown/empty names never qualify via a symbol-prefix fallback.

## Qualification policy

Required exchange/segment/type are NFO / NFO-OPT / CE or PE. Only the three configured
index names above qualify. NSE cash/index records, stock options, other indices,
futures, currencies and commodities are ignored. This is an NSE index-option master,
not qualification of every instrument listed on NSE.

Expiry, strike and option type come exclusively from structured CSV columns. The narrow
`parseKiteNfoOptionSymbol` decoder is a consistency check on broker routing metadata,
not a source of replacement economic fields. It recognizes exact NIFTY, BANKNIFTY and
FINNIFTY prefixes, and only these modern Kite forms with positive integer strikes:

- Monthly: `<underlying><YY><MMM><strike><CE|PE>` (JAN through DEC).
- Weekly: `<underlying><YY><M><DD><strike><CE|PE>` (1–9, O, N, D).

These conventions are documented in the [Kite weekly/monthly format discussion](https://kite.trade/forum/discussion/5574/change-in-format-of-weekly-options-instruments)
and [Kite monthly expiry clarification](https://kite.trade/forum/discussion/16060/nifty-option-chain-trading-symbol-and-expiry-mismatch).
Two-digit years are supported only in 2000–2099; legacy, unknown and decimal-strike
symbol formats fail closed. Integer-valued CSV decimals such as `25000.0000` remain
valid, but `25000.5` cannot agree with a symbol encoding `25000`.

The decoded underlying, exact integer-paise strike, option type and year/month must
match the structured fields. Weekly day must also match exactly and be a valid date.
Monthly symbols omit the day, so matching month/year alone is insufficient.
`QualifiedMonthlyExpiry[]`, the service's third constructor argument, is trusted
bootstrap metadata containing exact underlying, full monthly expiry and source reference.
It must be independently verified against exchange contract notices/calendar (including
holiday adjustments), never copied from the CSV row being checked. For example,
[NSE contract specifications](https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications)
describe expiry and holiday adjustment rules; this service does not assume those rules
apply to all historical dates or supply an unverified holiday calendar.

The service copies this metadata at construction, rejects conflicting dates for the
same underlying/month, and requires coverage for every supported row's underlying/month.
Missing evidence fails closed (`monthlyExpiryMetadata`), including for weekly records:
a known monthly expiry cannot be accepted using weekly encoding. Monthly rows must
match the evidence's exact full date. No network calendar fetcher or default calendar
is added. Supplying independently verified calendar metadata is an explicit bootstrap
prerequisite before using this isolated service; a source-reference label alone is not
proof of authenticity. Tests supply clearly labeled offline calendar fixtures.

All date checks use ISO date text and UTC validation, independent of process timezone.
No expiry is generated or substituted. The original full structured expiry remains
canonical. Contradictory supported rows abort the entire import, never silently drop
from an otherwise qualified master. No replacement symbol or generated fallback exists.

Tick and strike decimals are parsed from wire text through BigInt paise, then checked
against the safe integer bound. Zero, negative, exponent, non-finite, whitespace and
non-zero sub-paise inputs reject. Trailing decimal zeroes are harmless. Lot units are
positive safe integers read from the CSV; hard-coded strategy lot sizes are never used.
Tokens remain positive integer strings (up to 30 digits), matching Phase 3 representation.
Future price/quantity checks can use `priceMinor % tickSizeMinor` and
`quantityUnits % lotSizeUnits`; this slice does not authorize an order.

## Identity and token reuse

`canonicalId` is version-1 economic identity:

```
KITE:NFO:NFO-OPT:<underlying>:<YYYY-MM-DD expiry>:<strike in paise>:<CE|PE>
```

It excludes mutable token/tick/lot assignments. `contractKey` separately preserves
the Phase 3 `exchange:tradingsymbol` broker identity. Both identities are retained;
they are not interchangeable with an instrument token. Each definition also contains
both tokens, original symbol/name, expiry/strike, type, lot, tick and provenance.

Within a snapshot, duplicate canonical identities must have identical normalized
metadata. Conflicting symbol, token, exchange token, tick or lot rejects the whole
import with AMBIGUOUS_INSTRUMENT. A contradictory or unsupported symbol fails earlier
with INVALID_INSTRUMENT_FIELD; it cannot bypass the duplicate guard. Exact duplicate rows collapse. A symbol or token
assigned to two economic identities in one snapshot also rejects. No first-row winner.

Across snapshots, token X can name expired A and later B. A and B retain different
canonical IDs, and A's immutable lookup remains bound to A. Consumers must retain
the definition's master version together with its economic identity when archiving
references. A new master cannot be used to reinterpret a historical token.

## Explicit snapshot API

```ts
// Bootstrap-only trusted transport; no HTTP route or caller-supplied JSON records.
const provider = createKiteInstrumentCsvProvider(kiteAxiosClient, getAuthHeader);
// Independently verified exchange calendar snapshot supplied by trusted bootstrap.
// Do not derive qualifiedMonthlyExpiries from this instrument CSV.
const master = await new KiteInstrumentMasterService(
  provider, () => new Date(), qualifiedMonthlyExpiries,
).load();
const contract = master.resolveOption({
  underlying: "NIFTY", expiry: "2026-09-29", strike: "25000", optionType: "CE",
});
assertQualifiedInstrument(contract);
```

`resolveOption`, `resolveExpiry`, `getInstrumentByCanonicalId`,
`getByExchangeTradingsymbol`, and `getByCurrentInstrumentToken` require exact matches.
Missing matches throw INSTRUMENT_NOT_FOUND. `listExpiries` and `listStrikes` return
sorted, frozen lists; strikes are canonical rupee decimal strings. The word Current
means this selected snapshot only, not an assertion about the current market day.
Private maps are closure-owned; records, arrays, provenance and API facade are frozen.

## Provenance, freshness and storage choice

Provenance records broker KITE, source INSTRUMENT_MASTER, endpoint, normalization
version, SHA-256 of the exact decoded CSV, masterVersion, retrieval instant and IST
retrieval date. Master version is `kite-master-v1:<sourceFingerprint>`. Identical CSV
imports have the same version/IDs and no duplicate definitions; retrieval metadata
records each observation. Different CSV bytes have different versions, including
row-order or informational-price differences. Canonical economic IDs remain stable.

The CSV has no source generation timestamp: `sourceTradingDate` is explicitly null.
Retrieval today does not prove that cached bytes were generated today. No intraday
freshness SLA, expiry eligibility policy or automatic "current" master selection is
invented. Future consumers must explicitly select/check the expected master version.
Qualification means validated contract metadata, not current tradability or a price.

No Mongo persistence is needed for this isolated normalization/query slice: it has
no runtime consumer or automatic publication, and no mutable cross-version token map.
The output has durable deterministic identity and serializable provenance, but this
service does **not** provide disk retention across process restarts. Keeping source
CSV plus provenance in a trusted archive is a deployment integration prerequisite for
historical lookup; it is not silently claimed here. Archived data must be revalidated
through a trusted provider, not deserialized as a qualified object. No execution index
requirements change. Adding automatic storage/publication or a current-pointer update
would introduce lifecycle policy outside this smallest Phase 4A slice.

## Provenance isolation and deferred work

The provider only issues GET /instruments with captured credentials, version 3 and
text response handling. The HTTP client is responsible for gzip decoding. It never
calls quote, history or order endpoints and has no legacy/mock fallback. Errors are
sanitized. Providers are trusted bootstrap dependencies; offline tests explicitly use
hand-authored fixtures, not authenticated broker truth. Hashing is integrity/versioning,
not cryptographic proof that arbitrary CSV came from Kite.

Only immutable definitions minted by this service pass `assertQualifiedInstrument`.
Serialized copies, legacy `generateOptionChain` results and `buildNFOOptionSymbol`
strings are not qualified records. Existing synthetic objects gain no KITE/QUALIFIED
label. The instruments CSV's `last_price` is discarded entirely; there is no quote,
execution price, signal price, risk price or mark-to-market output.

Deferred: durable archive integration, runtime current-master/freshness policies,
quotes, candles, WebSockets, Greeks, strategy/SignalLoop wiring, Kite writes, LIVE
execution, workers, Redis and Phase 4B.
