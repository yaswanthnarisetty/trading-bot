import { classifyKiteReadError } from "../brokers/KiteReadOnlyAdapter";

export type MarketDataErrorCode = "SESSION_REQUIRED" | "AUTHENTICATION_FAILED" | "RATE_LIMITED" | "NETWORK_ERROR"
  | "BROKER_ERROR" | "INVALID_RESPONSE" | "QUOTE_UNAVAILABLE" | "HISTORICAL_DATA_UNAVAILABLE"
  | "HISTORICAL_INSTRUMENT_UNAVAILABLE" | "INSTRUMENT_MASTER_STALE" | "QUALIFIED_INSTRUMENT_REQUIRED"
  | "REAL_DATA_REQUIRED" | "STALE_MARKET_DATA" | "INVALID_REQUEST" | "DATA_MODE_REQUIRED" | "LEGACY_MARKET_DATA_DISABLED"
  | "MONTHLY_METADATA_REQUIRED";
export class MarketDataError extends Error {
  constructor(readonly code: MarketDataErrorCode) { super(code); }
}
export function safeMarketError(error: unknown): MarketDataError {
  return error instanceof MarketDataError ? error : new MarketDataError(classifyKiteReadError(error).code);
}
export const fail = (code: MarketDataErrorCode = "INVALID_RESPONSE"): never => { throw new MarketDataError(code); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
export function responseData(value: unknown): Record<string, unknown> {
  const envelope = object(value);
  if (envelope.status === "error") return fail(envelope.error_type === "TokenException" ? "AUTHENTICATION_FAILED"
    : envelope.error_type === "NetworkException" ? "NETWORK_ERROR" : "BROKER_ERROR");
  if (envelope.status !== "success") return fail();
  return object(envelope.data);
}
export function units(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
/** Reject sub-paise/unsafe values, never round. Parsed JSON numeric lexemes are not claimed. */
export function priceMinor(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail();
  const text = String(value);
  if (!/^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(text)) return fail();
  const [whole, fraction = ""] = text.split(".");
  if (/[1-9]/.test(fraction.slice(2))) return fail();
  const result = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return Number(result);
}
export const istDate = (ms: number) => new Date(ms + 19800000).toISOString().slice(0, 10);
/** REST quote naive timestamps are interpreted as IST; history must supply an offset. */
export function marketTimestamp(value: unknown, naiveIst = false): string {
  if (typeof value !== "string") return fail();
  let text = value;
  if (naiveIst && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) text = text.replace(" ", "T") + "+05:30";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) return fail();
  const zone = match[3].replace(":", "");
  const hours = zone === "Z" ? 0 : Number(zone.slice(1, 3)), mins = zone === "Z" ? 0 : Number(zone.slice(3, 5));
  if (hours > 14 || mins > 59 || (hours === 14 && mins !== 0)) return fail();
  const offset = (hours * 60 + mins) * 60000 * (zone[0] === "-" ? -1 : 1);
  const time = new Date(text).getTime();
  if (!Number.isFinite(time) || new Date(time + offset).toISOString().slice(0, 19) !== match[1]) return fail();
  return new Date(time).toISOString();
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
