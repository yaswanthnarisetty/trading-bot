import { createHash } from "node:crypto";
import { ALLOWED_ASSETS, type AssetKey } from "../config/assets";
import type { KiteInstrumentCsvProvider } from "../brokers/KiteInstrumentCsvProvider";
import { parseInstrumentCsv } from "../domain/instrumentCsv";
import { parseKiteNfoOptionSymbol } from "../domain/kiteNfoOptionSymbol";

export type InstrumentMasterErrorCode = "INVALID_INSTRUMENT_CSV" | "INVALID_INSTRUMENT_FIELD"
  | "UNSUPPORTED_UNDERLYING" | "INSTRUMENT_NOT_FOUND" | "AMBIGUOUS_INSTRUMENT" | "EMPTY_INSTRUMENT_MASTER";
export class InstrumentMasterError extends Error {
  constructor(readonly code: InstrumentMasterErrorCode, readonly field?: string) { super(field ? `${code}: ${field}` : code); }
}
export interface InstrumentMasterProvenance {
  readonly broker: "KITE";
  readonly source: "INSTRUMENT_MASTER";
  readonly endpoint: "/instruments";
  readonly normalizationVersion: 1;
  readonly masterVersion: string;
  readonly sourceFingerprint: string;
  readonly retrievedAt: string;
  readonly retrievedLocalDate: string;
  /** CSV has no generation timestamp/trading date. Retrieval date is not that proof. */
  readonly sourceTradingDate: null;
}
export interface InstrumentDefinition {
  readonly canonicalId: string;
  readonly broker: "KITE";
  readonly source: "INSTRUMENT_MASTER";
  readonly qualification: "QUALIFIED";
  readonly exchange: "NFO";
  readonly segment: "NFO-OPT";
  readonly tradingsymbol: string;
  /** Exactly the Phase 3 exchange:tradingsymbol identity, NOT an eternal token key. */
  readonly contractKey: string;
  readonly instrumentToken: string;
  readonly exchangeToken: string;
  readonly name: AssetKey;
  readonly underlying: AssetKey;
  readonly expiry: string;
  readonly strike: string;
  readonly strikeMinor: number;
  readonly instrumentType: "CE" | "PE";
  readonly tickSizeMinor: number;
  readonly lotSizeUnits: number;
  readonly provenance: InstrumentMasterProvenance;
}
export interface OptionLookup { underlying: AssetKey; expiry: string; strike: string; optionType: "CE" | "PE" }
/** Trusted bootstrap metadata, independently verified against the exchange calendar/
 * contract notices (including holiday adjustments), NEVER derived from the CSV under test.
 * sourceReference identifies that evidence; a nonempty label alone does not authenticate it. */
export interface QualifiedMonthlyExpiry {
  readonly underlying: AssetKey;
  readonly expiry: string;
  readonly sourceReference: string;
}
export interface KiteInstrumentMaster {
  readonly provenance: InstrumentMasterProvenance;
  readonly instruments: readonly InstrumentDefinition[];
  getInstrumentByCanonicalId(id: string): InstrumentDefinition;
  resolveOption(query: OptionLookup): InstrumentDefinition;
  listExpiries(underlying: AssetKey): readonly string[];
  resolveExpiry(underlying: AssetKey, expiry: string): string;
  listStrikes(underlying: AssetKey, expiry: string, optionType: "CE" | "PE"): readonly string[];
  getByExchangeTradingsymbol(exchange: string, tradingsymbol: string): InstrumentDefinition;
  /** Current means ONLY this explicitly selected snapshot, never historical token identity. */
  getByCurrentInstrumentToken(token: string): InstrumentDefinition;
}

const qualified = new WeakSet<object>();
export function assertQualifiedInstrument(value: unknown): asserts value is InstrumentDefinition {
  if (!value || typeof value !== "object" || !qualified.has(value)) throw new Error("QUALIFIED_INSTRUMENT_REQUIRED");
}
const columns = ["instrument_token", "exchange_token", "tradingsymbol", "name", "last_price", "expiry",
  "strike", "tick_size", "lot_size", "instrument_type", "segment", "exchange"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = (field: string): never => { throw new InstrumentMasterError("INVALID_INSTRUMENT_FIELD", field); };
function underlying(value: string): AssetKey {
  if (!Object.hasOwnProperty.call(ALLOWED_ASSETS, value)) throw new InstrumentMasterError("UNSUPPORTED_UNDERLYING");
  return value as AssetKey;
}
function expiryDate(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid("expiry");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return invalid("expiry");
  return value;
}
function optionType(value: string): "CE" | "PE" {
  if (value !== "CE" && value !== "PE") return invalid("instrument_type");
  return value;
}
function integer(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,29}$/.test(value)) return invalid(field);
  return BigInt(value);
}
/** Decimal wire text -> integer paise, before conversion to safe JS integer. */
function paise(value: string, field: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(value)) return invalid(field);
  const [whole, fraction = ""] = value.split(".");
  if (/[1-9]/.test(fraction.slice(2))) return invalid(field);
  const amount = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return invalid(field);
  return Number(amount);
}
function decimal(amount: number): string {
  const n = BigInt(amount), fraction = String(n % 100n).padStart(2, "0").replace(/0+$/, "");
  return String(n / 100n) + (fraction ? `.${fraction}` : "");
}
const canonicalId = (u: AssetKey, expiry: string, strikeMinor: number, type: "CE" | "PE") =>
  `KITE:NFO:NFO-OPT:${u}:${expiry}:${strikeMinor}:${type}`;

/** Explicit import, no timers/current-pointer mutation, Mongo, quote prices or legacy fallback.
 * Each returned snapshot owns its lookups; retaining A while importing B cannot remap A. */
export class KiteInstrumentMasterService {
  private readonly monthlyExpiries = new Map<string, string>();
  constructor(private readonly provider: KiteInstrumentCsvProvider, private readonly clock: () => Date = () => new Date(),
    monthlyExpiries: readonly QualifiedMonthlyExpiry[] = []) {
    for (const record of monthlyExpiries) {
      const u = underlying(record.underlying), date = expiryDate(record.expiry);
      if (!date.startsWith("20") || typeof record.sourceReference !== "string" || !record.sourceReference.trim()) invalid("monthlyExpiryMetadata");
      const key = `${u}:${date.slice(0, 7)}`, previous = this.monthlyExpiries.get(key);
      if (previous && previous !== date) invalid("monthlyExpiryMetadata");
      this.monthlyExpiries.set(key, date);
    }
  }
  async load(): Promise<KiteInstrumentMaster> {
    const csv = await this.provider.getInstrumentsCsv();
    if (typeof csv !== "string") throw new InstrumentMasterError("INVALID_INSTRUMENT_CSV");
    const time = this.clock();
    if (!(time instanceof Date) || !Number.isFinite(time.getTime())) return invalid("retrievedAt");
    const retrievedAt = time.toISOString(), sourceFingerprint = hash(csv);
    const provenance: InstrumentMasterProvenance = Object.freeze({ broker: "KITE", source: "INSTRUMENT_MASTER", endpoint: "/instruments",
      normalizationVersion: 1, masterVersion: `kite-master-v1:${sourceFingerprint}`, sourceFingerprint, retrievedAt,
      retrievedLocalDate: new Date(time.getTime() + 19800000).toISOString().slice(0, 10), sourceTradingDate: null });
    let rows: string[][];
    try { rows = parseInstrumentCsv(csv); } catch { throw new InstrumentMasterError("INVALID_INSTRUMENT_CSV"); }
    const header = rows.shift();
    if (!header || new Set(header).size !== header.length || columns.some(c => !header.includes(c)))
      throw new InstrumentMasterError("INVALID_INSTRUMENT_CSV");
    const economic = new Map<string, InstrumentDefinition>(), symbols = new Map<string, InstrumentDefinition>(), tokens = new Map<string, InstrumentDefinition>();
    for (const values of rows) {
      if (values.length !== header.length) throw new InstrumentMasterError("INVALID_INSTRUMENT_CSV");
      const row = Object.fromEntries(header.map((key, i) => [key, values[i]]));
      // Filter before parsing unsupported economics. No EQ/FUT/currency/commodity qualification.
      if (row.exchange !== "NFO" || row.segment !== "NFO-OPT" || !["CE", "PE"].includes(row.instrument_type)) continue;
      if (!Object.hasOwnProperty.call(ALLOWED_ASSETS, row.name)) continue;
      const u = underlying(row.name), expiry = expiryDate(row.expiry), type = optionType(row.instrument_type);
      const strikeMinor = paise(row.strike, "strike"), tickSizeMinor = paise(row.tick_size, "tick_size");
      const lot = integer(row.lot_size, "lot_size");
      if (lot > BigInt(Number.MAX_SAFE_INTEGER)) return invalid("lot_size");
      const instrumentToken = String(integer(row.instrument_token, "instrument_token"));
      const exchangeToken = String(integer(row.exchange_token, "exchange_token"));
      // Structured fields remain authoritative. Decode only to reject routing contradictions.
      const symbol = row.tradingsymbol;
      const parsed = parseKiteNfoOptionSymbol(symbol);
      if (!parsed || parsed.underlying !== u || parsed.optionType !== type || parsed.strikeMinor !== BigInt(strikeMinor)
        || parsed.yearMonth !== expiry.slice(0, 7)) return invalid("tradingsymbol");
      const monthlyExpiry = this.monthlyExpiries.get(`${u}:${parsed.yearMonth}`);
      // Required for both formats: a monthly contract cannot masquerade as weekly.
      if (!monthlyExpiry) return invalid("monthlyExpiryMetadata");
      if (parsed.expiryEncodingKind === "MONTHLY" ? expiry !== monthlyExpiry
        : expiry !== `${parsed.yearMonth}-${parsed.expiryDay}` || expiry === monthlyExpiry) return invalid("tradingsymbol");
      const definition: InstrumentDefinition = Object.freeze({ canonicalId: canonicalId(u, expiry, strikeMinor, type),
        broker: "KITE", source: "INSTRUMENT_MASTER", qualification: "QUALIFIED", exchange: "NFO", segment: "NFO-OPT",
        tradingsymbol: symbol, contractKey: `NFO:${symbol}`, instrumentToken, exchangeToken, name: u, underlying: u, expiry,
        strike: decimal(strikeMinor), strikeMinor, instrumentType: type, tickSizeMinor, lotSizeUnits: Number(lot), provenance });
      const previous = economic.get(definition.canonicalId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(definition)) throw new InstrumentMasterError("AMBIGUOUS_INSTRUMENT");
      if (previous) continue; // Exact duplicate rows do not duplicate economic contracts.
      if (symbols.has(definition.contractKey) || tokens.has(instrumentToken)) throw new InstrumentMasterError("AMBIGUOUS_INSTRUMENT");
      economic.set(definition.canonicalId, definition); symbols.set(definition.contractKey, definition); tokens.set(instrumentToken, definition);
    }
    if (!economic.size) throw new InstrumentMasterError("EMPTY_INSTRUMENT_MASTER");
    const instruments = Object.freeze([...economic.values()].sort((a, b) => a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0));
    for (const instrument of instruments) qualified.add(instrument);
    const found = (value: InstrumentDefinition | undefined) => { if (!value) throw new InstrumentMasterError("INSTRUMENT_NOT_FOUND"); return value; };
    const listExpiries = (asset: AssetKey) => Object.freeze([...new Set(instruments.filter(i => i.underlying === underlying(asset)).map(i => i.expiry))].sort());
    const resolveExpiry = (asset: AssetKey, date: string) => {
      const exact = expiryDate(date); if (!listExpiries(asset).includes(exact)) throw new InstrumentMasterError("INSTRUMENT_NOT_FOUND"); return exact;
    };
    return Object.freeze({ provenance, instruments,
      getInstrumentByCanonicalId: (id: string) => found(economic.get(id)),
      resolveOption: (query: OptionLookup) => found(economic.get(canonicalId(underlying(query.underlying), expiryDate(query.expiry), paise(query.strike, "strike"), optionType(query.optionType)))),
      listExpiries, resolveExpiry,
      listStrikes: (asset: AssetKey, date: string, type: "CE" | "PE") => {
        const exact = resolveExpiry(asset, date), side = optionType(type);
        return Object.freeze(instruments.filter(i => i.underlying === asset && i.expiry === exact && i.instrumentType === side)
          .sort((a, b) => a.strikeMinor - b.strikeMinor).map(i => i.strike));
      },
      getByExchangeTradingsymbol: (exchange: string, symbol: string) => found(symbols.get(`${exchange}:${symbol}`)),
      getByCurrentInstrumentToken: (token: string) => found(tokens.get(String(integer(token, "instrument_token")))),
    });
  }
}
