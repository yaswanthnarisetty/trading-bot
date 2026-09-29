import { kiteSession } from "./KiteService";
import { KiteIndexDataService, qualifyIndexMaster } from "./KiteIndexDataService";
import { fail } from "../domain/kiteMarketData";

/** Separate read-only index master; its objects never qualify as NFO options. */
export const kiteIndexData = new KiteIndexDataService(kiteSession, async () => {
  const csv = await kiteSession.get("/instruments");
  if (typeof csv !== "string") return fail();
  return qualifyIndexMaster(csv, new Date().toISOString());
}, () => kiteSession.getMode());
