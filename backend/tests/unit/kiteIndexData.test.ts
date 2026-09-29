import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KiteIndexDataService, qualifyIndexMaster, assertQualifiedIndex,
  assertQualifiedRealIndexQuote, assertQualifiedRealIndexHistory, type QualifiedIndex } from "../../src/services/KiteIndexDataService";
import { assertQualifiedInstrument } from "../../src/services/KiteInstrumentMasterService";

const optionsCsv = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const rows = [
  "256265,1001,NIFTY 50,NIFTY 50,25000,,0,0,0,EQ,INDICES,NSE",
  "260105,1002,NIFTY BANK,NIFTY BANK,51000,,0,0,0,EQ,INDICES,NSE",
  "257801,1003,NIFTY FIN SERVICE,NIFTY FIN SERVICE,24000,,0,0,0,EQ,INDICES,NSE",
];
const csv = optionsCsv + rows.join("\n") + "\n";
const nowMs = Date.parse("2026-09-29T08:30:00Z");
const retrievedAt = "2026-09-29T04:00:00Z";
const success = (data: unknown) => ({ status: "success", data });

function setup() {
  let now = nowMs, currentCsv = csv, mode: "KITE_REAL" | "MOCK" = "KITE_REAL";
  const calls: string[] = [];
  let responder: (path: string) => unknown = () => success({});
  const service = new KiteIndexDataService({ async get(path) { calls.push(path); return responder(path); } },
    async () => qualifyIndexMaster(currentCsv, new Date(now).toISOString()), () => mode, () => now);
  return { service, calls, setNow: (value: number) => { now = value; }, setCsv: (value: string) => { currentCsv = value; },
    setMode: (value: typeof mode) => { mode = value; }, respond: (fn: typeof responder) => { responder = fn; } };
}

test("index master qualifies exactly three NSE indices with reference-only identity", () => {
  const master = qualifyIndexMaster(csv, retrievedAt);
  assert.deepEqual(master.indices.map(i => i.underlying).sort(), ["BANKNIFTY", "FINNIFTY", "NIFTY"]);
  for (const i of master.indices) {
    assertQualifiedIndex(i); assert.equal(i.role, "REFERENCE_ONLY"); assert.equal(i.exchange, "NSE");
    assert.equal(i.broker, "KITE"); assert.match(i.canonicalId, /^KITE:NSE:INDEX:/);
    assert.throws(() => assertQualifiedInstrument(i), /QUALIFIED_INSTRUMENT_REQUIRED/);
  }
  assert.throws(() => master.resolve("SENSEX" as "NIFTY"), /QUALIFIED_INSTRUMENT_REQUIRED/);
  assert.throws(() => assertQualifiedIndex({ ...master.resolve("NIFTY") }), /QUALIFIED_INSTRUMENT_REQUIRED/);
});
for (const [name, changed] of [
  ["wrong exchange", rows[0]!.replace(",NSE", ",NFO")],
  ["wrong segment", rows[0]!.replace(",INDICES,", ",NFO-OPT,")],
  ["wrong name", rows[0]!.replace("NIFTY 50,25000", "NIFTY,25000")],
  ["arbitrary token", rows[0]!.replace("256265", "0")],
  ["executable lot", rows[0]!.replace(",0,EQ,", ",1,EQ,")],
] as const) test(`index qualification fails closed on ${name}`, () => {
  assert.throws(() => qualifyIndexMaster(csv.replace(rows[0]!, changed), retrievedAt), /INVALID_RESPONSE/);
});
test("missing documented index stays unavailable without inventing a token", () => {
  const master = qualifyIndexMaster(csv.replace(rows[2]! + "\n", ""), retrievedAt);
  assert.throws(() => master.resolve("FINNIFTY"), /QUALIFIED_INSTRUMENT_REQUIRED/);
  assert.equal(master.resolve("NIFTY").instrumentToken, "256265");
});
test("index quote binds exact key, token, packet time and read-only provenance", async () => {
  const f = setup(), master = await f.service.refreshMaster(), index = master.resolve("NIFTY");
  f.respond(() => success({ [index.contractKey]: { instrument_token: 256265, last_price: 25000.25,
    timestamp: "2026-09-29 14:00:00" } }));
  const quote = await f.service.getQuote(index, 1000);
  assert.equal(quote.priceMinor, 2500025); assert.equal(quote.source, "KITE"); assert.equal(quote.dataMode, "KITE_REAL");
  assert.equal(quote.freshness.state, "FRESH"); assert.equal(quote.canonicalId, index.canonicalId);
  assert.equal(quote.brokerTimestamp, "2026-09-29T08:30:00.000Z");
  assert.equal(quote.masterFingerprint, master.provenance.sourceFingerprint);
  assert.deepEqual(f.calls, ["/quote"]); assertQualifiedRealIndexQuote(quote, index, 1000);
  for (const fake of [{ ...quote }, JSON.parse(JSON.stringify(quote)), { source: "MOCK" }])
    assert.throws(() => assertQualifiedRealIndexQuote(fake, index, 1000), /REAL_DATA_REQUIRED/);
  f.setNow(nowMs + 1001);
  assert.throws(() => assertQualifiedRealIndexQuote(quote, index, 1000), /STALE_MARKET_DATA/);
});
test("index quote missing packet time is unavailable, wrong key/token reject without fallback", async () => {
  const f = setup(), index = (await f.service.refreshMaster()).resolve("NIFTY");
  f.respond(() => success({ [index.contractKey]: { instrument_token: 256265, last_price: 25000 } }));
  const unavailable = await f.service.getQuote(index, 1000);
  assert.equal(unavailable.freshness.state, "UNAVAILABLE");
  assert.throws(() => assertQualifiedRealIndexQuote(unavailable, index, 1000), /STALE_MARKET_DATA/);
  f.respond(() => success({ other: { instrument_token: 256265, last_price: 25000 } }));
  await assert.rejects(f.service.getQuote(index, 1000), /QUOTE_UNAVAILABLE/);
  f.respond(() => success({ [index.contractKey]: { instrument_token: 999999, last_price: 25000 } }));
  await assert.rejects(f.service.getQuote(index, 1000), /INVALID_RESPONSE/);
});
test("index historical candles use qualified token and preserve range/provenance", async () => {
  const f = setup(), index = (await f.service.refreshMaster()).resolve("NIFTY");
  f.respond(() => success({ candles: [["2026-09-29T09:15:00+05:30", 24999, 25010, 24990, 25000, 123]] }));
  const history = await f.service.getHistoricalCandles({ index, interval: "5minute",
    from: "2026-09-29T03:45:00Z", to: "2026-09-29T08:30:00Z" });
  assert.equal(f.calls[0], "/instruments/historical/256265/5minute");
  assert.equal(history.candles[0]?.closeMinor, 2500000); assert.equal(history.candles[0]?.index, index);
  assert.equal(history.source, "KITE"); assert.equal(history.dataMode, "KITE_REAL");
  assertQualifiedRealIndexHistory(history, index);
  assert.throws(() => assertQualifiedRealIndexHistory({ ...history }, index), /REAL_DATA_REQUIRED/);
});
test("old index evidence and token reuse fail after master replacement", async () => {
  const f = setup(), old = (await f.service.refreshMaster()).resolve("NIFTY");
  f.respond(() => success({ [old.contractKey]: { instrument_token: 256265, last_price: 25000,
    timestamp: "2026-09-29 14:00:00" } }));
  const quote = await f.service.getQuote(old, 1000);
  f.setCsv(csv.replace(rows[0]!, rows[0]!.replace("NIFTY 50,NIFTY 50,25000", "NIFTY 50,NIFTY 50,25001")));
  const next = (await f.service.refreshMaster()).resolve("NIFTY");
  assert.equal(next.instrumentToken, old.instrumentToken); assert.notEqual(next, old);
  assert.throws(() => assertQualifiedRealIndexQuote(quote, old, 1000), /INSTRUMENT_MASTER_STALE/);
  await assert.rejects(f.service.getQuote(old, 1000), /INSTRUMENT_MASTER_STALE/);
});
test("MOCK mode and arbitrary index cannot reach network", async () => {
  const f = setup(), index = (await f.service.refreshMaster()).resolve("NIFTY");
  f.setMode("MOCK"); await assert.rejects(f.service.getQuote(index, 1000), /DATA_MODE_REQUIRED/);
  f.setMode("KITE_REAL"); await assert.rejects(f.service.getQuote({ ...index } as QualifiedIndex, 1000), /QUALIFIED_INSTRUMENT_REQUIRED/);
  assert.equal(f.calls.length, 0);
});
