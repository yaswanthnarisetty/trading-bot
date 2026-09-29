# Phase 5D historical research replay

## Migration audit

REUSE: the POST /api/backtest/run entry point, date/asset/capital inputs, chronological trade bookkeeping, realized equity curve and metric names. Max positions, daily limits, stops, targets, holding bars and adverse slippage remain simulation policy.

REPLACE: the old service's host-local getHours/getDay clock, weekday-based guessed expiry, hardcoded Greeks, generated strikes, constant 0.3 underlying-to-option P&L sensitivity, forced minimum one lot, capital-scaled leverage, and duplicate RSI/ATR/opening/volume/SR/breakout gates. Phase 5B now alone selects and validates a spread. Legacy SR strike-adjustment counters are retained as zero for response compatibility. No SR or weak-momentum filter absent from Phase 5B is added here. Validated Phase 5A indicators are reused without recomputation in the simulator; unsupported historical support/resistance overlays remain absent.

DEFER: LLM replay, durable research storage, production Paper/Live execution, production exits and monitoring, and Phase 6 migration. SignalLoop and its legacy helpers are untouched.

## Historical provider and identity

There is NO complete historical option-price/master archive in this repository. The previous route fetched underlying bars only and invented option economics. The default route now returns 503 HISTORICAL_OPTION_ARCHIVE_NOT_CONFIGURED. A real Kite request is neither required nor attempted. No current master/quote fallback, generated expired token, or synthetic real-price approximation is used.

A trusted bootstrap can inject a HistoricalReplayProvider into createBacktestRouter or runHistoricalBacktest. The HTTP body cannot choose paths, URLs, broker tokens or credentials. The provider supplies at most 5,000 ordered candles and 100,000 option observations, at most 64 observations at a timestamp, and one explicitly archived master snapshot. Its original acquisition time must precede the historical candles; qualified NSE index and NFO option records must share that archive's fingerprint. Every quote must match the exact canonical identity, token and fingerprint, with explicit historical price and availability times. Duplicate timestamps/contracts reject, including equal duplicates. Current and archived token identities cannot be interchanged.

The trusted provider also supplies HISTORICAL_COVERAGE_V1 independently of the returned candles: coveredFrom/coveredTo, an ordered schedule of expected candle starts, and whether the archived qualified option universe is complete. The schedule explicitly omits documented non-trading periods, including holidays and exchange absences; it is a provider assertion, not a weekday-derived holiday guess. An observed candle outside that schedule rejects. Missing scheduled candles, insufficient horizon bounds or missing required option observations leave the result INCOMPLETE with structured counters. A missing hedge quote is distinguished from a genuinely absent qualified hedge by the complete archived master. Required Greeks with unusable inputs are incomplete; the approved sub-hour expiry model guard remains a deterministic strategy HOLD when its inputs are present. Neither gap handling nor later prices synthesize a fill. Holding bars count positions in the declared schedule, so a missing scheduled candle cannot compress holding duration.

KITE_ARCHIVE is a trusted-provider provenance assertion, not verification that an arbitrary CSV is a real historical broker archive. The provider must authenticate its archive and original timestamp independently; there is no production archive implementation/configuration in this phase. One master per run deliberately limits multi-snapshot/token-reuse histories. Missing identity or prices stays unavailable. The included fixture is synthetic research data, clearly FIXTURE_ONLY, not proof of real historical contracts/prices.

Replay results use HISTORICAL_REPLAY. The existing analytics/evaluator research path stays MOCK and executionAuthority NONE; historical quotes never obtain current KITE_REAL issuance. Index identity is reference-only. Neither passing through the importer nor originating at Kite grants current broker-data authority.

## Replay time and no look-ahead

Candle timestamps are interval starts with explicit offsets. A decision occurs at start + interval, using only the prefix ending at that completed candle. Historical option observations must be timestamped exactly at that evaluation time and already available then; there is no forward filling. The default EMA_ALIGNMENT_V1 proposal source receives only evaluatedAt and the approved indicator's EMA alignment. Confidence 0.8 is a fixed research score, not calibrated probability. Expiry comes from contracts/prices known at that replay instant, not a weekday guess. Greeks use the shared IV solver, historical spot and option prices, recorded expiry, 15:30 IST expiry-time convention and explicit versioned risk-free-rate assumption.

Warm-up requires 50 completed candles and may precede the requested entry period. No bars are generated on missing days. Candles outside weekday NSE session 09:15–15:30 reject; supplied historical candles are the activity evidence (a production archive must supply its exchange-calendar quality controls). The shared opening block remains authoritative. Entry cutoff and EOD are explicit IST minutes. Daily bars are intentionally unsupported because their close-time semantics differ from intraday bars. Dates must be explicit and the requested range is capped at 90 calendar days. Subsecond/minute misaligned session timestamps reject.

The configurable replay horizon determines terminal liquidation and entry suppression; no decision examines a future candle or trade outcome. Run timestamp is metadata only and excluded from run identity. Dataset/config/version fingerprints, per-entry analytics digest, exact legs, integer units and fill prices are retained.

## Research execution and accounting

Entry sells the short at historical bid minus slippage and buys the hedge at ask plus slippage. Exit buys the short at ask plus slippage and sells the hedge at bid minus slippage. Default slippage is 150 paise (1.5 points) per leg per side: four adjustments per round trip. Historical displayed depth caps whole lots; lot size is applied once. Nonpositive entry credit, impossible debit outside [0, spread width], or missing/depth-insufficient exit evidence cannot produce a fill.

Money and risk accumulation use bigint paise. The simulator sizes by configured percentage of realized equity and remaining capital after reserving worst-case spread loss plus round-trip slippage. No minimum one lot or leverage escalation. Results cannot spend negative capital. This is research capacity, never Phase 2C admission.

CONTEMPORANEOUS_QUOTE_CLOSE_ONLY_V1 is an observed-quote model, not an intrabar OHLC fill model. Underlying high/low cannot supply option fills or claim an intrabar target. If a bar's extremes would touch both stop and target, neither ordering is inferred: only the actual end observation is eligible, and stop evaluation precedes target. This may miss intrabar exits; it does not select a favorable extreme. Directional stop, if enabled, uses completed close versus entry spot/ATR. Time, configured EOD, and replay-horizon exits use only then-available quotes. Missing exit observations mark the run INCOMPLETE; no earlier timestamp or fill is fabricated. A later observed close is recorded at its actual later time, with overdue EOD priority. Unresolved prior-session positions block further entries.

One logical candidate per IST day and one open position per direction are simulation duplicate constraints; maximum positions/daily entries are separate from strategy desirability. No same-bar re-entry after an exit. Only completed trades enter P&L. Open/missing observations are exposed, never silently settled. Final capital, realized drawdown and equity curve are realized-only; unrealized intratrade drawdown is not claimed.

Legacy netPnL means after modeled slippage, EXCLUDING brokerage, taxes and other unimplemented charges. grossPnL is before slippage. Values exposed to the legacy UI are rupees; pnlMinor and fill-price audit fields are paise. Credit is rupees per contract unit. Profit factor is null when there is no losing denominator, rather than Infinity or a fabricated ratio.

## Offline verification

TS_NODE_PROJECT=backend/tsconfig.test.json node -r ts-node/register backend/scripts/backtest_blocks.ts

The script loads only a fixture, runs the shared Phase 5B pipeline, and checks chronology, date range, P&L reconciliation and final equity. Unit tests block HTTP/fetch and exercise the same fixture in four host timezones. Financial Mongo integration tests remain the independent approved suite; replay has no dependency on financial models, execution services, broker writes or OpenAI.
