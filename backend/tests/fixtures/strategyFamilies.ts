import { historicalFixture } from "./historicalReplay";
import { KiteInstrumentMasterService } from "../../src/services/KiteInstrumentMasterService";
import { qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import type { HistoricalReplayDataset } from "../../src/domain/historicalReplay";

/** Synthetic research tape only. No claim of real broker contracts or historical prices. */
export async function familyFixture(csvEdit: (csv: string) => string = csv => csv): Promise<HistoricalReplayDataset> {
  const base = await historicalFixture();
  const rows: string[] = [];
  let token = 200000;
  for (const type of ["CE", "PE"] as const) for (const strike of [24800, 24900, 25000, 25100, 25200]) {
    token++;
    rows.push(`${token},${token},NIFTY26O06${strike}${type},NIFTY,250,2026-10-06,${strike},0.05,65,${type},NFO-OPT,NFO`);
  }
  const csv = csvEdit("instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n"
    + rows.join("\n") + "\n256265,1001,NIFTY 50,NIFTY 50,25000,,0,0,0,EQ,INDICES,NSE\n");
  const master = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv },
    () => new Date(base.master.provenance.retrievedAt),
    [{ underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "OFFLINE_FIXTURE_CALENDAR" }]).load();
  const index = qualifyIndexMaster(csv, base.master.provenance.retrievedAt).resolve("NIFTY");
  const optionQuotes = base.candles.flatMap(c => master.instruments.map(i => {
    const price = 25000 + (i.strikeMinor - 2500000) / 2 * (i.instrumentType === "CE" ? -1 : 1);
    const timestamp = new Date(Date.parse(c.timestamp) + 300000).toISOString();
    return { timestamp, availableAt: timestamp, canonicalId: i.canonicalId, instrumentToken: i.instrumentToken,
      masterFingerprint: master.provenance.sourceFingerprint, bidMinor: price - 100, askMinor: price + 100,
      lastPriceMinor: price, bidQuantity: 65, askQuantity: 65 };
  }));
  return { ...base, sourceReference: "OFFLINE_FAMILY_FIXTURE", dataVersion: "FAMILY_FIXTURE_V1", master, index, optionQuotes };
}
