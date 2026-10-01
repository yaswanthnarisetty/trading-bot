import { z } from "zod";
import { classifiedEntryPlanSchema } from "./entryRisk";
import { fillAccounting } from "./fillAccounting";
import { freeze } from "./kiteMarketData";
const integer=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const paperExitConfigSchema=z.object({
 policyId:z.string().regex(/^[A-Z0-9_]{1,100}$/).optional(),
 underlying:z.enum(['NIFTY','BANKNIFTY','FINNIFTY']).optional(),
 version:z.literal('PAPER_EXIT_V1'),accountId:z.string().regex(/^PAPER:[^\s]+$/),executionMode:z.literal('PAPER'),
 family:z.enum(['LONG_OPTION','DEBIT_VERTICAL','CREDIT_VERTICAL']),dataMode:z.literal('KITE_REAL'),
 takeProfitBps:integer.max(100000),stopLossBps:integer.max(100000),maxHoldingMs:integer.max(86400000),
 eodMinuteIST:z.number().int().min(555).max(930),maxAgeMs:integer.max(60000),
 authorizationMs:integer.min(1000).max(3600000),
 directionalStop:z.literal('DEFERRED_NO_CAPTURED_BASIS'),
}).strict();
export type PaperExitConfig=z.infer<typeof paperExitConfigSchema>;
export const captureExitConfig=(input:unknown)=>freeze(paperExitConfigSchema.parse(input));
export const exitPriority=['STOP_LOSS','EOD_EXIT','DIRECTIONAL_STOP','STRANDED_LONG_CLEANUP','TAKE_PROFIT','TIME_EXIT'] as const;
export type ExitReason=typeof exitPriority[number];
export const exact=(value:bigint)=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('EXIT_ARITHMETIC_OVERFLOW');return Number(value);};
export const istEod=(openedAt:Date,minute:number)=>new Date(Date.parse(new Date(+openedAt+19800000).toISOString().slice(0,10)+'T00:00:00Z')-19800000+minute*60000);
export interface ExitLeg {legId:string;contractKey:string;entrySide:'BUY'|'SELL';entryFilledUnits:number;exitFilledUnits:number}
export interface ExitFill {fillId:string;intentId:string;legId:string;side:'BUY'|'SELL';quantityUnits:number;priceMinor:number;executedAt:Date}
export interface ExitPrice {legId:string;side:'BUY'|'SELL';quantityUnits:number;priceMinor:number}
/** All money is integer paise with BigInt accumulation. Estimates never mutate the ledger. */
export function exitEconomics(position:{entryIntentId:string;legs:ExitLeg[]},planInput:unknown,fills:ExitFill[],prices:ExitPrice[]) {
 const plan=classifiedEntryPlanSchema.parse(planInput);
 let entryCash=0n,allCash=0n,liquidation=0n,buy=0n,sell=0n;
 const entry=fills.filter(f=>f.intentId===position.entryIntentId);
 if(!entry.length)throw new Error('NO_EXPOSURE');
 for(const fill of fills){const cash=BigInt(fill.priceMinor)*BigInt(fill.quantityUnits)*(fill.side==='SELL'?1n:-1n);allCash+=cash;
  if(fill.intentId===position.entryIntentId){entryCash+=cash;if(fill.side==='BUY')buy-=cash;else sell+=cash;}}
 const legs=position.legs.map(leg=>{
  const owned=fills.filter(f=>f.legId===leg.legId),accounting=fillAccounting(owned,position.entryIntentId);
  const entries=owned.filter(f=>f.intentId===position.entryIntentId).reduce((n,f)=>n+BigInt(f.quantityUnits),0n);
  const exits=owned.filter(f=>f.intentId!==position.entryIntentId).reduce((n,f)=>n+BigInt(f.quantityUnits),0n);
  if(entries!==BigInt(leg.entryFilledUnits)||exits!==BigInt(leg.exitFilledUnits))throw new Error('POSITION_FILL_EVIDENCE_MISMATCH');
  const quantity=Math.abs(accounting.netQuantityUnits),side=accounting.netQuantityUnits>0?'SELL' as const:'BUY' as const;
  if(quantity){const p=prices.find(p=>p.legId===leg.legId);if(!p||p.side!==side||p.quantityUnits!==quantity||!Number.isSafeInteger(p.priceMinor)||p.priceMinor<=0)throw new Error('EXIT_QUOTE_REQUIRED');
   liquidation+=BigInt(quantity)*BigInt(p.priceMinor)*(side==='SELL'?1n:-1n);}
  return{...leg,netQuantityUnits:accounting.netQuantityUnits,entryNotionalMinor:accounting.entryNotionalMinor};
 });
 const stranded=plan.family!=='LONG_OPTION'&&legs.some(l=>l.entrySide==='BUY'&&l.netQuantityUnits>0)&&legs.every(l=>l.entrySide!=='SELL'||l.entryFilledUnits===0);
 const basis=stranded||plan.family!=='CREDIT_VERTICAL'?buy-sell:sell-buy;
 const openedAt=new Date(Math.min(...entry.map(f=>+new Date(f.executedAt))));
 if(!Number.isFinite(+openedAt))throw new Error('INVALID_FILL_TIME');
 const width=plan.legs.length===2?Math.abs(plan.legs[0].identity.strikeMinor-plan.legs[1].identity.strikeMinor):null;
 return{family:plan.family,strategyKind:plan.strategyKind,legs,openedAt,entryCashFlowMinor:exact(entryCash),
  entryBasisMinor:exact(basis),liquidationValueMinor:exact(liquidation),estimatedPnlMinor:exact(allCash+liquidation),
  stranded,widthMinor:width,fillIds:fills.map(f=>f.fillId).sort()};
}
export function exitTriggers(e:ReturnType<typeof exitEconomics>,config:PaperExitConfig,now:Date,cleanupSafe:boolean){
 if(!Number.isFinite(+now)||+now<+e.openedAt)throw new Error('INVALID_EVALUATION_TIME');
 const triggers:ExitReason[]=[];
 // Invalid/nonpositive actual premium disables percentage triggers; time/EOD can still reduce exposure.
 if(e.entryBasisMinor>0){const pnl=BigInt(e.estimatedPnlMinor)*10000n,basis=BigInt(e.entryBasisMinor);
  if(pnl<=-basis*BigInt(config.stopLossBps))triggers.push('STOP_LOSS');
  if(pnl>=basis*BigInt(config.takeProfitBps))triggers.push('TAKE_PROFIT');}
 if(+now>=+istEod(e.openedAt,config.eodMinuteIST))triggers.push('EOD_EXIT');
 if(+now-+e.openedAt>=config.maxHoldingMs)triggers.push('TIME_EXIT');
 if(e.stranded&&cleanupSafe)triggers.push('STRANDED_LONG_CLEANUP');
 const ordered=exitPriority.filter(reason=>triggers.includes(reason));
 return{triggers:ordered,reason:ordered[0]??null,directionalStop:'DEFERRED_NO_CAPTURED_BASIS' as const};
}
export function safeExitError(error:unknown):string{
 const raw=error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.message:'';
 const allowed=['STALE_MARKET_DATA','QUOTE_UNAVAILABLE','INSTRUMENT_MASTER_STALE','DATA_MODE_REQUIRED','REAL_DATA_REQUIRED','EXIT_QUOTE_REQUIRED',
  'QUALIFIED_INSTRUMENT_REQUIRED','EXIT_IDENTITY_MISMATCH','EXIT_CONFIG_REQUIRED','EXIT_LEASE_LOST','EXIT_QUOTE_TIMEOUT','EXIT_PRICE_NOT_EXECUTABLE',
  'UNRESOLVED_ENTRY_EXPOSURE','PAPER_NOT_READY','AUTHORIZATION_NOT_CURRENT','CLOSE_POLICY_NOT_CURRENT','EXIT_INDEXES_REQUIRED','POSITION_FILL_EVIDENCE_MISMATCH'];
 return allowed.includes(raw)?raw:'EXIT_REQUIRES_ATTENTION';
}
