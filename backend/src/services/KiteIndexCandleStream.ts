import WebSocket from "ws";
import type { QualifiedIndex } from "./KiteIndexDataService";

const FIVE_MINUTES_MS = 300_000;
const MAX_TICK_AGE_MS = 30_000;
const MAX_TICK_GAP_MS = 30_000;
const MAX_BARS = 32;

export interface KiteStreamCredentials {
  readonly apiKey: string;
  readonly accessToken: string;
  readonly generation: number;
}

export interface IndexStreamTick {
  readonly priceMinor: number;
  readonly exchangeAtMs: number;
}

export interface CompletedIndexStreamBar {
  readonly startMs: number;
  readonly openMinor: number;
  readonly highMinor: number;
  readonly lowMinor: number;
  readonly closeMinor: number;
  /** NSE indices have no traded volume in Kite's index tick packet. */
  readonly volume: 0;
}

/** Accept only the timestamped, 32-byte full-mode packet for our exact index token. */
export function parseKiteIndexTicks(frame: Buffer, expectedToken: number, receivedAtMs: number): IndexStreamTick[] {
  if (frame.length === 1) return []; // Kite's binary heartbeat.
  if (frame.length < 4 || frame.length > 1_000_000) throw new Error("INVALID_INDEX_STREAM_FRAME");
  const count = frame.readUInt16BE(0);
  if (count < 1 || count > 3000) throw new Error("INVALID_INDEX_STREAM_FRAME");
  const ticks: IndexStreamTick[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > frame.length) throw new Error("INVALID_INDEX_STREAM_FRAME");
    const length = frame.readUInt16BE(offset);
    offset += 2;
    if (length < 8 || offset + length > frame.length) throw new Error("INVALID_INDEX_STREAM_FRAME");
    const packet = frame.subarray(offset, offset + length);
    offset += length;
    if (packet.readUInt32BE(0) !== expectedToken) continue;
    if (length !== 32) throw new Error("INDEX_STREAM_TIMESTAMP_REQUIRED");
    const priceMinor = packet.readInt32BE(4);
    const exchangeAtMs = packet.readUInt32BE(28) * 1000;
    if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0
      || exchangeAtMs > receivedAtMs || receivedAtMs - exchangeAtMs > MAX_TICK_AGE_MS)
      throw new Error("STALE_INDEX_STREAM_TICK");
    ticks.push({ priceMinor, exchangeAtMs });
  }
  if (offset !== frame.length) throw new Error("INVALID_INDEX_STREAM_FRAME");
  return ticks;
}

interface WorkingBar extends CompletedIndexStreamBar {
  readonly firstTickAtMs: number;
  readonly lastTickAtMs: number;
  readonly largestGapMs: number;
}

/** A bar is usable only if one uninterrupted subscription covered its whole interval. */
export class IndexCandleAccumulator {
  private connectedAtMs: number | null = null;
  private lastExchangeAtMs: number | null = null;
  private bars = new Map<number, WorkingBar>();

  connect(atMs: number): void {
    this.bars.clear();
    this.lastExchangeAtMs = null;
    this.connectedAtMs = atMs;
  }

  disconnect(): void {
    this.bars.clear();
    this.lastExchangeAtMs = null;
    this.connectedAtMs = null;
  }

  observe(tick: IndexStreamTick): void {
    if (this.connectedAtMs === null) throw new Error("INDEX_STREAM_ORDER_INVALID");
    // Exchange timestamps have one-second precision; an already queued first tick
    // can predate subscription by a fraction of a second and proves no coverage.
    if (tick.exchangeAtMs < this.connectedAtMs) return;
    if (this.lastExchangeAtMs !== null && tick.exchangeAtMs < this.lastExchangeAtMs)
      throw new Error("INDEX_STREAM_ORDER_INVALID");
    this.lastExchangeAtMs = tick.exchangeAtMs;
    const startMs = Math.floor(tick.exchangeAtMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const prior = this.bars.get(startMs);
    this.bars.set(startMs, prior ? {
      ...prior, highMinor: Math.max(prior.highMinor, tick.priceMinor),
      lowMinor: Math.min(prior.lowMinor, tick.priceMinor), closeMinor: tick.priceMinor,
      lastTickAtMs: tick.exchangeAtMs,
      largestGapMs: Math.max(prior.largestGapMs, tick.exchangeAtMs - prior.lastTickAtMs),
    } : {
      startMs, openMinor: tick.priceMinor, highMinor: tick.priceMinor,
      lowMinor: tick.priceMinor, closeMinor: tick.priceMinor, volume: 0,
      firstTickAtMs: tick.exchangeAtMs, lastTickAtMs: tick.exchangeAtMs, largestGapMs: 0,
    });
    while (this.bars.size > MAX_BARS) this.bars.delete(this.bars.keys().next().value!);
  }

  completed(nowMs: number): CompletedIndexStreamBar[] {
    if (this.connectedAtMs === null) return [];
    return [...this.bars.values()].filter(bar => {
      const endMs = bar.startMs + FIVE_MINUTES_MS;
      return endMs <= nowMs && this.connectedAtMs! <= bar.startMs
        && bar.firstTickAtMs <= bar.startMs + MAX_TICK_GAP_MS
        && bar.lastTickAtMs >= endMs - MAX_TICK_GAP_MS
        && bar.largestGapMs <= MAX_TICK_GAP_MS;
    }).map(({ startMs, openMinor, highMinor, lowMinor, closeMinor, volume }) =>
      ({ startMs, openMinor, highMinor, lowMinor, closeMinor, volume }));
  }
}

/** Read-only Kite subscription. A disconnect or malformed frame discards partial bars. */
export class KiteIndexCandleStream {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: string | null = null;
  private index: QualifiedIndex | null = null;
  private attempts = 0;
  private readonly candles = new IndexCandleAccumulator();

  constructor(private readonly credentials: () => KiteStreamCredentials,
    private readonly clock: () => number = Date.now,
    private readonly connectSocket: (url: string) => WebSocket = url => new WebSocket(url, { handshakeTimeout: 10_000 })) {}

  ensure(index: QualifiedIndex): void {
    let credentials: KiteStreamCredentials;
    try { credentials = this.credentials(); }
    catch (error) { this.stop(); throw error; }
    if (!credentials.apiKey || !credentials.accessToken || !Number.isSafeInteger(credentials.generation)) {
      this.stop();
      throw new Error("KITE_SESSION_REQUIRED");
    }
    const identity = `${credentials.generation}:${index.instrumentToken}:${index.provenance.sourceFingerprint}`;
    const token = Number(index.instrumentToken);
    if (!Number.isSafeInteger(token) || token <= 0 || token > 0xffff_ffff)
      throw new Error("QUALIFIED_INSTRUMENT_REQUIRED");
    if (this.identity === identity && this.index === index) {
      if (!this.socket && !this.reconnectTimer) this.connect(credentials, identity, index);
      return;
    }
    this.stop();
    this.identity = identity;
    this.index = index;
    this.connect(credentials, identity, index);
  }

  completed(index: QualifiedIndex): CompletedIndexStreamBar[] {
    if (this.index !== index || this.socket?.readyState !== WebSocket.OPEN) return [];
    try {
      const credentials = this.credentials();
      if (this.identity !== `${credentials.generation}:${index.instrumentToken}:${index.provenance.sourceFingerprint}`) {
        this.stop();
        return [];
      }
      return this.candles.completed(this.clock());
    } catch { this.stop(); return []; }
  }

  stop(): void {
    this.identity = null;
    this.index = null;
    this.candles.disconnect();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {}); // A connecting socket can error as it is terminated.
      socket.terminate();
    }
  }

  private connect(credentials: KiteStreamCredentials, identity: string, index: QualifiedIndex): void {
    if (this.identity !== identity || this.index !== index) return;
    const url = new URL("wss://ws.kite.trade");
    url.search = new URLSearchParams({ api_key: credentials.apiKey, access_token: credentials.accessToken }).toString();
    let socket: WebSocket;
    try { socket = this.connectSocket(url.toString()); }
    catch { throw new Error("KITE_STREAM_UNAVAILABLE"); }
    this.socket = socket;
    const token = Number(index.instrumentToken);
    socket.on("open", () => {
      if (this.socket !== socket || this.identity !== identity) return;
      this.attempts = 0;
      this.candles.connect(this.clock());
      try {
        socket.send(JSON.stringify({ a: "subscribe", v: [token] }));
        socket.send(JSON.stringify({ a: "mode", v: ["full", [token]] }));
      } catch { this.candles.disconnect(); socket.terminate(); }
    });
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket || this.identity !== identity) return;
      if (!isBinary) {
        try { if (JSON.parse(String(data))?.type === "error") socket.terminate(); }
        catch { socket.terminate(); }
        return;
      }
      try {
        const receivedAtMs = this.clock();
        const frame = Buffer.isBuffer(data) ? data : Array.isArray(data)
          ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        for (const tick of parseKiteIndexTicks(frame, token, receivedAtMs)) this.candles.observe(tick);
      } catch { this.candles.disconnect(); socket.terminate(); }
    });
    socket.on("error", () => { this.candles.disconnect(); socket.terminate(); });
    socket.on("close", () => {
      if (this.socket !== socket || this.identity !== identity) return;
      this.socket = null;
      this.candles.disconnect();
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        try {
          const current = this.credentials();
          if (current.generation !== credentials.generation || current.accessToken !== credentials.accessToken)
            return this.stop();
          this.connect(current, identity, index);
        } catch { this.stop(); }
      }, delay);
      this.reconnectTimer.unref?.();
    });
  }
}
