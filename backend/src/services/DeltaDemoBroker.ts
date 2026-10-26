import crypto from "crypto";

const BASE_URL = "https://cdn-ind.testnet.deltaex.org";
const TIMEOUT_MS = 8_000;

export interface DeltaBrokerOrder {
  id: string; clientOrderId: string; productId: number; side: "buy" | "sell";
  sizeContracts: number; unfilledContracts: number; state: "open" | "pending" | "closed" | "cancelled";
  reduceOnly: boolean;
  averageFillPriceUsd: number | null; bracketStopUsd: number | null; bracketTargetUsd: number | null;
}

function credentials(): { key: string; secret: string } {
  if (process.env.DELTA_DATA_MODE === "MOCK") throw new Error("DELTA_DEMO_ONLY");
  const key = process.env.DELTA_API_KEY, secret = process.env.DELTA_API_SECRET;
  if (!key || !secret) throw new Error("DELTA_DEMO_CREDENTIALS_REQUIRED");
  return { key, secret };
}

async function signedRequest(method: "GET" | "POST", path: string, payload?: Record<string, unknown>): Promise<any> {
  const { key, secret } = credentials();
  const body = payload ? JSON.stringify(payload) : "";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret)
    .update(`${method}${timestamp}${path}${body}`).digest("hex");
  const response = await fetch(`${BASE_URL}${path}`, { method,
    headers: { "api-key": key, timestamp, signature, Accept: "application/json",
      "Content-Type": "application/json", "User-Agent": "trading-bot-demo/1.0" },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DELTA_HTTP_${response.status}`);
  const result: any = await response.json();
  if (result?.success !== true) throw new Error(`DELTA_API_${String(result?.error?.code ?? "INVALID_RESPONSE")}`);
  return result.result;
}

function parseOrder(raw: any): DeltaBrokerOrder {
  const id = Number(raw?.id), productId = Number(raw?.product_id), size = Number(raw?.size);
  const unfilled = Number(raw?.unfilled_size);
  const average = raw?.average_fill_price == null ? null : Number(raw.average_fill_price);
  const stop = raw?.bracket_stop_loss_price == null ? null : Number(raw.bracket_stop_loss_price);
  const target = raw?.bracket_take_profit_price == null ? null : Number(raw.bracket_take_profit_price);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(productId) || productId <= 0 ||
      typeof raw?.client_order_id !== "string" || raw.client_order_id.length < 1 || raw.client_order_id.length > 32 ||
      !["buy", "sell"].includes(raw?.side) || !["open", "pending", "closed", "cancelled"].includes(raw?.state) ||
      typeof raw?.reduce_only !== "boolean" ||
      !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(unfilled) || unfilled < 0 || unfilled > size ||
      (average !== null && (!Number.isFinite(average) || average <= 0)) ||
      (stop !== null && (!Number.isFinite(stop) || stop <= 0)) ||
      (target !== null && (!Number.isFinite(target) || target <= 0)))
    throw new Error("DELTA_ORDER_RESPONSE_INVALID");
  return { id: String(id), clientOrderId: raw.client_order_id, productId,
    side: raw.side, sizeContracts: size, unfilledContracts: unfilled, state: raw.state,
    reduceOnly: raw.reduce_only,
    averageFillPriceUsd: average, bracketStopUsd: stop, bracketTargetUsd: target };
}

function validClientId(id: string): boolean { return /^[A-Za-z0-9_-]{1,32}$/.test(id); }
function validTick(price: number, tick: number): boolean {
  return Number.isFinite(price) && price > 0 && Number.isFinite(tick) && tick > 0 &&
    Math.abs(price / tick - Math.round(price / tick)) < 1e-6;
}

/** An order request is sent once. Callers must persist its client ID before invoking this function. */
export async function submitDeltaProtectedEntry(input: {
  clientOrderId: string; productId: number; side: "LONG" | "SHORT"; sizeContracts: number;
  referencePriceUsd: number; stopUsd: number; targetUsd: number; tickSize: number;
}): Promise<DeltaBrokerOrder> {
  const { clientOrderId, productId, side, sizeContracts, referencePriceUsd, stopUsd, targetUsd, tickSize } = input;
  if (!validClientId(clientOrderId) || !Number.isSafeInteger(productId) || productId <= 0 ||
      !Number.isSafeInteger(sizeContracts) || sizeContracts <= 0 ||
      !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0 ||
      !validTick(stopUsd, tickSize) || !validTick(targetUsd, tickSize) ||
      !(side === "LONG" ? stopUsd < referencePriceUsd && targetUsd > referencePriceUsd
                        : stopUsd > referencePriceUsd && targetUsd < referencePriceUsd))
    throw new Error("DELTA_PROTECTED_ENTRY_INVALID");
  const raw = await signedRequest("POST", "/v2/orders", {
    product_id: productId, size: sizeContracts, side: side === "LONG" ? "buy" : "sell",
    order_type: "market_order", time_in_force: "ioc", reduce_only: false,
    bracket_stop_loss_price: String(stopUsd), bracket_take_profit_price: String(targetUsd),
    bracket_stop_trigger_method: "mark_price", client_order_id: clientOrderId,
    cancel_orders_accepted: false,
  });
  const order = parseOrder(raw);
  if (order.clientOrderId !== clientOrderId || order.productId !== productId ||
      order.side !== (side === "LONG" ? "buy" : "sell") || order.sizeContracts !== sizeContracts ||
      order.reduceOnly ||
      order.bracketStopUsd !== stopUsd || order.bracketTargetUsd !== targetUsd)
    throw new Error("DELTA_PROTECTION_UNCONFIRMED");
  return order;
}

export async function getDeltaOrderByClientId(clientOrderId: string): Promise<DeltaBrokerOrder> {
  if (!validClientId(clientOrderId)) throw new Error("DELTA_CLIENT_ORDER_ID_INVALID");
  return parseOrder(await signedRequest("GET", `/v2/orders/client_order_id/${clientOrderId}`));
}

/** Reduce-only close does not mark a trade closed; fills and flat exchange position must be verified separately. */
export async function submitDeltaReduceOnlyClose(input: {
  clientOrderId: string; productId: number; side: "LONG" | "SHORT"; sizeContracts: number;
}): Promise<DeltaBrokerOrder> {
  const { clientOrderId, productId, side, sizeContracts } = input;
  if (!validClientId(clientOrderId) || !Number.isSafeInteger(productId) || productId <= 0 ||
      !Number.isSafeInteger(sizeContracts) || sizeContracts <= 0)
    throw new Error("DELTA_CLOSE_INVALID");
  const raw = await signedRequest("POST", "/v2/orders", {
    product_id: productId, size: sizeContracts, side: side === "LONG" ? "sell" : "buy",
    order_type: "market_order", time_in_force: "ioc", reduce_only: true,
    client_order_id: clientOrderId, cancel_orders_accepted: false,
  });
  const order = parseOrder(raw);
  if (order.clientOrderId !== clientOrderId || order.productId !== productId ||
      order.side !== (side === "LONG" ? "sell" : "buy") || order.sizeContracts !== sizeContracts || !order.reduceOnly)
    throw new Error("DELTA_CLOSE_UNCONFIRMED");
  return order;
}
