import { test } from "node:test";
import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import type { Request, Response } from "express";
import { KiteSessionService } from "../../src/services/KiteSessionService";
import { createKiteCallback, createKiteRouter } from "../../src/routes/kite";
import type { KiteMarketDataService } from "../../src/services/KiteMarketDataService";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const success = (data: unknown) => ({ status: "success", data });
function setup() {
  let now = Date.parse("2026-09-29T04:00:00Z"), account = "AB1234";
  const calls: { method: string; path: string; config?: any; data?: unknown }[] = [];
  let exchangeError: unknown, getError: unknown, profileOverride: unknown;
  const client = { async post(path: string, data: unknown, config: unknown) {
    calls.push({ method: "POST", path, data, config }); if (exchangeError) throw exchangeError;
    return { data: success({ user_id: account, api_key: "key", access_token: "private-access" }) };
  }, async get(path: string, config: unknown) {
    calls.push({ method: "GET", path, config }); if (getError) throw getError;
    return { data: path === "/user/profile" ? success(profileOverride ?? { user_id: account, broker: "ZERODHA" }) : success({}) };
  } } as unknown as Pick<AxiosInstance, "get" | "post">;
  const sleeps: number[] = [];
  const session = new KiteSessionService(client, () => ({ apiKey: "key", apiSecret: "private-secret", expectedAccountId: "AB1234" }), () => now,
    async delay => { sleeps.push(delay); now += delay; });
  const state = () => new URLSearchParams(new URL(session.beginLogin()).searchParams.get("redirect_params")!).get("state")!;
  return { session, calls, sleeps, state, setNow: (value: number) => { now = value; },
    failExchange: (value: unknown) => { exchangeError = value; }, failGet: (value: unknown) => { getError = value; },
    setAccount: (value: string) => { account = value; }, setProfile: (value: unknown) => { profileOverride = value; } };
}
async function callback(session: KiteSessionService, query: Record<string, unknown>) {
  let redirect = "", status = 0; const headers: Record<string, string> = {};
  await createKiteCallback(session)({ query } as unknown as Request, {
    setHeader(key: string, value: string) { headers[key] = value; },
    redirect(code: number, location: string) { status = code; redirect = location; },
  } as unknown as Response);
  return { redirect, status, headers };
}
test("automatic callback exchanges once, verifies profile, stores session and redirects safely", async () => {
  const f = setup(), state = f.state();
  const r = await callback(f.session, { state, status: "success", request_token: "request-once" });
  assert.equal(r.status, 303); assert.equal(r.redirect, "http://localhost:3000/settings?kite=connected");
  assert.equal(r.headers["Referrer-Policy"], "no-referrer"); assert.equal(r.headers["Cache-Control"], "no-store");
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [["POST", "/session/token"], ["GET", "/user/profile"]]);
  assert.equal(f.session.status().connectionStatus, "CONNECTED"); assert.equal(f.session.status().brokerAccountId, "AB1234");
  assert.equal(f.session.getMode(), "KITE_REAL"); // Data policy is independent of authentication.
  assert.equal(f.session.status().execution, "PaperBroker"); assert.equal(f.session.status().tradingPhase, "PAPER");
  assert.equal(f.session.status().tokenExpiry, "2026-09-30T00:30:00.000Z");
  const publicOutput = JSON.stringify([r, f.session.status()]);
  for (const secret of ["private-access", "private-secret", "request-once"]) assert.equal(publicOutput.includes(secret), false);
  assert.equal((await callback(f.session, { state, status: "success", request_token: "request-once" })).redirect.includes("INVALID_REQUEST"), true);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
for (const query of [{ status: "success" }, { status: "failed", request_token: "x" }, { status: "success", request_token: ["x", "y"] }])
  test(`callback rejects missing/invalid parameters ${JSON.stringify(query)}`, async () => {
    const f = setup(), r = await callback(f.session, { ...query, state: f.state() });
    assert.match(r.redirect, /kite=error/); assert.equal(f.calls.length, 0); assert.equal(f.session.status().tokenValid, false);
  });
test("callback rejects missing, wrong and expired state before exchange", async () => {
  const f = setup();
  for (const state of [undefined, "wrong"]) assert.match((await callback(f.session, { state, status: "success", request_token: "x" })).redirect, /INVALID_REQUEST/);
  const state = f.state(); f.setNow(Date.parse("2026-09-29T05:00:00Z"));
  assert.match((await callback(f.session, { state, status: "success", request_token: "x" })).redirect, /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
});
test("callback failed exchange clears old connected state and sanitizes broker secrets", async () => {
  const f = setup(); await f.session.exchange("old-request");
  f.failExchange({ response: { status: 403, data: { message: "private-secret private-access" } } });
  const r = await callback(f.session, { state: f.state(), status: "success", request_token: "new-request" });
  assert.equal(r.redirect, "http://localhost:3000/settings?kite=error&code=AUTHENTICATION_FAILED");
  assert.equal(f.session.status().tokenValid, false);
  await assert.rejects(f.session.get("/quote"), /SESSION_REQUIRED/);
});
test("manual failed refresh cannot preserve stale CONNECTED state", async () => {
  const f = setup(); await f.session.exchange("old");
  f.failExchange({ code: "ECONNRESET" }); await assert.rejects(f.session.exchange("new"), /NETWORK_ERROR/);
  assert.equal(f.session.status().connectionStatus, "SESSION_REQUIRED");
});
for (const oldExchangeFails of [false, true])
  test(`manual refresh preserves its session against an obsolete callback (${oldExchangeFails ? "broker failure" : "broker success"})`, async () => {
    const f = setup(), oldState = f.state();
    await f.session.exchange("newer-manual-request");
    const currentHeader = f.session.getAuthHeader().Authorization, callsBefore = f.calls.length;
    if (oldExchangeFails) f.failExchange({ response: { status: 403 } });
    const result = await callback(f.session, { state: oldState, status: "success", request_token: "older-callback-request" });
    assert.equal(result.redirect, "http://localhost:3000/settings?kite=error&code=INVALID_REQUEST");
    assert.equal(f.calls.length, callsBefore); // Reject before attempting the obsolete broker exchange.
    assert.equal(f.session.status().connectionStatus, "CONNECTED");
    assert.equal(f.session.getAuthHeader().Authorization, currentHeader);
  });
test("manual exchange completion does not invalidate a newer pending login", async () => {
  let release!: (value: unknown) => void;
  let postCount = 0;
  const manualResponse = new Promise(resolve => { release = resolve; });
  const client = { async post() {
    if (++postCount === 1) return manualResponse;
    return { data: success({ api_key: "key", access_token: "callback-access", user_id: "AB1234" }) };
  }, async get() { return { data: success({ user_id: "AB1234", broker: "ZERODHA" }) }; }
  } as unknown as Pick<AxiosInstance, "get" | "post">;
  const session = new KiteSessionService(client, () => ({ apiKey: "key", apiSecret: "secret" }));
  const manual = session.exchange("manual-request");
  const state = new URLSearchParams(new URL(session.beginLogin()).searchParams.get("redirect_params")!).get("state")!;
  release({ data: success({ api_key: "key", access_token: "manual-access", user_id: "AB1234" }) });
  await manual;
  assert.equal((await callback(session, { state, status: "success", request_token: "callback-request" })).redirect,
    "http://localhost:3000/settings?kite=connected");
  assert.equal(postCount, 2);
  assert.equal(session.status().connectionStatus, "CONNECTED");
});
for (const profile of [{ user_id: "OTHER", broker: "ZERODHA" }, { user_id: "AB1234", broker: "OTHER" }])
  test(`session rejects profile identity ${JSON.stringify(profile)}`, async () => {
    const f = setup(); f.setProfile(profile); await assert.rejects(f.session.exchange("request"), /AUTHENTICATION_FAILED/); assert.equal(f.session.status().tokenValid, false);
  });
test("session verifies expected account rather than only token presence", async () => {
  const f = setup(); assert.equal(f.session.status().tokenValid, false); f.setAccount("OTHER");
  await assert.rejects(f.session.exchange("request"), /AUTHENTICATION_FAILED/);
});
test("session expires at next 06:00 IST and clears on broker authentication failure", async () => {
  const f = setup(); await f.session.exchange("request");
  f.failGet({ response: { status: 403 } }); await assert.rejects(f.session.get("/quote"), /AUTHENTICATION_FAILED/);
  assert.equal(f.session.status().tokenValid, false);
  f.failGet(undefined); await f.session.exchange("request2"); f.setNow(Date.parse("2026-09-30T00:30:00Z"));
  await assert.rejects(f.session.get("/quote"), /SESSION_REQUIRED/); assert.equal(f.session.status().connectionStatus, "SESSION_REQUIRED");
});
test("status validation failure clears connection and never returns raw error details", async () => {
  const f = setup(); await f.session.exchange("request"); f.failGet({ response: { status: 503 }, message: "private-access" });
  assert.equal(await f.session.validate(), false); assert.equal(f.session.status().tokenValid, false);
});
test("session allowlist blocks arbitrary APIs and exposes no order-write capability", async () => {
  const f = setup(); await f.session.exchange("request"); const before = f.calls.length;
  for (const path of ["/orders", "/orders/regular", "/margins/orders", "https://evil.invalid", "/instruments/historical/../orders/day"])
    await assert.rejects(f.session.get(path), /INVALID_REQUEST/);
  assert.equal(f.calls.length, before); assert.equal("placeOrder" in f.session, false);
  assert.deepEqual(f.calls.filter(c => c.method !== "GET").map(c => c.path), ["/session/token"]);
});
test("session paces concurrent HTTP quote/history requests without retries", async () => {
  const f = setup(); await f.session.exchange("request");
  await Promise.all([f.session.get("/quote"), f.session.get("/quote/ltp"), f.session.get("/quote/ohlc")]);
  assert.deepEqual(f.sleeps, [1000, 1000]);
  f.failGet({ response: { status: 429 } }); const before = f.calls.length;
  await assert.rejects(f.session.get("/quote"), /RATE_LIMITED/); assert.equal(f.calls.length, before + 1);
});
test("normal session rejects MOCK and invalid modes without changing authentication", () => {
  const f = setup(); f.session.setMode("KITE_REAL"); assert.equal(f.session.getMode(), "KITE_REAL");
  assert.throws(() => f.session.setMode("LIVE"), /INVALID_REQUEST/); assert.equal(f.session.status().tokenValid, false);
  assert.throws(() => f.session.setMode("MOCK"), /DATA_MODE_REQUIRED/);
  assert.equal(f.session.getMode(), "KITE_REAL");
});
test("Settings status handler reflects profile-verified session and separate PAPER execution", async () => {
  const f = setup(); await f.session.exchange("request");
  const router = createKiteRouter(f.session, {} as KiteMarketDataService);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === "/status");
  let body: any;
  await layer.route.stack[0].handle({}, { json(value: unknown) { body = value; } });
  assert.equal(body.connectionStatus, "CONNECTED"); assert.equal(body.config.execution, "PaperBroker"); assert.equal(body.config.tradingPhase, "PAPER");
  assert.equal(body.dataMode, "KITE_REAL"); assert.equal(JSON.stringify(body).includes("private-access"), false);
});
test("market and session modules have no financial Mongo/execution imports", () => {
  for (const file of ["KiteSessionService.ts", "KiteMarketDataService.ts", "KiteMarketDataRuntime.ts"])
    assert.doesNotMatch(readFileSync(join(__dirname, "../../src/services", file), "utf8"), /from ["'][^"']*(models|mongoose|OrderManager|SignalLoop|PaperBroker|Greeks)/);
});
test("late successful exchange cannot overwrite a newer failed refresh", async () => {
  let release!: (value: unknown) => void;
  let count = 0;
  const old = new Promise(resolve => { release = resolve; });
  const client = { async post() { if (++count === 1) return old; throw { response: { status: 403 } }; },
    async get() { return { data: success({ user_id: "AB1234", broker: "ZERODHA" }) }; } } as unknown as Pick<AxiosInstance, "get" | "post">;
  const session = new KiteSessionService(client, () => ({ apiKey: "key", apiSecret: "secret" }));
  const first = session.exchange("old");
  await assert.rejects(session.exchange("new"), /AUTHENTICATION_FAILED/);
  release({ data: success({ api_key: "key", access_token: "old-access", user_id: "AB1234" }) });
  await assert.rejects(first, /AUTHENTICATION_FAILED/); assert.equal(session.status().tokenValid, false);
});
test("late quote from an invalidated session cannot return as authenticated evidence", async () => {
  let release!: (value: unknown) => void;
  const reply = new Promise(resolve => { release = resolve; });
  const client = { async post() { return { data: success({ api_key: "key", access_token: "access", user_id: "AB1234" }) }; },
    async get(path: string) { return path === "/user/profile" ? { data: success({ user_id: "AB1234", broker: "ZERODHA" }) } : reply; } } as unknown as Pick<AxiosInstance, "get" | "post">;
  const session = new KiteSessionService(client, () => ({ apiKey: "key", apiSecret: "secret" }));
  await session.exchange("first"); const quote = session.get("/quote"); await new Promise(resolve => setImmediate(resolve));
  await session.exchange("replacement"); release({ data: success({}) });
  await assert.rejects(quote, /SESSION_REQUIRED/); assert.equal(session.status().tokenValid, true);
});
test("asset-only start exposes the stable missing-account reason", async () => {
  const { default: router } = await import("../../src/routes/session");
  const { kiteSession } = await import("../../src/services/KiteService");
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === "/start");
  let status = 0, body: any;
  kiteSession.setMode("KITE_REAL");
  const { paperDefaultSession } = await import("../../src/services/PaperOrchestrationRuntime");
  const originalConfig = paperDefaultSession.config;
  paperDefaultSession.config = async () => { throw new Error("PAPER_ACCOUNT_REQUIRED"); };
  try {
    await layer.route.stack.at(-1).handle({ body: { asset: "NIFTY" } }, {
      status(value: number) { status = value; return this; }, json(value: unknown) { body = value; },
    }, (error: unknown) => { throw error; });
    assert.equal(status, 409); assert.equal(body.error, "PAPER_ACCOUNT_REQUIRED");
  } finally {
    paperDefaultSession.config = originalConfig; }
});
