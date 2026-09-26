import crypto from "crypto";
import axios, { type AxiosInstance } from "axios";
import { subDays } from "date-fns";
import type { AssetKey } from "../config/assets";
import { ALLOWED_ASSETS } from "../config/assets";
import { MARGIN_ESTIMATE_MULTIPLIER } from "../config/constants";
import type { MarketData, OptionChainData, OHLCVData, OHLCV } from "../types/trading";
import {
  generateLTP,
  generateMarketData,
  generateOptionChain,
} from "./MockDataService";
import { logger } from "../utils/logger";
import { BrokerReadError, classifyKiteReadError, kiteIdentity, kiteReadPaths, kiteResponseData,
  type KiteReadSession } from "../brokers/KiteReadOnlyAdapter";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * All Kite Connect REST API endpoints live under api.kite.trade.
 * kite.zerodha.com/connect is the OAuth login UI — NOT the API server.
 */
const BASE_URL = "https://api.kite.trade";

/**
 * X-Kite-Version: 3 is mandatory on every Kite API request.
 * Omitting it causes 403 regardless of token validity.
 */
const VERSION_HEADER = { "X-Kite-Version": "3" } as const;

// ─── Internal state ───────────────────────────────────────────────────────────

let httpClient: AxiosInstance | null = null;
let lastTokenValidatedOn: string | null = null;

// ─── Types ────────────────────────────────────────────────────────────────────

export type HistoricalInterval =
  | "minute"
  | "3minute"
  | "5minute"
  | "10minute"
  | "15minute"
  | "30minute"
  | "60minute"
  | "day";

interface HistoricalFetchParams {
  from: string;
  to: string;
  interval: HistoricalInterval;
  /** Optional per-request credential override — used by backtest route */
  apiKey?: string;
  accessToken?: string;
}

// ─── Kite symbol maps ─────────────────────────────────────────────────────────

const KITE_QUOTE_SYMBOLS: Record<AssetKey, string> = {
  NIFTY: "NSE:NIFTY 50",
  BANKNIFTY: "NSE:NIFTY BANK",
  FINNIFTY: "NSE:NIFTY FIN SERVICE",
};

const KITE_INSTRUMENT_TOKENS: Record<AssetKey, number> = {
  NIFTY: 256265,
  BANKNIFTY: 260105,
  FINNIFTY: 257801,
};

const KITE_INSTRUMENT_TOKEN_ENV: Record<AssetKey, string> = {
  NIFTY: "KITE_NIFTY_INSTRUMENT_TOKEN",
  BANKNIFTY: "KITE_BANKNIFTY_INSTRUMENT_TOKEN",
  FINNIFTY: "KITE_FINNIFTY_INSTRUMENT_TOKEN",
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Lazily constructs an Axios client pointed at api.kite.trade.
 * X-Kite-Version: 3 is baked into the instance defaults so every
 * request carries it automatically.
 */
function getClient(): AxiosInstance {
  if (!httpClient) {
    httpClient = axios.create({
      baseURL: BASE_URL,
      timeout: 10_000,
      headers: {
        ...VERSION_HEADER,
        "Content-Type": "application/json",
      },
    });
  }
  return httpClient;
}

/**
 * Builds per-request Kite headers including the version and auth token.
 * Used internally by fetchHistoricalOHLCV which supports credential overrides.
 */
function buildHeaders(apiKey?: string, accessToken?: string): Record<string, string> {
  const key = apiKey ?? process.env.KITE_API_KEY ?? "";
  const token = accessToken ?? process.env.KITE_ACCESS_TOKEN ?? "";
  return {
    ...VERSION_HEADER,
    Authorization: `token ${key}:${token}`,
  };
}

function getInstrumentToken(asset: AssetKey): number {
  const envKey = KITE_INSTRUMENT_TOKEN_ENV[asset];
  const envVal = process.env[envKey];
  if (envVal && !Number.isNaN(Number(envVal))) return Number(envVal);
  return KITE_INSTRUMENT_TOKENS[asset];
}

/**
 * Converts a Date to "YYYY-MM-DD HH:mm:ss" in IST for Kite API date params.
 * IST = UTC+5:30, no daylight saving.
 */
function toKiteDateString(date: Date): string {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(date.getTime() + istOffsetMs);
  return ist.toISOString().slice(0, 10) + " " + ist.toISOString().slice(11, 19);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true when KITE_API_KEY is absent.
 * An absent access token means the token needs refreshing — not mock mode.
 */
export function isMock(): boolean {
  return !process.env.KITE_API_KEY;
}

/**
 * Returns true if the token was validated for today's IST date.
 * Kite tokens expire at midnight IST — one validation per calendar day suffices.
 */
export function isTokenValid(): boolean {
  if (isMock()) return false;
  const today = new Date().toISOString().slice(0, 10);
  return lastTokenValidatedOn === today;
}

/**
 * Returns the full set of headers required for every authenticated Kite API call:
 *   X-Kite-Version: 3
 *   Authorization: token {KITE_API_KEY}:{KITE_ACCESS_TOKEN}
 *
 * Both headers are mandatory. Kite returns 403 if either is missing.
 */
export function getAuthHeader(): Record<string, string> {
  const apiKey = process.env.KITE_API_KEY ?? "";
  const accessToken = process.env.KITE_ACCESS_TOKEN ?? "";
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${apiKey}:${accessToken}`,
  };
}

/** Explicit read-only capability; reuses this client's transport and supported auth.
 * A captured credential pair cannot silently switch accounts during a snapshot.
 * The optional dependencies permit offline tests without any broker account.
 * No legacy mock fallback, raw error logging, automatic refresh or execution access.
 */
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

/**
 * Validates the current Kite access token against GET /user/profile.
 *
 * Always calls Kite live — never uses the cached isTokenValid() result.
 * 200 → caches today's date, returns true.
 * 403 → logs a clear refresh instruction, returns false.
 * Any other error → logs and returns false.
 * Never throws.
 *
 * @returns Promise resolving to true if the token is valid.
 */
export async function validateToken(): Promise<boolean> {
  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;

  if (!apiKey || !accessToken) {
    return false;
  }

  try {
    await getClient().get("/user/profile", {
      headers: getAuthHeader(),
    });

    const today = new Date().toISOString().slice(0, 10);
    lastTokenValidatedOn = today;
    logger.info("✅ Kite token valid", { date: today });
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 403 || status === 401) {
        logger.warn(
          `⚠️ Kite token expired or invalid (HTTP ${status}). ` +
            `Visit https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey} — ` +
            `then call POST /api/kite/refresh with request_token`
        );
      } else {
        const msg =
          (error.response?.data as { message?: string } | undefined)?.message ??
          error.message;
        logger.error("Kite token validation failed", { status, message: msg });
      }
    } else {
      logger.error("Kite token validation failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

/**
 * Generates a fresh Kite access token by exchanging a one-time request_token.
 *
 * Checksum = SHA-256(api_key + request_token + api_secret)
 * Strings are concatenated with no separators, then hex-digested.
 *
 * POST https://api.kite.trade/session/token
 * Header: X-Kite-Version: 3
 * Content-Type: application/x-www-form-urlencoded
 * Body: api_key=xxx&request_token=yyy&checksum=zzz
 *
 * @param requestToken - One-time token from the Kite OAuth redirect URL.
 * @returns Promise resolving to a fresh access_token string.
 */
export async function generateAccessToken(requestToken: string): Promise<string> {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "KITE_API_KEY and KITE_API_SECRET are required to generate an access token"
    );
  }

  // SHA-256(api_key + request_token + api_secret) — concatenated, no separators
  const checksum = crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const formBody = new URLSearchParams({
    api_key: apiKey,
    request_token: requestToken,
    checksum,
  }).toString();

  try {
    const response = await getClient().post("/session/token", formBody, {
      headers: {
        ...VERSION_HEADER,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const accessToken = (
      response.data as { data?: { access_token?: string } } | undefined
    )?.data?.access_token;

    if (!accessToken) {
      throw new Error("No access_token in Kite session/token response");
    }

    logger.info("Kite access token generated successfully");
    return accessToken;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg =
        (err.response?.data as { message?: string } | undefined)?.message ??
        err.message;
      logger.error("Failed to generate Kite access token", {
        status: err.response?.status,
        message: msg,
      });
      throw new Error(msg);
    }
    logger.error("Failed to generate Kite access token", {
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Fetches the current LTP for an asset via GET /quote?i={symbol}.
 * Falls back to MockDataService on any error or in mock mode.
 */
export async function fetchLTP(asset: AssetKey): Promise<number> {
  if (isMock()) return generateLTP(asset);

  try {
    const symbol = KITE_QUOTE_SYMBOLS[asset];
    const response = await getClient().get("/quote", {
      params: { i: symbol },
      headers: getAuthHeader(),
    });

    const ltp = (
      response.data?.data as Record<string, { last_price?: number }> | undefined
    )?.[symbol]?.last_price;

    if (typeof ltp === "number" && ltp > 0) return ltp;
    return ALLOWED_ASSETS[asset].basePrice;
  } catch (error) {
    logger.warn("Kite LTP fetch failed, using mock", {
      asset,
      message: error instanceof Error ? error.message : String(error),
    });
    return generateLTP(asset);
  }
}

/**
 * Fetches OHLCV market data via GET /quote/ohlc?i={symbol}.
 * Validates token before the first live call per day.
 * Falls back to MockDataService on any error or in mock mode.
 */
export async function fetchMarketData(asset: AssetKey): Promise<MarketData> {
  if (isMock()) return generateMarketData(asset);

  if (!isTokenValid()) {
    const ok = await validateToken();
    if (!ok) {
      logger.warn("Using mock market data — Kite token invalid", { asset });
      return generateMarketData(asset);
    }
  }

  try {
    const symbol = KITE_QUOTE_SYMBOLS[asset];
    const response = await getClient().get("/quote/ohlc", {
      params: { i: symbol },
      headers: getAuthHeader(),
    });

    type OhlcPayload = {
      last_price?: number;
      ohlc?: { open: number; high: number; low: number; close: number };
      volume?: number;
    };

    const data = (
      response.data?.data as Record<string, OhlcPayload> | undefined
    )?.[symbol];
    if (!data) return generateMarketData(asset);

    const ltp = data.last_price ?? ALLOWED_ASSETS[asset].basePrice;
    const now = new Date();
    const ohlcv = [
      {
        timestamp: now,
        open: data.ohlc?.open ?? ltp,
        high: data.ohlc?.high ?? ltp,
        low: data.ohlc?.low ?? ltp,
        close: ltp,
        volume: data.volume ?? ALLOWED_ASSETS[asset].lotSize * 1000,
      },
    ];
    const volume = ohlcv.reduce((sum, c) => sum + c.volume, 0);

    return { asset, ohlcv, ltp, volume, dataMode: "LIVE" };
  } catch (error) {
    logger.error("Live market data fetch failed, falling back to mock", {
      asset,
      message: error instanceof Error ? error.message : String(error),
    });
    return generateMarketData(asset);
  }
}

/**
 * Fetches the option chain for an asset.
 * Gets real LTP from Kite (or mock), then generates synthetic Greeks.
 */
export async function fetchOptionChain(
  asset: AssetKey
): Promise<OptionChainData> {
  const ltp = await fetchLTP(asset);
  return generateOptionChain(asset, ltp);
}

/**
 * Returns the current LTP for an asset. Delegates to fetchLTP.
 */
export async function getLTP(asset: AssetKey): Promise<number> {
  return fetchLTP(asset);
}

/**
 * Fetches historical OHLCV candles from GET /instruments/historical/{token}/{interval}.
 * Powers backtesting. Accepts optional per-request credential overrides.
 *
 * @param asset - Asset whose underlying history is requested.
 * @param params - Date range, interval, and optional credential overrides.
 * @returns Normalized OHLCV candles in chronological order.
 */
export async function fetchHistoricalOHLCV(
  asset: AssetKey,
  params: HistoricalFetchParams
): Promise<OHLCVData> {
  const apiKey = params.apiKey ?? process.env.KITE_API_KEY;
  const accessToken = params.accessToken ?? process.env.KITE_ACCESS_TOKEN;

  if (!apiKey || !accessToken) {
    throw new Error("Kite API key and access token are required for historical data");
  }

  const instrumentToken = getInstrumentToken(asset);
  const fromStr = toKiteDateString(new Date(params.from));
  const toStr = toKiteDateString(new Date(params.to));

  let response;
  try {
    response = await getClient().get(
      `/instruments/historical/${instrumentToken}/${params.interval}`,
      {
        params: { from: fromStr, to: toStr, continuous: 0, oi: 0 },
        headers: buildHeaders(apiKey, accessToken),
      }
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const kiteMessage =
        (err.response?.data as { message?: string } | undefined)?.message ?? "";
      if (status === 403 || status === 401) {
        throw new Error(
          `Kite token expired or invalid (HTTP ${status}${kiteMessage ? ": " + kiteMessage : ""}). ` +
            `Refresh at: https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`
        );
      }
    }
    throw err;
  }

  const candlesRaw = response.data?.data?.candles as
    | Array<[string, number, number, number, number, number]>
    | undefined;

  if (!candlesRaw || candlesRaw.length === 0) return [];

  const candles = candlesRaw.map((c) => ({
    timestamp: new Date(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  }));

  candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return candles;
}

/**
 * Builds a Kite NFO tradingsymbol for an index option contract.
 *
 * Kite symbol formats (verified from GET /instruments NFO segment CSV):
 *
 *   Weekly expiry (any Thursday that is NOT the last Thursday of the month):
 *     NFO:{ASSET}{YY}{M}{DD}{STRIKE}{CE|PE}
 *     where M = month without leading zero (1–9), or O/N/D for Oct/Nov/Dec
 *     e.g. NFO:NIFTY2631024000CE  (NIFTY, 10-Mar-2026 weekly, 24000CE)
 *
 *   Monthly expiry (last Thursday of the month):
 *     NFO:{ASSET}{YY}{MMM}{STRIKE}{CE|PE}
 *     where MMM = 3-letter month abbreviation (JAN…DEC)
 *     e.g. NFO:NIFTY26MAR24000CE  (NIFTY, 26-Mar-2026 monthly, 24000CE)
 *
 * Verify format by fetching: GET /instruments → NFO segment → filter by name.
 * The tradingsymbol column in that file is the canonical source of truth.
 *
 * @param asset - Underlying index key.
 * @param expiryDate - Exact contract expiry date (IST midnight = UTC 18:30 prev day).
 * @param strike - Strike price, rounded to nearest integer.
 * @param optionType - "CE" for call, "PE" for put.
 * @returns Full Kite NFO symbol with exchange prefix.
 */
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

/**
 * Fetches the live last-traded price for an NFO option symbol via GET /quote/ltp.
 * Returns null in mock mode or on any error — callers must fall back to Black-Scholes
 * estimates when null is returned.
 *
 * Kite response shape:
 *   { data: { "NFO:NIFTY09MAR2623950CE": { last_price: 94.5 } } }
 *
 * @param nfoSymbol - Full Kite symbol with exchange prefix (e.g. "NFO:NIFTY09MAR2623950CE").
 * @returns Live LTP as a positive number, or null on failure.
 */
export async function fetchOptionLTP(nfoSymbol: string): Promise<number | null> {
  if (isMock()) return null;

  logger.info(`Fetching option LTP: ${nfoSymbol}`);

  try {
    const response = await getClient().get("/quote/ltp", {
      params: { i: nfoSymbol },
      headers: getAuthHeader(),
    });

    const data = response.data?.data as
      | Record<string, { last_price?: number }>
      | undefined;

    logger.info(`Raw LTP response for ${nfoSymbol}`, {
      keys: data ? Object.keys(data) : [],
      value: data?.[nfoSymbol] ?? null,
    });

    const ltp = data?.[nfoSymbol]?.last_price;

    if (typeof ltp !== "number" || ltp <= 0) {
      logger.error(
        `LTP null for ${nfoSymbol} — symbol format wrong or contract not found in Kite. ` +
        `Verify exact symbol by fetching GET /instruments (NFO segment) and searching ` +
        `tradingsymbol column. Weekly format: NIFTY2631024000PE, monthly: NIFTY26MAR24000PE`
      );
      return null;
    }

    return ltp;
  } catch (error) {
    logger.warn(`fetchOptionLTP failed for ${nfoSymbol}`, {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetches SPAN + exposure margin for a two-leg credit spread via POST /margins/orders.
 * Kite's portfolio margin engine nets the spread benefit — result is lower than two
 * individual legs summed separately (typically 40–60% of gross margin).
 *
 * Falls back to spreadWidth × lotSize × lots × MARGIN_ESTIMATE_MULTIPLIER when:
 *   - Running in mock mode
 *   - Kite API call fails for any reason
 *
 * @param asset      - Underlying index (NIFTY / BANKNIFTY / FINNIFTY).
 * @param sellStrike - Strike sold (higher-premium leg of the spread).
 * @param buyStrike  - Strike bought (hedge leg).
 * @param optionType - "CE" for bear call spread, "PE" for bull put spread.
 * @param expiryDate - Contract expiry date.
 * @param lotSize    - Number of units per lot.
 * @param lots       - Number of lots traded.
 * @returns Margin in rupees and the source ("KITE_API" or "ESTIMATED").
 */
export async function getSpreadMargin(params: {
  asset: AssetKey;
  sellStrike: number;
  buyStrike: number;
  optionType: "CE" | "PE";
  expiryDate: Date;
  lotSize: number;
  lots: number;
}): Promise<{ margin: number; source: "KITE_API" | "ESTIMATED" }> {
  const spreadWidth = Math.abs(params.sellStrike - params.buyStrike);
  const estimatedMargin = spreadWidth * params.lotSize * params.lots * MARGIN_ESTIMATE_MULTIPLIER;

  if (isMock()) {
    return { margin: estimatedMargin, source: "ESTIMATED" };
  }

  try {
    const sellSymbol = buildNFOOptionSymbol(
      params.asset, params.expiryDate, params.sellStrike, params.optionType
    ).replace("NFO:", "");
    const buySymbol  = buildNFOOptionSymbol(
      params.asset, params.expiryDate, params.buyStrike,  params.optionType
    ).replace("NFO:", "");

    const quantity = params.lotSize * params.lots;

    const orders = [
      {
        exchange: "NFO",
        tradingsymbol: sellSymbol,
        transaction_type: "SELL",
        variety: "regular",
        product: "MIS",
        order_type: "MARKET",
        quantity,
      },
      {
        exchange: "NFO",
        tradingsymbol: buySymbol,
        transaction_type: "BUY",
        variety: "regular",
        product: "MIS",
        order_type: "MARKET",
        quantity,
      },
    ];

    const response = await getClient().post("/margins/orders", orders, {
      headers: {
        ...getAuthHeader(),
        "Content-Type": "application/json",
      },
    });

    type MarginData = { final?: { equity?: { total?: number } } };
    const data = (response.data as { data?: MarginData } | undefined)?.data;
    const total = data?.final?.equity?.total;

    if (typeof total === "number" && total > 0) {
      logger.info("Spread margin from Kite API", {
        asset: params.asset,
        sellStrike: params.sellStrike,
        buyStrike: params.buyStrike,
        lots: params.lots,
        margin: total,
      });
      return { margin: total, source: "KITE_API" };
    }

    logger.warn("Kite margin API returned unexpected shape — using estimate", {
      responseData: response.data,
    });
    return { margin: estimatedMargin, source: "ESTIMATED" };
  } catch (error) {
    logger.warn("Kite margin API call failed — using estimate", {
      asset: params.asset,
      message: error instanceof Error ? error.message : String(error),
    });
    return { margin: estimatedMargin, source: "ESTIMATED" };
  }
}

/**
 * Fetches the most recently CLOSED 5-minute candle from Kite historical API.
 * Used by SignalLoopService to append live candles to the in-memory history buffer.
 *
 * Fetches a 15-minute window (2-3 candles) and returns the last one whose
 * timestamp is strictly before now — i.e., the candle that has already closed.
 * Returns null in mock mode or if no closed candle is available.
 *
 * @param asset - Asset key to fetch candle for.
 * @returns The most recently closed 5-min OHLCV candle, or null.
 */
export async function fetchLatest5MinCandle(asset: AssetKey): Promise<OHLCV | null> {
  if (isMock()) return null;

  const now = new Date();
  // 15-minute window guarantees at least one closed 5-min bar is included
  const from = new Date(now.getTime() - 15 * 60 * 1000);

  try {
    const candles = await fetchHistoricalOHLCV(asset, {
      from: from.toISOString(),
      to: now.toISOString(),
      interval: "5minute",
    });
    // Candle timestamp = bar open time; bar is closed when a newer bar has started
    // A candle is "closed" when its timestamp is strictly before now
    const closed = candles.filter((c) => c.timestamp < now);
    return closed.length > 0 ? (closed[closed.length - 1] ?? null) : null;
  } catch (error) {
    logger.warn("fetchLatest5MinCandle failed — skipping candle append", {
      asset,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetches the Previous Day (PD) OHLC for an asset using Kite's historical API.
 * Goes back 5 calendar days to safely cross weekends and single-day holidays.
 * Returns the second-to-last candle in the daily series = the last completed trading day.
 *
 * Returns null in mock mode or on any error to allow graceful degradation.
 *
 * @param asset - Asset key (NIFTY, BANKNIFTY, FINNIFTY).
 * @returns Previous day OHLC or null.
 */
export async function getPreviousDayOHLC(asset: AssetKey): Promise<{
  pdHigh: number;
  pdLow: number;
  pdClose: number;
  pdOpen: number;
} | null> {
  if (isMock()) return null;

  try {
    const to = new Date();
    const from = subDays(to, 5); // 5 calendar days covers any weekend + holiday gap

    const candles = await fetchHistoricalOHLCV(asset, {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: "day",
    });

    // Need at least 2 candles: today (partial) + previous completed day
    if (candles.length < 2) {
      logger.warn("getPreviousDayOHLC: fewer than 2 daily candles returned", { asset });
      return null;
    }

    // Second-to-last = last fully completed trading day
    const prevDay = candles[candles.length - 2]!;

    return {
      pdHigh:  prevDay.high,
      pdLow:   prevDay.low,
      pdClose: prevDay.close,
      pdOpen:  prevDay.open,
    };
  } catch (error) {
    logger.error("getPreviousDayOHLC: failed to fetch previous day OHLC", {
      asset,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
