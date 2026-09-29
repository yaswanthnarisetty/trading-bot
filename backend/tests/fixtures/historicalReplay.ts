import { KiteInstrumentMasterService } from "../../src/services/KiteInstrumentMasterService";
import { qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import type { HistoricalReplayDataset, HistoricalOptionQuote, BacktestRunParams } from "../../src/domain/historicalReplay";
import type { StrategyQualityConfig } from "../../src/domain/strategyEvaluation";

// Synthetic offline fixture records, not a claim about an actual historical broker tape.
export const historicalCsv = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
100010,410,NIFTY26O0624900PE,NIFTY,200,2026-10-06,24900,0.05,65,PE,NFO-OPT,NFO
100011,411,NIFTY26O0624800PE,NIFTY,150,2026-10-06,24800,0.05,65,PE,NFO-OPT,NFO
100012,412,NIFTY26O0625100CE,NIFTY,200,2026-10-06,25100,0.05,65,CE,NFO-OPT,NFO
100013,413,NIFTY26O0625200CE,NIFTY,150,2026-10-06,25200,0.05,65,CE,NFO-OPT,NFO
256265,1001,NIFTY 50,NIFTY 50,25000,,0,0,0,EQ,INDICES,NSE
`;
export const fixtureQuality: StrategyQualityConfig = { version: "FIXTURE_QUALITY_V1", minConfidence: 0.65,
  maxAtrPoints: 100, minVolumeRatio: 0, bullishRsiMax: 100, bearishRsiMin: 0,
  openingBlockMinutes: 15, minDteDays: 3, strikeStepMinor: 5000, widthMinor: 10000,
  shortOffsetMinor: 10000, minDepthUnits: 1, maxBidAskSpreadMinor: 1000, minCreditMinor: 1000 };
export async function historicalFixture(bars = 55): Promise<HistoricalReplayDataset> {
  const acquiredAt = "2026-09-28T03:00:00.000Z";
  const master = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => historicalCsv },
    () => new Date(acquiredAt), [{ underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "OFFLINE_FIXTURE_CALENDAR" }]).load();
  const index = qualifyIndexMaster(historicalCsv, acquiredAt).resolve("NIFTY");
  const candles = Array.from({ length: bars }, (_, n) => {
    const closeMinor = 2_490_000 + n * 200;
    return { timestamp: new Date(Date.parse("2026-09-29T03:45:00Z") + n * 300000).toISOString(),
      openMinor: closeMinor - 100, highMinor: closeMinor + 1000, lowMinor: closeMinor - 1000, closeMinor, volume: 100 + n };
  });
  const optionQuotes: HistoricalOptionQuote[] = candles.flatMap((c, n) => master.instruments.map(instrument => {
    const short = ["100010", "100012"].includes(instrument.instrumentToken);
    const price = short ? (n >= 50 ? 16500 : 20000) : 15000;
    const timestamp = new Date(Date.parse(c.timestamp) + 300000).toISOString();
    return { timestamp, availableAt: timestamp, canonicalId: instrument.canonicalId,
      instrumentToken: instrument.instrumentToken, masterFingerprint: master.provenance.sourceFingerprint,
      bidMinor: price - 100, askMinor: price + 100, lastPriceMinor: price, bidQuantity: 6500, askQuantity: 6500 };
  }));
  return { version: "HISTORICAL_DATASET_V1", source: "FIXTURE", sourceReference: "OFFLINE_PHASE5D_FIXTURE",
    dataVersion: "FIXTURE_V1", asset: "NIFTY", interval: "5minute", master, index, candles, optionQuotes,
    riskFreeRate: 0.065, riskFreeRateVersion: "FIXTURE_RATE_V1",
    coverage: { version: "HISTORICAL_COVERAGE_V1", coveredFrom: candles[0]!.timestamp,
      coveredTo: new Date(Date.parse(candles[candles.length - 1]!.timestamp) + 300000).toISOString(),
      expectedCandleStarts: candles.map(c => c.timestamp), optionUniverseComplete: true } };
}
export function fixtureParams(data: HistoricalReplayDataset): BacktestRunParams {
  return { asset: "NIFTY", from: new Date(Date.parse(data.candles[49]!.timestamp) + 300000).toISOString(),
    to: new Date(Date.parse(data.candles[data.candles.length - 1]!.timestamp) + 300000).toISOString(),
    interval: "5minute", initialCapital: 200000, riskPerTradePct: 2, targetProfitPct: 0.5,
    stopLossPct: 0.5, maxHoldingBars: 12, strategyConfig: { ...fixtureQuality } };
}
