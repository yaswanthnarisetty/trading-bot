import { KiteReadOnlyAdapter, type KiteReadPath } from "../src/brokers/KiteReadOnlyAdapter";
import { kiteOrder, kiteTrade, kitePosition, kiteFunds, kiteSuccess } from "./kiteReadFixtures";
import { orderKey, fingerprint, type ReconciliationLink } from "../src/domain/reconciliation";
import * as f from "./fixtures";
export const reconciliationTime = new Date("2026-09-11T04:00:10.000Z");
export const config = { kind: "PAPER_KITE_SHADOW_V1", scope: "REFERENCE_ONLY", brokerAccountId: "AB1234" } as const;
export const nativeOrderId = "250101000001", nativeTradeId = "000123";
export const tradeKey = fingerprint(["KITE_READ_V1", "AB1234", "NFO", "2026-09-11", nativeOrderId, nativeTradeId]);
export function orderLink(orderId = "order-1"): ReconciliationLink {
  return { linkId: "order-link", brokerAccountId: "AB1234", evidenceRef: "explicit-shadow-attestation-1", link: {
    kind: "ORDER", internalId: orderId, brokerKey: orderKey("NFO", "2026-09-11", nativeOrderId), brokerOrderId: nativeOrderId,
    exchangeOrderId: "EX1001", tradingDay: "2026-09-11", instrument: { exchange: "NFO", tradingsymbol: "contract-1", instrumentToken: "123456" },
    product: "MIS", internalProduct: "INTRADAY", positionScope: "ENTIRE_BROKER_NET_POSITION" } };
}
export function fillLink(fillId = "fill-1"): ReconciliationLink {
  return { linkId: "fill-link", brokerAccountId: "AB1234", evidenceRef: "explicit-shadow-attestation-2", link: {
    kind: "FILL", internalId: fillId, brokerKey: tradeKey, orderLinkId: "order-link", nativeTradeId } };
}
export interface SnapshotOptions {
  units?: number; order?: Record<string, unknown>; trade?: Record<string, unknown>; position?: Record<string, unknown>;
  orders?: boolean; trades?: boolean; positions?: boolean; fail?: KiteReadPath; account?: string; time?: Date;
}
export async function brokerSnapshot(options: SnapshotOptions = {}) {
  const units = options.units ?? 4, account = options.account ?? "AB1234";
  const common = { tradingsymbol: "contract-1", product: "MIS" };
  const data: Record<KiteReadPath, unknown> = {
    "/orders": options.orders === false ? [] : [kiteOrder({ ...common, account_id: account, price: 10,
      order_timestamp: "2026-09-11 09:29:59", exchange_timestamp: null, exchange_update_timestamp: null,
      filled_quantity: units, pending_quantity: 10 - units, status: units === 10 ? "COMPLETE" : "OPEN", ...options.order })],
    "/trades": options.trades === false || !units ? [] : [kiteTrade({ ...common, quantity: units, average_price: 9,
      fill_timestamp: "2026-09-11 09:30:00", exchange_timestamp: null, ...options.trade })],
    "/portfolio/positions": { net: options.positions === false || !units ? [] : [kitePosition({ ...common, quantity: units, average_price: 9, ...options.position })], day: [] },
    "/user/margins": kiteFunds(),
  };
  return new KiteReadOnlyAdapter({ brokerAccountId: account, async get(path) {
    if (path === options.fail) throw new Error("offline endpoint failure"); return kiteSuccess(data[path]);
  } }, () => options.time ?? reconciliationTime).getSnapshot();
}
export function ledger(units = 4) {
  return { orders: [{ ...f.brokerOrder(), phase: units === 10 ? "FILLED" : units ? "PARTIALLY_FILLED" : "ACKNOWLEDGED", filledUnits: units,
    submissionAuthorization: { product: "INTRADAY" } }],
  fills: units ? [{ ...f.fillRecord(), quantityUnits: units, priceMinor: 900 }] : [],
  positions: [{ ...f.position(), legs: [{ ...f.position().legs[0], entryFilledUnits: units }] }],
  links: [orderLink(), ...(units ? [fillLink()] : [])] };
}
