import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { IndexCandleAccumulator, KiteIndexCandleStream, parseKiteIndexTicks,
  type CompletedIndexStreamBar } from "../../src/services/KiteIndexCandleStream";
import type { QualifiedIndex } from "../../src/services/KiteIndexDataService";
import { marketEvidenceExpiry, isMarketAnalyticsFresh } from "../../src/domain/marketAnalytics";
import { config, evaluationTime, realProvider } from "../fixtures/paperOrchestration";

const start = +evaluationTime - 300_000;
const token = 256265;
const packet = (priceMinor: number, exchangeAtMs: number, length = 32) => {
  const frame = Buffer.alloc(4 + length);
  frame.writeUInt16BE(1, 0);
  frame.writeUInt16BE(length, 2);
  frame.writeUInt32BE(token, 4);
  frame.writeInt32BE(priceMinor, 8);
  if (length === 32) frame.writeUInt32BE(exchangeAtMs / 1000, 32);
  return frame;
};

test("Kite index parser requires exact token, full-mode timestamp and current binary evidence", () => {
  assert.deepEqual(parseKiteIndexTicks(Buffer.from([0]), token, start), []);
  assert.deepEqual(parseKiteIndexTicks(packet(2_500_000, start), token, start + 1000),
    [{ priceMinor: 2_500_000, exchangeAtMs: start }]);
  assert.deepEqual(parseKiteIndexTicks(packet(2_500_000, start), token + 1, start + 1000), []);
  assert.throws(() => parseKiteIndexTicks(packet(2_500_000, start, 28), token, start + 1000),
    /INDEX_STREAM_TIMESTAMP_REQUIRED/);
  assert.throws(() => parseKiteIndexTicks(packet(2_500_000, start), token, start + 30_001),
    /STALE_INDEX_STREAM_TICK/);
  assert.throws(() => parseKiteIndexTicks(packet(2_500_000, start), token, start - 1),
    /STALE_INDEX_STREAM_TICK/);
  assert.throws(() => parseKiteIndexTicks(packet(0, start), token, start), /STALE_INDEX_STREAM_TICK/);
  assert.throws(() => parseKiteIndexTicks(packet(2_500_000, start).subarray(0, 35), token, start),
    /INVALID_INDEX_STREAM_FRAME/);
});

test("only an uninterrupted, fully observed five-minute index bar can finalize", () => {
  const candles = new IndexCandleAccumulator();
  candles.connect(start - 1000);
  for (let t = start; t < start + 300_000; t += 10_000)
    candles.observe({ exchangeAtMs: t, priceMinor: 2_500_000 + (t - start) / 10_000 });
  assert.deepEqual(candles.completed(start + 300_000), [{ startMs: start,
    openMinor: 2_500_000, highMinor: 2_500_029, lowMinor: 2_500_000,
    closeMinor: 2_500_029, volume: 0 }]);
  candles.disconnect();
  assert.deepEqual(candles.completed(start + 300_000), []);

  candles.connect(start + 60_000);
  for (let t = start + 60_000; t < start + 300_000; t += 10_000)
    candles.observe({ exchangeAtMs: t, priceMinor: 2_500_000 });
  assert.deepEqual(candles.completed(start + 300_000), []);

  candles.connect(start - 1000);
  candles.observe({ exchangeAtMs: start, priceMinor: 2_500_000 });
  candles.observe({ exchangeAtMs: start + 240_000, priceMinor: 2_500_001 });
  candles.observe({ exchangeAtMs: start + 290_000, priceMinor: 2_500_002 });
  assert.deepEqual(candles.completed(start + 300_000), []);
  assert.throws(() => candles.observe({ exchangeAtMs: start + 280_000, priceMinor: 2_500_000 }),
    /INDEX_STREAM_ORDER_INVALID/);
});

test("the read-only socket subscribes in full mode and discards bars on credential rotation", () => {
  class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    readonly sent: string[] = [];
    terminated = false;
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
    terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; }
  }
  let now = start - 1000;
  let generation = 1;
  const sockets: FakeSocket[] = [];
  const stream = new KiteIndexCandleStream(() => ({ apiKey: "fixture", accessToken: "fixture-token", generation }),
    () => now, () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const index = { instrumentToken: String(token), provenance: { sourceFingerprint: "fixture-master" } } as QualifiedIndex;
  stream.ensure(index);
  sockets[0]!.readyState = WebSocket.OPEN;
  sockets[0]!.emit("open");
  assert.deepEqual(sockets[0]!.sent.map(value => JSON.parse(value)), [
    { a: "subscribe", v: [token] }, { a: "mode", v: ["full", [token]] },
  ]);
  for (let t = start; t < start + 300_000; t += 10_000) {
    now = t + 1000;
    sockets[0]!.emit("message", packet(2_500_000, t), true);
  }
  now = start + 300_000;
  assert.equal(stream.completed(index).length, 1);
  generation = 2;
  stream.ensure(index);
  assert.equal(sockets[0]!.terminated, true);
  assert.equal(stream.completed(index).length, 0);
  assert.equal(sockets.length, 2);
  stream.stop();
});

test("a failed socket handshake is sanitized and can be retried", () => {
  class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    terminate() { this.readyState = WebSocket.CLOSED; }
  }
  const index = { instrumentToken: String(token), provenance: { sourceFingerprint: "fixture-master" } } as QualifiedIndex;
  let attempts = 0;
  const stream = new KiteIndexCandleStream(() => ({ apiKey: "fixture", accessToken: "private-token", generation: 1 }),
    () => start, () => {
      if (++attempts === 1) throw new Error("private-token handshake detail");
      return new FakeSocket() as unknown as WebSocket;
    });
  assert.throws(() => stream.ensure(index), error => error instanceof Error
    && error.message === "KITE_STREAM_UNAVAILABLE");
  stream.ensure(index);
  assert.equal(attempts, 2);
  stream.stop();
});

const liveBar: CompletedIndexStreamBar = { startMs: start, openMinor: 2_499_900,
  highMinor: 2_500_100, lowMinor: 2_499_800, closeMinor: 2_499_800, volume: 0 };

test("completed streamed bar bridges delayed REST history without extending quote freshness", async () => {
  const now = new Date(+evaluationTime + 27_000);
  const stream = { ensure() {}, stop() {}, completed: () => [liveBar] };
  const real = await realProvider(() => now, false, stream);
  real.state.historyLagBars = 1;
  const paper = { ...config("LONG_OPTION"), dataMode: "KITE_REAL" as const };
  await real.provider.prepare(paper);
  const captured = await real.provider.capture(paper);
  assert.equal(captured.analytics.available, true, JSON.stringify(captured.analytics));
  if (!captured.analytics.available) return;
  assert.equal(captured.analytics.snapshot.indicators.lastFinalizedAt, evaluationTime.toISOString());
  assert.equal(marketEvidenceExpiry(captured.analytics.snapshot), +now + paper.maxAgeMs);
  assert.equal(isMarketAnalyticsFresh(captured.analytics.snapshot, +now + 4000), true);
  assert.equal(isMarketAnalyticsFresh(captured.analytics.snapshot, +now + paper.maxAgeMs + 1), false);

  const delayed = await realProvider(() => now);
  delayed.state.historyLagBars = 1;
  await delayed.provider.prepare(paper);
  const older = await delayed.provider.capture(paper);
  assert.equal(older.analytics.available, true);
  if (older.analytics.available)
    assert.equal(isMarketAnalyticsFresh(older.analytics.snapshot, +now + 4000), false);
});

test("late evaluation uses the newly completed bar and fails closed if Kite still serves the prior bar", async () => {
  const now = new Date(+evaluationTime + 45_000);
  const paper = { ...config("LONG_OPTION"), dataMode: "KITE_REAL" as const };
  const current = await realProvider(() => now);
  await current.provider.prepare(paper);
  const fresh = await current.provider.capture(paper);
  assert.equal(fresh.analytics.available, true);
  if (fresh.analytics.available)
    assert.equal(fresh.analytics.snapshot.indicators.lastFinalizedAt, evaluationTime.toISOString());

  const delayed = await realProvider(() => now);
  delayed.state.historyLagBars = 1;
  await delayed.provider.prepare(paper);
  assert.deepEqual((await delayed.provider.capture(paper)).analytics,
    { available: false, reason: "MARKET_DATA_NOT_FRESH" });
});

test("streamed candle cannot bridge a missing same-day broker bar", async () => {
  const now = new Date(+evaluationTime + 27_000);
  const real = await realProvider(() => now, false, { ensure() {}, stop() {}, completed: () => [liveBar] });
  real.state.historyLagBars = 2;
  const paper = { ...config("LONG_OPTION"), dataMode: "KITE_REAL" as const };
  await real.provider.prepare(paper);
  assert.deepEqual((await real.provider.capture(paper)).analytics,
    { available: false, reason: "MARKET_DATA_NOT_FRESH" });
});

test("five-minute readiness checks keep healthy masters and the live subscription", async () => {
  const calls = { stops: 0, ensures: 0 };
  const stream = { ensure() { calls.ensures++; }, stop() { calls.stops++; }, completed: () => [] };
  const real = await realProvider(() => evaluationTime, false, stream);
  const paper = { ...config("LONG_OPTION"), dataMode: "KITE_REAL" as const };
  await real.provider.prepare(paper);
  const first = calls.stops;
  await real.provider.prepare(paper);
  assert.equal(calls.stops, first);
  assert.equal(calls.ensures, 2);
});
