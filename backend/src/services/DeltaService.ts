import crypto from "crypto";
import { rejectDeltaExecution } from "../domain/ExecutionSafety";
import type { CryptoAssetKey } from "../config/assets";
import { CRYPTO_ASSETS } from "../config/assets";
import { logger } from "../utils/logger";
import type { OHLCV } from "../types/trading";

const DELTA_BASE_URL = "https://cdn-ind.testnet.deltaex.org";
const DELTA_TIMEOUT_MS = 8_000;

/*
|--------------------------------------------------------------------------
| Mock Mode
|--------------------------------------------------------------------------
*/

export function isDeltaMock(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DELTA_DATA_MODE === "MOCK"
    && !process.env.DELTA_API_KEY && !process.env.DELTA_API_SECRET;
}

function demoCredentials(): { key: string; secret: string } {
  const key = process.env.DELTA_API_KEY, secret = process.env.DELTA_API_SECRET;
  if (!key || !secret) throw new Error("DELTA_DEMO_CREDENTIALS_REQUIRED");
  return { key, secret };
}

async function deltaJson(path: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${DELTA_BASE_URL}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "trading-bot-demo/1.0", ...headers },
    signal: AbortSignal.timeout(DELTA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DELTA_HTTP_${response.status}`);
  const body: any = await response.json();
  if (body?.success !== true) throw new Error(`DELTA_API_${String(body?.error?.code ?? "INVALID_RESPONSE")}`);
  return body;
}

async function signedGet(path: string): Promise<any> {
  const { key, secret } = demoCredentials();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(`GET${timestamp}${path}`).digest("hex");
  return deltaJson(path, { "api-key": key, timestamp, signature });
}

/** A real-time position read is required for admission: /positions/margined can lag by 10 seconds. */
export async function getDeltaDemoBtcExposure(productId: number): Promise<{
  sizeContracts: number; entryPriceUsd: number | null; activeOrders: Array<{ id: string; clientOrderId: string | null }>;
}> {
  if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error("DELTA_PRODUCT_ID_INVALID");
  const [position, orders] = await Promise.all([
    signedGet(`/v2/positions?product_id=${productId}`),
    signedGet(`/v2/orders?product_id=${productId}`),
  ]);
  const sizeContracts = Number(position?.result?.size);
  const rawEntryPrice = position?.result?.entry_price;
  const entryPriceUsd = rawEntryPrice == null ? null : Number(rawEntryPrice);
  if (!Number.isSafeInteger(sizeContracts) ||
      (sizeContracts !== 0 && (!Number.isFinite(entryPriceUsd) || entryPriceUsd! <= 0)) ||
      !Array.isArray(orders?.result))
    throw new Error("DELTA_EXPOSURE_RESPONSE_INVALID");
  const activeOrders = orders.result.map((order: any) => {
    if (!Number.isSafeInteger(Number(order?.id)) ||
        !["open", "pending"].includes(order?.state) ||
        Number(order?.product_id) !== productId)
      throw new Error("DELTA_EXPOSURE_RESPONSE_INVALID");
    return { id: String(order.id), clientOrderId: typeof order.client_order_id === "string" ? order.client_order_id : null };
  });
  return { sizeContracts, entryPriceUsd, activeOrders };
}

/** Exchange fills, rather than local position rows, establish whether an order traded. */
export async function getDeltaDemoRecentFills(productId: number): Promise<Array<{
  id: string; orderId: string; side: "buy" | "sell"; sizeContracts: number;
  priceUsd: number; commissionUsd: number; createdAt: string;
}>> {
  if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error("DELTA_PRODUCT_ID_INVALID");
  const response = await signedGet(`/v2/fills?product_ids=${productId}&page_size=100`);
  if (!Array.isArray(response?.result)) throw new Error("DELTA_FILLS_RESPONSE_INVALID");
  // Never reconcile from a truncated page. Pagination must be added before a
  // busier account can be admitted to automated execution.
  if (response.result.length >= 100) throw new Error("DELTA_FILLS_PAGINATION_REQUIRED");
  return response.result.map((fill: any) => {
    const sizeContracts = Number(fill?.size), priceUsd = Number(fill?.price);
    const commissionUsd = Number(fill?.commission ?? 0);
    if (typeof fill?.id !== "string" || fill.id.length === 0 ||
        !Number.isSafeInteger(Number(fill?.order_id)) ||
        !["buy", "sell"].includes(fill?.side) ||
        !Number.isSafeInteger(sizeContracts) || sizeContracts <= 0 ||
        !Number.isFinite(priceUsd) || priceUsd <= 0 ||
        !Number.isFinite(commissionUsd) || commissionUsd < 0 ||
        Number(fill?.product_id) !== productId || typeof fill?.created_at !== "string")
      throw new Error("DELTA_FILLS_RESPONSE_INVALID");
    return { id: fill.id, orderId: String(fill.order_id), side: fill.side,
      sizeContracts, priceUsd, commissionUsd, createdAt: fill.created_at };
  });
}

/** Read-only proof from the Demo account. A public ticker never proves API-key access. */
export async function getDeltaDemoAccount(): Promise<{ equity: number; openPositionCount: number; activeOrderCount: number }> {
  const [wallet, positions, orders] = await Promise.all([
    signedGet("/v2/wallet/balances"), signedGet("/v2/positions/margined"), signedGet("/v2/orders"),
  ]);
  const equity = Number(wallet?.meta?.net_equity);
  if (!Number.isFinite(equity) || equity < 0 || !Array.isArray(wallet?.result)
    || !Array.isArray(positions?.result) || !Array.isArray(orders?.result))
    throw new Error("DELTA_ACCOUNT_RESPONSE_INVALID");
  return { equity, openPositionCount: positions.result.length, activeOrderCount: orders.result.length };
}

export interface DeltaDemoProduct {
  id: number;
  symbol: "BTCUSD";
  contractValueBtc: number;
  tickSize: number;
}

export async function getDeltaDemoProduct(): Promise<DeltaDemoProduct> {
  demoCredentials();
  const product = (await deltaJson("/v2/products/BTCUSD")).result;
  const id = Number(product?.id);
  const contractValueBtc = Number(product?.contract_value);
  const tickSize = Number(product?.tick_size);
  if (!Number.isSafeInteger(id) || id <= 0 || product?.symbol !== "BTCUSD" ||
    product?.contract_type !== "perpetual_futures" || product?.state !== "live" ||
    product?.trading_status !== "operational" ||
    product?.contract_unit_currency !== "BTC" ||
    !Number.isFinite(contractValueBtc) || contractValueBtc <= 0 ||
    !Number.isFinite(tickSize) || tickSize <= 0)
    throw new Error("DELTA_PRODUCT_INVALID");
  return { id, symbol: "BTCUSD", contractValueBtc, tickSize };
}

/** Only 60 contiguous, fully closed UTC daily candles may drive Demo entry. */
export async function getDeltaDemoCompletedDailyCandles(): Promise<OHLCV[]> {
  demoCredentials();
  const dayMs = 86_400_000;
  const today = Math.floor(Date.now() / dayMs) * dayMs;
  const query = new URLSearchParams({ symbol: "BTCUSD", resolution: "1d",
    start: String(Math.floor((today - 65 * dayMs) / 1000)),
    end: String(Math.floor(Date.now() / 1000)) });
  const result = (await deltaJson(`/v2/history/candles?${query}`)).result;
  if (!Array.isArray(result)) throw new Error("DELTA_DAILY_CANDLES_INVALID");
  const byTime = new Map<number, OHLCV>();
  for (const raw of result) {
    const time = Number(raw?.time) * 1000;
    if (time >= today) continue; // The current UTC candle is still forming.
    const bar: OHLCV = { timestamp: new Date(time), open: Number(raw?.open),
      high: Number(raw?.high), low: Number(raw?.low), close: Number(raw?.close),
      volume: Number(raw?.volume) };
    if (!Number.isFinite(time) || time % dayMs !== 0 ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.open <= 0 || bar.low <= 0 || bar.close <= 0 ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0) throw new Error("DELTA_DAILY_CANDLES_INVALID");
    const previous = byTime.get(time);
    if (previous && ["open", "high", "low", "close", "volume"].some(key =>
      previous[key as keyof Pick<OHLCV, "open" | "high" | "low" | "close" | "volume">] !==
      bar[key as keyof Pick<OHLCV, "open" | "high" | "low" | "close" | "volume">]))
      throw new Error("DELTA_DAILY_CANDLES_CONFLICT");
    byTime.set(time, bar);
  }
  const bars = [...byTime.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).slice(-60);
  if (bars.length !== 60 || bars[59]!.timestamp.getTime() !== today - dayMs ||
      bars.some((bar, index) => index > 0 &&
        bar.timestamp.getTime() - bars[index - 1]!.timestamp.getTime() !== dayMs))
    throw new Error("DELTA_DAILY_CANDLES_STALE_OR_GAPPED");
  return bars;
}

export interface DeltaDemoBtcBook {
  bidUsd: number; askUsd: number; bidSizeContracts: number; askSizeContracts: number;
  executionBidUsd: number; executionAskUsd: number; spreadBps: number; exchangeTimeMs: number;
}

/** Validate live executable quotes before a market order; mark price alone does not show spread or depth. */
export function qualifyDeltaDemoBtcBook(raw: any, nowMs: number, requiredContracts: number): DeltaDemoBtcBook {
  const bid = Number(raw?.buy?.[0]?.price), ask = Number(raw?.sell?.[0]?.price);
  const exchangeTimeMs = Number(raw?.last_updated_at) / 1000;
  const spreadBps = (ask - bid) / ((ask + bid) / 2) * 10_000;
  if (raw?.symbol !== "BTCUSD" || !Number.isSafeInteger(requiredContracts) || requiredContracts <= 0 ||
      !Number.isFinite(nowMs) || !Number.isFinite(exchangeTimeMs) ||
      nowMs - exchangeTimeMs < -5_000 || nowMs - exchangeTimeMs > 10_000 ||
      !Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= bid ||
      !Number.isFinite(spreadBps) || spreadBps > 10)
    throw new Error("DELTA_BOOK_STALE_WIDE_OR_THIN");
  function nearby(side: any, best: number, buy: boolean): { depth: number; execution: number } {
    if (!Array.isArray(side) || side.length < 1 || side.length > 5)
      throw new Error("DELTA_BOOK_STALE_WIDE_OR_THIN");
    let depth = 0, remaining = requiredContracts, weightedPrice = 0, previous = best;
    for (const rawLevel of side) {
      const price = Number(rawLevel?.price), size = Number(rawLevel?.size);
      if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(size) || size <= 0 ||
          (buy ? price > previous : price < previous))
        throw new Error("DELTA_BOOK_STALE_WIDE_OR_THIN");
      previous = price;
      if (buy ? price < best * (1 - 0.0005) : price > best * (1 + 0.0005)) break;
      depth += size;
      const used = Math.min(remaining, size);
      weightedPrice += used * price;
      remaining -= used;
    }
    if (depth < requiredContracts * 3 || remaining > 0)
      throw new Error("DELTA_BOOK_STALE_WIDE_OR_THIN");
    return { depth, execution: weightedPrice / requiredContracts };
  }
  const buy = nearby(raw.buy, bid, true), sell = nearby(raw.sell, ask, false);
  return { bidUsd: bid, askUsd: ask, bidSizeContracts: buy.depth, askSizeContracts: sell.depth,
    executionBidUsd: buy.execution, executionAskUsd: sell.execution, spreadBps, exchangeTimeMs };
}

export async function getDeltaDemoBtcBook(requiredContracts: number): Promise<DeltaDemoBtcBook> {
  demoCredentials();
  const raw = (await deltaJson("/v2/l2orderbook/BTCUSD?depth=5")).result;
  return qualifyDeltaDemoBtcBook(raw, Date.now(), requiredContracts);
}

/*
|--------------------------------------------------------------------------
| Get BTC Price (PUBLIC ENDPOINT)
|--------------------------------------------------------------------------
*/

export async function getDeltaPrice(asset: CryptoAssetKey): Promise<number> {

  if (isDeltaMock()) {
    const base = CRYPTO_ASSETS[asset].basePrice;
    const jitter = (Math.random() - 0.5) * 0.01 * base;
    return parseFloat((base + jitter).toFixed(2));
  }

  demoCredentials();

  const ticker = (await deltaJson(`/v2/tickers/${encodeURIComponent(asset)}`)).result;
  const price = Number(ticker?.mark_price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("DELTA_TICKER_INVALID");
  const exchangeTimeMs = Number(ticker?.timestamp) / 1000; // Delta timestamp is microseconds.
  const ageMs = Date.now() - exchangeTimeMs;
  if (!Number.isFinite(exchangeTimeMs) || ageMs < -5_000 || ageMs > 15_000)
    throw new Error("DELTA_TICKER_STALE");
  return price;
}

/*
|--------------------------------------------------------------------------
| Candle Resolution Mapping
|--------------------------------------------------------------------------
*/

function mapResolution(resolutionSeconds: number): string {
  const map: Record<number, string> = {
    60: "1m",
    300: "5m",
    900: "15m",
  };
  const resolution = map[resolutionSeconds];
  if (!resolution) throw new Error("DELTA_RESOLUTION_UNSUPPORTED");
  return resolution;
}

/*
|--------------------------------------------------------------------------
| Fetch Candles (PUBLIC ENDPOINT)
|--------------------------------------------------------------------------
*/

export async function getDeltaCandles(
  asset: CryptoAssetKey,
  resolutionSeconds: number = 60,
  limit: number = 60
): Promise<OHLCV[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new Error("DELTA_CANDLE_LIMIT_INVALID");
  const resolution = mapResolution(resolutionSeconds);

  if (isDeltaMock()) {
    return generateMockCandles(asset, limit, resolutionSeconds);
  }

  demoCredentials();

  const end = Math.floor(Date.now() / 1000);

  const start = end - resolutionSeconds * limit;

  const url =
    `${DELTA_BASE_URL}/v2/history/candles` +
    `?symbol=${asset}` +
    `&resolution=${resolution}` +
    `&start=${start}` +
    `&end=${end}`;

  const json = await deltaJson(url.slice(DELTA_BASE_URL.length));
  if (!Array.isArray(json.result)) throw new Error("DELTA_CANDLES_INVALID");
  const candles: OHLCV[] = json.result.map((c: any) => ({
    timestamp: new Date(c.time * 1000),
    open: Number(c.open), high: Number(c.high), low: Number(c.low),
    close: Number(c.close), volume: Number(c.volume),
  }));
  if (candles.some(c => !Number.isFinite(c.timestamp.getTime()) || ![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)
    || c.open <= 0 || c.high < Math.max(c.open,c.close) || c.low > Math.min(c.open,c.close) || c.low <= 0 || c.volume < 0))
    throw new Error("DELTA_CANDLES_INVALID");
  return candles.sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );
}

/*
|--------------------------------------------------------------------------
| Place Order (PRIVATE ENDPOINT)
|--------------------------------------------------------------------------
*/

export async function placeOrder(
  side: "buy" | "sell",
  size: number,
  asset: CryptoAssetKey,
  reduceOnly = false
): Promise<{ orderId: string; status: string }> {
  return rejectDeltaExecution();
}

// delta api connection check
export async function checkDeltaConnection(): Promise<boolean> {
  try {
    const account = await getDeltaDemoAccount();

    logger.info("Delta API connected", {
      openPositionCount: account.openPositionCount,
      environment: "TESTNET",
      exchange: "DELTA"
    });

    return true;

  } catch (error) {

    logger.error("Delta API connection failed", {
      message: error instanceof Error ? error.message : String(error)
    });

    return false;
  }
}

/*
|--------------------------------------------------------------------------
| Mock Candle Generator
|--------------------------------------------------------------------------
*/

function generateMockCandles(
  asset: CryptoAssetKey,
  count: number,
  resolutionSeconds: number
): OHLCV[] {

  const base = CRYPTO_ASSETS[asset].basePrice;

  const candles: OHLCV[] = [];

  let price:number = base;

  const lastClosedStart = Math.floor(Date.now() / (resolutionSeconds * 1000)) * resolutionSeconds * 1000
    - resolutionSeconds * 1000;

  for (let i = count - 1; i >= 0; i--) {

    const ts = new Date(lastClosedStart - i * resolutionSeconds * 1000);

    const change = (Math.random() - 0.49) * 0.006 * price;

    const open = price;

    const close = parseFloat((price + change).toFixed(2));

    const high = parseFloat(
      (Math.max(open, close) * (1 + Math.random() * 0.003)).toFixed(2)
    );

    const low = parseFloat(
      (Math.min(open, close) * (1 - Math.random() * 0.003)).toFixed(2)
    );

    const volume = parseFloat(
      (Math.random() * 500 + 50).toFixed(4)
    );

    candles.push({
      timestamp: ts,
      open,
      high,
      low,
      close,
      volume,
    });

    price = close;
  }

  return candles;
}
