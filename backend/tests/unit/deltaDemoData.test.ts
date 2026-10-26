import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDeltaCandles, getDeltaDemoAccount, getDeltaDemoBtcExposure, getDeltaDemoProduct, getDeltaDemoRecentFills, getDeltaDemoCompletedDailyCandles, getDeltaPrice, isDeltaMock, qualifyDeltaDemoBtcBook } from "../../src/services/DeltaService";
import { qualifyClosedCryptoCandles } from "../../src/services/CryptoSignalService";
import type { OHLCV } from "../../src/types/trading";

function withDemoFetch(handler: (url: URL, init: RequestInit) => unknown): () => void {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.DELTA_API_KEY;
  const oldSecret = process.env.DELTA_API_SECRET;
  process.env.DELTA_API_KEY = "demo-key";
  process.env.DELTA_API_SECRET = "demo-secret";
  globalThis.fetch = async (input, init) => new Response(JSON.stringify(handler(new URL(String(input)), init ?? {})), {
    status: 200, headers: { "content-type": "application/json" },
  });
  return () => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = oldSecret;
  };
}

test("Demo connection uses authenticated account endpoints and exchange equity", async () => {
  const seen: string[] = [];
  const restore = withDemoFetch((url, init) => {
    seen.push(url.pathname);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["api-key"], "demo-key");
    assert.equal(headers["User-Agent"], "trading-bot-demo/1.0");
    assert.equal(headers.signature, crypto.createHmac("sha256", "demo-secret")
      .update(`GET${headers.timestamp}${url.pathname}`).digest("hex"));
    if (url.pathname.endsWith("/wallet/balances"))
      return { success: true, meta: { net_equity: "158.75" }, result: [] };
    return { success: true, result: [] };
  });
  try {
    assert.equal(isDeltaMock(), false);
    assert.deepEqual(await getDeltaDemoAccount(), { equity: 158.75, openPositionCount: 0, activeOrderCount: 0 });
    assert.deepEqual(seen.sort(), ["/v2/orders", "/v2/positions/margined", "/v2/wallet/balances"]);
  } finally { restore(); }
});

test("invalid configured Demo price and candles fail closed", async () => {
  const restore = withDemoFetch(url => url.pathname.includes("tickers")
    ? { success: true, result: { mark_price: "bad" } }
    : { success: true, result: [{ time: 1, open: "1", high: "1", low: "1", close: "bad", volume: "1" }] });
  try {
    await assert.rejects(getDeltaPrice("BTCUSD"), /DELTA_TICKER_INVALID/);
    await assert.rejects(getDeltaCandles("BTCUSD"), /DELTA_CANDLES_INVALID/);
  } finally { restore(); }
});

test("daily Demo feed excludes the forming candle and rejects a missing completed day", async () => {
  const day = 86_400_000;
  const today = Math.floor(Date.now() / day) * day;
  const raw = Array.from({ length: 61 }, (_, i) => ({ time: (today - (60 - i) * day) / 1000,
    open: "80000", high: "80100", low: "79900", close: "80050", volume: "100" }));
  const restore = withDemoFetch(() => ({ success: true, result: raw }));
  try {
    const bars = await getDeltaDemoCompletedDailyCandles();
    assert.equal(bars.length, 60);
    assert.equal(bars.at(-1)?.timestamp.getTime(), today - day);
    raw.splice(59, 1);
    await assert.rejects(getDeltaDemoCompletedDailyCandles(), /DELTA_DAILY_CANDLES_STALE_OR_GAPPED/);
  } finally { restore(); }
});

test("ticker freshness comes from Delta exchange time, not fetch time", async () => {
  const restore = withDemoFetch(() => ({ success: true, result: {
    mark_price: "60000", timestamp: (Date.now() - 30_000) * 1000,
  } }));
  try { await assert.rejects(getDeltaPrice("BTCUSD"), /DELTA_TICKER_STALE/); }
  finally { restore(); }
});

test("Demo product is resolved by exchange symbol and contract metadata", async () => {
  const restore = withDemoFetch(() => ({ success: true, result: {
    id: 84, symbol: "BTCUSD", contract_type: "perpetual_futures", state: "live", trading_status: "operational",
    contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.1",
  } }));
  try { assert.deepEqual(await getDeltaDemoProduct(), { id: 84, symbol: "BTCUSD", contractValueBtc: 0.001, tickSize: 0.1 }); }
  finally { restore(); }
});

test("BTC market-order admission requires fresh, tight and sufficiently deep Demo quotes", () => {
  const now = Date.now();
  const book = { symbol: "BTCUSD", last_updated_at: now * 1000,
    buy: [{ price: "80000", size: 10 }], sell: [{ price: "80004", size: 10 }] };
  assert.ok(qualifyDeltaDemoBtcBook(book, now, 1).spreadBps < 1);
  const nearby = qualifyDeltaDemoBtcBook({ ...book,
    sell: [{ price: "80004", size: 1 }, { price: "80006", size: 2 }] }, now, 1);
  assert.equal(nearby.askSizeContracts, 3);
  assert.equal(nearby.executionAskUsd, 80_004);
  assert.throws(() => qualifyDeltaDemoBtcBook({ ...book,
    sell: [{ price: "80004", size: 1 }, { price: "80100", size: 100 }] }, now, 1),
    /DELTA_BOOK_STALE_WIDE_OR_THIN/);
  assert.throws(() => qualifyDeltaDemoBtcBook({ ...book, last_updated_at: (now - 11_000) * 1000 }, now, 1),
    /DELTA_BOOK_STALE_WIDE_OR_THIN/);
  assert.throws(() => qualifyDeltaDemoBtcBook({ ...book, sell: [{ price: "80100", size: 10 }] }, now, 1),
    /DELTA_BOOK_STALE_WIDE_OR_THIN/);
  assert.throws(() => qualifyDeltaDemoBtcBook({ ...book, buy: [{ price: "80000", size: 1 }] }, now, 1),
    /DELTA_BOOK_STALE_WIDE_OR_THIN/);
});

test("BTC admission uses signed real-time position and active order reads", async () => {
  const seen: string[] = [];
  const restore = withDemoFetch((url, init) => {
    seen.push(url.pathname + url.search);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.signature, crypto.createHmac("sha256", "demo-secret")
      .update(`GET${headers.timestamp}${url.pathname}${url.search}`).digest("hex"));
    if (url.pathname === "/v2/positions") return { success: true, result: { size: -2, entry_price: "82000" } };
    return { success: true, result: [{ id: 12, product_id: 84, state: "open", client_order_id: "btc-entry-1" }] };
  });
  try {
    assert.deepEqual(await getDeltaDemoBtcExposure(84), {
      sizeContracts: -2, entryPriceUsd: 82000, activeOrders: [{ id: "12", clientOrderId: "btc-entry-1" }],
    });
    assert.deepEqual(seen.sort(), ["/v2/orders?product_id=84", "/v2/positions?product_id=84"]);
  } finally { restore(); }
});

test("invalid or ambiguous exchange exposure and fills fail closed", async () => {
  const restore = withDemoFetch(url => url.pathname === "/v2/positions"
    ? { success: true, result: { size: "unknown" } }
    : { success: true, result: [] });
  try { await assert.rejects(getDeltaDemoBtcExposure(84), /DELTA_EXPOSURE_RESPONSE_INVALID/); }
  finally { restore(); }
  const restoreFills = withDemoFetch(() => ({ success: true, result: [{ id: "f1", order_id: "12",
    side: "buy", size: "1", price: "80000", commission: "-1", product_id: 84, created_at: "1" }] }));
  try { await assert.rejects(getDeltaDemoRecentFills(84), /DELTA_FILLS_RESPONSE_INVALID/); }
  finally { restoreFills(); }
});

test("missing credentials never turn production BTC reads into mock prices", async () => {
  const key = process.env.DELTA_API_KEY, secret = process.env.DELTA_API_SECRET, mode = process.env.DELTA_DATA_MODE;
  delete process.env.DELTA_API_KEY; delete process.env.DELTA_API_SECRET;
  delete process.env.DELTA_DATA_MODE;
  try { await assert.rejects(getDeltaPrice("BTCUSD"), /DELTA_DEMO_CREDENTIALS_REQUIRED/); }
  finally {
    if (key !== undefined) process.env.DELTA_API_KEY = key;
    if (secret !== undefined) process.env.DELTA_API_SECRET = secret;
    if (mode !== undefined) process.env.DELTA_DATA_MODE = mode;
  }
});

test("explicit mock fixtures stay available only outside production", async () => {
  const key = process.env.DELTA_API_KEY, secret = process.env.DELTA_API_SECRET;
  const mode = process.env.DELTA_DATA_MODE, nodeEnv = process.env.NODE_ENV;
  delete process.env.DELTA_API_KEY; delete process.env.DELTA_API_SECRET;
  process.env.DELTA_DATA_MODE = "MOCK"; process.env.NODE_ENV = "test";
  try {
    assert.equal(isDeltaMock(), true);
    assert.equal(qualifyClosedCryptoCandles(await getDeltaCandles("BTCUSD", 60, 53), Date.now()).length, 50);
    process.env.NODE_ENV = "production";
    assert.equal(isDeltaMock(), false);
    await assert.rejects(getDeltaPrice("BTCUSD"), /DELTA_DEMO_CREDENTIALS_REQUIRED/);
  } finally {
    if (key === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = key;
    if (secret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = secret;
    if (mode === undefined) delete process.env.DELTA_DATA_MODE; else process.env.DELTA_DATA_MODE = mode;
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
});

test("signal input requires complete, contiguous, fresh closed bars", () => {
  const end = 1_700_000_040_000; // exact minute boundary
  const bars: OHLCV[] = Array.from({ length: 52 }, (_, i) => ({
    timestamp: new Date(end - (51 - i) * 60_000), open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
  const qualified = qualifyClosedCryptoCandles(bars, end + 10_000);
  assert.equal(qualified.length, 50);
  assert.equal(qualified.at(-1)?.timestamp.getTime(), end - 60_000);
  assert.throws(() => qualifyClosedCryptoCandles(bars, end + 180_001), /BTC_CANDLES_STALE/);
  assert.throws(() => qualifyClosedCryptoCandles(bars.slice(0, 45), end + 10_000), /BTC_CANDLES_INSUFFICIENT/);
  const gapped = [...bars]; gapped[30] = { ...gapped[30]!, timestamp: new Date(gapped[30]!.timestamp.getTime() + 60_000) };
  assert.throws(() => qualifyClosedCryptoCandles(gapped, end + 10_000), /BTC_CANDLES_INVALID_OR_GAPPED/);
});
