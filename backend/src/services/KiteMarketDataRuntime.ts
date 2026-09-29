import { readFile } from "node:fs/promises";
import { kiteSession } from "./KiteService";
import { KiteInstrumentMasterService, type QualifiedMonthlyExpiry } from "./KiteInstrumentMasterService";
import { KiteMarketDataService } from "./KiteMarketDataService";
import { fail, MarketDataError } from "../domain/kiteMarketData";

/** Server-owned independently verified calendar; never accept metadata/tokens from HTTP callers. */
async function loadMaster() {
  const file = process.env.KITE_MONTHLY_EXPIRIES_FILE;
  if (!file) return fail("INSTRUMENT_MASTER_STALE");
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(value)) return fail("INSTRUMENT_MASTER_STALE");
    return await new KiteInstrumentMasterService({ async getInstrumentsCsv() {
      const result = await kiteSession.get("/instruments");
      if (typeof result !== "string") return fail();
      return result;
    } }, () => new Date(), value as QualifiedMonthlyExpiry[]).load();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    return fail("INSTRUMENT_MASTER_STALE");
  }
}
export const kiteMarketData = new KiteMarketDataService(kiteSession, loadMaster, () => kiteSession.getMode());
