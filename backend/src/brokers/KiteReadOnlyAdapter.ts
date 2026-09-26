import { createHash } from "node:crypto";
import { z } from "zod";
import type { Immutable } from "./BrokerAdapter";

// Runtime provenance boundary: only immutable snapshots normalized by this adapter
// enter reconciliation. Serialized/reconstituted snapshot ingestion is deferred.
const normalizedSnapshots = new WeakSet<object>();
export function assertKiteAccountSnapshot(value: unknown): asserts value is BrokerAccountSnapshot {
  if (!value || typeof value !== "object" || !normalizedSnapshots.has(value)) throw new Error("NORMALIZED_KITE_SNAPSHOT_REQUIRED");
}

export const kiteReadPaths = ["/orders", "/trades", "/portfolio/positions", "/user/margins"] as const;
export type KiteReadPath = typeof kiteReadPaths[number];
/** Authenticated, account-bound raw REST session. Never an SDK that rewrites dates.
 * Production construction verifies /user/profile and captures one credential pair.
 */
export interface KiteReadSession {
  readonly brokerAccountId: string;
  get(path: KiteReadPath): Promise<unknown>;
}
export type BrokerReadErrorCode = "AUTHENTICATION_FAILED" | "RATE_LIMITED" | "NETWORK_ERROR" | "BROKER_ERROR" | "INVALID_RESPONSE";
export class BrokerReadError extends Error {
  constructor(readonly code: BrokerReadErrorCode, readonly httpStatus?: number) { super(code); }
}
const object = z.record(z.unknown());
export const kiteIdentity = z.string().min(1).max(200).regex(/^[^\s\x00-\x1f\x7f]+$/);
const label = z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).refine(s => s === s.trim());
const units = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedUnits = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const side = z.enum(["BUY", "SELL"]);
const optionalId = (value: unknown) => value == null ? null : kiteIdentity.parse(value);

/** Deliberately excludes messages, response bodies, request config and credentials. */
export function classifyKiteReadError(error: unknown): { code: BrokerReadErrorCode; httpStatus?: number } {
  if (error instanceof BrokerReadError) return { code: error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) };
  if (error instanceof z.ZodError) return { code: "INVALID_RESPONSE" };
  // Axios' isAxiosError flag is a non-enumerable prototype property.
  const e = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = object.safeParse(e.response);
  const body = object.safeParse(response.success ? response.data.data : undefined);
  const status = response.success && typeof response.data.status === "number" && Number.isInteger(response.data.status)
    && response.data.status >= 100 && response.data.status <= 599 ? response.data.status : undefined;
  const kind = body.success ? body.data.error_type : undefined;
  const code = status === 401 || status === 403 || kind === "TokenException" ? "AUTHENTICATION_FAILED"
    : status === 429 ? "RATE_LIMITED"
    : kind === "NetworkException" || (!response.success &&
      (e.isAxiosError === true || ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "ECONNABORTED"].includes(String(e.code)))) ? "NETWORK_ERROR"
    : "BROKER_ERROR";
  return { code, ...(status === undefined ? {} : { httpStatus: status }) };
}
export function kiteResponseData(input: unknown): unknown {
  const envelope = object.parse(input);
  if (envelope.status === "error") throw new BrokerReadError(envelope.error_type === "TokenException" ? "AUTHENTICATION_FAILED"
    : envelope.error_type === "NetworkException" ? "NETWORK_ERROR" : "BROKER_ERROR");
  if (envelope.status !== "success" || envelope.data == null) throw new BrokerReadError("INVALID_RESPONSE");
  return envelope.data;
}

export interface BrokerReadProvenance {
  source: "KITE";
  broker: "KITE";
  brokerAccountId: string;
  fetchedAt: string;
  normalizationVersion: 1;
  endpoint: KiteReadPath;
}
export interface BrokerReadIssue { code: "UNKNOWN_BROKER_STATUS"; brokerOrderId: string; rawStatus: string }
export type BrokerReadResult<T> = Immutable<BrokerReadProvenance & (
  { availability: "AVAILABLE"; data: T; issues: BrokerReadIssue[] }
  | { availability: "UNAVAILABLE"; error: { code: BrokerReadErrorCode; httpStatus?: number } }
)>;

/** Decimal text of the parsed JSON number; no rounding or financial accumulation.
 * Kite includes sub-paise prices and floating tails in funds/averages. Never force
 * those into the Phase 2 integer-paise ledger. Original wire lexemes are not claimed.
 */
function decimal(input: unknown, signed = false): string {
  const n = z.number().finite().min(signed ? Number.MIN_SAFE_INTEGER : 0).max(Number.MAX_SAFE_INTEGER).parse(input);
  const [mantissa, exponent] = String(n).toLowerCase().split("e");
  if (exponent === undefined) return mantissa;
  const negative = mantissa.startsWith("-"), absolute = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ""] = absolute.split(".");
  const digits = whole + fraction, point = whole.length + Number(exponent);
  const result = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + result;
}
function exactPaise(value: string): number | null {
  const [whole, fraction = ""] = value.split(".");
  if (/[1-9]/.test(fraction.slice(2))) return null;
  const result = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
/** Full REST timestamps are documented IST. Reject rollover dates and SDK Date objects. */
function timestamp(input: unknown): { raw: string; iso: string } {
  const raw = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).parse(input);
  const date = new Date(raw.replace(" ", "T") + "+05:30");
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 19800000).toISOString().slice(0, 19).replace("T", " ") !== raw)
    throw new BrokerReadError("INVALID_RESPONSE");
  return { raw, iso: date.toISOString() };
}
const optionalTimestamp = (value: unknown) => value == null ? null : timestamp(value);
function orderTradeTimestamp(value: unknown) {
  if (value == null) return null;
  // The official trades example contains time-only order_timestamp. Its date is
  // unknown: preserve it, never attach the fill date or fetch date to it.
  if (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) return { raw: value, iso: null };
  return timestamp(value);
}
function instrument(row: Record<string, unknown>) {
  const exchange = kiteIdentity.parse(row.exchange), tradingsymbol = kiteIdentity.parse(row.tradingsymbol);
  const token = typeof row.instrument_token === "number" ? String(units.refine(n => n > 0).parse(row.instrument_token))
    : z.string().regex(/^[1-9]\d*$/).max(30).parse(row.instrument_token);
  const expiry = row.expiry == null ? null : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(row.expiry);
  if (expiry !== null) timestamp(expiry + " 00:00:00");
  return { exchange, tradingsymbol, instrumentToken: token, contractKey: `${exchange}:${tradingsymbol}`,
    segment: row.segment == null ? null : label.parse(row.segment), expiry,
    strike: row.strike == null ? null : decimal(row.strike), instrumentType: row.instrument_type == null ? null : label.parse(row.instrument_type) };
}
function ownedRow(input: unknown, account: string) {
  const row = object.parse(input);
  if (row.account_id !== undefined && kiteIdentity.parse(row.account_id) !== account) throw new BrokerReadError("INVALID_RESPONSE");
  return row; // placed_by can be a dealer, so it is NOT an ownership assertion.
}
function orderState(status: string, filled: number) {
  if (status === "OPEN") return filled > 0 ? "PARTIALLY_FILLED" as const : "WORKING" as const;
  if (status === "TRIGGER PENDING") return "TRIGGER_PENDING" as const;
  if (status === "COMPLETE" || status === "CANCELLED" || status === "REJECTED") return status;
  if (["PUT ORDER REQ RECEIVED", "VALIDATION PENDING", "OPEN PENDING", "MODIFY VALIDATION PENDING", "MODIFY PENDING", "CANCEL PENDING", "AMO REQ RECEIVED"].includes(status)) return "PENDING" as const;
  return "UNKNOWN" as const;
}
function normalizeOrder(input: unknown, provenance: BrokerReadProvenance) {
  const row = ownedRow(input, provenance.brokerAccountId), requestedUnits = units.refine(n => n > 0).parse(row.quantity);
  const filledUnits = units.parse(row.filled_quantity), rawStatus = label.parse(row.status);
  const pendingUnits = row.pending_quantity === undefined ? requestedUnits - filledUnits : units.parse(row.pending_quantity);
  const cancelledUnits = row.cancelled_quantity === undefined ? null : units.parse(row.cancelled_quantity);
  if (filledUnits > requestedUnits || pendingUnits > requestedUnits - filledUnits || (cancelledUnits !== null && cancelledUnits > requestedUnits)
    || (rawStatus === "COMPLETE" && filledUnits !== requestedUnits)) throw new BrokerReadError("INVALID_RESPONSE");
  return { ...provenance, brokerNamespace: "KITE_READ_V1" as const, brokerOrderId: kiteIdentity.parse(row.order_id),
    exchangeOrderId: optionalId(row.exchange_order_id), parentOrderId: optionalId(row.parent_order_id), instrument: instrument(row),
    side: side.parse(row.transaction_type), product: label.parse(row.product), orderType: label.parse(row.order_type), validity: label.parse(row.validity),
    variety: row.variety === undefined ? null : label.parse(row.variety), requestedUnits, filledUnits, pendingUnits, cancelledUnits,
    pendingQuantitySource: row.pending_quantity === undefined ? "DERIVED_UNFILLED_NOT_EXECUTABLE" as const : "BROKER_REPORTED" as const,
    limitPrice: decimal(row.price), averageFillPrice: decimal(row.average_price),
    triggerPrice: row.trigger_price === undefined ? null : decimal(row.trigger_price),
    rawStatus, state: orderState(rawStatus, filledUnits),
    statusSource: "REST_SNAPSHOT" as const, brokerStatusVersion: null,
    orderTimestamp: timestamp(row.order_timestamp), exchangeTimestamp: optionalTimestamp(row.exchange_timestamp),
    exchangeUpdateTimestamp: optionalTimestamp(row.exchange_update_timestamp) };
}
function normalizeTrade(input: unknown, provenance: BrokerReadProvenance) {
  const row = ownedRow(input, provenance.brokerAccountId), nativeTradeId = kiteIdentity.parse(row.trade_id);
  const brokerOrderId = kiteIdentity.parse(row.order_id), identity = instrument(row), executionTimestamp = timestamp(row.fill_timestamp);
  const tradingDay = executionTimestamp.raw.slice(0, 10), price = decimal(row.average_price);
  // No economic values, mutable exchange order ID, fetch time or internal IDs in identity.
  const namespace = ["KITE_READ_V1", provenance.brokerAccountId, identity.exchange, tradingDay, brokerOrderId, nativeTradeId];
  return { ...provenance, brokerNamespace: "KITE_READ_V1" as const, brokerOrderId, nativeTradeId,
    brokerTradeKey: createHash("sha256").update(JSON.stringify(namespace)).digest("hex"), tradingDay,
    exchangeOrderId: optionalId(row.exchange_order_id), instrument: identity, contractKey: identity.contractKey,
    side: side.parse(row.transaction_type), product: label.parse(row.product), quantityUnits: units.refine(n => n > 0).parse(row.quantity),
    price, priceMinor: exactPaise(price), executedAt: executionTimestamp.iso, executionTimestamp,
    orderTimestamp: orderTradeTimestamp(row.order_timestamp), exchangeTimestamp: optionalTimestamp(row.exchange_timestamp),
    ledgerMapping: "UNMAPPED" as const };
}
function normalizePosition(input: unknown, provenance: BrokerReadProvenance, view: "net" | "day") {
  const row = ownedRow(input, provenance.brokerAccountId);
  const quantities: Record<string, number> = {}, brokerValues: Record<string, string> = {};
  for (const key of ["buy_quantity", "sell_quantity", "day_buy_quantity", "day_sell_quantity"])
    if (row[key] !== undefined) quantities[key] = units.parse(row[key]);
  for (const key of ["pnl", "m2m", "realised", "unrealised", "value", "buy_value", "sell_value", "buy_m2m", "sell_m2m", "day_buy_value", "day_sell_value"])
    if (row[key] !== undefined) brokerValues[key] = decimal(row[key], true);
  for (const key of ["close_price", "last_price", "buy_price", "sell_price", "day_buy_price", "day_sell_price"])
    if (row[key] !== undefined) brokerValues[key] = decimal(row[key]);
  return { ...provenance, view, instrument: instrument(row), product: label.parse(row.product),
    quantityUnits: signedUnits.parse(row.quantity), overnightQuantityUnits: signedUnits.parse(row.overnight_quantity),
    multiplier: units.refine(n => n > 0).parse(row.multiplier), averagePrice: decimal(row.average_price),
    quantities, brokerValues, evidenceKind: "POSITION_SNAPSHOT_NOT_FILL" as const };
}
function normalizeFunds(input: unknown, provenance: BrokerReadProvenance) {
  const row = object.parse(input);
  const segment = (input: unknown) => {
    const value = object.parse(input);
    const amounts = (input: unknown) => Object.fromEntries(Object.entries(object.parse(input)).map(([key, amount]) => {
      // Retain broker field names and decimal values, not invented admission limits.
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new BrokerReadError("INVALID_RESPONSE");
      return [key, decimal(amount, true)];
    }));
    return { enabled: z.boolean().parse(value.enabled), net: decimal(value.net, true), available: amounts(value.available), utilised: amounts(value.utilised) };
  };
  return { ...provenance, equity: segment(row.equity), commodity: segment(row.commodity), valueEncoding: "DECIMAL_TEXT_FROM_JSON_NUMBER" as const };
}
function unique<T>(data: T[], key: (row: T) => string): T[] {
  if (new Set(data.map(key)).size !== data.length) throw new BrokerReadError("INVALID_RESPONSE");
  return data;
}
function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Immutable<T>;
}
export type BrokerReadOrder = Immutable<ReturnType<typeof normalizeOrder>>;
export type BrokerReadTrade = Immutable<ReturnType<typeof normalizeTrade>>;
export type BrokerReadPosition = Immutable<ReturnType<typeof normalizePosition>>;

/** Broker truth only. No BrokerAdapter execution methods, ledger IDs, mode
 * activation, Mongo dependency, retries, synthetic fallback or reconciliation.
 */
export class KiteReadOnlyAdapter {
  readonly brokerAccountId: string;
  constructor(private readonly session: KiteReadSession, private readonly clock: () => Date = () => new Date()) {
    this.brokerAccountId = kiteIdentity.parse(session.brokerAccountId);
  }
  private async read<T>(endpoint: KiteReadPath, normalize: (body: unknown, p: BrokerReadProvenance) => { data: T; issues?: BrokerReadIssue[] }): Promise<BrokerReadResult<T>> {
    const provenance = (): BrokerReadProvenance => ({ source: "KITE", broker: "KITE", brokerAccountId: this.brokerAccountId,
      endpoint, fetchedAt: this.clock().toISOString(), normalizationVersion: 1 });
    try {
      if (this.session.brokerAccountId !== this.brokerAccountId) throw new BrokerReadError("AUTHENTICATION_FAILED");
      const body = await this.session.get(endpoint), p = provenance();
      const result = normalize(kiteResponseData(body), p);
      return freeze({ ...p, availability: "AVAILABLE", data: result.data, issues: result.issues ?? [] });
    } catch (error) {
      return freeze({ ...provenance(), availability: "UNAVAILABLE", error: classifyKiteReadError(error) });
    }
  }
  getOrders() {
    return this.read("/orders", (input, p) => {
      const data = unique(z.array(z.unknown()).parse(input).map(row => normalizeOrder(row, p)),
        row => JSON.stringify([row.instrument.exchange, row.orderTimestamp.raw.slice(0, 10), row.brokerOrderId]));
      return { data, issues: data.filter(row => row.state === "UNKNOWN").map(row => ({ code: "UNKNOWN_BROKER_STATUS" as const,
        brokerOrderId: row.brokerOrderId, rawStatus: row.rawStatus })) };
    });
  }
  getTrades() {
    return this.read("/trades", (input, p) => ({ data: unique(z.array(z.unknown()).parse(input).map(row => normalizeTrade(row, p)), row => row.brokerTradeKey) }));
  }
  getPositions() {
    return this.read("/portfolio/positions", (input, p) => {
      const body = object.parse(input);
      const view = (name: "net" | "day") => unique(z.array(z.unknown()).parse(body[name]).map(row => normalizePosition(row, p, name)),
        row => JSON.stringify([row.instrument.exchange, row.instrument.tradingsymbol, row.product]));
      return { data: { net: view("net"), day: view("day") } };
    });
  }
  getFunds() { return this.read("/user/margins", (input, p) => ({ data: normalizeFunds(input, p) })); }
  async getSnapshot() {
    const startedAt = this.clock().toISOString();
    const [orders, trades, positions, funds] = await Promise.all([this.getOrders(), this.getTrades(), this.getPositions(), this.getFunds()]);
    const available = [orders, trades, positions, funds].filter(r => r.availability === "AVAILABLE").length;
    const snapshot = freeze({ source: "KITE" as const, broker: "KITE" as const, brokerAccountId: this.brokerAccountId,
      normalizationVersion: 1 as const, startedAt, fetchedAt: this.clock().toISOString(),
      completeness: available === 4 ? "COMPLETE" as const : available === 0 ? "UNAVAILABLE" as const : "PARTIAL" as const,
      consistency: "INDEPENDENT_ENDPOINT_READS" as const, orders, trades, positions, funds });
    normalizedSnapshots.add(snapshot);
    return snapshot;
  }
}
export type BrokerAccountSnapshot = Awaited<ReturnType<KiteReadOnlyAdapter["getSnapshot"]>>;
