import type { KiteIndexDataService } from "./KiteIndexDataService";
import { safeMarketError } from "../domain/kiteMarketData";

/** Display only. Never supplies analytics/candidates or entry authorization. */
export async function readPaperMarketObservation(indices: Pick<KiteIndexDataService, "activeMaster" | "refreshMaster" | "getQuote">) {
  try {
    let master;
    try { master = indices.activeMaster(); } catch { master = await indices.refreshMaster(); }
    const quote = await indices.getQuote(master.resolve("NIFTY"), 30000);
    return { status: "AVAILABLE" as const, tradability: "NON_TRADABLE" as const, quote,
      greeks: { status: "UNAVAILABLE" as const, reason: "QUALIFIED_OPTION_ANALYTICS_REQUIRED" } };
  } catch (e) {
    return { status: "UNAVAILABLE" as const, tradability: "NON_TRADABLE" as const, quote: null,
      reason: safeMarketError(e).code,
      greeks: { status: "UNAVAILABLE" as const, reason: "QUALIFIED_OPTION_ANALYTICS_REQUIRED" } };
  }
}
