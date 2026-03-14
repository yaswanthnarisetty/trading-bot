import crypto from "crypto";
import type { CryptoAssetKey } from "../config/assets";
import { CRYPTO_ASSETS } from "../config/assets";
import { logger } from "../utils/logger";
import type { OHLCV } from "../types/trading";

const DELTA_BASE_URL = "https://cdn-ind.testnet.deltaex.org";

/*
|--------------------------------------------------------------------------
| Mock Mode
|--------------------------------------------------------------------------
*/

export function isDeltaMock(): boolean {
  return !process.env.DELTA_API_KEY;
}

/*
|--------------------------------------------------------------------------
| Signature Builder (ONLY for private endpoints)
|--------------------------------------------------------------------------
*/

function buildSignature(
  method: string,
  path: string,
  body: string = ""
): { timestamp: string; signature: string } {

  const secret = process.env.DELTA_API_SECRET ?? "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${method}${timestamp}${path}${body}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return { timestamp, signature };
}

function authHeaders(
  method: string,
  path: string,
  body: string = ""
): Record<string, string> {

  const apiKey = process.env.DELTA_API_KEY ?? "";

  const { timestamp, signature } = buildSignature(method, path, body);

  return {
    "api-key": apiKey,
    timestamp,
    signature,
    "Content-Type": "application/json",
    "User-Agent": "node-trading-bot"
  };
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

  try {

    const res = await fetch(`${DELTA_BASE_URL}/v2/tickers/${asset}`);

    if (!res.ok) {
      throw new Error(`Delta ticker API error: ${res.status}`);
    }

    const json: any = await res.json();

    const ticker = json.result;

    if (!ticker) throw new Error("Ticker not found");

    const price =
      parseFloat(ticker.mark_price) ||
      parseFloat(ticker.close);

    return price;

  } catch (err) {

    logger.warn("getDeltaPrice failed — using mock fallback", {
      asset,
      message: err instanceof Error ? err.message : String(err),
    });

    const base = CRYPTO_ASSETS[asset].basePrice;

    return parseFloat(
      (base * (1 + (Math.random() - 0.5) * 0.01)).toFixed(2)
    );
  }
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
  return map[resolutionSeconds] ?? "1m";
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

  if (isDeltaMock()) {
    return generateMockCandles(asset, limit, resolutionSeconds);
  }

  try {

    const resolution = mapResolution(resolutionSeconds);

    const end = Math.floor(Date.now() / 1000);

    const start = end - resolutionSeconds*60 * limit;

    const url =
      `${DELTA_BASE_URL}/v2/history/candles` +
      `?symbol=${asset}` +
      `&resolution=${resolution}` +
      `&start=${start}` +
      `&end=${end}`;

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Delta candles API error: ${res.status}`);
    }

    const json: any = await res.json();

    const candles: OHLCV[] = (json.result ?? []).map((c: any) => ({
      timestamp: new Date(c.time * 1000),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));

    return candles.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

  } catch (err) {

    logger.warn("getDeltaCandles failed — using mock candles", {
      asset,
      message: err instanceof Error ? err.message : String(err),
    });

    return generateMockCandles(asset, limit, resolutionSeconds);
  }
}

/*
|--------------------------------------------------------------------------
| Place Order (PRIVATE ENDPOINT)
|--------------------------------------------------------------------------
*/

export async function placeOrder(
  side: "buy" | "sell",
  size: number,
  asset: CryptoAssetKey
): Promise<{ orderId: string; status: string }> {

  if (isDeltaMock()) {
    logger.info("📋 (Mock) Delta order skipped", { side, size, asset });
    return { orderId: `mock-${Date.now()}`, status: "filled" };
  }

  const productId = CRYPTO_ASSETS[asset].productId;
  // Convert physical BTC size to an integer number of contracts
  const multiplier = (CRYPTO_ASSETS[asset] as any).contractMultiplier || 1;
  const contractSize = Math.max(1, Math.floor(size * multiplier));

  try {
    // 1. Set leverage and margin mode for the product
    const levPath = `/v2/products/${productId}/orders/leverage`;
    const levBody = JSON.stringify({ margin_type: "isolated", leverage: "5" });
    const levRes = await fetch(`${DELTA_BASE_URL}${levPath}`, {
      method: "POST",
      headers: authHeaders("POST", levPath, levBody),
      body: levBody,
    });
    if (!levRes.ok) {
      const errText = await levRes.text();
      logger.warn(`Failed to set leverage: ${levRes.status} ${errText}`);
    }

    // 2. Place the order
    const orderPath = "/v2/orders";
    const orderBody = JSON.stringify({
      product_id: productId,
      size: contractSize,
      side,
      order_type: "market_order",
      time_in_force: "gtc"
    });

    const res = await fetch(`${DELTA_BASE_URL}${orderPath}`, {
      method: "POST",
      headers: authHeaders("POST", orderPath, orderBody),
      body: orderBody,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Delta place order error: ${res.status} ${errText}`);
    }

    const json: any = await res.json();
    return {
      orderId: String(json.result?.id ?? "unknown"),
      status: json.result?.state ?? "unknown",
    };
  } catch (err) {
    logger.error("placeOrder failed", {
      asset,
      side,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}



// delta api connection check
export async function checkDeltaConnection(): Promise<boolean> {
  try {

    const price = await getDeltaPrice("BTCUSD");

    logger.info("Delta API connected", {
      price,
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

  const now = Date.now();

  for (let i = count - 1; i >= 0; i--) {

    const ts = new Date(now - i * resolutionSeconds * 1000);

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