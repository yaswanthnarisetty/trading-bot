import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { BtcDemoOrderIntentModel } from "../../src/models/BtcDemoOrderIntent";
import { BtcDemoAutoControlModel } from "../../src/models/BtcDemoAutoControl";
import { planBtcDemoTrade } from "../../src/domain/btcDemoPlan";
import { evaluateCryptoSignalFromClosedCandles } from "../../src/services/CryptoSignalService";
import { reconcileBtcDemoIntent, recoverBtcDemoIntents, requestBtcDemoClose, submitBtcDemoCandidate,
  submitBtcDemoDailyCandidate } from "../../src/services/BtcDemoExecutionService";
import { runBtcDemoAutoCycle, setBtcDemoAutoPaused } from "../../src/services/BtcDemoAutoService";
import type { BtcBacktestResult } from "../../src/services/BtcResearchService";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated test Mongo required");
before(async () => { await mongoose.connect(uri); await BtcDemoOrderIntentModel.init(); });
after(async () => { await mongoose.disconnect(); });

const product = { id: 84, symbol: "BTCUSD" as const, contractValueBtc: 0.001, tickSize: 0.5 };
const firstBar = Math.floor(Date.now() / 60_000) * 60_000 - 50 * 60_000;
let barPrice = 79500;
const signalBars = Array.from({ length: 50 }, (_, i) => {
  const open = barPrice; barPrice += i % 2 ? -80 : 100;
  return { timestamp: new Date(firstBar + i * 60_000), open, high: Math.max(open, barPrice) + 10,
    low: Math.min(open, barPrice) - 10, close: barPrice, volume: i === 49 ? 100 : 10 };
});
const signal = evaluateCryptoSignalFromClosedCandles("BTCUSD", signalBars, new Date().toISOString());
if (signal.side !== "LONG") throw new Error("test signal unexpectedly non-actionable");
const plan = planBtcDemoTrade({ side: "LONG", entryPrice: 80000, atr: signal.atr, equityUsd: 158.75,
  product, openPositionCount: 0, activeOrderCount: 0 });
if (!plan.eligible) throw new Error("test plan unexpectedly ineligible");
const goodResult = (intervalMs: number): BtcBacktestResult => ({ intervalMs, startingEquityUsd: 158.75,
  endingEquityUsd: 161.75, netPnlUsd: 3, bars: 3000, qualifiedBars: 2900, actionableSignals: 50,
  trades: 25, wins: 15, losses: 10, winRate: 0.6, profitFactor: 1.3,
  maxDrawdownPct: 2, costAllowanceBpsRoundTrip: 30 });

test("a failed research gate cannot submit an order or create an intent", async () => {
  await assert.rejects(submitBtcDemoCandidate({ plan, signalTimestamp: new Date().toISOString(),
    outOfSampleResults: [goodResult(60_000)] }), /BTC_STRATEGY_NOT_VALIDATED/);
  assert.equal(await BtcDemoOrderIntentModel.countDocuments(), 0);
});

test("operator pause persists and blocks daily Demo entry before any market request", async () => {
  const previous = process.env.BTC_DEMO_AUTO_TRADING;
  process.env.BTC_DEMO_AUTO_TRADING = "ENABLED";
  try {
    const paused = await setBtcDemoAutoPaused(true);
    assert.equal(paused.enabled, false);
    assert.equal((await BtcDemoAutoControlModel.findOne({ key: "BTCUSD:DELTA_DEMO" }))?.paused, true);
    await assert.rejects(submitBtcDemoDailyCandidate(), /BTC_DEMO_AUTO_OPERATOR_PAUSED/);
    assert.equal(await BtcDemoOrderIntentModel.countDocuments(), 0);
    assert.equal((await setBtcDemoAutoPaused(false)).enabled, true);
  } finally {
    await BtcDemoAutoControlModel.deleteMany({}).exec();
    if (previous === undefined) delete process.env.BTC_DEMO_AUTO_TRADING;
    else process.env.BTC_DEMO_AUTO_TRADING = previous;
  }
});

test("daily Demo automation submits once with the prior-day stop and durable daily slot", async t => {
  await BtcDemoOrderIntentModel.deleteMany({}).exec();
  const realNow = Date.now();
  const dayMs = 86_400_000;
  const today = Math.floor(realNow / dayMs) * dayMs;
  t.mock.method(Date, "now", () => today + 120_000);
  const previousAuto = process.env.BTC_DEMO_AUTO_TRADING;
  const previousKey = process.env.DELTA_API_KEY, previousSecret = process.env.DELTA_API_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.BTC_DEMO_AUTO_TRADING = "ENABLED";
  process.env.DELTA_API_KEY = "test-key"; process.env.DELTA_API_SECRET = "test-secret";
  const bars = Array.from({ length: 60 }, (_, i) => {
    const open = 79_000 + i * 10;
    return { time: (today - (60 - i) * dayMs) / 1000, open: String(open),
      high: String(open + 12), low: String(open - 5), close: String(open + 10), volume: "100" };
  });
  let position = 0, postCount = 0;
  let entry: any, close: any;
  const fills: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    let result: any;
    if (url.pathname === "/v2/products/BTCUSD") result = { id: 84, symbol: "BTCUSD",
      contract_type: "perpetual_futures", state: "live", trading_status: "operational",
      contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.1" };
    else if (url.pathname === "/v2/wallet/balances") return new Response(JSON.stringify({ success: true,
      meta: { net_equity: "1000" }, result: [] }), { status: 200 });
    else if (url.pathname === "/v2/positions/margined" || url.pathname === "/v2/orders" && init?.method !== "POST") result = [];
    else if (url.pathname === "/v2/positions") result = { size: position,
      entry_price: position ? "80000" : null };
    else if (url.pathname === "/v2/tickers/BTCUSD") result = { mark_price: "80000",
      timestamp: Date.now() * 1000 };
    else if (url.pathname === "/v2/l2orderbook/BTCUSD") result = { symbol: "BTCUSD",
      last_updated_at: Date.now() * 1000, buy: [{ price: "79999.5", size: 100 }],
      sell: [{ price: "80000.5", size: 100 }] };
    else if (url.pathname === "/v2/history/candles") result = bars;
    else if (url.pathname === "/v2/fills") result = fills;
    else if (url.pathname === "/v2/orders" && init?.method === "POST") {
      postCount++;
      const closing = body.reduce_only;
      if (!closing) {
        assert.equal(body.side, "buy");
        assert.ok(Number(body.bracket_stop_loss_price) < 79_585);
        assert.ok(Number(body.bracket_take_profit_price) > 80_000);
      }
      result = { id: closing ? 302 : 301, client_order_id: body.client_order_id,
        product_id: 84, side: body.side, size: body.size, unfilled_size: 0,
        state: "closed", reduce_only: closing,
        average_fill_price: closing ? "80100" : "80000",
        bracket_stop_loss_price: body.bracket_stop_loss_price ?? null,
        bracket_take_profit_price: body.bracket_take_profit_price ?? null };
      position = closing ? 0 : body.size;
      fills.push({ id: closing ? "daily-exit" : "daily-entry", order_id: String(result.id),
        product_id: 84, side: body.side, size: String(body.size), price: closing ? "80100" : "80000",
        commission: "0.01", created_at: new Date(today + (closing ? 180_000 : 120_000)).toISOString() });
      if (closing) close = result; else entry = result;
    } else if (url.pathname.startsWith("/v2/orders/client_order_id/")) result =
      url.pathname.endsWith(entry?.client_order_id) ? entry : close;
    else throw new Error(`Unexpected daily Demo API path ${url.pathname}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  try {
    const opened = await submitBtcDemoDailyCandidate();
    assert.equal(opened.status, "FILLED_PROTECTED");
    assert.equal(opened.validationId, "BTC_DAILY_FORWARD_DEMO_V1");
    assert.equal(opened.dailySlot, `BTCUSD:DELTA_DEMO:${new Date(today).toISOString().slice(0, 10)}`);
    assert.equal(postCount, 1);
    await BtcDemoOrderIntentModel.collection.updateOne({ clientOrderId: opened.clientOrderId },
      { $set: { createdAt: new Date(today - 6 * dayMs) } });
    await setBtcDemoAutoPaused(true);
    const cycle = await runBtcDemoAutoCycle();
    assert.equal(cycle.reason, "FIVE_DAY_MAX_HOLD");
    assert.equal(cycle.paused, true);
    const closed = await BtcDemoOrderIntentModel.findOne({ clientOrderId: opened.clientOrderId }).lean().exec();
    assert.ok(closed);
    assert.equal(closed.status, "CLOSED_CONFIRMED");
    await setBtcDemoAutoPaused(false);
    await assert.rejects(submitBtcDemoDailyCandidate(), /BTC_DAILY_ALREADY_ATTEMPTED/);
    assert.equal(postCount, 2);
  } finally {
    await BtcDemoOrderIntentModel.deleteMany({}).exec();
    await BtcDemoAutoControlModel.deleteMany({}).exec();
    globalThis.fetch = previousFetch;
    if (previousAuto === undefined) delete process.env.BTC_DEMO_AUTO_TRADING;
    else process.env.BTC_DEMO_AUTO_TRADING = previousAuto;
    if (previousKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = previousSecret;
    t.mock.restoreAll();
  }
});

test("Demo entry and close require persisted intent, bracket echo, fills and real-time position", async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.DELTA_API_KEY, oldSecret = process.env.DELTA_API_SECRET;
  const oldMode = process.env.DELTA_DATA_MODE;
  process.env.DELTA_API_KEY = "test-key"; process.env.DELTA_API_SECRET = "test-secret"; delete process.env.DELTA_DATA_MODE;
  let positionSize = 0, postCount = 0;
  let entry: any, close: any;
  const fillTime = new Date().toISOString();
  const fills: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    let result: any;
    if (url.pathname === "/v2/products/BTCUSD") result = { id: 84, symbol: "BTCUSD",
      contract_type: "perpetual_futures", state: "live", trading_status: "operational",
      contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.5" };
    else if (url.pathname === "/v2/wallet/balances") return new Response(JSON.stringify({ success: true,
      meta: { net_equity: "158.75" }, result: [] }), { status: 200 });
    else if (url.pathname === "/v2/positions/margined") result = [];
    else if (url.pathname === "/v2/positions") result = { size: positionSize,
      entry_price: positionSize ? "80000" : null };
    else if (url.pathname === "/v2/orders" && method === "GET") result = [];
    else if (url.pathname === "/v2/tickers/BTCUSD") result = { mark_price: "80000", timestamp: Date.now() * 1000 };
    else if (url.pathname === "/v2/l2orderbook/BTCUSD") result = { symbol: "BTCUSD",
      last_updated_at: Date.now() * 1000, buy: [{ price: "79999.5", size: 10 }],
      sell: [{ price: "80000.5", size: 10 }] };
    else if (url.pathname === "/v2/history/candles") result = signalBars.map(bar => ({ time: bar.timestamp.getTime() / 1000,
      open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close), volume: String(bar.volume) }));
    else if (url.pathname === "/v2/fills") result = fills;
    else if (url.pathname === "/v2/orders" && method === "POST") {
      assert.equal(await BtcDemoOrderIntentModel.countDocuments({ activeSlot: "BTCUSD:DELTA_DEMO" }), 1);
      postCount++;
      const isClose = body.reduce_only === true;
      result = { id: isClose ? 102 : 101, client_order_id: body.client_order_id,
        product_id: 84, side: body.side, size: body.size, unfilled_size: 0, state: "closed",
        reduce_only: body.reduce_only,
        average_fill_price: isClose ? "80100" : "80000",
        bracket_stop_loss_price: body.bracket_stop_loss_price ?? null,
        bracket_take_profit_price: body.bracket_take_profit_price ?? null };
      if (isClose) {
        assert.equal(body.side, "sell"); assert.equal(body.reduce_only, true);
        close = result; positionSize = 0;
        fills.push({ id: "exit-fill", order_id: "102", product_id: 84, side: "sell",
          size: String(body.size), price: "80100", commission: "0.01", created_at: new Date(Date.parse(fillTime) + 1).toISOString() });
      } else {
        assert.equal(body.side, "buy"); assert.equal(body.reduce_only, false);
        entry = result; positionSize = body.size;
        fills.push({ id: "entry-fill", order_id: "101", product_id: 84, side: "buy",
          size: String(body.size), price: "80000", commission: "0.01", created_at: fillTime });
      }
    } else if (url.pathname.startsWith("/v2/orders/client_order_id/")) result =
      url.pathname.endsWith(entry?.client_order_id) ? entry : close;
    else throw new Error(`Unexpected API path ${method} ${url.pathname}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  try {
    const opened = await submitBtcDemoCandidate({ plan, signalTimestamp: new Date().toISOString(),
      outOfSampleResults: [goodResult(60_000), goodResult(300_000)] });
    assert.equal(opened.status, "FILLED_PROTECTED");
    assert.equal(opened.filledContracts, plan.contractCount);
    assert.deepEqual(opened.entryFillIds, ["entry-fill"]);
    assert.equal(postCount, 1);
    const closed = await requestBtcDemoClose(opened.clientOrderId);
    assert.equal(closed.status, "CLOSED_CONFIRMED");
    assert.deepEqual(closed.exitFillIds, ["exit-fill"]);
    assert.equal(closed.realizedPnlUsd, 0.08 * plan.contractCount);
    assert.equal(closed.averageExitPriceUsd, 80100);
    assert.equal(closed.activeSlot, null);
    assert.equal(postCount, 2);
    assert.equal((await reconcileBtcDemoIntent(opened.clientOrderId)).status, "CLOSED_CONFIRMED");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = oldSecret;
    if (oldMode === undefined) delete process.env.DELTA_DATA_MODE; else process.env.DELTA_DATA_MODE = oldMode;
  }
});

test("an uncertain entry remains locked across recovery and is never sent twice", async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.DELTA_API_KEY;
  const oldSecret = process.env.DELTA_API_SECRET, oldMode = process.env.DELTA_DATA_MODE;
  process.env.DELTA_API_KEY = "test-key"; process.env.DELTA_API_SECRET = "test-secret";
  delete process.env.DELTA_DATA_MODE;
  let postCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") { postCount++; throw new Error("simulated timeout after unknown acceptance"); }
    if (url.pathname === "/v2/products/BTCUSD") return new Response(JSON.stringify({ success: true, result: {
      id: 84, symbol: "BTCUSD", contract_type: "perpetual_futures", state: "live",
      trading_status: "operational", contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.5",
    } }), { status: 200 });
    if (url.pathname === "/v2/wallet/balances") return new Response(JSON.stringify({ success: true,
      meta: { net_equity: "158.75" }, result: [] }), { status: 200 });
    if (url.pathname === "/v2/positions/margined" || url.pathname === "/v2/orders")
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    if (url.pathname === "/v2/positions") return new Response(JSON.stringify({ success: true,
      result: { size: 0, entry_price: null } }), { status: 200 });
    if (url.pathname === "/v2/tickers/BTCUSD") return new Response(JSON.stringify({ success: true,
      result: { mark_price: "80000", timestamp: Date.now() * 1000 } }), { status: 200 });
    if (url.pathname === "/v2/l2orderbook/BTCUSD") return new Response(JSON.stringify({ success: true,
      result: { symbol: "BTCUSD", last_updated_at: Date.now() * 1000,
        buy: [{ price: "79999.5", size: 10 }], sell: [{ price: "80000.5", size: 10 }] } }), { status: 200 });
    if (url.pathname === "/v2/history/candles") return new Response(JSON.stringify({ success: true,
      result: signalBars.map(bar => ({ time: bar.timestamp.getTime() / 1000,
        open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close), volume: String(bar.volume) })) }), { status: 200 });
    if (url.pathname.startsWith("/v2/orders/client_order_id/")) return new Response("not found", { status: 404 });
    if (url.pathname === "/v2/fills") return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    throw new Error(`Unexpected ${url.pathname}`);
  };
  try {
    await assert.rejects(submitBtcDemoCandidate({ plan, signalTimestamp: new Date().toISOString(),
      outOfSampleResults: [goodResult(60_000), goodResult(300_000)] }), /simulated timeout/);
    assert.equal(postCount, 1);
    const pending = await BtcDemoOrderIntentModel.findOne({ activeSlot: "BTCUSD:DELTA_DEMO" }).lean().exec();
    assert.equal(pending?.status, "ATTENTION");
    await recoverBtcDemoIntents();
    assert.equal(postCount, 1);
    assert.equal((await BtcDemoOrderIntentModel.findOne({ clientOrderId: pending!.clientOrderId }))?.status, "ATTENTION");
    await assert.rejects(BtcDemoOrderIntentModel.create({ ...pending, _id: undefined,
      clientOrderId: "duplicate-intent", status: "PREPARED" }), /E11000/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = oldSecret;
    if (oldMode === undefined) delete process.env.DELTA_DATA_MODE; else process.env.DELTA_DATA_MODE = oldMode;
  }
});

test("new exchange exposure before submission cancels a prepared intent without POST", async () => {
  await BtcDemoOrderIntentModel.deleteMany({}).exec();
  const oldFetch = globalThis.fetch, oldKey = process.env.DELTA_API_KEY;
  const oldSecret = process.env.DELTA_API_SECRET, oldMode = process.env.DELTA_DATA_MODE;
  process.env.DELTA_API_KEY = "test-key"; process.env.DELTA_API_SECRET = "test-secret";
  delete process.env.DELTA_DATA_MODE;
  let positionReads = 0, postCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") { postCount++; throw new Error("unexpected order"); }
    let result: any;
    if (url.pathname === "/v2/products/BTCUSD") result = { id: 84, symbol: "BTCUSD",
      contract_type: "perpetual_futures", state: "live", trading_status: "operational",
      contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.5" };
    else if (url.pathname === "/v2/wallet/balances") return new Response(JSON.stringify({ success: true,
      meta: { net_equity: "158.75" }, result: [] }), { status: 200 });
    else if (url.pathname === "/v2/positions/margined" || url.pathname === "/v2/orders") result = [];
    else if (url.pathname === "/v2/positions") result = { size: ++positionReads === 1 ? 0 : 1,
      entry_price: positionReads === 1 ? null : "80000" };
    else if (url.pathname === "/v2/tickers/BTCUSD") result = { mark_price: "80000", timestamp: Date.now() * 1000 };
    else if (url.pathname === "/v2/l2orderbook/BTCUSD") result = { symbol: "BTCUSD",
      last_updated_at: Date.now() * 1000, buy: [{ price: "79999.5", size: 10 }],
      sell: [{ price: "80000.5", size: 10 }] };
    else if (url.pathname === "/v2/history/candles") result = signalBars.map(bar => ({
      time: bar.timestamp.getTime() / 1000, open: String(bar.open), high: String(bar.high),
      low: String(bar.low), close: String(bar.close), volume: String(bar.volume) }));
    else throw new Error(`Unexpected ${url.pathname}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  try {
    await assert.rejects(submitBtcDemoCandidate({ plan, signalTimestamp: new Date().toISOString(),
      outOfSampleResults: [goodResult(60_000), goodResult(300_000)] }), /BTC_PRE_SEND_EVIDENCE_CHANGED/);
    assert.equal(postCount, 0);
    const intent = await BtcDemoOrderIntentModel.findOne({ status: "CANCELLED_UNFILLED" }).lean().exec();
    assert.equal(intent?.activeSlot, null);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = oldSecret;
    if (oldMode === undefined) delete process.env.DELTA_DATA_MODE; else process.env.DELTA_DATA_MODE = oldMode;
  }
});
