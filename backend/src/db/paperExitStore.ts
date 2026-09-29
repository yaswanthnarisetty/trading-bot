import type { ClientSession,Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { PaperExitConfig } from '../domain/paperExits';
export class PaperExitStore {
 constructor(private readonly connection:Connection,private readonly clock:()=>Date){}
 get states(){return this.connection.db!.collection('paper_exit_states');}
 get decisions(){return this.connection.db!.collection('paper_exit_decisions');}
 async initialize(){await this.states.createIndex({accountId:1,positionId:1},{unique:true});await this.decisions.createIndex({decisionId:1},{unique:true});}
 async assertIndexes(){for(const [collection,key] of [[this.states,{accountId:1,positionId:1}],[this.decisions,{decisionId:1}]] as const){
  const indexes=await collection.listIndexes().toArray();if(!indexes.some(i=>i.unique&&!i.sparse&&!i.hidden&&!i.partialFilterExpression&&JSON.stringify(i.key)===JSON.stringify(key)))throw new Error('EXIT_INDEXES_REQUIRED');}}
 async acquire(accountId:string,positionId:string,config?:PaperExitConfig){
  await this.assertIndexes();
  try{await this.states.updateOne({accountId,positionId},{$setOnInsert:{accountId,positionId,executionMode:'PAPER',version:0,status:'WAITING',...(config?{config}:{}),leaseUntil:new Date(0)}},{upsert:true});}
  catch(e){if((e as {code?:number}).code!==11000)throw e;}
  if(config)await this.states.updateOne({accountId,positionId,config:{$exists:false}},{$set:{config},$inc:{version:1}});
  const leaseId=randomUUID(),now=this.clock();
  const row=await this.states.findOneAndUpdate({accountId,positionId,leaseUntil:{$lte:now}},{$set:{leaseId,leaseUntil:new Date(+now+60000)},$inc:{version:1}},{returnDocument:'after'});
  return row?{accountId,positionId,leaseId,config:row.config as PaperExitConfig|undefined}:null;
 }
 async fence(lease:{accountId:string;positionId:string;leaseId:string},session?:ClientSession){
  const r=await this.states.updateOne({accountId:lease.accountId,positionId:lease.positionId,leaseId:lease.leaseId,leaseUntil:{$gt:this.clock()}},{$inc:{version:1}},{session});
  if(r.matchedCount!==1)throw new Error('EXIT_LEASE_LOST');
 }
 async markDecision(lease:{accountId:string;positionId:string;leaseId:string},decisionId:string,triggerReason:string|null,stranded:boolean){
  const result=await this.states.updateOne({accountId:lease.accountId,positionId:lease.positionId,leaseId:lease.leaseId,leaseUntil:{$gt:this.clock()}},
   {$set:{decisionId,triggerReason,stranded},$inc:{version:1}});
  if(result.matchedCount!==1)throw new Error('EXIT_LEASE_LOST');
 }
 async finish(lease:{accountId:string;positionId:string;leaseId:string},status:string,reason:string,extra:Record<string,unknown>={}){
  await this.states.updateOne({accountId:lease.accountId,positionId:lease.positionId,leaseId:lease.leaseId},
   {$set:{status,reason,...extra,updatedAt:this.clock(),leaseUntil:new Date(0)},$inc:{version:1}});
 }
 async record(lease:{accountId:string;positionId:string;leaseId:string},value:Record<string,unknown>){
  const decisionId=randomUUID();await this.decisions.insertOne({decisionId,accountId:lease.accountId,positionId:lease.positionId,executionMode:'PAPER',monitorVersion:'PAPER_EXIT_V1',...value});return decisionId;
 }
}
// Mandatory initial-claim proof for monitor-owned children. Outcome/fill writes never use it.
const claims=new WeakMap<ClientSession,Set<string>>();
export function permitExitClaim(session:ClientSession,orderId:string){const set=claims.get(session)??new Set<string>();set.add(orderId);claims.set(session,set);}
export const exitClaimPermitted=(session:ClientSession,orderId:string)=>claims.get(session)?.has(orderId)===true;
