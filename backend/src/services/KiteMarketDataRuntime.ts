import { readFile } from "node:fs/promises";
import { z } from "zod";
import { kiteSession } from "./KiteService";
import type { KiteMarketSession } from "./KiteSessionService";
import { KiteInstrumentMasterService, InstrumentMasterError, type InstrumentQualificationScope } from "./KiteInstrumentMasterService";
import { KiteMarketDataService } from "./KiteMarketDataService";
import { fail, freeze, MarketDataError } from "../domain/kiteMarketData";
import { niftyMonthlyExpiries, NIFTY_OPERATIONAL_DEFAULTS as defaults } from "../config/niftyOperationalDefaults";

const monthlySchema = z.array(z.object({
  underlying: z.enum(["NIFTY", "BANKNIFTY", "FINNIFTY"]),
  expiry: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(date => {
    const at = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(+at) && at.toISOString().slice(0, 10) === date;
  }),
  sourceReference: z.string().trim().min(1).max(2000),
}).strict()).min(1).max(1000);

export async function monthlyExpiryConfiguration(now = new Date(), env = process.env) {
  try {
    if (!env.KITE_MONTHLY_EXPIRIES_FILE) return {
      records: niftyMonthlyExpiries(now), version: defaults.monthlyExpiry.version,
      source: defaults.monthlyExpiry.sourceReference,
      scope: { underlying: "NIFTY", coveredFrom: defaults.coveredFrom, coveredTo: defaults.coveredTo } as InstrumentQualificationScope,
    };
    const records = monthlySchema.parse(JSON.parse(await readFile(env.KITE_MONTHLY_EXPIRIES_FILE, "utf8")));
    if (new Set(records.map(r => `${r.underlying}:${r.expiry.slice(0, 7)}`)).size !== records.length) return fail("MONTHLY_METADATA_REQUIRED");
    return { records: freeze(records), version: "EXPLICIT_SERVER_FILE", source: "EXPLICIT_SERVER_FILE", scope: undefined };
  } catch { return fail("MONTHLY_METADATA_REQUIRED"); }
}

/** Server-owned independently verified calendar; never accept metadata/tokens from HTTP callers. */
export async function loadKiteOptionMaster(session: KiteMarketSession = kiteSession, clock: () => Date = () => new Date(), env = process.env) {
  const metadata = await monthlyExpiryConfiguration(clock(), env);
  try {
    return await new KiteInstrumentMasterService({ async getInstrumentsCsv() {
      const result = await session.get("/instruments");
      if (typeof result !== "string") return fail();
      return result;
    } }, clock, metadata.records, metadata.scope).load();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (error instanceof InstrumentMasterError && error.field === "monthlyExpiryMetadata") return fail("MONTHLY_METADATA_REQUIRED");
    return fail("INSTRUMENT_MASTER_STALE");
  }
}
export const kiteMarketData = new KiteMarketDataService(kiteSession, () => loadKiteOptionMaster(), () => kiteSession.getMode());
