import { assertQualifiedInstrument, type InstrumentDefinition, type KiteInstrumentMaster } from "./KiteInstrumentMasterService";
import type { KiteMarketSession, MarketDataMode } from "./KiteSessionService";
import { fail, freeze, istDate, marketTimestamp, object, priceMinor, responseData, safeMarketError, units } from "../domain/kiteMarketData";

export const historicalIntervals = ["minute", "3minute", "5minute", "10minute", "15minute", "30minute", "60minute", "day"] as const;
export type HistoricalInterval = typeof historicalIntervals[number];
export interface Freshness {
  readonly state: "FRESH" | "STALE" | "UNAVAILABLE";
  readonly brokerAgeMs: number | null;
  readonly fetchedAgeMs: number;
  readonly evaluatedAt: string;
  readonly maxAgeMs: number;
  readonly ruleVersion: "KITE_EXCHANGE_AGE_V1";
}
export interface MarketProvenance {
  readonly source: "KITE"; readonly dataMode: "KITE_REAL"; readonly normalizationVersion: 1;
  readonly instrument: InstrumentDefinition; readonly fetchedAt: string;
  readonly masterVersion: string; readonly masterFingerprint: string;
}
export interface MarketQuote extends MarketProvenance {
  readonly kind: "LTP" | "QUOTE" | "OHLC";
  readonly lastPriceMinor: number;
  readonly ohlc: Readonly<{ openMinor: number; highMinor: number; lowMinor: number; previousCloseMinor: number }> | null;
  readonly volume: number | null; readonly oi: number | null;
  readonly depth: Readonly<{ buy: readonly DepthLevel[]; sell: readonly DepthLevel[] }> | null;
  readonly brokerTimestamp: string | null; readonly lastTradeTimestamp: string | null;
  readonly freshness: Freshness;
}
interface DepthLevel { readonly priceMinor: number; readonly quantity: number; readonly orders: number }
export interface HistoricalCandle extends MarketProvenance {
  readonly interval: HistoricalInterval; readonly timestamp: string;
  readonly openMinor: number; readonly highMinor: number; readonly lowMinor: number; readonly closeMinor: number;
  readonly volume: number; readonly oi: number | null;
}
export interface HistoricalResult extends MarketProvenance {
  readonly interval: HistoricalInterval; readonly requestedRange: Readonly<{ from: string; to: string }>;
  readonly actualRange: Readonly<{ from: string; to: string }>;
  readonly candles: readonly HistoricalCandle[];
}
const issued = new WeakMap<object, { service: KiteMarketDataService; instrument: InstrumentDefinition }>();
function freshness(quote: Pick<MarketQuote, "fetchedAt" | "brokerTimestamp">, now: number, maxAgeMs: number): Freshness {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(now)) return fail("INVALID_REQUEST");
  const fetchedAgeMs = now - Date.parse(quote.fetchedAt), brokerAgeMs = quote.brokerTimestamp === null ? null : now - Date.parse(quote.brokerTimestamp);
  return freeze({ state: brokerAgeMs === null ? "UNAVAILABLE" : fetchedAgeMs < 0 || brokerAgeMs < 0 || fetchedAgeMs > maxAgeMs || brokerAgeMs > maxAgeMs ? "STALE" : "FRESH",
    brokerAgeMs, fetchedAgeMs, evaluatedAt: new Date(now).toISOString(), maxAgeMs, ruleVersion: "KITE_EXCHANGE_AGE_V1" });
}
/** Re-evaluates age at consumption, and checks the service's active snapshot again. */
export function assertQualifiedRealMarketData(value: unknown, options: { maxAgeMs: number; instrument: InstrumentDefinition }): asserts value is MarketQuote {
  const proof = value && typeof value === "object" ? issued.get(value) : undefined;
  if (!proof || proof.instrument !== options.instrument) return fail("REAL_DATA_REQUIRED");
  proof.service.assertCurrentInstrument(options.instrument);
  if (proof.service.evaluateFreshness(value as MarketQuote, options.maxAgeMs).state !== "FRESH") return fail("STALE_MARKET_DATA");
}
/** Explicit request-only HTTP service. No timers, writes, caching, mocks or strategy dependencies. */
export class KiteMarketDataService {
  private master: KiteInstrumentMaster | null = null;
  private loading: Promise<KiteInstrumentMaster> | null = null;
  constructor(private readonly session: KiteMarketSession, private readonly load: () => Promise<KiteInstrumentMaster>,
    private readonly mode: () => MarketDataMode, private readonly clock: () => number = Date.now) {}
  private real() { if (this.mode() !== "KITE_REAL") fail("DATA_MODE_REQUIRED"); }
  async refreshMaster(): Promise<KiteInstrumentMaster> {
    this.real();
    if (this.loading) return this.loading;
    this.master = null; // failed refresh must not leave the previous snapshot available.
    this.loading = this.load().then(master => { this.checkMaster(master); this.master = master; return master; })
      .finally(() => { this.loading = null; });
    return this.loading;
  }
  private checkMaster(master: KiteInstrumentMaster) {
    const now = this.clock(), retrieved = Date.parse(master.provenance.retrievedAt), today = istDate(now);
    // Conservative daily use: explicit HTTP reload after 08:30 IST, never an old token map.
    const earliest = Date.parse(`${today}T08:30:00+05:30`);
    if (!Number.isFinite(retrieved) || retrieved < earliest || retrieved > now || istDate(retrieved) !== today
      || master.provenance.retrievedLocalDate !== today) fail("INSTRUMENT_MASTER_STALE");
  }
  activeMaster(): KiteInstrumentMaster {
    this.real(); if (!this.master) return fail("INSTRUMENT_MASTER_STALE");
    this.checkMaster(this.master); return this.master;
  }
  assertCurrentInstrument(instrument: InstrumentDefinition): void {
    try { assertQualifiedInstrument(instrument); } catch { return fail("QUALIFIED_INSTRUMENT_REQUIRED"); }
    const master = this.activeMaster();
    if (instrument.expiry < istDate(this.clock())) return fail("HISTORICAL_INSTRUMENT_UNAVAILABLE");
    try {
      if (master.getInstrumentByCanonicalId(instrument.canonicalId) !== instrument
        || master.getByCurrentInstrumentToken(instrument.instrumentToken) !== instrument
        || instrument.provenance !== master.provenance) return fail("INSTRUMENT_MASTER_STALE");
    } catch { return fail("INSTRUMENT_MASTER_STALE"); }
  }
  private provenance(instrument: InstrumentDefinition): MarketProvenance {
    return { source: "KITE", dataMode: "KITE_REAL", normalizationVersion: 1, instrument,
      fetchedAt: new Date(this.clock()).toISOString(), masterVersion: instrument.provenance.masterVersion,
      masterFingerprint: instrument.provenance.sourceFingerprint };
  }
  evaluateFreshness(quote: MarketQuote, maxAgeMs: number): Freshness { return freshness(quote, this.clock(), maxAgeMs); }
  getLtp(instrument: InstrumentDefinition, maxAgeMs: number) { return this.quotes([instrument], "LTP", maxAgeMs).then(rows => rows[0]); }
  getQuote(instrument: InstrumentDefinition, maxAgeMs: number) { return this.quotes([instrument], "QUOTE", maxAgeMs).then(rows => rows[0]); }
  getOhlc(instrument: InstrumentDefinition, maxAgeMs: number) { return this.quotes([instrument], "OHLC", maxAgeMs).then(rows => rows[0]); }
  getQuotes(instruments: readonly InstrumentDefinition[], maxAgeMs: number) { return this.quotes(instruments, "QUOTE", maxAgeMs); }
  private async quotes(instruments: readonly InstrumentDefinition[], kind: MarketQuote["kind"], maxAgeMs: number): Promise<readonly MarketQuote[]> {
    if (!instruments.length || instruments.length > (kind === "QUOTE" ? 500 : 1000)
      || new Set(instruments.map(i => i.canonicalId)).size !== instruments.length || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return fail("INVALID_REQUEST");
    for (const instrument of instruments) this.assertCurrentInstrument(instrument);
    const params = new URLSearchParams(); for (const i of instruments) params.append("i", i.contractKey);
    try {
      const data = responseData(await this.session.get(kind === "QUOTE" ? "/quote" : kind === "LTP" ? "/quote/ltp" : "/quote/ohlc", params));
      const result = instruments.map(instrument => {
        this.assertCurrentInstrument(instrument);
        if (!Object.hasOwnProperty.call(data, instrument.contractKey)) return fail("QUOTE_UNAVAILABLE");
        const raw = object(data[instrument.contractKey]);
        const token = typeof raw.instrument_token === "string" && /^[1-9]\d{0,29}$/.test(raw.instrument_token)
          ? raw.instrument_token : String(units(raw.instrument_token));
        if (token !== instrument.instrumentToken) return fail();
        const lastPriceMinor = priceMinor(raw.last_price);
        const o = kind === "LTP" ? null : object(raw.ohlc);
        const ohlc = o === null ? null : { openMinor: priceMinor(o.open), highMinor: priceMinor(o.high), lowMinor: priceMinor(o.low), previousCloseMinor: priceMinor(o.close) };
        // Quote close is PREVIOUS session close, not a same-bar close.
        if (ohlc && (ohlc.highMinor < ohlc.lowMinor || ohlc.openMinor < ohlc.lowMinor || ohlc.openMinor > ohlc.highMinor)) return fail();
        const levels = (value: unknown): DepthLevel[] => {
          if (!Array.isArray(value) || value.length > 5) return fail();
          return value.map(v => { const level = object(v); return { priceMinor: priceMinor(level.price), quantity: units(level.quantity), orders: units(level.orders) }; });
        };
        const d = raw.depth == null ? null : object(raw.depth);
        const fields = { ...this.provenance(instrument), kind, lastPriceMinor, ohlc,
          volume: raw.volume == null ? null : units(raw.volume), oi: raw.oi == null ? null : units(raw.oi),
          depth: d === null ? null : { buy: levels(d.buy), sell: levels(d.sell) },
          brokerTimestamp: raw.timestamp == null ? null : marketTimestamp(raw.timestamp, true),
          lastTradeTimestamp: raw.last_trade_time == null ? null : marketTimestamp(raw.last_trade_time, true) };
        return freeze({ ...fields, freshness: freshness(fields, this.clock(), maxAgeMs) });
      });
      for (const quote of result) issued.set(quote, { service: this, instrument: quote.instrument });
      return Object.freeze(result);
    } catch (error) { throw safeMarketError(error); }
  }
  async getHistoricalCandles(input: { instrument: InstrumentDefinition; from: string; to: string; interval: HistoricalInterval }): Promise<HistoricalResult> {
    this.assertCurrentInstrument(input.instrument);
    if (!historicalIntervals.includes(input.interval)) return fail("INVALID_REQUEST");
    let from: string, to: string;
    try { from = marketTimestamp(input.from); to = marketTimestamp(input.to); } catch { return fail("INVALID_REQUEST"); }
    const start = Date.parse(from), end = Date.parse(to), day = 86400000;
    // Conservative 29-day chunks are below all published interval limits; max 24 chunks.
    const span = 29 * day;
    if (start > end || end > this.clock() || end - start > 24 * span || start % 1000 || end % 1000) return fail("INVALID_REQUEST");
    const merged = new Map<string, HistoricalCandle>();
    const wireDate = (ms: number) => new Date(ms + 19800000).toISOString().slice(0, 19).replace("T", " ");
    try {
      for (let index = 0; index < Math.max(1, Math.ceil((end - start) / span)); index++) {
        const left = start + index * span, right = Math.min(left + span, end);
        this.assertCurrentInstrument(input.instrument);
        const raw = responseData(await this.session.get(`/instruments/historical/${input.instrument.instrumentToken}/${input.interval}`,
          new URLSearchParams({ from: wireDate(left), to: wireDate(right), continuous: "0", oi: "1" })));
        this.assertCurrentInstrument(input.instrument);
        if (!Array.isArray(raw.candles) || raw.candles.length > 50000) return fail();
        const provenance = this.provenance(input.instrument);
        for (const row of raw.candles) {
          if (!Array.isArray(row) || (row.length !== 6 && row.length !== 7)) return fail();
          const timestamp = marketTimestamp(row[0]), time = Date.parse(timestamp);
          if (time < left || time > right) return fail();
          const candle: HistoricalCandle = freeze({ ...provenance, interval: input.interval, timestamp,
            openMinor: priceMinor(row[1]), highMinor: priceMinor(row[2]), lowMinor: priceMinor(row[3]), closeMinor: priceMinor(row[4]),
            volume: units(row[5]), oi: row.length === 7 ? units(row[6]) : null });
          if (candle.highMinor < candle.lowMinor || candle.openMinor < candle.lowMinor || candle.openMinor > candle.highMinor
            || candle.closeMinor < candle.lowMinor || candle.closeMinor > candle.highMinor) return fail();
          const previous = merged.get(timestamp);
          const economics = (c: HistoricalCandle) => [c.openMinor, c.highMinor, c.lowMinor, c.closeMinor, c.volume, c.oi];
          if (previous && JSON.stringify(economics(previous)) !== JSON.stringify(economics(candle))) return fail();
          if (!previous) merged.set(timestamp, candle);
        }
      }
      if (!merged.size) return fail("HISTORICAL_DATA_UNAVAILABLE");
      const candles = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return freeze({ ...this.provenance(input.instrument), interval: input.interval, requestedRange: { from, to },
        actualRange: { from: candles[0].timestamp, to: candles[candles.length - 1].timestamp }, candles });
    } catch (error) { throw safeMarketError(error); }
  }
}
