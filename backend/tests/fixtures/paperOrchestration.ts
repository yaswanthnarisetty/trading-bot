import { familyFixture } from "./strategyFamilies";
import { fixtureQuality } from "./historicalReplay";
import { buildMockMarketAnalytics } from "../../src/domain/marketAnalytics";
import { capturePaperConfig } from "../../src/domain/paperOrchestration";
import { PRIMARY_PROMPT_VERSION, VERIFIER_PROMPT_VERSION, type Phase5LLMConfig, type Phase5LLMTransport } from "../../src/services/Phase5LLMService";
import type { StrategyFamily } from "../../src/domain/strategyEvaluation";
export const evaluationTime=new Date("2026-09-29T07:55:00.000Z");
export const config=(family:StrategyFamily="CREDIT_VERTICAL")=>capturePaperConfig({configId:`fixture-${family}`,accountId:"PAPER:test-account",executionMode:"PAPER",
  asset:"NIFTY",dataMode:"MOCK",strategyConfig:{...fixtureQuality,strategyFamily:family},intervalMs:300000,entryCutoffMinuteIST:900,
  calendar:{version:"FIXTURE_V1",sourceReference:"OFFLINE_ONLY",openDates:["2026-09-29"]},maxAgeMs:30000,riskFreeRate:0.065,riskFreeRateVersion:"FIXTURE_RATE_V1"});
export const llmConfig:Phase5LLMConfig={primaryModel:"fixture",verifierModel:"fixture",primaryPromptVersion:PRIMARY_PROMPT_VERSION,
  verifierPromptVersion:VERIFIER_PROMPT_VERSION,verifierConfidenceThreshold:0.75,timeoutMs:1000,temperature:0,maxOutputTokens:600};
export function fakeLLM(direction="BULLISH",verdict="AGREE",onCall:()=>void=()=>{}):Phase5LLMTransport{return{async complete(r){onCall();return{model:"fixture",
  content:JSON.stringify({...r.stage==="PRIMARY"?{direction}:{verdict},confidence:0.8,reasonCode:"FIXTURE",rationale:"Offline direction",riskFlags:[]})};}};}
export async function mockCapture(at=evaluationTime){
  const data=await familyFixture(), evaluatedAt=at.toISOString(), expiry="2026-10-06";
  const candles=data.candles.slice(0,50).map(c=>({...c,timestamp:new Date(Date.parse(c.timestamp)+at.getTime()-evaluationTime.getTime()).toISOString()}));
  const options=data.master.instruments.map(i=>{const q=data.optionQuotes.find(q=>q.canonicalId===i.canonicalId)!;return{instrument:i,
    bidMinor:q.bidMinor,askMinor:q.askMinor,bidQuantity:65,askQuantity:65,optionPriceMinor:q.lastPriceMinor,priceTimestamp:evaluatedAt};});
  const analytics=buildMockMarketAnalytics({underlying:"NIFTY",evaluatedAt,spotMinor:2499800,spotTimestamp:evaluatedAt,
    interval:"5minute",candles,options,expiryAtByDate:{[expiry]:`${expiry}T10:00:00.000Z`},expiryAssumptionVersion:"NSE_CLOSE_1530_V1",riskFreeRate:0.065,riskFreeRateVersion:"FIXTURE_V1"});
  return{analytics,evaluatedAt,expiry};
}

// Synthetic wire responses exercise the real qualification/normalization services;
// KITE_REAL here describes the tested code path, not a claim of live broker data.
import { KiteInstrumentMasterService } from "../../src/services/KiteInstrumentMasterService";
import { KiteIndexDataService, qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import { KiteMarketDataService } from "../../src/services/KiteMarketDataService";
import { PaperMarketDataProvider } from "../../src/services/PaperMarketDataProvider";
import type { KiteMarketSession } from "../../src/services/KiteSessionService";
export async function realProvider(clock:()=>Date=()=>evaluationTime) {
  let csv="";const data=await familyFixture(value=>{csv=value;return value;});
  const state={connected:true,mode:"KITE_REAL",ageMs:0,missing:false,exitPrices:{} as Record<string,{bidMinor:number;askMinor:number}>};
  const paths:string[]=[];
  const wire:KiteMarketSession={async get(path,params){
    paths.push(path);if(state.missing)throw new Error("fixture unavailable");
    const at=clock(),timestamp=new Date(+at-state.ageMs).toISOString();
    if(path.startsWith('/instruments/historical/'))return{status:'success',data:{candles:data.candles.slice(0,50).map(c=>[
      new Date(Date.parse(c.timestamp)+ +at- +evaluationTime).toISOString(),c.openMinor/100,c.highMinor/100,c.lowMinor/100,c.closeMinor/100,c.volume])}};
    if(path!=="/quote")throw new Error('UNEXPECTED_FIXTURE_ENDPOINT');
    const values:Record<string,unknown>={};
    for(const key of params!.getAll('i')){
      if(key==='NSE:NIFTY 50')values[key]={instrument_token:'256265',last_price:24998,timestamp};
      else{
        const instrument=data.master.instruments.find(i=>i.contractKey===key);if(!instrument)throw new Error('UNEXPECTED_FIXTURE_IDENTITY');
        const q=data.optionQuotes.find(q=>q.canonicalId===instrument.canonicalId)!;
        const exit=state.exitPrices[instrument.contractKey];
        const p=(exit?exit.bidMinor:q.lastPriceMinor)/100;
        values[key]={instrument_token:instrument.instrumentToken,last_price:p,timestamp,last_trade_time:timestamp,
          ohlc:{open:p,high:p+10,low:p-10,close:p},volume:100,oi:100,
          depth:{buy:[{price:(exit?.bidMinor??q.bidMinor)/100,quantity:65,orders:1}],sell:[{price:(exit?.askMinor??q.askMinor)/100,quantity:65,orders:1}]}};
      }
    }
    return{status:'success',data:values};
  }};
  const mode=()=>state.mode as 'KITE_REAL';
  const options=new KiteMarketDataService(wire,()=>new KiteInstrumentMasterService({getInstrumentsCsv:async()=>csv},clock,
    [{underlying:'NIFTY',expiry:'2026-10-27',sourceReference:'OFFLINE_CALENDAR'}]).load(),mode,()=>+clock());
  const index=new KiteIndexDataService(wire,async()=>qualifyIndexMaster(csv,clock().toISOString()),mode,()=>+clock());
  const provider=new PaperMarketDataProvider(index,options,{status:()=>({tokenValid:state.connected}),getMode:()=>state.mode},clock);
  return{provider,state,paths,index,options};
}
