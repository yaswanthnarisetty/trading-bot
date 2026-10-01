import { buildRealMarketAnalytics } from "../domain/marketAnalytics";
import { inLongSelectionUniverse, verticalContractQueries } from "../domain/strategyEvaluation";
import { istDate } from "../domain/kiteMarketData";
import type { PaperSessionConfig } from "../domain/paperOrchestration";
import type { PaperMarketProvider } from "./PaperEntryOrchestrator";
import type { KiteIndexDataService } from "./KiteIndexDataService";
import type { KiteMarketDataService } from "./KiteMarketDataService";
/** Approved read-only service composition. MOCK requires an explicitly injected provider. */
export class PaperMarketDataProvider implements PaperMarketProvider {
  constructor(private readonly index:KiteIndexDataService, private readonly options:KiteMarketDataService,
    private readonly session: { status(): {tokenValid:boolean}; getMode():string }, private readonly clock:()=>Date=()=>new Date()) {}
  assertSessionCurrent(c:Readonly<PaperSessionConfig>) {
    if(c.dataMode!=="KITE_REAL")throw new Error("MOCK_PROVIDER_REQUIRED");
    if(this.session.getMode()!==c.dataMode)throw new Error("DATA_MODE_REQUIRED");
    if(!this.session.status().tokenValid)throw new Error("KITE_SESSION_REQUIRED");
  }
  assertCurrent(c:Readonly<PaperSessionConfig>) {
    this.assertSessionCurrent(c);
    const option=this.options.activeMaster(), index=this.index.activeMaster();
    if(option.provenance.sourceFingerprint!==index.provenance.sourceFingerprint)throw new Error("INSTRUMENT_MASTER_STALE");
    index.resolve(c.asset);
    this.expiry(c);
  }
  private expiry(c:Readonly<PaperSessionConfig>) {
    const earliest=Date.parse(`${istDate(this.clock().getTime())}T00:00:00Z`)+c.strategyConfig.minDteDays*86400000;
    const expiry=this.options.activeMaster().listExpiries(c.asset).find(e=>Date.parse(`${e}T00:00:00Z`)>=earliest);
    if(!expiry)throw new Error("QUALIFIED_INSTRUMENT_REQUIRED");
    return expiry;
  }
  async prepare(c:Readonly<PaperSessionConfig>) {
    if(c.dataMode!=="KITE_REAL")throw new Error("MOCK_PROVIDER_REQUIRED");
    if(this.session.getMode()!==c.dataMode)throw new Error("DATA_MODE_REQUIRED");
    if(!this.session.status().tokenValid)throw new Error("KITE_SESSION_REQUIRED");
    await Promise.all([this.options.refreshMaster(),this.index.refreshMaster()]);
    await this.checkReadiness(c);
  }
  async checkReadiness(c:Readonly<PaperSessionConfig>) {
    this.assertCurrent(c);
    // Startup must prove current qualified index data, not merely a token map.
    const q=await this.index.getQuote(this.index.activeMaster().resolve(c.asset),c.maxAgeMs);
    if(q.freshness.state!=="FRESH")throw new Error("STALE_MARKET_DATA");
  }
  async capture(c:Readonly<PaperSessionConfig>) {
    this.assertCurrent(c);
    const master=this.options.activeMaster(), index=this.index.activeMaster().resolve(c.asset), expiry=this.expiry(c);
    const end=Math.floor(this.clock().getTime()/1000)*1000;
    const history=await this.index.getHistoricalCandles({index,interval:"5minute",from:new Date(end-7*86400000).toISOString(),to:new Date(end).toISOString()});
    const quote=await this.index.getQuote(index,c.maxAgeMs);
    const queries=[...verticalContractQueries(quote.priceMinor,"BULLISH",c.strategyConfig),...verticalContractQueries(quote.priceMinor,"BEARISH",c.strategyConfig)];
    const instruments=master.instruments.filter(i=>c.strategyConfig.strategyFamily==="LONG_OPTION"
      ? inLongSelectionUniverse(i,c.asset,expiry,"BULLISH",quote.priceMinor,c.strategyConfig)||inLongSelectionUniverse(i,c.asset,expiry,"BEARISH",quote.priceMinor,c.strategyConfig)
      : i.underlying===c.asset&&i.expiry===expiry&&queries.some(q=>q.type===i.instrumentType&&q.strike===i.strikeMinor));
    const optionQuotes=await this.options.getQuotes(instruments,c.maxAgeMs);
    this.assertCurrent(c);
    const evaluatedAt=this.clock().toISOString();
    const analytics=buildRealMarketAnalytics({index,indexQuote:quote,indexHistory:history,optionQuotes,
      evaluatedAt,observedAt:evaluatedAt,maxAgeMs:c.maxAgeMs,
      expiryAtByDate:{[expiry]:`${expiry}T10:00:00.000Z`},expiryAssumptionVersion:"NSE_CLOSE_1530_V1",
      riskFreeRate:c.riskFreeRate,riskFreeRateVersion:c.riskFreeRateVersion});
    return {analytics,evaluatedAt,expiry,assertCurrent:()=>{
      this.assertCurrent(c); this.index.assertCurrentIndex(index);
      for(const instrument of instruments)this.options.assertCurrentInstrument(instrument);
    }};
  }
}
