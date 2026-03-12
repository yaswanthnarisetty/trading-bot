/**
 * ALLOWED_ASSETS — the only assets this system can trade.
 * MVP-1: Index options only (NIFTY, BANKNIFTY, FINNIFTY).
 * Stock options are intentionally excluded until Phase 2.
 *
 * lotSize: NSE-defined contract lot size
 * basePrice: approximate current level (used by MockDataService)
 * expiryDay: day of week for weekly expiry (0=Sun, 1=Mon...6=Sat)
 * exchange: always NFO for index options
 */
// ⚠️  Lot sizes change periodically via SEBI/NSE circulars.
// Last verified: March 2026
// Always re-check at: https://www.nseindia.com/regulations/circulars
// or Kite instruments file: GET https://api.kite.trade/instruments (NFO segment)
// Filter by: name=NIFTY/BANKNIFTY/FINNIFTY, instrument_type=CE, and read lot_size column.
// ⚠️  Lot sizes change periodically via SEBI/NSE circulars.
// Verified on Kite: March 9 2026
// Check monthly — SEBI changes these periodically
// NIFTY instrument token: 256265
// BANKNIFTY instrument token: 260105
// FINNIFTY instrument token: 257801
// To re-verify: GET https://api.kite.trade/instruments → NFO segment
// Filter by: name=NIFTY/BANKNIFTY/FINNIFTY, instrument_type=CE → read lot_size column.
export const ALLOWED_ASSETS = {
  NIFTY:     { lotSize: 65,  basePrice: 23000, expiryDay: 2, exchange: "NFO" },
  BANKNIFTY: { lotSize: 30,  basePrice: 51000, expiryDay: 2, exchange: "NFO" },
  FINNIFTY:  { lotSize: 60,  basePrice: 24000, expiryDay: 2, exchange: "NFO" },
} as const;

export type AssetKey = keyof typeof ALLOWED_ASSETS;

