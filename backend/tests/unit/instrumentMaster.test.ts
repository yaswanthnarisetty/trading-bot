import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AxiosInstance } from "axios";
import { KiteInstrumentMasterService, assertQualifiedInstrument, type QualifiedMonthlyExpiry } from "../../src/services/KiteInstrumentMasterService";
import { createKiteInstrumentCsvProvider } from "../../src/brokers/KiteInstrumentCsvProvider";
import { KiteReadOnlyAdapter } from "../../src/brokers/KiteReadOnlyAdapter";
import { generateOptionChain } from "../../src/services/MockDataService";
import { kiteOrder, kiteSuccess } from "../kiteReadFixtures";
import { parseKiteNfoOptionSymbol } from "../../src/domain/kiteNfoOptionSymbol";

const csv = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const lines = csv.trimEnd().split("\n"), header = lines[0].split(",");
const clock = () => new Date("2026-09-28T04:00:00.000Z");
// Offline independently supplied calendar fixtures, not inferred from the imported CSV.
const monthlyExpiries: readonly QualifiedMonthlyExpiry[] = [
  ...(["NIFTY", "BANKNIFTY", "FINNIFTY"] as const).map(underlying => ({ underlying, expiry: "2026-09-29", sourceReference: "test-calendar:2026-09" })),
  { underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "test-calendar:2026-10" },
  { underlying: "NIFTY", expiry: "2025-09-30", sourceReference: "test-calendar:2025-09" },
];
const load = (text = csv) => new KiteInstrumentMasterService({ getInstrumentsCsv: async () => text }, clock, monthlyExpiries).load();
const query = { underlying: "NIFTY" as const, expiry: "2026-09-29", strike: "25000", optionType: "CE" as const };
function row(changes: Record<string, string | undefined> = {}) {
  return lines[1].split(",").map((value, i) => changes[header[i]] ?? value).join(",");
}
const single = (changes: Record<string, string | undefined>) => `${lines[0]}\n${row(changes)}\n`;

for (const [label, changes] of Object.entries({
  "reproduced 24000 symbol versus structured 25000": { tradingsymbol: "NIFTY26SEP24000CE" },
  "CE versus PE": { tradingsymbol: "NIFTY26SEP25000PE" },
  "BANKNIFTY versus NIFTY": { name: "BANKNIFTY" },
  "FINNIFTY versus NIFTY": { name: "FINNIFTY" },
  "unknown prefix": { tradingsymbol: "XNIFTY26SEP25000CE" },
  "ambiguous prefix": { tradingsymbol: "BANKNIFTYNIFTY26SEP25000CE" },
  "nonsense": { tradingsymbol: "NIFTY1CE" },
  "decimal structured strike versus integer symbol": { strike: "25000.5" },
  "unsupported decimal symbol": { strike: "25000.5", tradingsymbol: "NIFTY26SEP25000.5CE" },
  "different month": { tradingsymbol: "NIFTY26OCT25000CE" },
  "different year": { tradingsymbol: "NIFTY25SEP25000CE" },
  "arbitrary day in matching monthly month": { expiry: "2026-09-22" },
  "weekly day mismatch": { expiry: "2026-10-06", tradingsymbol: "NIFTY26O0725000CE" },
  "invalid weekly calendar day": { tradingsymbol: "NIFTY2693125000CE" },
  "invalid weekly month code": { tradingsymbol: "NIFTY26X0625000CE" },
  "monthly expiry encoded as weekly": { tradingsymbol: "NIFTY2692925000CE" },
  "century alias": { expiry: "2126-09-29" },
})) test(`master symbol consistency rejects ${label}`, async () => {
  await assert.rejects(load(single(changes)), /INVALID_INSTRUMENT_FIELD/);
});
test("master matching monthly contract qualifies with independently supplied exact expiry", async () => {
  const i = (await load(single({}))).resolveOption(query);
  assert.equal(i.tradingsymbol, "NIFTY26SEP25000CE");
  assert.equal(i.canonicalId, "KITE:NFO:NFO-OPT:NIFTY:2026-09-29:2500000:CE");
});
test("Kite parser distinguishes all exact supported underlyings", () => {
  for (const underlying of ["NIFTY", "BANKNIFTY", "FINNIFTY"]) {
    const parsed = parseKiteNfoOptionSymbol(`${underlying}26SEP25000PE`);
    assert.equal(parsed?.underlying, underlying); assert.equal(parsed?.optionType, "PE");
    assert.equal(parsed?.strikeMinor, 2500000n); assert.equal(parsed?.expiryEncodingKind, "MONTHLY");
  }
});
test("Kite weekly parser validates all month codes and complete calendar dates", () => {
  for (const [index, code] of [..."123456789OND"].entries()) {
    const parsed = parseKiteNfoOptionSymbol(`NIFTY26${code}0625000CE`);
    assert.equal(parsed?.yearMonth, `2026-${String(index + 1).padStart(2, "0")}`);
    assert.equal(parsed?.expiryDay, "06"); assert.equal(parsed?.expiryEncodingKind, "WEEKLY");
  }
  assert.equal(parseKiteNfoOptionSymbol("NIFTY2422925000CE")?.expiryDay, "29");
  for (const symbol of ["NIFTY2622925000CE", "NIFTY2600625000CE", "NIFTY26O0025000CE", "NIFTY26O625000CE",
    "NIFTY26O0625000CE\n", "NIFTY26SEP025000CE", "NIFTY26SEP0CE", "NIFTY26sep25000CE"])
    assert.equal(parseKiteNfoOptionSymbol(symbol), null, symbol);
});
test("master weekly contracts preserve distinct full dates and economic IDs in the same month", async () => {
  const a = (await load(single({ expiry: "2026-10-06", tradingsymbol: "NIFTY26O0625000CE" }))).instruments[0];
  const b = (await load(single({ expiry: "2026-10-13", tradingsymbol: "NIFTY26O1325000CE" }))).instruments[0];
  assert.notEqual(a.canonicalId, b.canonicalId);
  assert.match(a.canonicalId, /:2026-10-06:/); assert.match(b.canonicalId, /:2026-10-13:/);
});
test("master fails closed without independent monthly metadata, including weekly ambiguity", async () => {
  for (const text of [single({}), single({ expiry: "2026-10-06", tradingsymbol: "NIFTY26O0625000CE" })])
    await assert.rejects(new KiteInstrumentMasterService({ getInstrumentsCsv: async () => text }, clock).load(), /monthlyExpiryMetadata/);
  await assert.rejects(new KiteInstrumentMasterService({ getInstrumentsCsv: async () => single({}) }, clock,
    [{ underlying: "BANKNIFTY", expiry: "2026-09-29", sourceReference: "test-calendar" }]).load(), /monthlyExpiryMetadata/);
});
test("master uses exact holiday-adjusted calendar evidence, not a fixed expiry weekday", async () => {
  const metadata: QualifiedMonthlyExpiry[] = [{ underlying: "NIFTY", expiry: "2026-03-30", sourceReference: "test-calendar:March31-holiday" }];
  const provider = (expiry: string) => ({ getInstrumentsCsv: async () => single({ expiry, tradingsymbol: "NIFTY26MAR25000CE" }) });
  const service = new KiteInstrumentMasterService(provider("2026-03-30"), clock, metadata);
  metadata[0] = { ...metadata[0], expiry: "2026-03-31" }; // Service captured the evidence at construction.
  assert.equal((await service.load()).instruments[0].expiry, "2026-03-30");
  await assert.rejects(new KiteInstrumentMasterService(provider("2026-03-31"), clock,
    [{ ...metadata[0], expiry: "2026-03-30" }]).load(), /INVALID_INSTRUMENT_FIELD/);
});
test("master rejects missing, malformed or conflicting monthly evidence", () => {
  const provider = { getInstrumentsCsv: async () => csv };
  for (const value of [{ expiry: "2026-02-30", sourceReference: "test" }, { expiry: "2026-09-29", sourceReference: " " }])
    assert.throws(() => new KiteInstrumentMasterService(provider, clock, [{ underlying: "NIFTY", ...value }]), /INVALID_INSTRUMENT_FIELD/);
  assert.throws(() => new KiteInstrumentMasterService(provider, clock, [...monthlyExpiries,
    { underlying: "NIFTY", expiry: "2026-09-22", sourceReference: "conflicting-calendar" }]), /monthlyExpiryMetadata/);
});
test("master contradictory supported row aborts entire import in either row order", async () => {
  const bad = row({ tradingsymbol: "NIFTY26SEP24000CE", instrument_token: "888888" });
  for (const text of [`${csv}${bad}\n`, `${lines[0]}\n${bad}\n${lines.slice(1).join("\n")}\n`])
    await assert.rejects(load(text), /INVALID_INSTRUMENT_FIELD/);
  assertQualifiedInstrument((await load()).resolveOption(query));
});

for (const type of ["CE", "PE"] as const) test(`master qualifies exact NFO ${type} with Phase 3 identity`, async () => {
  const master = await load(), instrument = master.resolveOption({ ...query, optionType: type });
  assertQualifiedInstrument(instrument);
  assert.equal(instrument.instrumentType, type); assert.equal(instrument.exchange, "NFO"); assert.equal(instrument.segment, "NFO-OPT");
  assert.equal(instrument.contractKey, `NFO:${instrument.tradingsymbol}`);
  assert.equal(instrument.instrumentToken, type === "CE" ? "100001" : "100002");
  assert.equal(instrument.exchangeToken, type === "CE" ? "390" : "391");
  assert.equal(instrument.lotSizeUnits, 65); assert.equal(instrument.tickSizeMinor, 5); assert.equal(instrument.strikeMinor, 2500000);
});
test("master exposes only configured index options and sorted exact expiries/strikes", async () => {
  const m = await load(); assert.equal(m.instruments.length, 6);
  assert.deepEqual(m.listExpiries("NIFTY"), ["2026-09-29", "2026-10-06"]);
  assert.deepEqual(m.listStrikes("NIFTY", "2026-09-29", "CE"), ["25000", "25050"]);
  assert.deepEqual(m.listStrikes("NIFTY", "2026-09-29", "PE"), ["25000"]);
  assert.equal(m.resolveExpiry("NIFTY", "2026-10-06"), "2026-10-06");
  assert.equal(m.resolveOption({ ...query, expiry: "2026-10-06" }).instrumentToken, "100004");
  assert.equal(m.resolveOption({ ...query, strike: "25050" }).instrumentToken, "100003");
  assert.equal(m.resolveOption({ underlying: "BANKNIFTY", expiry: query.expiry, strike: "51000", optionType: "CE" }).lotSizeUnits, 30);
  assert.equal(m.resolveOption({ underlying: "FINNIFTY", expiry: query.expiry, strike: "24000", optionType: "PE" }).lotSizeUnits, 60);
});
test("master missing strike/expiry/identity never substitutes or generates a contract", async () => {
  const m = await load();
  for (const q of [{ ...query, strike: "25100" }, { ...query, expiry: "2026-10-13" }]) assert.throws(() => m.resolveOption(q), /INSTRUMENT_NOT_FOUND/);
  assert.throws(() => m.resolveExpiry("NIFTY", "2026-10-13"), /INSTRUMENT_NOT_FOUND/);
  assert.throws(() => m.getInstrumentByCanonicalId("missing"), /INSTRUMENT_NOT_FOUND/);
  assert.throws(() => m.getByCurrentInstrumentToken("999999"), /INSTRUMENT_NOT_FOUND/);
  assert.throws(() => m.getByExchangeTradingsymbol("NSE", "NIFTY2692925000CE"), /INSTRUMENT_NOT_FOUND/);
  assert.throws(() => m.resolveOption({ ...query, underlying: "MIDCPNIFTY" as any }), /UNSUPPORTED_UNDERLYING/);
});
for (const changes of [{ instrument_token: "200001" }, { lot_size: "75" }, { tick_size: "0.10" }, { tradingsymbol: "NIFTY2692925000CE" }, { exchange_token: "999" }])
test(`master conflicting economic duplicate rejects: ${Object.keys(changes)[0]}`, async () => {
  // The alternate weekly spelling now fails consistency before the unchanged duplicate guard.
  await assert.rejects(load(`${csv}${row(changes)}\n`), changes.tradingsymbol ? /INVALID_INSTRUMENT_FIELD/ : /AMBIGUOUS_INSTRUMENT/);
});
test("master symbol or token collision within one snapshot rejects", async () => {
  await assert.rejects(load(`${csv}${row({ strike: "26000" })}\n`), /INVALID_INSTRUMENT_FIELD/);
  await assert.rejects(load(`${csv}${row({ strike: "26000", tradingsymbol: "NIFTY26SEP26000CE" })}\n`), /AMBIGUOUS_INSTRUMENT/);
});
test("master duplicate import and identical rows are idempotent", async () => {
  const service = new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv }, clock, monthlyExpiries);
  assert.deepEqual(await service.load().then(m => m.instruments), await service.load().then(m => m.instruments));
  const m = await load(`${csv}${lines[1]}\n`); assert.equal(m.instruments.length, 6);
  assert.equal(m.resolveOption(query).canonicalId, (await load()).resolveOption(query).canonicalId);
});
test("master token reuse preserves historical contract and snapshot-scoped token binding", async () => {
  const a = await load(single({ expiry: "2025-09-30", tradingsymbol: "NIFTY25SEP25000CE" }));
  const b = await load(single({ expiry: "2026-10-27", tradingsymbol: "NIFTY26OCT25000CE" }));
  const old = a.getByCurrentInstrumentToken("100001"), next = b.getByCurrentInstrumentToken("100001");
  assert.notEqual(old.canonicalId, next.canonicalId); assert.notEqual(old.contractKey, next.contractKey);
  assert.notEqual(a.provenance.masterVersion, b.provenance.masterVersion);
  assert.equal(a.getInstrumentByCanonicalId(old.canonicalId), old);
  assert.throws(() => b.getInstrumentByCanonicalId(old.canonicalId), /INSTRUMENT_NOT_FOUND/);
  assert.equal(a.getByCurrentInstrumentToken("100001"), old);
});
test("master token changes do not change economic canonical identity", async () => {
  const a = await load(), b = await load(single({ instrument_token: "999999" }));
  assert.equal(a.resolveOption(query).canonicalId, b.resolveOption(query).canonicalId);
  assert.notEqual(a.resolveOption(query).instrumentToken, b.resolveOption(query).instrumentToken);
});
test("master preserves integer token text beyond JavaScript safe-integer range", async () => {
  const token = "9007199254740993123", m = await load(single({ instrument_token: token, exchange_token: token }));
  assert.equal(m.getByCurrentInstrumentToken(token).instrumentToken, token);
  assert.equal(m.resolveOption(query).exchangeToken, token);
});
test("master identifiers match actual Phase 3 normalized order identities", async () => {
  const i = (await load()).resolveOption(query);
  const adapter = new KiteReadOnlyAdapter({ brokerAccountId: "AB1234", get: async path => {
    assert.equal(path, "/orders"); return kiteSuccess([kiteOrder({ exchange: i.exchange, tradingsymbol: i.tradingsymbol,
      instrument_token: i.instrumentToken, expiry: i.expiry, strike: Number(i.strike), instrument_type: i.instrumentType, segment: i.segment })]);
  } }, clock);
  const result = await adapter.getOrders(); assert.equal(result.availability, "AVAILABLE");
  if (result.availability !== "AVAILABLE") assert.fail("normalization failed");
  const actual = result.data[0].instrument;
  for (const key of ["exchange", "tradingsymbol", "instrumentToken", "contractKey", "expiry", "strike", "instrumentType", "segment"] as const)
    assert.equal(actual[key], i[key]);
});
test("master decimal normalization is exact without binary arithmetic", async () => {
  const m = await load(single({ strike: "25000.0000", tick_size: "0.05000", lot_size: "17" }));
  const i = m.resolveOption({ ...query, strike: "25000.00" });
  assert.equal(i.strike, "25000"); assert.equal(i.strikeMinor, 2500000); assert.equal(i.tickSizeMinor, 5); assert.equal(i.lotSizeUnits, 17);
  assert.equal(105 % i.tickSizeMinor, 0); assert.equal(34 % i.lotSizeUnits, 0);
});
for (const [field, values] of Object.entries({
  tick_size: ["0.001", "0", "-0.05", "NaN", "Infinity", "5e-2"],
  strike: ["0", "-1", "NaN", "Infinity", "25000.001", "9007199254740992", " 25000"],
  lot_size: ["0", "-1", "1.5", "Infinity", "9007199254740992"],
  instrument_token: ["0", "-1", "1.1", "NaN", "1e5", "01"], exchange_token: ["0", "-1", "1.1"],
  expiry: ["2026-02-30", "2026-13-01", "2026-9-29", "not-a-date"],
  tradingsymbol: ["BANKNIFTY26SEP25000CE", "NIFTY26SEP25000PE", "NIFTYsomethingCE", "NIFTY26SEP25000CE "],
})) test(`master rejects invalid ${field} values`, async () => {
  for (const value of values) await assert.rejects(load(single({ [field]: value })), /INVALID_INSTRUMENT_FIELD/);
});
for (const changes of [{ exchange: "BFO" }, { segment: "NFO-FUT" }, { instrument_type: "FUT" }, { instrument_type: "EQ" }, { name: "MIDCPNIFTY" }, { name: "" }])
test(`master unsupported record ignored before economics: ${JSON.stringify(changes)}`, async () => {
  const m = await load(`${csv}${row({ ...changes, tick_size: "bad", instrument_token: "bad" })}\n`);
  assert.equal(m.instruments.length, 6);
});
test("master CSV supports reordered columns, BOM, quoted commas/newlines and escaped quotes", async () => {
  const reversed = lines.slice(0, 7).map(l => l.split(",").reverse().map(v => `"${v}"`).join(",")).join("\r\n");
  assert.equal((await load(`\uFEFF${reversed}\r\n`)).instruments.length, 6);
  const unsupported = '408065,1594,INFY,"A, company\nwith ""quotes""",0,,,0.05,1,EQ,NSE,NSE';
  assert.equal((await load(`${lines.slice(0, 7).join("\n")}\n${unsupported}`)).instruments.length, 6);
});
test("master malformed CSV/headers fail before publishing partial qualification", async () => {
  for (const value of ["", csv + '"unterminated', csv + "short,row\n", csv.replace("instrument_token,", "name,"),
    csv.replace("tick_size,", "missing,"), csv + '"closed"extra\n', csv + 'bad"quote\n', csv + 'x\r', csv + '\n'])
    await assert.rejects(load(value), /INVALID_INSTRUMENT_CSV/);
  await assert.rejects(load(lines[0] + "\n"), /EMPTY_INSTRUMENT_MASTER/);
});
test("master provenance exposes retrieval date but does not invent dump trading date", async () => {
  const m = await load(); assert.equal(m.provenance.sourceFingerprint, createHash("sha256").update(csv).digest("hex"));
  assert.equal(m.provenance.source, "INSTRUMENT_MASTER"); assert.equal(m.provenance.broker, "KITE");
  assert.equal(m.provenance.normalizationVersion, 1); assert.equal(m.provenance.retrievedAt, clock().toISOString());
  assert.equal(m.provenance.retrievedLocalDate, "2026-09-28"); assert.equal(m.provenance.sourceTradingDate, null);
  assert.equal(m.resolveOption(query).provenance, m.provenance);
  const later = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv }, () => new Date("2026-09-28T20:00:00Z"), monthlyExpiries).load();
  assert.equal(later.provenance.masterVersion, m.provenance.masterVersion); assert.equal(later.provenance.retrievedLocalDate, "2026-09-29");
});
test("master records, lists, provenance and facade are immutable; serialized lookalikes reject", async () => {
  const m = await load(), i = m.resolveOption(query);
  for (const object of [m, m.instruments, i, m.provenance, m.listExpiries("NIFTY"), m.listStrikes("NIFTY", query.expiry, "CE")]) assert.ok(Object.isFrozen(object));
  assert.throws(() => { (i as any).instrumentToken = "999"; }, TypeError);
  assert.throws(() => { (m.provenance as any).masterVersion = "forged"; }, TypeError);
  assert.throws(() => assertQualifiedInstrument(JSON.parse(JSON.stringify(i))), /QUALIFIED_INSTRUMENT_REQUIRED/);
});
test("master last_price never becomes quote, risk or execution price authority", async () => {
  const a = (await load(single({ last_price: "99999999.123456" }))).resolveOption(query);
  const b = (await load(single({ last_price: "NaN" }))).resolveOption(query);
  for (const key of ["last_price", "lastPrice", "ltp", "price", "limitPriceMinor"]) assert.equal(key in a, false);
  const { provenance: ap, ...av } = a, { provenance: bp, ...bv } = b;
  assert.deepEqual(av, bv); assert.notEqual(ap.sourceFingerprint, bp.sourceFingerprint);
});
test("master never accepts legacy generated options as qualified instruments", () => {
  const chain = generateOptionChain("NIFTY", 25000);
  assert.throws(() => assertQualifiedInstrument(chain), /QUALIFIED_INSTRUMENT_REQUIRED/);
  assert.throws(() => assertQualifiedInstrument(chain.strikes[0]), /QUALIFIED_INSTRUMENT_REQUIRED/);
});
test("master provider exposes only the instrument CSV GET and captures authentication", async () => {
  const seen: any[] = []; let token = "token key:first";
  const client = { get: async (...args: unknown[]) => { seen.push(args); return { data: csv }; } } as unknown as Pick<AxiosInstance, "get">;
  const provider = createKiteInstrumentCsvProvider(client, () => ({ Authorization: token })); token = "token key:second";
  assert.equal((await new KiteInstrumentMasterService(provider, clock, monthlyExpiries).load()).instruments.length, 6);
  assert.equal(seen.length, 1); assert.equal(seen[0][0], "/instruments");
  assert.equal(seen[0][1].headers.Authorization, "token key:first"); assert.equal(seen[0][1].headers["X-Kite-Version"], "3");
  assert.equal(seen[0][1].responseType, "text"); assert.equal(seen[0][1].transformResponse[0](csv), csv);
});
test("master provider fails closed without credentials or text and sanitizes transport errors", async () => {
  const fake = (get: unknown) => ({ get }) as Pick<AxiosInstance, "get">;
  assert.throws(() => createKiteInstrumentCsvProvider(fake(async () => ({ data: csv })), () => ({})), /AUTHENTICATION_FAILED/);
  await assert.rejects(createKiteInstrumentCsvProvider(fake(async () => ({ data: {} })), () => ({ Authorization: "token key:value" })).getInstrumentsCsv(), /INVALID_RESPONSE/);
  await assert.rejects(createKiteInstrumentCsvProvider(fake(async () => { throw { response: { status: 403 }, message: "secret" }; }), () => ({ Authorization: "token key:value" })).getInstrumentsCsv(), error => {
    assert.equal((error as Error).message, "AUTHENTICATION_FAILED"); assert.equal(JSON.stringify(error).includes("secret"), false); return true;
  });
});
