import { paperSessionConfigSchema } from "../domain/paperOrchestration";
import { captureExitConfig } from "../domain/paperExits";
import { freeze } from "../domain/kiteMarketData";
import { classifyNseDate, nseLocalDate } from "../domain/nseTradingCalendar";
import { NSE_FO_CALENDAR_2026 } from "./nseTradingCalendar";

/** Backend policy assumptions, not a live RBI rate or broker-provided Greeks.
 * BSM uses continuous annual compounding, ACT/365 and zero dividend yield.
 * Review/version together with the bounded exchange calendar. */
export const NIFTY_OPERATIONAL_DEFAULTS = freeze({
  version: "NIFTY_PAPER_OPERATIONS_20261001_V1",
  coveredFrom: NSE_FO_CALENDAR_2026.coveredFrom,
  coveredTo: NSE_FO_CALENDAR_2026.coveredTo,
  greeks: {
    ...paperSessionConfigSchema.pick({ riskFreeRate: true, riskFreeRateVersion: true }).parse({
      riskFreeRate: 0.065, riskFreeRateVersion: "NIFTY_FIXED_BSM_RATE_6_5_PERCENT_2026_V1",
    }),
    sourceReference: "BACKEND_FIXED_MODEL_ASSUMPTION_NOT_LIVE_RATE",
    expiryAssumptionVersion: "NSE_CLOSE_1530_V1",
  },
  monthlyExpiry: {
    version: "NIFTY_MONTHLY_LAST_TUESDAY_2026_V1",
    sourceReference: `NSE/FAOP/68747;${NSE_FO_CALENDAR_2026.sourceReference}`,
    sources: ["https://nsearchives.nseindia.com/content/circulars/FAOP68747.pdf",
      "https://www.nseindia.com/static/products-services/equity-derivatives-nifty50", ...NSE_FO_CALENDAR_2026.sources],
  },
  // Same documented durable-exit terms; never imported from legacy settings.
  exitPolicy: captureExitConfig({
    version: "PAPER_EXIT_V1", policyId: "NIFTY_LONG_OPTION_EXITS_V1", accountId: "PAPER:NSE",
    executionMode: "PAPER", dataMode: "KITE_REAL", family: "LONG_OPTION", underlying: "NIFTY",
    takeProfitBps: 5000, stopLossBps: 5000, maxHoldingMs: 3600000, eodMinuteIST: 920,
    maxAgeMs: 30000, authorizationMs: 900000, directionalStop: "DEFERRED_NO_CAPTURED_BASIS",
  }),
});

export function assertNiftyDefaultsCoverage(now: Date, reason: string): void {
  const date = nseLocalDate(now);
  if (date < NIFTY_OPERATIONAL_DEFAULTS.coveredFrom || date > NIFTY_OPERATIONAL_DEFAULTS.coveredTo)
    throw new Error(reason);
}

/** Independent exchange evidence. Never infer monthly status from the CSV being
 * qualified, its symbol encoding, or the largest expiry present in that CSV. */
export function niftyMonthlyExpiries(now: Date) {
  assertNiftyDefaultsCoverage(now, "MONTHLY_METADATA_REQUIRED");
  return freeze(Array.from({ length: 12 }, (_, month) => {
    const at = new Date(Date.UTC(2026, month + 1, 0));
    at.setUTCDate(at.getUTCDate() - (at.getUTCDay() + 5) % 7);
    while (true) {
      const evidence = classifyNseDate(at.toISOString().slice(0, 10));
      if (evidence.status === "OPEN") return { underlying: "NIFTY" as const,
        expiry: evidence.localDate, sourceReference: NIFTY_OPERATIONAL_DEFAULTS.monthlyExpiry.sourceReference };
      if (!["CLOSED_WEEKEND", "CLOSED_HOLIDAY"].includes(evidence.status)) throw new Error("MONTHLY_METADATA_REQUIRED");
      at.setUTCDate(at.getUTCDate() - 1);
    }
  }));
}
