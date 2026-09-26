import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AxiosError, type AxiosInstance } from "axios";
import { KiteReadOnlyAdapter, kiteReadPaths, type KiteReadPath, type BrokerReadResult, type KiteReadSession,
  BrokerReadError, classifyKiteReadError } from "../../src/brokers/KiteReadOnlyAdapter";
import { createKiteReadSession } from "../../src/services/KiteService";
import { kiteOrder, kiteTrade, kitePosition, kiteFunds, kiteSuccess } from "../kiteReadFixtures";

const now = "2026-09-25T04:01:00.000Z", clock = () => new Date(now);
function fake(changes: Partial<Record<KiteReadPath, unknown>> = {}, brokerAccountId = "AB1234") {
  const calls: string[] = [];
  const replies = { "/orders": kiteSuccess([kiteOrder()]), "/trades": kiteSuccess([kiteTrade()]),
    "/portfolio/positions": kiteSuccess({ net: [kitePosition()], day: [kitePosition()] }), "/user/margins": kiteSuccess(kiteFunds()), ...changes };
  const session: KiteReadSession = { brokerAccountId, async get(path) {
    calls.push(path); const result = replies[path];
    if (typeof result === "function") return result();
    return structuredClone(result);
  } };
  return { adapter: new KiteReadOnlyAdapter(session, clock), calls, session };
}
function available<T>(result: BrokerReadResult<T>) {
  assert.equal(result.availability, "AVAILABLE");
  return result.data;
}
function unavailable<T>(result: BrokerReadResult<T>, code = "INVALID_RESPONSE") {
  assert.equal(result.availability, "UNAVAILABLE");
  if (result.availability !== "UNAVAILABLE") assert.fail("Expected failure");
  assert.equal(result.error.code, code); assert.equal("data" in result, false);
}
async function order(changes: Record<string, unknown> = {}) {
  return available(await fake({ "/orders": kiteSuccess([kiteOrder(changes)]) }).adapter.getOrders())[0];
}
test("Kite open order preserves native identity, units, instrument and read provenance", async () => {
  const row = await order();
  assert.equal(row.state, "WORKING"); assert.equal(row.brokerOrderId, "250101000001"); assert.equal(row.exchangeOrderId, "EX1001");
  assert.equal(row.instrument.instrumentToken, "123456"); assert.equal(row.instrument.contractKey, "NFO:NIFTY26OCT25000CE");
  assert.equal(row.limitPrice, "100.05"); assert.equal(row.requestedUnits, 10); assert.equal(row.pendingUnits, 10);
  assert.equal(row.brokerAccountId, "AB1234"); assert.equal(row.broker, "KITE"); assert.equal(row.source, "KITE");
  assert.equal(row.fetchedAt, now); assert.equal(row.normalizationVersion, 1); assert.equal(row.brokerStatusVersion, null);
  assert.equal(row.orderTimestamp.iso, "2026-09-25T03:45:01.000Z");
});
test("Kite partial OPEN order retains cumulative quantities without producing trades", async () => {
  const row = await order({ filled_quantity: 4, pending_quantity: 6, average_price: 90.125 });
  assert.equal(row.state, "PARTIALLY_FILLED"); assert.equal(row.filledUnits, 4); assert.equal(row.averageFillPrice, "90.125");
});
test("Kite COMPLETE and a successful empty trade endpoint never fabricate a Fill", async () => {
  const result = await fake({ "/orders": kiteSuccess([kiteOrder({ status: "COMPLETE", filled_quantity: 10, pending_quantity: 0 })]),
    "/trades": kiteSuccess([]) }).adapter.getSnapshot();
  assert.equal(available(result.orders)[0].state, "COMPLETE"); assert.deepEqual(available(result.trades), []);
  assert.equal(result.completeness, "COMPLETE"); assert.equal(result.consistency, "INDEPENDENT_ENDPOINT_READS");
});
for (const status of ["CANCELLED", "REJECTED", "TRIGGER PENDING", "CANCEL PENDING"]) test(`Kite preserves ${status} distinctly`, async () => {
  const row = await order({ status }); assert.equal(row.rawStatus, status);
  assert.equal(row.state, ({ "TRIGGER PENDING": "TRIGGER_PENDING", "CANCEL PENDING": "PENDING" } as Record<string, string>)[status] ?? status);
});
test("Kite unknown future status is available unknown evidence with an explicit issue", async () => {
  const result = await fake({ "/orders": kiteSuccess([kiteOrder({ status: "FUTURE EXCHANGE STATE" })]) }).adapter.getOrders();
  assert.equal(available(result)[0].state, "UNKNOWN");
  if (result.availability === "AVAILABLE") assert.deepEqual(result.issues, [{ code: "UNKNOWN_BROKER_STATUS", brokerOrderId: "250101000001", rawStatus: "FUTURE EXCHANGE STATE" }]);
});
test("Kite cancelled pending quantity is retained independently of cancelled quantity", async () => {
  const row = await order({ status: "CANCELLED", cancelled_quantity: 10, pending_quantity: 10 });
  assert.equal(row.pendingUnits, 10); assert.equal(row.cancelledUnits, 10);
});
test("Kite missing pending quantity derives unfilled quantity without promising executability", async () => {
  const row = await order({ pending_quantity: undefined, filled_quantity: 4 });
  assert.equal(row.pendingUnits, 6); assert.equal(row.pendingQuantitySource, "DERIVED_UNFILLED_NOT_EXECUTABLE");
});
test("Kite missing exchange ID and timestamps remain null while parent order is retained", async () => {
  const row = await order({ exchange_order_id: undefined, parent_order_id: "parent-1", exchange_timestamp: null, exchange_update_timestamp: null });
  assert.equal(row.exchangeOrderId, null); assert.equal(row.parentOrderId, "parent-1"); assert.equal(row.exchangeTimestamp, null);
});
test("Kite native trade identity and exact price survive normalization without ledger IDs", async () => {
  const row = available(await fake().adapter.getTrades())[0];
  assert.equal(row.nativeTradeId, "000123"); assert.equal(row.quantityUnits, 4); assert.equal(row.priceMinor, 9005);
  assert.equal(row.executedAt, "2026-09-25T03:45:05.000Z"); assert.equal(row.ledgerMapping, "UNMAPPED");
  assert.deepEqual(row.orderTimestamp, { raw: "09:15:01", iso: null });
  for (const key of ["orderId", "intentId", "positionId", "legId", "executionMode"]) assert.equal(key in row, false);
});
test("Kite multiple fills for the same order retain distinct native trade identities", async () => {
  const rows = available(await fake({ "/trades": kiteSuccess([kiteTrade(), kiteTrade({ trade_id: "000124", quantity: 6 })]) }).adapter.getTrades());
  assert.deepEqual(rows.map(row => row.quantityUnits), [4, 6]); assert.notEqual(rows[0].brokerTradeKey, rows[1].brokerTradeKey);
});
for (const dimension of ["account", "exchange", "day", "order"] as const) test(`Kite identical trade IDs in different ${dimension} namespaces do not collide`, async () => {
  const initial = available(await fake().adapter.getTrades())[0];
  const changes = dimension === "exchange" ? { exchange: "BFO" } : dimension === "day" ? { fill_timestamp: "2026-09-26 09:15:05" }
    : dimension === "order" ? { order_id: "another-order" } : {};
  const other = available(await fake({ "/trades": kiteSuccess([kiteTrade(changes)]) }, dimension === "account" ? "CD5678" : "AB1234").adapter.getTrades())[0];
  assert.notEqual(initial.brokerTradeKey, other.brokerTradeKey); assert.equal(initial.nativeTradeId, other.nativeTradeId);
});
test("Kite trade key is stable across fetches, missing exchange IDs and changed economics", async () => {
  const a = available(await fake().adapter.getTrades())[0];
  const b = available(await fake({ "/trades": kiteSuccess([kiteTrade({ exchange_order_id: null, average_price: 89, quantity: 1 })]) }).adapter.getTrades())[0];
  assert.equal(a.brokerTradeKey, b.brokerTradeKey); assert.notEqual(a.price, b.price);
});
test("Kite repeated native trade key in one response fails closed instead of collapsing conflicting evidence", async () => {
  unavailable(await fake({ "/trades": kiteSuccess([kiteTrade(), kiteTrade({ quantity: 2 })]) }).adapter.getTrades());
});
test("Kite sub-paise currency trade is preserved without rounding into a paise Fill", async () => {
  const row = available(await fake({ "/trades": kiteSuccess([kiteTrade({ exchange: "CDS", average_price: 72.755 })]) }).adapter.getTrades())[0];
  assert.equal(row.price, "72.755"); assert.equal(row.priceMinor, null);
});
test("Kite decimal exponent expansion preserves values without accumulation", async () => {
  const row = available(await fake({ "/trades": kiteSuccess([kiteTrade({ average_price: 1e-7 })]) }).adapter.getTrades())[0];
  assert.equal(row.price, "0.0000001"); assert.equal(row.priceMinor, null);
});
test("Kite identical symbols on different exchanges remain distinct", async () => {
  const rows = available(await fake({ "/orders": kiteSuccess([kiteOrder({ exchange: "NSE", tradingsymbol: "ABC" }), kiteOrder({ exchange: "BSE", tradingsymbol: "ABC" })]) }).adapter.getOrders());
  assert.notEqual(rows[0].instrument.contractKey, rows[1].instrument.contractKey);
});
test("Kite instrument metadata is preserved when supplied and never guessed from a symbol", async () => {
  const row = await order({ instrument_token: "123456", expiry: "2026-10-27", strike: 25000, instrument_type: "CE", segment: "NFO-OPT" });
  assert.equal(row.instrument.expiry, "2026-10-27"); assert.equal(row.instrument.strike, "25000"); assert.equal(row.instrument.segment, "NFO-OPT");
  assert.equal((await order()).instrument.expiry, null);
});
test("Kite positions preserve signed quantity, separate net/day and broker-reported P&L", async () => {
  const result = available(await fake({ "/portfolio/positions": kiteSuccess({ net: [kitePosition({ quantity: -4, overnight_quantity: -2, multiplier: 1000 })], day: [kitePosition()] }) }).adapter.getPositions());
  assert.equal(result.net[0].quantityUnits, -4); assert.equal(result.net[0].overnightQuantityUnits, -2); assert.equal(result.net[0].multiplier, 1000);
  assert.equal(result.net[0].brokerValues.realised, "-100"); assert.equal(result.day[0].quantityUnits, 4);
  assert.equal(result.net[0].evidenceKind, "POSITION_SNAPSHOT_NOT_FILL");
});
test("Kite successful flat account and zero-quantity position remain explicit available evidence", async () => {
  assert.deepEqual(available(await fake({ "/portfolio/positions": kiteSuccess({ net: [], day: [] }) }).adapter.getPositions()), { net: [], day: [] });
  const result = available(await fake({ "/portfolio/positions": kiteSuccess({ net: [kitePosition({ quantity: 0 })], day: [] }) }).adapter.getPositions());
  assert.equal(result.net[0].quantityUnits, 0);
});
test("Kite funds preserve named signed broker decimals, including floating tails, without risk-counter semantics", async () => {
  const result = available(await fake().adapter.getFunds());
  assert.equal(result.equity.net, "99725.05000000002"); assert.equal(result.equity.utilised.m2m_realised, "-761.7");
  assert.equal(result.commodity.enabled, false); assert.equal("committedExposureMinor" in result, false);
});
for (const [name, changes] of Object.entries({ fractionalQuantity: { quantity: 1.5 }, negativeQuantity: { quantity: -1 },
  unsafeQuantity: { quantity: Number.MAX_SAFE_INTEGER + 1 }, missingId: { order_id: undefined }, numericId: { order_id: 123 },
  invalidSide: { transaction_type: "SHORT" }, invalidPrice: { price: "100.5" }, negativePrice: { price: -1 },
  nonFinitePrice: { price: Infinity }, invalidTimestamp: { order_timestamp: "2026-02-30 09:15:00" },
  invalidExchangeTimestamp: { exchange_timestamp: "yesterday" }, overfilled: { filled_quantity: 11 },
  incompleteComplete: { status: "COMPLETE", filled_quantity: 0 }, wrongAccount: { account_id: "OTHER" } }))
test(`Kite malformed order ${name} makes the endpoint unavailable`, async () => {
  unavailable(await fake({ "/orders": kiteSuccess([kiteOrder(changes)]) }).adapter.getOrders());
});
for (const [name, changes] of Object.entries({ missingTrade: { trade_id: undefined }, zeroQuantity: { quantity: 0 },
  fractionalQuantity: { quantity: 1.25 }, invalidPrice: { average_price: NaN }, invalidSide: { transaction_type: "INVALID" },
  missingExecutionDate: { fill_timestamp: "09:15:05" }, invalidExecutionDate: { fill_timestamp: "2026-13-01 09:15:05" },
  malformedOrderTime: { order_timestamp: "25:00:00" }, wrongQuantityField: { quantity: undefined, filled: 4 } }))
test(`Kite malformed trade ${name} fails without fabricating identity/economics`, async () => {
  unavailable(await fake({ "/trades": kiteSuccess([kiteTrade(changes)]) }).adapter.getTrades());
});
test("Kite malformed positions cannot be converted to a flat account", async () => {
  unavailable(await fake({ "/portfolio/positions": kiteSuccess({ net: [] }) }).adapter.getPositions());
  unavailable(await fake({ "/portfolio/positions": kiteSuccess({ net: [kitePosition({ quantity: "0" })], day: [] }) }).adapter.getPositions());
});
test("Kite malformed funds cannot become zero buying power or invented defaults", async () => {
  unavailable(await fake({ "/user/margins": kiteSuccess({}) }).adapter.getFunds());
});
for (const path of kiteReadPaths) test(`Kite ${path} failure yields a partial snapshot with no empty substitute`, async () => {
  const result = await fake({ [path]: () => { throw new AxiosError("private authorization", "ECONNRESET"); } }).adapter.getSnapshot();
  assert.equal(result.completeness, "PARTIAL");
  const key = ({ "/orders": "orders", "/trades": "trades", "/portfolio/positions": "positions", "/user/margins": "funds" } as const)[path];
  unavailable(result[key] as BrokerReadResult<unknown>, "NETWORK_ERROR");
  assert.equal([result.orders, result.trades, result.positions, result.funds].filter(r => r.availability === "AVAILABLE").length, 3);
});
for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHENTICATION_FAILED"], [429, "RATE_LIMITED"], [500, "BROKER_ERROR"]] as const)
test(`Kite HTTP ${status} is sanitized as ${code}`, async () => {
  const result = await fake({ "/orders": () => { throw { response: { status, data: { message: "secret-token" } }, config: { headers: { Authorization: "secret-token" } } }; } }).adapter.getOrders();
  unavailable(result, code); assert.equal(JSON.stringify(result).includes("secret-token"), false);
  if (result.availability === "UNAVAILABLE") assert.equal(result.error.httpStatus, status);
});
test("Kite application authentication error in a resolved response is not success", async () => {
  unavailable(await fake({ "/trades": { status: "error", error_type: "TokenException", message: "secret" } }).adapter.getTrades(), "AUTHENTICATION_FAILED");
});
test("Kite malformed success envelope fails closed", async () => {
  for (const body of [null, {}, { data: [] }, kiteSuccess(null)]) unavailable(await fake({ "/orders": body }).adapter.getOrders());
});
test("Kite all endpoint failures return UNAVAILABLE with independently classified errors", async () => {
  const replies = Object.fromEntries(kiteReadPaths.map(path => [path, () => { throw new BrokerReadError("RATE_LIMITED", 429); }]));
  const result = await fake(replies).adapter.getSnapshot(); assert.equal(result.completeness, "UNAVAILABLE");
  for (const part of [result.orders, result.trades, result.positions, result.funds]) unavailable(part as BrokerReadResult<unknown>, "RATE_LIMITED");
});
test("Kite evidence is deeply immutable and preserves fetch timestamps per endpoint", async () => {
  const { session } = fake(); let tick = 0;
  const result = await new KiteReadOnlyAdapter(session, () => new Date(Date.parse(now) + tick++ * 1000)).getSnapshot();
  assert.equal(result.startedAt, now); assert.ok(result.fetchedAt > result.startedAt);
  assert.notEqual(result.orders.fetchedAt, result.trades.fetchedAt);
  const row = available(result.orders)[0]; assert.ok(Object.isFrozen(row.instrument)); assert.ok(Object.isFrozen(result));
  assert.throws(() => { (row as unknown as { filledUnits: number }).filledUnits = 10; }, TypeError);
});
test("Kite adapter cannot silently switch the injected session's account", async () => {
  const f = fake(); (f.session as { brokerAccountId: string }).brokerAccountId = "OTHER";
  unavailable(await f.adapter.getOrders(), "AUTHENTICATION_FAILED"); assert.deepEqual(f.calls, []);
});
test("Kite reads do not invoke Mongo financial mutation or transactions", async t => {
  const fail = () => { throw new Error("Forbidden Mongo mutation"); };
  const spies = [t.mock.method(mongoose.Model.prototype, "save", fail), t.mock.method(mongoose.Model, "create", fail),
    t.mock.method(mongoose.Model, "updateOne", fail), t.mock.method(mongoose.Model, "bulkWrite", fail),
    t.mock.method(mongoose.Connection.prototype, "startSession", fail)];
  assert.equal((await fake().adapter.getSnapshot()).completeness, "COMPLETE");
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

function transport(profile = "AB1234") {
  const calls: { path: string; headers: Record<string, string> }[] = [], writes: string[] = [];
  const client = { async get(path: string, config: { headers: Record<string, string> }) {
    calls.push({ path, headers: { ...config.headers } });
    if (path === "/user/profile") return { data: kiteSuccess({ user_id: profile }) };
    return { data: path === "/orders" || path === "/trades" ? kiteSuccess([])
      : path === "/portfolio/positions" ? kiteSuccess({ net: [], day: [] }) : kiteSuccess(kiteFunds()) };
  }, post() { writes.push("POST"); throw new Error("Forbidden"); }, put() { writes.push("PUT"); throw new Error("Forbidden"); },
  delete() { writes.push("DELETE"); throw new Error("Forbidden"); } };
  return { client: client as unknown as Pick<AxiosInstance, "get">, calls, writes };
}
test("Kite existing-client session verifies account and exposes only allowlisted GETs, never execution calls", async () => {
  const f = transport(); let auth = "token fake-key:fake-token";
  const session = await createKiteReadSession("AB1234", f.client, () => ({ Authorization: auth }));
  auth = "token other-key:other-token";
  const result = await new KiteReadOnlyAdapter(session, clock).getSnapshot(); assert.equal(result.completeness, "COMPLETE");
  assert.deepEqual(f.calls.map(c => c.path).sort(), ["/user/profile", ...kiteReadPaths].sort()); assert.deepEqual(f.writes, []);
  for (const call of f.calls) { assert.equal(call.headers.Authorization, "token fake-key:fake-token"); assert.equal(call.headers["X-Kite-Version"], "3"); }
  for (const key of ["placeOrder", "modifyOrder", "cancelOrder", "submitOrder"]) assert.equal(key in session, false);
  await assert.rejects(session.get("/orders/regular" as KiteReadPath), /INVALID_RESPONSE/); assert.equal(f.calls.length, 5);
  assert.equal(JSON.stringify(result).includes("fake-token"), false);
});
test("Kite session account mismatch prevents snapshot reads", async () => {
  const f = transport("OTHER");
  await assert.rejects(createKiteReadSession("AB1234", f.client, () => ({ Authorization: "token fake:fake" })), /AUTHENTICATION_FAILED/);
  assert.deepEqual(f.calls.map(c => c.path), ["/user/profile"]);
});
test("Kite missing credentials fail without HTTP or synthetic fallback", async () => {
  const f = transport(); await assert.rejects(createKiteReadSession("AB1234", f.client, () => ({})), /AUTHENTICATION_FAILED/);
  assert.equal(f.calls.length, 0);
});
test("Kite session factory never propagates raw credential-bearing HTTP errors", async () => {
  const client = { async get() { throw { response: { status: 403, data: { message: "secret-token" } }, config: { token: "secret-token" } }; } };
  await assert.rejects(createKiteReadSession("AB1234", client as unknown as Pick<AxiosInstance, "get">, () => ({ Authorization: "token fake:fake" })), error => {
    assert.ok(error instanceof BrokerReadError); assert.equal(error.code, "AUTHENTICATION_FAILED");
    assert.equal(JSON.stringify(error).includes("secret-token"), false); assert.equal(String(error).includes("secret-token"), false); return true;
  });
});
test("Kite actual Axios network errors without a response are classified without their messages", () => {
  assert.deepEqual(classifyKiteReadError(new AxiosError("secret-token", "ECONNREFUSED")), { code: "NETWORK_ERROR" });
});
