import { createHash } from "node:crypto";
import type { AssetKey } from "../config/assets";
import { parseInstrumentCsv } from "../domain/instrumentCsv";
import { fail, freeze, istDate, marketTimestamp, object, priceMinor, responseData, safeMarketError, units } from "../domain/kiteMarketData";
import type { Freshness, HistoricalInterval } from "./KiteMarketDataService";
import { historicalIntervals } from "./KiteMarketDataService";
import type { KiteMarketSession, MarketDataMode } from "./KiteSessionService";

/** Broker documented index symbols; the CSV supplies the actual token and routing identity. */
const symbols = { NIFTY: "NIFTY 50", BANKNIFTY: "NIFTY BANK", FINNIFTY: "NIFTY FIN SERVICE" } as const;
export interface QualifiedIndex {
  readonly canonicalId: string;
  readonly underlying: AssetKey;
  readonly broker: "KITE";
  readonly exchange: "NSE";
  readonly segment: "INDICES" | "NSE-INDICES";
  readonly tradingsymbol: string;
  readonly contractKey: string;
  readonly instrumentToken: string;
  readonly exchangeToken: string;
  readonly role: "REFERENCE_ONLY";
  readonly provenance: IndexMasterProvenance;
}
export interface IndexMasterProvenance {
  readonly source: "KITE_INSTRUMENT_MASTER";
  readonly endpoint: "/instruments";
  readonly sourceFingerprint: string;
  readonly masterVersion: string;
  readonly retrievedAt: string;
  readonly retrievedLocalDate: string;
  readonly normalizationVersion: 1;
}
export interface IndexMaster {
  readonly provenance: IndexMasterProvenance;
  readonly indices: readonly QualifiedIndex[];
  resolve(underlying: AssetKey): QualifiedIndex;
}
const qualified = new WeakSet<object>();
export function assertQualifiedIndex(value: unknown): asserts value is QualifiedIndex {
  if (!value || typeof value !== "object" || !qualified.has(value)) fail("QUALIFIED_INSTRUMENT_REQUIRED");
}
const token = (s: unknown) => typeof s === "string" && /^[1-9]\d{0,29}$/.test(s);
const price = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Exact NSE index rows only. Missing/ambiguous rows fail per underlying, never gain an invented token. */
export function qualifyIndexMaster(csv: string, retrievedAt: string): IndexMaster {
  let rows: string[][];
  try { rows = parseInstrumentCsv(csv); } catch { return fail(); }
  const header = rows.shift();
  const columns = ["instrument_token", "exchange_token", "tradingsymbol", "name", "expiry", "strike",
    "tick_size", "lot_size", "instrument_type", "segment", "exchange"];
  if (!header || new Set(header).size !== header.length || columns.some(c => !header.includes(c))) return fail();
  let normalizedAt: string;
  try { normalizedAt = marketTimestamp(retrievedAt); } catch { return fail(); }
  const fingerprint = createHash("sha256").update(csv).digest("hex");
  const provenance: IndexMasterProvenance = freeze({ source: "KITE_INSTRUMENT_MASTER", endpoint: "/instruments",
    sourceFingerprint: fingerprint, masterVersion: `kite-index-v1:${fingerprint}`, retrievedAt: normalizedAt,
    retrievedLocalDate: istDate(Date.parse(normalizedAt)), normalizationVersion: 1 });
  const found = new Map<AssetKey, QualifiedIndex>(), usedTokens = new Set<string>();
  for (const fields of rows) {
    if (fields.length !== header.length) return fail();
    const row = Object.fromEntries(header.map((column, index) => [column, fields[index]]));
    const underlying = (Object.keys(symbols) as AssetKey[]).find(key => row.tradingsymbol === symbols[key]);
    if (!underlying) continue;
    // An index is a reference price, never an executable NFO contract.
    if (row.exchange !== "NSE" || (row.segment !== "INDICES" && row.segment !== "NSE-INDICES")
      || row.instrument_type !== "EQ" || row.name !== symbols[underlying]
      || row.expiry !== "" || !["", "0", "0.0"].includes(row.strike)
      || !["0", "0.0", ""].includes(row.tick_size) || row.lot_size !== "0"
      || !token(row.instrument_token) || !token(row.exchange_token) || found.has(underlying)
      || usedTokens.has(row.instrument_token)) return fail();
    const index: QualifiedIndex = freeze({ canonicalId: `KITE:NSE:INDEX:${underlying}`, underlying,
      broker: "KITE", exchange: "NSE", segment: row.segment, tradingsymbol: row.tradingsymbol,
      contractKey: `NSE:${row.tradingsymbol}`, instrumentToken: row.instrument_token,
      exchangeToken: row.exchange_token, role: "REFERENCE_ONLY", provenance });
    qualified.add(index); found.set(underlying, index); usedTokens.add(row.instrument_token);
  }
  if (!found.size) return fail("QUALIFIED_INSTRUMENT_REQUIRED");
  return freeze({ provenance, indices: [...found.values()], resolve(underlying: AssetKey) {
    if (!Object.hasOwnProperty.call(symbols, underlying)) return fail("QUALIFIED_INSTRUMENT_REQUIRED");
    return found.get(underlying) ?? fail("QUALIFIED_INSTRUMENT_REQUIRED");
  } });
}

interface IndexEvidence {
  readonly source: "KITE";
  readonly dataMode: "KITE_REAL";
  readonly index: QualifiedIndex;
  readonly canonicalId: string;
  readonly fetchedAt: string;
  readonly masterVersion: string;
  readonly masterFingerprint: string;
  readonly normalizationVersion: 1;
}
export interface IndexQuote extends IndexEvidence {
  readonly priceMinor: number;
  readonly brokerTimestamp: string | null;
  readonly freshness: Freshness;
}
export interface IndexCandle extends IndexEvidence {
  readonly interval: HistoricalInterval;
  readonly timestamp: string;
  readonly openMinor: number;
  readonly highMinor: number;
  readonly lowMinor: number;
  readonly closeMinor: number;
  readonly volume: number;
}
export interface IndexHistory extends IndexEvidence {
  readonly interval: HistoricalInterval;
  readonly requestedRange: Readonly<{ from: string; to: string }>;
  readonly actualRange: Readonly<{ from: string; to: string }>;
  readonly candles: readonly IndexCandle[];
}
const issuedQuote = new WeakMap<object, KiteIndexDataService>();
const issuedHistory = new WeakMap<object, KiteIndexDataService>();
function freshness(fetchedAt: string, brokerTimestamp: string | null, now: number, maxAgeMs: number): Freshness {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(now)) return fail("INVALID_REQUEST");
  const fetchedAgeMs = now - Date.parse(fetchedAt), brokerAgeMs = brokerTimestamp === null ? null : now - Date.parse(brokerTimestamp);
  return freeze({ state: brokerAgeMs === null ? "UNAVAILABLE" : fetchedAgeMs < 0 || brokerAgeMs < 0
    || fetchedAgeMs > maxAgeMs || brokerAgeMs > maxAgeMs ? "STALE" : "FRESH",
    fetchedAgeMs, brokerAgeMs, evaluatedAt: new Date(now).toISOString(), maxAgeMs, ruleVersion: "KITE_EXCHANGE_AGE_V1" });
}
/** A copied object has no runtime proof, even if all public fields match. */
export function assertQualifiedRealIndexQuote(value: unknown, index: QualifiedIndex, maxAgeMs: number): asserts value is IndexQuote {
  const service = value && typeof value === "object" ? issuedQuote.get(value) : undefined;
  if (!service || (value as IndexQuote).index !== index) return fail("REAL_DATA_REQUIRED");
  service.assertCurrentIndex(index);
  if (service.evaluateFreshness(value as IndexQuote, maxAgeMs).state !== "FRESH") return fail("STALE_MARKET_DATA");
}
export function assertQualifiedRealIndexHistory(value: unknown, index: QualifiedIndex): asserts value is IndexHistory {
  const service = value && typeof value === "object" ? issuedHistory.get(value) : undefined;
  if (!service || (value as IndexHistory).index !== index) return fail("REAL_DATA_REQUIRED");
  service.assertCurrentIndex(index);
}

/** Read-only, explicitly refreshed NSE index feed; no orders, workers or fallback. */
export class KiteIndexDataService {
  private master: IndexMaster | null = null;
  private loading: Promise<IndexMaster> | null = null;
  constructor(private readonly session: KiteMarketSession, private readonly load: () => Promise<IndexMaster>,
    private readonly mode: () => MarketDataMode, private readonly clock: () => number = Date.now) {}
  private real() { if (this.mode() !== "KITE_REAL") fail("DATA_MODE_REQUIRED"); }
  private checkMaster(master: IndexMaster) {
    const now = this.clock(), today = istDate(now), retrieved = Date.parse(master.provenance.retrievedAt);
    const earliest = Date.parse(`${today}T08:30:00+05:30`);
    if (!Number.isFinite(retrieved) || retrieved < earliest || retrieved > now
      || istDate(retrieved) !== today || master.provenance.retrievedLocalDate !== today)
      fail("INSTRUMENT_MASTER_STALE");
  }
  async refreshMaster(): Promise<IndexMaster> {
    this.real();
    if (this.loading) return this.loading;
    this.master = null;
    this.loading = this.load().then(master => { this.checkMaster(master); this.master = master; return master; })
      .finally(() => { this.loading = null; });
    return this.loading;
  }
  activeMaster(): IndexMaster { this.real(); if (!this.master) return fail("INSTRUMENT_MASTER_STALE"); this.checkMaster(this.master); return this.master; }
  assertCurrentIndex(index: QualifiedIndex): void {
    assertQualifiedIndex(index);
    const master = this.activeMaster();
    try { if (master.resolve(index.underlying) !== index || index.provenance !== master.provenance) fail("INSTRUMENT_MASTER_STALE"); }
    catch { fail("INSTRUMENT_MASTER_STALE"); }
  }
  private evidence(index: QualifiedIndex): IndexEvidence {
    return { source: "KITE", dataMode: "KITE_REAL", index, canonicalId: index.canonicalId,
      fetchedAt: new Date(this.clock()).toISOString(), masterVersion: index.provenance.masterVersion,
      masterFingerprint: index.provenance.sourceFingerprint, normalizationVersion: 1 };
  }
  evaluateFreshness(quote: IndexQuote, maxAgeMs: number): Freshness {
    return freshness(quote.fetchedAt, quote.brokerTimestamp, this.clock(), maxAgeMs);
  }
  async getQuote(index: QualifiedIndex, maxAgeMs: number): Promise<IndexQuote> {
    this.assertCurrentIndex(index);
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return fail("INVALID_REQUEST");
    try {
      const data = responseData(await this.session.get("/quote", new URLSearchParams({ i: index.contractKey })));
      this.assertCurrentIndex(index);
      if (!Object.hasOwnProperty.call(data, index.contractKey)) return fail("QUOTE_UNAVAILABLE");
      const raw = object(data[index.contractKey]);
      const routedToken = typeof raw.instrument_token === "string" && token(raw.instrument_token)
        ? raw.instrument_token : String(units(raw.instrument_token));
      if (routedToken !== index.instrumentToken) return fail();
      const priceMinorValue = priceMinor(raw.last_price);
      if (!price(priceMinorValue)) return fail();
      const evidence = this.evidence(index);
      const brokerTimestamp = raw.timestamp == null ? null : marketTimestamp(raw.timestamp, true);
      const quote: IndexQuote = freeze({ ...evidence, priceMinor: priceMinorValue, brokerTimestamp,
        freshness: freshness(evidence.fetchedAt, brokerTimestamp, this.clock(), maxAgeMs) });
      issuedQuote.set(quote, this);
      return quote;
    } catch (error) { throw safeMarketError(error); }
  }
  async getHistoricalCandles(input: { index: QualifiedIndex; from: string; to: string; interval: HistoricalInterval }): Promise<IndexHistory> {
    this.assertCurrentIndex(input.index);
    if (!historicalIntervals.includes(input.interval)) return fail("INVALID_REQUEST");
    let from: string, to: string;
    try { from = marketTimestamp(input.from); to = marketTimestamp(input.to); } catch { return fail("INVALID_REQUEST"); }
    const start = Date.parse(from), end = Date.parse(to), span = 29 * 86_400_000;
    if (start > end || end > this.clock() || end - start > 24 * span || start % 1000 || end % 1000) return fail("INVALID_REQUEST");
    const merged = new Map<string, IndexCandle>();
    const wireDate = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(0, 19).replace("T", " ");
    try {
      for (let n = 0; n < Math.max(1, Math.ceil((end - start) / span)); n++) {
        const left = start + n * span, right = Math.min(left + span, end);
        this.assertCurrentIndex(input.index);
        const data = responseData(await this.session.get(`/instruments/historical/${input.index.instrumentToken}/${input.interval}`,
          new URLSearchParams({ from: wireDate(left), to: wireDate(right), continuous: "0", oi: "0" })));
        this.assertCurrentIndex(input.index);
        if (!Array.isArray(data.candles) || data.candles.length > 50_000) return fail();
        const evidence = this.evidence(input.index);
        for (const row of data.candles) {
          if (!Array.isArray(row) || row.length !== 6) return fail();
          const timestamp = marketTimestamp(row[0]), time = Date.parse(timestamp);
          if (time < left || time > right) return fail();
          const candle: IndexCandle = freeze({ ...evidence, interval: input.interval, timestamp,
            openMinor: priceMinor(row[1]), highMinor: priceMinor(row[2]), lowMinor: priceMinor(row[3]),
            closeMinor: priceMinor(row[4]), volume: units(row[5]) });
          if (![candle.openMinor, candle.highMinor, candle.lowMinor, candle.closeMinor].every(price)
            || candle.highMinor < candle.lowMinor || candle.openMinor < candle.lowMinor || candle.openMinor > candle.highMinor
            || candle.closeMinor < candle.lowMinor || candle.closeMinor > candle.highMinor) return fail();
          const previous = merged.get(timestamp);
          if (previous && (previous.openMinor !== candle.openMinor || previous.highMinor !== candle.highMinor
            || previous.lowMinor !== candle.lowMinor || previous.closeMinor !== candle.closeMinor || previous.volume !== candle.volume)) return fail();
          if (!previous) merged.set(timestamp, candle);
        }
      }
      if (!merged.size) return fail("HISTORICAL_DATA_UNAVAILABLE");
      const candles = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const result: IndexHistory = freeze({ ...this.evidence(input.index), interval: input.interval,
        requestedRange: { from, to }, actualRange: { from: candles[0]!.timestamp, to: candles[candles.length - 1]!.timestamp }, candles });
      issuedHistory.set(result, this);
      return result;
    } catch (error) { throw safeMarketError(error); }
  }
}
