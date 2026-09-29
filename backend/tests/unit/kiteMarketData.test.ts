import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KiteInstrumentMasterService, type InstrumentDefinition, type QualifiedMonthlyExpiry } from "../../src/services/KiteInstrumentMasterService";
import { KiteMarketDataService, assertQualifiedRealMarketData, type HistoricalInterval } from "../../src/services/KiteMarketDataService";
import { MarketDataError, marketTimestamp, priceMinor } from "../../src/domain/kiteMarketData";
import { generateOptionChain } from "../../src/services/MockDataService";
import { fetchLTP, fetchMarketData, fetchOptionChain, fetchOptionLTP, fetchHistoricalOHLCV, kiteSession } from "../../src/services/KiteService";
const csv = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const metadata: QualifiedMonthlyExpiry[] = [
  ...(["NIFTY", "BANKNIFTY", "FINNIFTY"] as const).map(underlying => ({ underlying, expiry: "2026-09-29", sourceReference: "offline-calendar" })),
  { underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "offline-calendar" },
];
const success = (data: unknown) => ({ status: "success", data });
const quote = (i: InstrumentDefinition) => ({ instrument_token: Number(i.instrumentToken), last_price: 123.45,
  ohlc: { open: 120, high: 130, low: 110, close: 105 }, timestamp: "2026-09-29 09:30:00", last_trade_time: "2026-09-29 09:29:59",
  volume: 20, oi: 30, depth: { buy: [{ price: 123.40, quantity: 65, orders: 1 }], sell: [{ price: 123.5, quantity: 130, orders: 2 }] } });
async function setup() {
  let now = Date.parse("2026-09-29T04:00:00Z"), mode: "MOCK" | "KITE_REAL" = "KITE_REAL", text = csv;
  const calls: { path: string; params?: URLSearchParams }[] = [];
  let responder: (path: string, params?: URLSearchParams) => unknown | Promise<unknown> = () => success({});
  const market = new KiteMarketDataService({ async get(path, params) { calls.push({ path, params }); return responder(path, params); } },
    () => new KiteInstrumentMasterService({ getInstrumentsCsv: async () => text }, () => new Date(now), metadata).load(), () => mode, () => now);
  const master = await market.refreshMaster(), i = master.resolveOption({ underlying: "NIFTY", expiry: "2026-09-29", strike: "25000", optionType: "CE" });
  responder = () => success({ [i.contractKey]: quote(i) });
  return { market, i, master, calls, respond: (fn: typeof responder) => { responder = fn; }, setNow: (value: number) => { now = value; },
    setText: (value: string) => { text = value; }, setMode: (value: typeof mode) => { mode = value; }, now: () => now };
}
for (const kind of ["LTP", "QUOTE", "OHLC"] as const) test(`real market normalizes ${kind} with immutable provenance`, async () => {
  const f = await setup();
  if (kind === "LTP") f.respond(() => success({ [f.i.contractKey]: { instrument_token: 100001, last_price: 123.45 } }));
  if (kind === "OHLC") f.respond(() => { const { timestamp, last_trade_time, ...raw } = quote(f.i); return success({ [f.i.contractKey]: raw }); });
  const result = await (kind === "LTP" ? f.market.getLtp(f.i, 1000) : kind === "OHLC" ? f.market.getOhlc(f.i, 1000) : f.market.getQuote(f.i, 1000));
  assert.equal(result.lastPriceMinor, 12345); assert.equal(result.instrument, f.i); assert.equal(result.source, "KITE"); assert.equal(result.dataMode, "KITE_REAL");
  assert.equal(result.masterFingerprint, f.master.provenance.sourceFingerprint); assert.equal(result.masterVersion, f.master.provenance.masterVersion);
  assert.equal(result.fetchedAt, "2026-09-29T04:00:00.000Z"); assert.equal(result.normalizationVersion, 1);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.instrument));
  assert.equal(result.freshness.state, kind === "QUOTE" ? "FRESH" : "UNAVAILABLE");
  if (kind === "QUOTE") {
    assert.equal(result.ohlc?.previousCloseMinor, 10500); // Yesterday's close may be outside today's range.
    assert.equal(result.depth?.buy[0].priceMinor, 12340); assert.ok(Object.isFrozen(result.depth?.buy));
    assertQualifiedRealMarketData(result, { instrument: f.i, maxAgeMs: 1000 });
  } else assert.throws(() => assertQualifiedRealMarketData(result, { instrument: f.i, maxAgeMs: 1000 }), /STALE_MARKET_DATA/);
});
test("real multi-quote maps by exact key independent of response order", async () => {
  const f = await setup(), other = f.master.resolveOption({ underlying: "NIFTY", expiry: "2026-09-29", strike: "25000", optionType: "PE" });
  f.respond(() => success({ [other.contractKey]: { ...quote(other), last_price: 90 }, [f.i.contractKey]: quote(f.i) }));
  const result = await f.market.getQuotes([f.i, other], 1000);
  assert.deepEqual(result.map(q => q.lastPriceMinor), [12345, 9000]);
  assert.deepEqual(f.calls[0].params?.getAll("i"), [f.i.contractKey, other.contractKey]);
});
test("real quote missing key is unavailable, never zero or array-order substitution", async () => {
  const f = await setup(); f.respond(() => success({ other: quote(f.i) }));
  await assert.rejects(f.market.getQuote(f.i, 1000), /QUOTE_UNAVAILABLE/);
});
for (const [label, changes] of Object.entries({ token: { instrument_token: 9 }, missingPrice: { last_price: undefined }, subPaise: { last_price: 1.001 },
  negative: { last_price: -1 }, infinite: { last_price: Infinity }, unsafe: { last_price: 9007199254740992 },
  volume: { volume: -1 }, oi: { oi: 1.5 }, timestamp: { timestamp: "2026-02-30 09:30:00" },
  ohlc: { ohlc: { open: 10, high: 1, low: 2, close: 3 } }, depth: { depth: { buy: [{ price: 1, quantity: 0.5, orders: 1 }], sell: [] } },
})) test(`real quote rejects malformed ${label}`, async () => {
  const f = await setup(); f.respond(() => success({ [f.i.contractKey]: { ...quote(f.i), ...changes } }));
  await assert.rejects(f.market.getQuote(f.i, 1000), /INVALID_RESPONSE/);
});
test("paise conversion is exact without rounding", () => {
  for (const [input, expected] of [[0.05, 5], [123.45, 12345], [0, 0], ["1.2300", 123]] as const) assert.equal(priceMinor(input), expected);
  for (const input of [0.1 + 0.2, NaN, Infinity, -1, "1e2", "1.0001", "9007199254740992"]) assert.throws(() => priceMinor(input), /INVALID_RESPONSE/);
});
for (const [error, code] of [[{ response: { status: 403 } }, "AUTHENTICATION_FAILED"], [{ response: { status: 429 } }, "RATE_LIMITED"],
  [{ code: "ETIMEDOUT" }, "NETWORK_ERROR"], [{ response: { status: 503 } }, "BROKER_ERROR"], [new MarketDataError("SESSION_REQUIRED"), "SESSION_REQUIRED"]] as const)
  test(`real market preserves ${code} without mock fallback`, async () => { const f = await setup(); f.respond(() => { throw error; }); await assert.rejects(f.market.getQuote(f.i, 1000), new RegExp(code)); });
for (const raw of [{}, { status: "success", data: [] }, { status: "error", error_type: "TokenException" }])
  test(`real market rejects invalid envelope ${JSON.stringify(raw)}`, async () => { const f = await setup(); f.respond(() => raw); await assert.rejects(f.market.getQuote(f.i, 1000), /INVALID_RESPONSE|AUTHENTICATION_FAILED/); });
test("freshness is re-evaluated at consumption, including failed refresh and future timestamps", async () => {
  const f = await setup(), q = await f.market.getQuote(f.i, 1000);
  f.setNow(f.now() + 1001); f.respond(() => { throw new MarketDataError("NETWORK_ERROR"); });
  await assert.rejects(f.market.getQuote(f.i, 1000), /NETWORK_ERROR/);
  assert.throws(() => assertQualifiedRealMarketData(q, { instrument: f.i, maxAgeMs: 1000 }), /STALE_MARKET_DATA/);
  f.respond(() => success({ [f.i.contractKey]: { ...quote(f.i), timestamp: "2026-09-29 10:30:00" } }));
  assert.equal((await f.market.getQuote(f.i, 1000)).freshness.state, "STALE");
});
test("real guard rejects mock, serialized and mismatched-instrument objects", async () => {
  const f = await setup(), q = await f.market.getQuote(f.i, 1000);
  for (const value of [{ source: "MOCK" }, { ...q }, JSON.parse(JSON.stringify(q))])
    assert.throws(() => assertQualifiedRealMarketData(value, { instrument: f.i, maxAgeMs: 1000 }), /REAL_DATA_REQUIRED/);
  assert.throws(() => assertQualifiedRealMarketData(q, { instrument: f.master.instruments[0], maxAgeMs: 1000 }), /REAL_DATA_REQUIRED/);
});
test("real APIs reject synthetic/generated and caller-supplied token objects before transport", async () => {
  const f = await setup();
  for (const i of [{ ...f.i }, { instrumentToken: "100001" }, generateOptionChain("NIFTY", 25000).strikes[0]])
    await assert.rejects(f.market.getLtp(i as InstrumentDefinition, 1000), /QUALIFIED_INSTRUMENT_REQUIRED/);
  assert.equal(f.calls.length, 0);
});
test("real master becomes stale on local date rollover and cannot accept old snapshot tokens", async () => {
  const f = await setup(), q = await f.market.getQuote(f.i, 1000);
  f.setText(csv.replace("100001,390", "200001,390")); await f.market.refreshMaster();
  await assert.rejects(f.market.getLtp(f.i, 1000), /INSTRUMENT_MASTER_STALE/);
  assert.throws(() => assertQualifiedRealMarketData(q, { instrument: f.i, maxAgeMs: 1000 }), /INSTRUMENT_MASTER_STALE/);
  f.setNow(Date.parse("2026-09-30T04:00:00Z")); assert.throws(() => f.market.activeMaster(), /INSTRUMENT_MASTER_STALE/);
});
test("real master fails before daily cutoff and after failed refresh", async () => {
  const f = await setup(); f.setNow(Date.parse("2026-09-29T02:00:00Z"));
  await assert.rejects(f.market.refreshMaster(), /INSTRUMENT_MASTER_STALE/);
  f.setNow(Date.parse("2026-09-29T04:00:00Z")); f.setText("bad"); await assert.rejects(f.market.refreshMaster());
  assert.throws(() => f.market.activeMaster(), /INSTRUMENT_MASTER_STALE/);
});
test("explicit MOCK cannot invoke real APIs or auto-switch after authentication", async () => {
  const f = await setup(); f.setMode("MOCK"); await assert.rejects(f.market.getQuote(f.i, 1000), /DATA_MODE_REQUIRED/); assert.equal(f.calls.length, 0);
});
test("real quote batch rejects duplicate IDs and official-size overflow before transport", async () => {
  const f = await setup(); for (const rows of [[], [f.i, f.i], Array(501).fill(f.i)]) await assert.rejects(f.market.getQuotes(rows, 1000), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
});
const candle = (time = "2026-09-29T09:15:00+0530") => [time, 120, 130, 110, 125, 65, 100];
const range = { from: "2026-09-29T03:45:00Z", to: "2026-09-29T04:00:00Z", interval: "5minute" as const };
test("real historical candles preserve exact prices, timestamps, ranges and provenance", async () => {
  const f = await setup(); f.respond(() => success({ candles: [candle()] }));
  const result = await f.market.getHistoricalCandles({ ...range, instrument: f.i });
  assert.equal(result.candles[0].timestamp, "2026-09-29T03:45:00.000Z"); assert.equal(result.candles[0].closeMinor, 12500);
  assert.equal(result.candles[0].instrument, f.i); assert.equal(result.candles[0].oi, 100);
  assert.equal(result.masterFingerprint, f.i.provenance.sourceFingerprint); assert.equal(result.actualRange.from, result.candles[0].timestamp);
  assert.equal(f.calls[0].params?.get("continuous"), "0"); assert.equal(f.calls[0].params?.get("oi"), "1"); assert.ok(Object.isFrozen(result.candles));
});
for (const [label, index, value] of [["timestamp", 0, "2026-09-29"], ["negative", 1, -1], ["nonfinite", 1, Infinity], ["subpaise", 1, 0.001],
  ["highBelowLow", 2, 109], ["openAboveHigh", 1, 131], ["closeBelowLow", 4, 109], ["volume", 5, -1], ["oi", 6, 0.5]] as const)
  test(`historical rejects invalid ${label}`, async () => { const f = await setup(), row = candle(); row[index] = value;
    f.respond(() => success({ candles: [row] })); await assert.rejects(f.market.getHistoricalCandles({ ...range, instrument: f.i }), /INVALID_RESPONSE/); });
test("historical empty data is unavailable and unknown intervals/ranges reject", async () => {
  const f = await setup(); f.respond(() => success({ candles: [] }));
  await assert.rejects(f.market.getHistoricalCandles({ ...range, instrument: f.i }), /HISTORICAL_DATA_UNAVAILABLE/);
  for (const override of [{ interval: "2minute" as HistoricalInterval }, { from: range.to, to: range.from }, { to: "2099-01-01T00:00:00Z" }, { from: "2020-01-01T00:00:00Z" }])
    await assert.rejects(f.market.getHistoricalCandles({ ...range, ...override, instrument: f.i }), /INVALID_REQUEST/);
});
test("historical chunks are bounded, ordered and dedupe exact boundary candles", async () => {
  const f = await setup();
  f.respond((_path, params) => success({ candles: [candle(marketTimestamp(params!.get("to"), true)), candle(marketTimestamp(params!.get("from"), true))] }));
  const r = await f.market.getHistoricalCandles({ instrument: f.i, interval: "day", from: "2026-08-01T04:00:00Z", to: "2026-09-29T04:00:00Z" });
  assert.equal(f.calls.length, 3); assert.equal(r.candles.length, 4); assert.deepEqual(r.candles.map(c => c.timestamp), [...r.candles.map(c => c.timestamp)].sort());
});
test("historical conflicting chunk boundary rejects the whole result", async () => {
  const f = await setup(); let calls = 0;
  f.respond((_path, params) => { const rows = [candle(marketTimestamp(params!.get("from"), true)), candle(marketTimestamp(params!.get("to"), true))];
    if (++calls === 2) rows[0][4] = 124; return success({ candles: rows }); });
  await assert.rejects(f.market.getHistoricalCandles({ instrument: f.i, interval: "day", from: "2026-08-30T04:00:00Z", to: "2026-09-29T04:00:00Z" }), /INVALID_RESPONSE/);
});
test("historical expired option mapping fails explicitly, never guesses a token", async () => {
  const f = await setup(); f.setNow(Date.parse("2026-09-30T04:00:00Z")); await f.market.refreshMaster();
  const old = f.market.activeMaster().getByCurrentInstrumentToken("100001");
  await assert.rejects(f.market.getHistoricalCandles({ ...range, instrument: old }), /HISTORICAL_INSTRUMENT_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
});
test("legacy helpers cannot use generated contracts or fall back to mock in KITE_REAL", async () => {
  kiteSession.setMode("KITE_REAL");
  try { for (const fn of [() => fetchLTP("NIFTY"), () => fetchMarketData("NIFTY"), () => fetchOptionChain("NIFTY"), () => fetchOptionLTP("NFO:generated")])
    await assert.rejects(fn(), /LEGACY_MARKET_DATA_DISABLED/);
    await assert.rejects(fetchHistoricalOHLCV("NIFTY", range), /QUALIFIED_INSTRUMENT_REQUIRED/);
  } finally { kiteSession.setMode("MOCK"); }
  assert.equal((await fetchMarketData("NIFTY")).dataMode, "MOCK");
});
test("reused token in new snapshot cannot identify the old economic contract", async () => {
  const f = await setup();
  f.setText(csv.replace("NIFTY26SEP25000CE,NIFTY,123.45,2026-09-29", "NIFTY26O1325000CE,NIFTY,123.45,2026-10-13"));
  const current = await f.market.refreshMaster(), next = current.getByCurrentInstrumentToken("100001");
  assert.notEqual(next.canonicalId, f.i.canonicalId); assert.equal(next.instrumentToken, f.i.instrumentToken);
  await assert.rejects(f.market.getQuote(f.i, 1000), /INSTRUMENT_MASTER_STALE/);
  f.respond(() => success({ [next.contractKey]: quote(next) }));
  assert.equal((await f.market.getQuote(next, 1000)).instrument, next);
});
test("master replacement while quote is in flight rejects the old response", async () => {
  const f = await setup(); let release!: (value: unknown) => void;
  f.respond(() => new Promise(resolve => { release = resolve; }));
  const pending = f.market.getQuote(f.i, 1000); await f.market.refreshMaster();
  release(success({ [f.i.contractKey]: quote(f.i) })); await assert.rejects(pending, /INSTRUMENT_MASTER_STALE/);
});
