import { classifiedEntryPlanSchema } from '../domain/entryRisk';
import { freeze } from '../domain/kiteMarketData';
import type { ExitLeg,ExitPrice,PaperExitConfig } from '../domain/paperExits';
import { assertQualifiedRealMarketData,type KiteMarketDataService } from './KiteMarketDataService';
export interface ExitMarketEvidence {prices:readonly ExitPrice[];provenance:unknown;assertCurrent():void}
export interface ExitMarketProvider {capture(plan:unknown,legs:ExitLeg[],config:PaperExitConfig):Promise<ExitMarketEvidence>}
/** Current Phase 4B quotes only. Re-resolve economic identity; never reuse stored broker tokens. */
export class PaperExitMarketData implements ExitMarketProvider {
 constructor(private readonly market:KiteMarketDataService,private readonly clock:()=>Date=()=>new Date()){}
 async capture(input:unknown,legs:ExitLeg[],config:PaperExitConfig):Promise<ExitMarketEvidence>{
  const plan=classifiedEntryPlanSchema.parse(input);if(plan.dataMode!=='KITE_REAL'||config.dataMode!=='KITE_REAL')throw new Error('REAL_DATA_REQUIRED');
  let master;try{master=this.market.activeMaster();}catch{master=await this.market.refreshMaster();}
  const targets=legs.filter(l=>l.entryFilledUnits>l.exitFilledUnits).map(leg=>{
   const terms=plan.legs.find(t=>t.legId===leg.legId);if(!terms)throw new Error('EXIT_IDENTITY_MISMATCH');
   const i=master.getInstrumentByCanonicalId(terms.identity.canonicalId);
   if(i.contractKey!==leg.contractKey||i.contractKey!==terms.contractKey||i.tickSizeMinor!==terms.tickSizeMinor||i.lotSizeUnits!==terms.lotSizeUnits)throw new Error('EXIT_IDENTITY_MISMATCH');
   return{leg,instrument:i};
  });
  if(!targets.length)throw new Error('NO_EXPOSURE');
  const quotes=await this.market.getQuotes(targets.map(t=>t.instrument),config.maxAgeMs);
  const prices=targets.map(({leg,instrument},index)=>{
   const q=quotes[index];assertQualifiedRealMarketData(q,{instrument,maxAgeMs:config.maxAgeMs});
   const side=leg.entrySide==='BUY'?'SELL' as const:'BUY' as const,level=side==='SELL'?q.depth?.buy[0]:q.depth?.sell[0];
   const quantityUnits=leg.entryFilledUnits-leg.exitFilledUnits;
   if(q.kind!=='QUOTE'||!level||level.priceMinor<=0||level.quantity<quantityUnits||level.priceMinor%instrument.tickSizeMinor!==0)throw new Error('EXIT_QUOTE_REQUIRED');
   return{legId:leg.legId,side,quantityUnits,priceMinor:level.priceMinor};
  });
  const assertCurrent=()=>{for(let i=0;i<targets.length;i++){
   assertQualifiedRealMarketData(quotes[i],{instrument:targets[i].instrument,maxAgeMs:config.maxAgeMs});
   const q=quotes[i];if(+this.clock()<Date.parse(q.fetchedAt)||+this.clock()>Math.min(Date.parse(q.fetchedAt),Date.parse(q.brokerTimestamp!))+config.maxAgeMs)throw new Error('STALE_MARKET_DATA');
  }};
  assertCurrent();return freeze({prices,assertCurrent,provenance:quotes.map(q=>({source:q.source,dataMode:q.dataMode,normalizationVersion:q.normalizationVersion,
   canonicalId:q.instrument.canonicalId,contractKey:q.instrument.contractKey,instrumentToken:q.instrument.instrumentToken,masterFingerprint:q.masterFingerprint,
   masterVersion:q.masterVersion,fetchedAt:q.fetchedAt,exchangeTimestamp:q.brokerTimestamp,maxAgeMs:config.maxAgeMs}))});
 }
}
