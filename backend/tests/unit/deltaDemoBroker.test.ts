import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getDeltaOrderByClientId, submitDeltaProtectedEntry, submitDeltaReduceOnlyClose } from "../../src/services/DeltaDemoBroker";

function fixture(handler: (path: string, body: any) => any): () => void {
  const oldFetch = globalThis.fetch, oldKey = process.env.DELTA_API_KEY;
  const oldSecret = process.env.DELTA_API_SECRET, oldMode = process.env.DELTA_DATA_MODE;
  process.env.DELTA_API_KEY = "test-key"; process.env.DELTA_API_SECRET = "test-secret";
  delete process.env.DELTA_DATA_MODE;
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.host, "cdn-ind.testnet.deltaex.org");
    const headers = init?.headers as Record<string, string>;
    const body = init?.body ? String(init.body) : "";
    assert.equal(headers["api-key"], "test-key");
    assert.equal(headers.signature, crypto.createHmac("sha256", "test-secret")
      .update(`${init?.method}${headers.timestamp}${requestUrl.pathname}${requestUrl.search}${body}`).digest("hex"));
    return new Response(JSON.stringify({ success: true, result: handler(requestUrl.pathname, body ? JSON.parse(body) : null) }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return () => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DELTA_API_KEY; else process.env.DELTA_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DELTA_API_SECRET; else process.env.DELTA_API_SECRET = oldSecret;
    if (oldMode === undefined) delete process.env.DELTA_DATA_MODE; else process.env.DELTA_DATA_MODE = oldMode;
  };
}

test("protected Demo entry is signed, bracketed, and matched to the exchange echo", async () => {
  const restore = fixture((_path, body) => {
    assert.equal(body.order_type, "market_order");
    assert.equal(body.time_in_force, "ioc");
    assert.equal(body.reduce_only, false);
    assert.equal(body.bracket_stop_trigger_method, "mark_price");
    assert.equal(body.bracket_stop_loss_price, "79900");
    assert.equal(body.bracket_take_profit_price, "80200");
    return { id: 100, client_order_id: body.client_order_id, product_id: 84, side: "buy",
      size: 1, unfilled_size: 0, state: "closed", reduce_only: false, average_fill_price: "80001",
      bracket_stop_loss_price: body.bracket_stop_loss_price,
      bracket_take_profit_price: body.bracket_take_profit_price };
  });
  try {
    const order = await submitDeltaProtectedEntry({ clientOrderId: "btc-1", productId: 84, side: "LONG",
      sizeContracts: 1, referencePriceUsd: 80000, stopUsd: 79900, targetUsd: 80200, tickSize: 0.5 });
    assert.equal(order.bracketStopUsd, 79900);
    assert.equal(order.averageFillPriceUsd, 80001);
  } finally { restore(); }
});

test("mismatched bracket echo fails closed and reduce-only close never opens exposure", async () => {
  const restore = fixture((_path, body) => ({ id: 101, client_order_id: body.client_order_id,
    product_id: 84, side: body.side, size: body.size, unfilled_size: 0, state: "closed", reduce_only: body.reduce_only,
    bracket_stop_loss_price: "1", bracket_take_profit_price: "2" }));
  try {
    await assert.rejects(submitDeltaProtectedEntry({ clientOrderId: "btc-2", productId: 84, side: "SHORT",
      sizeContracts: 1, referencePriceUsd: 80000, stopUsd: 80100, targetUsd: 79800, tickSize: 0.5 }),
    /DELTA_PROTECTION_UNCONFIRMED/);
  } finally { restore(); }
  const closeRestore = fixture((_path, body) => {
    assert.equal(body.reduce_only, true);
    assert.equal(body.side, "sell");
    assert.equal(body.time_in_force, "ioc");
    return { id: 102, client_order_id: body.client_order_id, product_id: 84,
      side: body.side, size: body.size, unfilled_size: 0, state: "closed", reduce_only: true };
  });
  try { assert.equal((await submitDeltaReduceOnlyClose({ clientOrderId: "close-1", productId: 84,
    side: "LONG", sizeContracts: 1 })).id, "102"); }
  finally { closeRestore(); }
});

test("broker rejects mock mode and invalid stop direction before network", async () => {
  const restore = fixture(() => { throw new Error("unexpected network"); });
  try {
    await assert.rejects(submitDeltaProtectedEntry({ clientOrderId: "btc-3", productId: 84, side: "LONG",
      sizeContracts: 1, referencePriceUsd: 80000, stopUsd: 80100, targetUsd: 80200, tickSize: 0.5 }),
    /DELTA_PROTECTED_ENTRY_INVALID/);
    process.env.DELTA_DATA_MODE = "MOCK";
    await assert.rejects(getDeltaOrderByClientId("btc-3"), /DELTA_DEMO_ONLY/);
  } finally { restore(); }
});
