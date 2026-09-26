/** Hand-authored offline REST fixtures following the linked Kite v3 examples.
 * These are never connected to application bootstrap or presented as live data.
 */
export const kiteOrder = (changes: Record<string, unknown> = {}) => ({
  account_id: "AB1234", placed_by: "DEALER", order_id: "250101000001", exchange_order_id: "EX1001", parent_order_id: null,
  status: "OPEN", order_timestamp: "2026-09-25 09:15:01", exchange_timestamp: "2026-09-25 09:15:02",
  exchange_update_timestamp: "2026-09-25 09:15:03", variety: "regular", exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE",
  instrument_token: 123456, transaction_type: "BUY", product: "NRML", order_type: "LIMIT", validity: "DAY",
  quantity: 10, filled_quantity: 0, pending_quantity: 10, cancelled_quantity: 0, price: 100.05, average_price: 0, trigger_price: 0,
  ...changes,
});
export const kiteTrade = (changes: Record<string, unknown> = {}) => ({
  trade_id: "000123", order_id: "250101000001", exchange_order_id: "EX1001", exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE",
  instrument_token: 123456, product: "NRML", transaction_type: "BUY", quantity: 4, average_price: 90.05,
  fill_timestamp: "2026-09-25 09:15:05", order_timestamp: "09:15:01", exchange_timestamp: "2026-09-25 09:15:02", ...changes,
});
export const kitePosition = (changes: Record<string, unknown> = {}) => ({
  exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE", instrument_token: 123456, product: "NRML",
  quantity: 4, overnight_quantity: 0, multiplier: 1, average_price: 90.05,
  realised: -100, unrealised: 250, pnl: 150, m2m: 50, buy_quantity: 4, sell_quantity: 0, day_buy_quantity: 4, day_sell_quantity: 0, ...changes,
});
export const kiteFunds = () => ({
  equity: { enabled: true, net: 99725.05000000002,
    available: { cash: 245431.6, opening_balance: 245431.6, live_balance: 99725.05000000002, collateral: 0, intraday_payin: 0, adhoc_margin: 0 },
    utilised: { debits: 145706.55, exposure: 38981.25, m2m_realised: -761.7, m2m_unrealised: 0, option_premium: 0, span: 101989, payout: 0 } },
  commodity: { enabled: false, net: 0, available: { cash: 0 }, utilised: { debits: 0 } },
});
export const kiteSuccess = (data: unknown) => ({ status: "success", data });
