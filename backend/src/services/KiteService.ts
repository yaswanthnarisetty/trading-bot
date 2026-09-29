import axios, { type AxiosInstance } from "axios";
import type { AssetKey } from "../config/assets";
import { MARGIN_ESTIMATE_MULTIPLIER } from "../config/constants";
import type { MarketData, OptionChainData, OHLCVData, OHLCV } from "../types/trading";
import { generateLTP, generateMarketData, generateOptionChain } from "./MockDataService";
import { BrokerReadError, classifyKiteReadError, kiteIdentity, kiteReadPaths, kiteResponseData,
  type KiteReadSession } from "../brokers/KiteReadOnlyAdapter";
import { KiteSessionService } from "./KiteSessionService";
import { fail } from "../domain/kiteMarketData";
import type { HistoricalInterval } from "./KiteMarketDataService";
export type { HistoricalInterval } from "./KiteMarketDataService";

const VERSION_HEADER = { "X-Kite-Version": "3" } as const;
const httpClient = axios.create({ baseURL: "https://api.kite.trade", timeout: 10000, headers: VERSION_HEADER });
const getClient = () => httpClient;
export const kiteSession = new KiteSessionService(httpClient, () => ({
  apiKey: process.env.KITE_API_KEY ?? "", apiSecret: process.env.KITE_API_SECRET ?? "",
  expectedAccountId: process.env.KITE_USER_ID,
}), Date.now, undefined, process.env.MARKET_DATA_MODE === "KITE_REAL" ? "KITE_REAL" : "MOCK");
export const isMock = () => kiteSession.getMode() === "MOCK";
export const isTokenValid = () => kiteSession.status().tokenValid;
export const getAuthHeader = () => kiteSession.getAuthHeader();
export const validateToken = () => kiteSession.validate();
// Existing refresh entry point now stores only a profile-verified in-memory session.
export const generateAccessToken = (requestToken: string): Promise<void> => kiteSession.exchange(requestToken);

export async function createKiteReadSession(expectedAccountId: string,
  client: Pick<AxiosInstance, "get"> = getClient(), headers: () => Record<string, string> = getAuthHeader): Promise<KiteReadSession> {
  const brokerAccountId = kiteIdentity.parse(expectedAccountId);
  const captured: Record<string, string> = { ...headers(), ...VERSION_HEADER };
  if (!/^token [^:\s]+:[^:\s]+$/.test(captured.Authorization ?? "")) throw new BrokerReadError("AUTHENTICATION_FAILED");
  const read = async (path: string) => {
    try { return (await client.get(path, { headers: { ...captured } })).data as unknown; }
    catch (error) { const safe = classifyKiteReadError(error); throw new BrokerReadError(safe.code, safe.httpStatus); }
  };
  try {
    const profile = kiteResponseData(await read("/user/profile"));
    if (!profile || typeof profile !== "object" || !("user_id" in profile)
      || profile.user_id !== brokerAccountId) throw new BrokerReadError("AUTHENTICATION_FAILED");
  } catch (error) { const safe = classifyKiteReadError(error); throw new BrokerReadError(safe.code, safe.httpStatus); }
  return Object.freeze({ brokerAccountId, async get(path) {
    if (!kiteReadPaths.includes(path)) throw new BrokerReadError("INVALID_RESPONSE");
    return read(path);
  } } satisfies KiteReadSession);
}


/** Legacy strategy helpers are MOCK-only until Phase 5 explicitly integrates qualified data.
 * Selecting KITE_REAL cannot route generated symbols/underlying token constants to Kite. */
function legacyMockOnly(): void { if (!isMock()) fail("LEGACY_MARKET_DATA_DISABLED"); }
export async function fetchLTP(asset: AssetKey): Promise<number> { legacyMockOnly(); return generateLTP(asset); }
export async function fetchMarketData(asset: AssetKey): Promise<MarketData> { legacyMockOnly(); return generateMarketData(asset); }
export async function fetchOptionChain(asset: AssetKey): Promise<OptionChainData> { legacyMockOnly(); return generateOptionChain(asset, generateLTP(asset)); }
export const getLTP = fetchLTP;
export async function fetchHistoricalOHLCV(_asset: AssetKey, _params: {
  from: string; to: string; interval: HistoricalInterval; apiKey?: string; accessToken?: string;
}): Promise<OHLCVData> { return fail("QUALIFIED_INSTRUMENT_REQUIRED"); }
export async function fetchOptionLTP(_symbol: string): Promise<number | null> { legacyMockOnly(); return null; }
export async function fetchLatest5MinCandle(_asset: AssetKey): Promise<OHLCV | null> { legacyMockOnly(); return null; }
export async function getPreviousDayOHLC(_asset: AssetKey): Promise<{ pdHigh: number; pdLow: number; pdClose: number; pdOpen: number } | null> { legacyMockOnly(); return null; }
export async function getSpreadMargin(params: { asset: AssetKey; sellStrike: number; buyStrike: number; optionType: "CE" | "PE";
  expiryDate: Date; lotSize: number; lots: number }): Promise<{ margin: number; source: "KITE_API" | "ESTIMATED" }> {
  legacyMockOnly();
  return { margin: Math.abs(params.sellStrike - params.buyStrike) * params.lotSize * params.lots * MARGIN_ESTIMATE_MULTIPLIER, source: "ESTIMATED" };
}

/** Legacy display helper only. Its output is never accepted by real market-data APIs. */
export function buildNFOOptionSymbol(
  asset: AssetKey,
  expiryDate: Date,
  strike: number,
  optionType: "CE" | "PE"
): string {
  const MONTHS_3 = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ] as const;

  // Weekly month encoding: 1–9 are digits; Oct=O, Nov=N, Dec=D (NSE standard)
  const WEEKLY_MONTH_CODES = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D",
  ] as const;

  // Convert to IST date components (UTC+5:30, no DST)
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(expiryDate.getTime() + istOffsetMs);

  const year  = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth(); // 0-indexed
  const day   = istDate.getUTCDate();
  const yy    = String(year).slice(2);
  const strikeStr = String(Math.round(strike));

  // Detect monthly expiry: last Thursday of the month means no Thursday falls
  // in the next 7 days within the same month.
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isMonthlyExpiry = day + 7 > daysInMonth;

  if (isMonthlyExpiry) {
    const mmm = MONTHS_3[month]!;
    return `NFO:${asset}${yy}${mmm}${strikeStr}${optionType}`;
  }

  const m  = WEEKLY_MONTH_CODES[month]!;
  const dd = String(day).padStart(2, "0");
  return `NFO:${asset}${yy}${m}${dd}${strikeStr}${optionType}`;
}
